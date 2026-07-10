//! Typed Bokeh document-session transport and persistence helpers.
//!
//! Panel is only a producer of the initial document. This module models the
//! generic Bokeh checkpoint/patch protocol between the launcher, runtime, and
//! isolated browser view without exposing arbitrary Jupyter messages.

use std::future::Future;
use std::pin::Pin;

use bytes::Bytes;
use notebook_protocol::protocol::{
    BokehSessionBuffer, BokehSessionBufferRef, BokehSessionCheckpointPayload,
    BokehSessionPatchEvent, BokehSessionPatchPayload, BokehSessionPatchReply,
    BokehSessionPatchRequest, NotebookBroadcast,
};
use runtime_doc::{
    BokehSessionCheckpoint, BokehSessionContentRef, BokehSessionPatchRef, BokehSessionState,
    BokehSessionStatus, RuntimeStateHandle,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::blob_store::BlobStore;
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_commit_context::OutputCommitContext;
use crate::output_store::{self, OutputManifest, DEFAULT_INLINE_THRESHOLD};

pub(crate) const BOKEH_SESSION_MIME: &str = "application/vnd.nteract.bokeh-session.v1+json";
pub(crate) const BOKEH_PATCH_REQUEST: &str = "nteract_bokeh_patch_request";
pub(crate) const BOKEH_PATCH_REPLY: &str = "nteract_bokeh_patch_reply";
pub(crate) const BOKEH_CHECKPOINT_REQUEST: &str = "nteract_bokeh_checkpoint_request";
pub(crate) const BOKEH_CHECKPOINT_REPLY: &str = "nteract_bokeh_checkpoint_reply";
pub(crate) const BOKEH_EVENT: &str = "nteract_bokeh_event";
pub(crate) const BOKEH_CHECKPOINT_MEDIA_TYPE: &str =
    "application/vnd.nteract.bokeh-checkpoint.v1+json";
pub(crate) const BOKEH_PATCH_MEDIA_TYPE: &str = "application/vnd.nteract.bokeh-patch.v1+json";
pub(crate) const BOKEH_PATCH_CHECKPOINT_THRESHOLD: usize = 32;
pub(crate) const BOKEH_PATCH_TAIL_HARD_LIMIT: usize = 128;

#[derive(Debug)]
pub(crate) struct RawBokehKernelMessage {
    pub(crate) msg_type: String,
    pub(crate) content: Value,
    pub(crate) buffers: Vec<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct BokehKernelSerialization {
    pub content: Value,
    pub buffers: Vec<BokehSessionBuffer>,
}

#[derive(Debug)]
pub struct BokehKernelPatchResponse {
    pub reply: BokehSessionPatchReply,
    pub stdout: String,
    pub stderr: String,
    pub error_output: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct BokehKernelCheckpoint {
    pub session_id: String,
    pub revision: u64,
    pub document: BokehKernelSerialization,
}

pub type BokehCheckpointFuture =
    Pin<Box<dyn Future<Output = anyhow::Result<BokehKernelCheckpoint>> + Send + 'static>>;

#[derive(Debug)]
pub(crate) struct PreparedInitialBokehSession {
    pub(crate) session_id: String,
    pub(crate) state: BokehSessionState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BokehEventIngest {
    Applied { checkpoint_needed: bool },
    Duplicate,
    ResyncNeeded { session_id: String },
}

pub(crate) async fn ingest_kernel_event(
    content: &Value,
    raw_buffers: &[Vec<u8>],
    kernel_id: &str,
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
    broadcast_tx: &tokio::sync::broadcast::Sender<NotebookBroadcast>,
) -> anyhow::Result<BokehEventIngest> {
    anyhow::ensure!(
        content.get("schema_version").and_then(Value::as_u64) == Some(1),
        "unsupported Bokeh event schema"
    );
    let session_id = required_str(content, "session_id")?.to_string();
    let transaction_id = required_str(content, "transaction_id")?.to_string();
    let base_revision = required_u64(content, "base_revision")?;
    let revision = required_u64(content, "revision")?;
    anyhow::ensure!(
        revision == base_revision + 1,
        "Bokeh event revision must advance exactly once"
    );

    let client_serialization = content
        .get("client_patch")
        .filter(|value| !value.is_null())
        .map(|value| parse_serialization(value, "patch", raw_buffers))
        .transpose()?;
    let server_serialization = content
        .get("server_patch")
        .filter(|value| !value.is_null())
        .map(|value| parse_serialization(value, "patch", raw_buffers))
        .transpose()?;
    let checkpoint_serialization = content
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .map(|value| parse_serialization(value, "document", raw_buffers))
        .transpose()?;
    let (checkpoint, checkpoint_ref) = store_event_checkpoint(
        checkpoint_serialization,
        &session_id,
        revision,
        blob_store,
        blob_publisher,
    )
    .await?;
    let event = BokehSessionPatchEvent {
        session_id: session_id.clone(),
        transaction_id,
        base_revision,
        revision,
        client_patch: store_patch_payload(client_serialization, blob_store, blob_publisher).await?,
        server_patch: store_patch_payload(server_serialization, blob_store, blob_publisher).await?,
        checkpoint,
    };
    let patch_artifact = if checkpoint_ref.is_none() {
        let event_bytes = serde_json::to_vec(&event)?;
        let event_hash = blob_store.put(&event_bytes, BOKEH_PATCH_MEDIA_TYPE).await?;
        blob_publisher
            .publish_artifact(
                event_hash.clone(),
                event_bytes.len() as u64,
                BOKEH_PATCH_MEDIA_TYPE.to_string(),
                blob_store,
            )
            .await?;
        Some((event_hash, event_bytes.len() as u64))
    } else {
        None
    };

    let update = state.with_doc(|state_doc| {
        let Some(mut session) = state_doc.get_bokeh_session(&session_id) else {
            return Err(runtime_doc::RuntimeStateError::InvalidBokehSession(
                format!("unknown Bokeh session {session_id}"),
            ));
        };
        if session.kernel_id != kernel_id || session.status != BokehSessionStatus::Connected {
            return Err(runtime_doc::RuntimeStateError::InvalidBokehSession(
                format!("Bokeh session {session_id} is not connected to kernel {kernel_id}"),
            ));
        }
        if revision <= session.head_revision {
            return Ok(BokehEventIngest::Duplicate);
        }
        if base_revision != session.head_revision && checkpoint_ref.is_none() {
            return Ok(BokehEventIngest::ResyncNeeded {
                session_id: session_id.clone(),
            });
        }

        session.head_revision = revision;
        if let Some(checkpoint_ref) = checkpoint_ref {
            session.checkpoint = Some(checkpoint_ref);
            session.patch_tail.clear();
        } else {
            if session.patch_tail.len() >= BOKEH_PATCH_TAIL_HARD_LIMIT {
                return Ok(BokehEventIngest::ResyncNeeded {
                    session_id: session_id.clone(),
                });
            }
            let (event_hash, event_size) = patch_artifact.clone().ok_or_else(|| {
                runtime_doc::RuntimeStateError::InvalidBokehSession(
                    "Bokeh patch artifact missing".to_string(),
                )
            })?;
            session.patch_tail.push(BokehSessionPatchRef {
                base_revision,
                revision,
                content_ref: BokehSessionContentRef {
                    blob: event_hash,
                    size: event_size,
                    media_type: BOKEH_PATCH_MEDIA_TYPE.to_string(),
                },
            });
        }
        let checkpoint_needed = session.patch_tail.len() >= BOKEH_PATCH_CHECKPOINT_THRESHOLD;
        state_doc.put_bokeh_session(&session_id, &session)?;
        Ok(BokehEventIngest::Applied { checkpoint_needed })
    })?;

    if matches!(update, BokehEventIngest::Applied { .. }) {
        let _ = broadcast_tx.send(NotebookBroadcast::BokehSessionPatch {
            patch: Box::new(event),
        });
    }
    Ok(update)
}

pub(crate) async fn persist_checkpoint(
    checkpoint: &BokehKernelCheckpoint,
    expected_kernel_id: &str,
    allow_head_advance: bool,
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<()> {
    let buffers = store_buffers(&checkpoint.document.buffers, blob_store, blob_publisher).await?;
    let payload = json!({
        "schema_version": 1,
        "session_id": checkpoint.session_id,
        "revision": checkpoint.revision,
        "document": checkpoint.document.content,
        "buffers": buffers,
    });
    let bytes = serde_json::to_vec(&payload)?;
    let hash = blob_store.put(&bytes, BOKEH_CHECKPOINT_MEDIA_TYPE).await?;
    blob_publisher
        .publish_artifact(
            hash.clone(),
            bytes.len() as u64,
            BOKEH_CHECKPOINT_MEDIA_TYPE.to_string(),
            blob_store,
        )
        .await?;

    state.with_doc(|state_doc| {
        let Some(mut session) = state_doc.get_bokeh_session(&checkpoint.session_id) else {
            return Err(runtime_doc::RuntimeStateError::InvalidBokehSession(
                format!("unknown Bokeh session {}", checkpoint.session_id),
            ));
        };
        if session.kernel_id != expected_kernel_id
            || session.status != BokehSessionStatus::Connected
        {
            return Err(runtime_doc::RuntimeStateError::InvalidBokehSession(
                format!(
                    "Bokeh session {} is not connected to kernel {}",
                    checkpoint.session_id, expected_kernel_id
                ),
            ));
        }
        if checkpoint.revision > session.head_revision && !allow_head_advance {
            return Err(runtime_doc::RuntimeStateError::InvalidBokehSession(
                format!(
                    "checkpoint revision {} is ahead of projected revision {}",
                    checkpoint.revision, session.head_revision
                ),
            ));
        }
        if allow_head_advance {
            session.head_revision = session.head_revision.max(checkpoint.revision);
        }
        session.checkpoint = Some(BokehSessionCheckpoint {
            revision: checkpoint.revision,
            content_ref: BokehSessionContentRef {
                blob: hash,
                size: bytes.len() as u64,
                media_type: BOKEH_CHECKPOINT_MEDIA_TYPE.to_string(),
            },
        });
        session
            .patch_tail
            .retain(|patch| patch.revision > checkpoint.revision);
        state_doc.put_bokeh_session(&checkpoint.session_id, &session)
    })?;
    Ok(())
}

pub(crate) async fn append_callback_outputs(
    session_id: &str,
    response: &BokehKernelPatchResponse,
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<()> {
    let execution_id = state
        .read(|state_doc| {
            state_doc
                .get_bokeh_session(session_id)
                .map(|session| session.execution_id)
        })?
        .ok_or_else(|| anyhow::anyhow!("unknown Bokeh session {session_id}"))?;

    let mut outputs = Vec::new();
    if !response.stdout.is_empty() {
        outputs.push(json!({
            "output_type": "stream",
            "name": "stdout",
            "text": response.stdout,
        }));
    }
    if !response.stderr.is_empty() {
        outputs.push(json!({
            "output_type": "stream",
            "name": "stderr",
            "text": response.stderr,
        }));
    }
    if let Some(error) = &response.error_output {
        outputs.push(error.clone());
    }
    if outputs.is_empty() {
        return Ok(());
    }

    let mut manifests = Vec::with_capacity(outputs.len());
    for output in outputs {
        let manifest =
            output_store::create_manifest(&output, blob_store, DEFAULT_INLINE_THRESHOLD).await?;
        blob_publisher
            .publish_manifest_blobs(&manifest, blob_store)
            .await?;
        manifests.push(manifest.to_json());
    }
    state.with_doc(|state_doc| state_doc.append_outputs(&execution_id, &manifests))?;
    Ok(())
}

async fn store_patch_payload(
    serialization: Option<BokehKernelSerialization>,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<Option<BokehSessionPatchPayload>> {
    let Some(serialization) = serialization else {
        return Ok(None);
    };
    Ok(Some(BokehSessionPatchPayload {
        patch: serialization.content,
        buffers: store_buffers(&serialization.buffers, blob_store, blob_publisher).await?,
    }))
}

async fn store_event_checkpoint(
    serialization: Option<BokehKernelSerialization>,
    session_id: &str,
    revision: u64,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<(
    Option<BokehSessionCheckpointPayload>,
    Option<BokehSessionCheckpoint>,
)> {
    let Some(serialization) = serialization else {
        return Ok((None, None));
    };
    let buffers = store_buffers(&serialization.buffers, blob_store, blob_publisher).await?;
    let payload = BokehSessionCheckpointPayload {
        document: serialization.content,
        buffers,
    };
    let artifact = json!({
        "schema_version": 1,
        "session_id": session_id,
        "revision": revision,
        "document": payload.document,
        "buffers": payload.buffers,
    });
    let bytes = serde_json::to_vec(&artifact)?;
    let hash = blob_store.put(&bytes, BOKEH_CHECKPOINT_MEDIA_TYPE).await?;
    blob_publisher
        .publish_artifact(
            hash.clone(),
            bytes.len() as u64,
            BOKEH_CHECKPOINT_MEDIA_TYPE.to_string(),
            blob_store,
        )
        .await?;
    Ok((
        Some(payload),
        Some(BokehSessionCheckpoint {
            revision,
            content_ref: BokehSessionContentRef {
                blob: hash,
                size: bytes.len() as u64,
                media_type: BOKEH_CHECKPOINT_MEDIA_TYPE.to_string(),
            },
        }),
    ))
}

async fn store_buffers(
    buffers: &[BokehSessionBuffer],
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<Vec<BokehSessionBufferRef>> {
    let mut refs = Vec::with_capacity(buffers.len());
    for buffer in buffers {
        let hash = blob_store
            .put(&buffer.data, "application/octet-stream")
            .await?;
        blob_publisher
            .publish_artifact(
                hash.clone(),
                buffer.data.len() as u64,
                "application/octet-stream".to_string(),
                blob_store,
            )
            .await?;
        refs.push(BokehSessionBufferRef {
            id: buffer.id.clone(),
            blob: hash,
            size: buffer.data.len() as u64,
            media_type: "application/octet-stream".to_string(),
        });
    }
    Ok(refs)
}

pub(crate) async fn prepare_initial_session(
    execution_id: &str,
    nbformat_value: &Value,
    manifest: &OutputManifest,
    context: &OutputCommitContext,
) -> anyhow::Result<Option<PreparedInitialBokehSession>> {
    let Some(payload) = nbformat_value
        .get("data")
        .and_then(|data| data.get(BOKEH_SESSION_MIME))
    else {
        return Ok(None);
    };
    anyhow::ensure!(
        payload.get("schema_version").and_then(Value::as_u64) == Some(1),
        "unsupported Bokeh session schema"
    );
    let session_id = required_str(payload, "session_id")?.to_string();
    let revision = payload
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("Bokeh session is missing revision"))?;
    let producer = payload
        .get("producer")
        .ok_or_else(|| anyhow::anyhow!("Bokeh session is missing producer"))?;
    let root_ids = payload
        .get("root_ids")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("Bokeh session is missing root_ids"))?
        .iter()
        .map(|root| {
            root.as_str()
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("Bokeh root id must be a string"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(!root_ids.is_empty(), "Bokeh session has no roots");
    anyhow::ensure!(
        payload.get("document").is_some(),
        "Bokeh session is missing document"
    );

    let mut checkpoint_payload = payload.clone();
    normalize_initial_buffer_refs(&mut checkpoint_payload, context).await?;
    let checkpoint_bytes = serde_json::to_vec(&checkpoint_payload)?;
    let checkpoint_hash = context
        .blob_store
        .put(&checkpoint_bytes, BOKEH_CHECKPOINT_MEDIA_TYPE)
        .await?;
    context
        .blob_publisher
        .publish_artifact(
            checkpoint_hash.clone(),
            checkpoint_bytes.len() as u64,
            BOKEH_CHECKPOINT_MEDIA_TYPE.to_string(),
            &context.blob_store,
        )
        .await?;

    let cell_id = context
        .state
        .read(|state_doc| {
            state_doc
                .get_execution(execution_id)
                .and_then(|execution| execution.cell_id)
        })
        .ok()
        .flatten();
    let cell_id = cell_id
        .ok_or_else(|| anyhow::anyhow!("Bokeh output execution is missing cell association"))?;

    Ok(Some(PreparedInitialBokehSession {
        session_id,
        state: BokehSessionState {
            output_id: manifest.output_id().to_string(),
            cell_id,
            execution_id: execution_id.to_string(),
            kernel_id: context.kernel_id.clone(),
            status: BokehSessionStatus::Connected,
            head_revision: revision,
            producer_name: required_str(producer, "name")?.to_string(),
            producer_version: optional_str(producer, "version").to_string(),
            bokeh_version: required_str(payload, "bokeh_version")?.to_string(),
            root_ids,
            checkpoint: Some(BokehSessionCheckpoint {
                revision,
                content_ref: BokehSessionContentRef {
                    blob: checkpoint_hash,
                    size: checkpoint_bytes.len() as u64,
                    media_type: BOKEH_CHECKPOINT_MEDIA_TYPE.to_string(),
                },
            }),
            patch_tail: Vec::new(),
        },
    }))
}

async fn normalize_initial_buffer_refs(
    payload: &mut Value,
    context: &OutputCommitContext,
) -> anyhow::Result<()> {
    let descriptors = payload
        .get_mut("buffers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow::anyhow!("Bokeh session buffers must be an array"))?;
    for descriptor in descriptors {
        let hash = required_str(descriptor, "hash")?.to_string();
        let size = descriptor
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer is missing size"))?;
        anyhow::ensure!(
            context.blob_store.exists(&hash),
            "Bokeh buffer {hash} is missing from blob storage"
        );
        context
            .blob_publisher
            .publish_artifact(
                hash.clone(),
                size,
                "application/octet-stream".to_string(),
                &context.blob_store,
            )
            .await?;
        let object = descriptor
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer descriptor must be an object"))?;
        object.insert("blob".to_string(), Value::String(hash));
        object.insert(
            "media_type".to_string(),
            Value::String("application/octet-stream".to_string()),
        );
        object.remove("buffer_index");
        object.remove("hash");
    }
    Ok(())
}

pub(crate) fn patch_request_wire(request: &BokehSessionPatchRequest) -> (Value, Vec<Bytes>) {
    let descriptors = request
        .buffers
        .iter()
        .enumerate()
        .map(|(buffer_index, buffer)| {
            json!({
                "id": buffer.id,
                "hash": hex_sha256(&buffer.data),
                "size": buffer.data.len(),
                "buffer_index": buffer_index,
            })
        })
        .collect::<Vec<_>>();
    let buffers = request
        .buffers
        .iter()
        .map(|buffer| Bytes::copy_from_slice(&buffer.data))
        .collect();
    (
        json!({
            "schema_version": 1,
            "session_id": request.session_id,
            "transaction_id": request.transaction_id,
            "base_revision": request.base_revision,
            "patch": request.patch,
            "buffers": descriptors,
        }),
        buffers,
    )
}

pub(crate) fn checkpoint_request_wire(session_id: &str, transaction_id: &str) -> Value {
    json!({
        "schema_version": 1,
        "session_id": session_id,
        "transaction_id": transaction_id,
    })
}

pub(crate) fn parse_patch_reply(
    message: RawBokehKernelMessage,
) -> anyhow::Result<BokehKernelPatchResponse> {
    anyhow::ensure!(
        message.msg_type == BOKEH_PATCH_REPLY,
        "expected {BOKEH_PATCH_REPLY}, got {}",
        message.msg_type
    );
    let session_id = required_str(&message.content, "session_id")?.to_string();
    let transaction_id = required_str(&message.content, "transaction_id")?.to_string();
    let stdout = optional_str(&message.content, "stdout").to_string();
    let stderr = optional_str(&message.content, "stderr").to_string();

    let status = required_str(&message.content, "status")?;
    let revision = message.content.get("revision").and_then(Value::as_u64);
    let error_output = message.content.get("error").map(kernel_error_output);
    let reply = match status {
        "ok" => BokehSessionPatchReply::Accepted {
            session_id,
            transaction_id,
            revision: revision
                .ok_or_else(|| anyhow::anyhow!("Bokeh patch reply is missing revision"))?,
        },
        "stale" => BokehSessionPatchReply::Stale {
            session_id,
            transaction_id,
            revision: revision
                .ok_or_else(|| anyhow::anyhow!("stale Bokeh reply is missing revision"))?,
        },
        "error" => BokehSessionPatchReply::Error {
            session_id,
            transaction_id,
            revision,
            error: kernel_error_text(message.content.get("error")),
        },
        other => anyhow::bail!("unknown Bokeh patch reply status {other:?}"),
    };

    Ok(BokehKernelPatchResponse {
        reply,
        stdout,
        stderr,
        error_output,
    })
}

pub(crate) fn parse_checkpoint_reply(
    message: RawBokehKernelMessage,
) -> anyhow::Result<BokehKernelCheckpoint> {
    anyhow::ensure!(
        message.msg_type == BOKEH_CHECKPOINT_REPLY,
        "expected {BOKEH_CHECKPOINT_REPLY}, got {}",
        message.msg_type
    );
    let status = required_str(&message.content, "status")?;
    if status != "ok" {
        anyhow::bail!(
            "Bokeh checkpoint failed: {}",
            kernel_error_text(message.content.get("error"))
        );
    }
    Ok(BokehKernelCheckpoint {
        session_id: required_str(&message.content, "session_id")?.to_string(),
        revision: message
            .content
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow::anyhow!("Bokeh checkpoint reply is missing revision"))?,
        document: parse_serialization(
            message
                .content
                .get("checkpoint")
                .ok_or_else(|| anyhow::anyhow!("Bokeh checkpoint reply is missing checkpoint"))?,
            "document",
            &message.buffers,
        )?,
    })
}

fn parse_serialization(
    value: &Value,
    content_key: &str,
    raw_buffers: &[Vec<u8>],
) -> anyhow::Result<BokehKernelSerialization> {
    let content = value
        .get(content_key)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Bokeh serialization is missing {content_key}"))?;
    let descriptors = value
        .get("buffers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut buffers = Vec::with_capacity(descriptors.len());
    for descriptor in descriptors {
        let id = required_str(&descriptor, "id")?.to_string();
        let index = descriptor
            .get("buffer_index")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer {id} is missing buffer_index"))?
            as usize;
        let data = raw_buffers
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer index {index} is out of range"))?
            .clone();
        validate_buffer_descriptor(&descriptor, &data)?;
        buffers.push(BokehSessionBuffer { id, data });
    }
    Ok(BokehKernelSerialization { content, buffers })
}

fn validate_buffer_descriptor(descriptor: &Value, data: &[u8]) -> anyhow::Result<()> {
    if let Some(size) = descriptor.get("size").and_then(Value::as_u64) {
        anyhow::ensure!(
            size == data.len() as u64,
            "Bokeh buffer size mismatch: expected {size}, got {}",
            data.len()
        );
    }
    if let Some(expected_hash) = descriptor.get("hash").and_then(Value::as_str) {
        let actual_hash = hex_sha256(data);
        anyhow::ensure!(
            expected_hash == actual_hash,
            "Bokeh buffer hash mismatch: expected {expected_hash}, got {actual_hash}"
        );
    }
    Ok(())
}

fn kernel_error_output(error: &Value) -> Value {
    json!({
        "output_type": "error",
        "ename": error.get("ename").and_then(Value::as_str).unwrap_or("BokehSessionError"),
        "evalue": error.get("evalue").and_then(Value::as_str).unwrap_or("Bokeh session callback failed"),
        "traceback": error.get("traceback").and_then(Value::as_array).cloned().unwrap_or_default(),
    })
}

fn kernel_error_text(error: Option<&Value>) -> String {
    let Some(error) = error else {
        return "Bokeh session request failed".to_string();
    };
    let name = error
        .get("ename")
        .and_then(Value::as_str)
        .unwrap_or("BokehSessionError");
    let value = error.get("evalue").and_then(Value::as_str).unwrap_or("");
    if value.is_empty() {
        name.to_string()
    } else {
        format!("{name}: {value}")
    }
}

fn required_str<'a>(value: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Bokeh message is missing string {key}"))
}

fn required_u64(value: &Value, key: &str) -> anyhow::Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("Bokeh message is missing integer {key}"))
}

fn optional_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn hex_sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_state(head_revision: u64) -> RuntimeStateHandle {
        let mut doc = runtime_doc::RuntimeStateDoc::try_new_with_actor("test-runtime")
            .expect("runtime state");
        doc.create_execution_with_source_provenance(
            "exec-1",
            "panel_output",
            0,
            None,
            Some("cell-1"),
        )
        .expect("execution");
        doc.put_bokeh_session(
            "session-1",
            &BokehSessionState {
                output_id: "output-1".to_string(),
                cell_id: "cell-1".to_string(),
                execution_id: "exec-1".to_string(),
                kernel_id: "kernel-1".to_string(),
                status: BokehSessionStatus::Connected,
                head_revision,
                producer_name: "panel".to_string(),
                producer_version: "1.9.3".to_string(),
                bokeh_version: "3.9.1".to_string(),
                root_ids: vec!["p1001".to_string()],
                checkpoint: Some(BokehSessionCheckpoint {
                    revision: 0,
                    content_ref: BokehSessionContentRef {
                        blob: "checkpoint-0".to_string(),
                        size: 10,
                        media_type: BOKEH_CHECKPOINT_MEDIA_TYPE.to_string(),
                    },
                }),
                patch_tail: Vec::new(),
            },
        )
        .expect("session");
        let (changed_tx, _changed_rx) = tokio::sync::broadcast::channel(8);
        RuntimeStateHandle::new(doc, changed_tx)
    }

    fn patch_event(base_revision: u64, revision: u64) -> Value {
        json!({
            "schema_version": 1,
            "session_id": "session-1",
            "transaction_id": format!("tx-{revision}"),
            "base_revision": base_revision,
            "revision": revision,
            "client_patch": {
                "patch": {"events": []},
                "buffers": [],
            },
            "server_patch": null,
            "checkpoint": null,
        })
    }

    #[test]
    fn patch_request_keeps_bokeh_buffer_identity() {
        let request = BokehSessionPatchRequest {
            session_id: "session-1".to_string(),
            transaction_id: "tx-1".to_string(),
            base_revision: 4,
            patch: json!({"events": []}),
            buffers: vec![BokehSessionBuffer {
                id: "buffer-1".to_string(),
                data: b"payload".to_vec(),
            }],
            buffer_refs: Vec::new(),
        };

        let (content, buffers) = patch_request_wire(&request);
        assert_eq!(content["buffers"][0]["id"], "buffer-1");
        assert_eq!(content["buffers"][0]["buffer_index"], 0);
        assert_eq!(buffers, vec![Bytes::from_static(b"payload")]);
    }

    #[test]
    fn parses_stale_patch_reply() {
        let response = parse_patch_reply(RawBokehKernelMessage {
            msg_type: BOKEH_PATCH_REPLY.to_string(),
            content: json!({
                "status": "stale",
                "session_id": "session-1",
                "transaction_id": "tx-1",
                "revision": 8,
                "stdout": "",
                "stderr": "",
            }),
            buffers: Vec::new(),
        })
        .unwrap();

        assert_eq!(
            response.reply,
            BokehSessionPatchReply::Stale {
                session_id: "session-1".to_string(),
                transaction_id: "tx-1".to_string(),
                revision: 8,
            }
        );
    }

    #[tokio::test]
    async fn canonical_patch_appends_blob_backed_tail_and_broadcasts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().join("blobs"));
        let publisher = OutputBlobPublisher::none();
        let state = runtime_state(0);
        let (broadcast_tx, mut broadcast_rx) = tokio::sync::broadcast::channel(4);

        let result = ingest_kernel_event(
            &patch_event(0, 1),
            &[],
            "kernel-1",
            &state,
            &blob_store,
            &publisher,
            &broadcast_tx,
        )
        .await
        .expect("ingest patch");

        assert_eq!(
            result,
            BokehEventIngest::Applied {
                checkpoint_needed: false,
            }
        );
        let session = state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("session");
        assert_eq!(session.head_revision, 1);
        assert_eq!(session.patch_tail.len(), 1);
        assert_eq!(session.patch_tail[0].base_revision, 0);
        assert_eq!(session.patch_tail[0].revision, 1);
        assert!(blob_store.exists(&session.patch_tail[0].content_ref.blob));

        match broadcast_rx.recv().await.expect("broadcast") {
            NotebookBroadcast::BokehSessionPatch { patch } => {
                assert_eq!(patch.session_id, "session-1");
                assert_eq!(patch.revision, 1);
            }
            NotebookBroadcast::Comm { .. } => panic!("expected Bokeh patch broadcast"),
        }
    }

    #[tokio::test]
    async fn canonical_noop_event_advances_revision_and_broadcasts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().join("blobs"));
        let publisher = OutputBlobPublisher::none();
        let state = runtime_state(0);
        let (broadcast_tx, mut broadcast_rx) = tokio::sync::broadcast::channel(4);
        let event = json!({
            "schema_version": 1,
            "session_id": "session-1",
            "transaction_id": "tx-button-click",
            "base_revision": 0,
            "revision": 1,
            "client_patch": null,
            "server_patch": null,
            "checkpoint": null,
        });

        let result = ingest_kernel_event(
            &event,
            &[],
            "kernel-1",
            &state,
            &blob_store,
            &publisher,
            &broadcast_tx,
        )
        .await
        .expect("ingest no-op revision");

        assert_eq!(
            result,
            BokehEventIngest::Applied {
                checkpoint_needed: false,
            }
        );
        let session = state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("session");
        assert_eq!(session.head_revision, 1);
        assert_eq!(session.patch_tail.len(), 1);
        match broadcast_rx.recv().await.expect("broadcast") {
            NotebookBroadcast::BokehSessionPatch { patch } => {
                assert_eq!(patch.transaction_id, "tx-button-click");
                assert_eq!(patch.revision, 1);
                assert!(patch.client_patch.is_none());
                assert!(patch.server_patch.is_none());
                assert!(patch.checkpoint.is_none());
            }
            NotebookBroadcast::Comm { .. } => panic!("expected Bokeh patch broadcast"),
        }
    }

    #[tokio::test]
    async fn revision_gap_requests_resync_without_advancing_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().join("blobs"));
        let publisher = OutputBlobPublisher::none();
        let state = runtime_state(0);
        let (broadcast_tx, mut broadcast_rx) = tokio::sync::broadcast::channel(4);

        let result = ingest_kernel_event(
            &patch_event(2, 3),
            &[],
            "kernel-1",
            &state,
            &blob_store,
            &publisher,
            &broadcast_tx,
        )
        .await
        .expect("ingest gap");

        assert_eq!(
            result,
            BokehEventIngest::ResyncNeeded {
                session_id: "session-1".to_string(),
            }
        );
        let session = state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("session");
        assert_eq!(session.head_revision, 0);
        assert!(session.patch_tail.is_empty());
        assert!(matches!(
            broadcast_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn canonical_checkpoint_replaces_patch_tail() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().join("blobs"));
        let publisher = OutputBlobPublisher::none();
        let state = runtime_state(0);
        let (broadcast_tx, _broadcast_rx) = tokio::sync::broadcast::channel(4);
        ingest_kernel_event(
            &patch_event(0, 1),
            &[],
            "kernel-1",
            &state,
            &blob_store,
            &publisher,
            &broadcast_tx,
        )
        .await
        .expect("initial patch");
        let checkpoint_event = json!({
            "schema_version": 1,
            "session_id": "session-1",
            "transaction_id": "tx-error",
            "base_revision": 1,
            "revision": 2,
            "client_patch": null,
            "server_patch": null,
            "checkpoint": {
                "document": {"version": "3.9.1", "roots": []},
                "buffers": [],
            },
        });

        let result = ingest_kernel_event(
            &checkpoint_event,
            &[],
            "kernel-1",
            &state,
            &blob_store,
            &publisher,
            &broadcast_tx,
        )
        .await
        .expect("checkpoint event");

        assert_eq!(
            result,
            BokehEventIngest::Applied {
                checkpoint_needed: false,
            }
        );
        let session = state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("session");
        assert_eq!(session.head_revision, 2);
        assert_eq!(session.checkpoint.expect("checkpoint").revision, 2);
        assert!(session.patch_tail.is_empty());
    }

    #[tokio::test]
    async fn canonical_checkpoint_repairs_a_revision_gap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().join("blobs"));
        let publisher = OutputBlobPublisher::none();
        let state = runtime_state(0);
        let (broadcast_tx, _broadcast_rx) = tokio::sync::broadcast::channel(4);
        let checkpoint_event = json!({
            "schema_version": 1,
            "session_id": "session-1",
            "transaction_id": "tx-gap-checkpoint",
            "base_revision": 4,
            "revision": 5,
            "client_patch": null,
            "server_patch": null,
            "checkpoint": {
                "document": {"version": "3.9.1", "roots": []},
                "buffers": [],
            },
        });

        let result = ingest_kernel_event(
            &checkpoint_event,
            &[],
            "kernel-1",
            &state,
            &blob_store,
            &publisher,
            &broadcast_tx,
        )
        .await
        .expect("repair from checkpoint");

        assert_eq!(
            result,
            BokehEventIngest::Applied {
                checkpoint_needed: false,
            }
        );
        let session = state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("session");
        assert_eq!(session.head_revision, 5);
        assert_eq!(session.checkpoint.expect("checkpoint").revision, 5);
    }

    #[tokio::test]
    async fn forced_checkpoint_can_advance_only_the_owning_kernel_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().join("blobs"));
        let publisher = OutputBlobPublisher::none();
        let state = runtime_state(0);
        let checkpoint = BokehKernelCheckpoint {
            session_id: "session-1".to_string(),
            revision: 3,
            document: BokehKernelSerialization {
                content: json!({"version": "3.9.1", "roots": []}),
                buffers: Vec::new(),
            },
        };

        persist_checkpoint(
            &checkpoint,
            "kernel-1",
            false,
            &state,
            &blob_store,
            &publisher,
        )
        .await
        .expect_err("routine compaction cannot skip revisions");
        persist_checkpoint(
            &checkpoint,
            "wrong-kernel",
            true,
            &state,
            &blob_store,
            &publisher,
        )
        .await
        .expect_err("foreign kernel cannot replace checkpoint");
        persist_checkpoint(
            &checkpoint,
            "kernel-1",
            true,
            &state,
            &blob_store,
            &publisher,
        )
        .await
        .expect("forced checkpoint");

        let session = state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("session");
        assert_eq!(session.head_revision, 3);
        assert_eq!(session.checkpoint.expect("checkpoint").revision, 3);
    }

    #[tokio::test]
    async fn callback_outputs_append_after_owning_execution_completed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().join("blobs"));
        let publisher = OutputBlobPublisher::none();
        let state = runtime_state(0);
        state
            .with_doc(|doc| {
                doc.set_execution_running("exec-1")?;
                doc.set_execution_done("exec-1", true)
            })
            .expect("finish execution");
        let response = BokehKernelPatchResponse {
            reply: BokehSessionPatchReply::Accepted {
                session_id: "session-1".to_string(),
                transaction_id: "tx-output".to_string(),
                revision: 1,
            },
            stdout: "callback stdout\n".to_string(),
            stderr: "callback stderr\n".to_string(),
            error_output: None,
        };

        append_callback_outputs("session-1", &response, &state, &blob_store, &publisher)
            .await
            .expect("append callback outputs");

        let outputs = state
            .read(|doc| doc.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0]["name"], "stdout");
        assert_eq!(outputs[0]["text"]["inline"], "callback stdout\n");
        assert_eq!(outputs[1]["name"], "stderr");
        assert_eq!(outputs[1]["text"]["inline"], "callback stderr\n");
    }
}
