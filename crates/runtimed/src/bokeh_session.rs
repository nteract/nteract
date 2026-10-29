//! Kernel-owned Bokeh document sessions.
//!
//! Each session's state lives in a `BokehSessionDoc`. The runtime agent owns
//! the authoritative replica ([`store::BokehSessionStore`], owned by
//! [`agent::BokehAgentExtension`]): it builds the document from the display
//! payload, applies the launcher's `nteract_bokeh_delta` messages under the
//! kernel actor ([`ingest`], [`kernel`]), and forwards property changes won by
//! other actors to the kernel. The room keeps
//! a hub replica per session ([`hub::BokehSessionHub`]) and routes frame
//! `0x0b` between the runtime agent and peers. Data events and Python messages
//! are one-off and travel as `NotebookBroadcast::BokehSessionEvents`. See
//! `docs/adr/bokeh-session-documents.md`.

pub(crate) mod agent;
pub(crate) mod hub;
pub(crate) mod ingest;
pub(crate) mod kernel;
pub(crate) mod materialize;
pub(crate) mod output_hook;
pub(crate) mod store;

use bytes::Bytes;
use notebook_protocol::protocol::{BokehSessionPatchReply, BokehSessionPatchRequest};
use runtime_doc::{BokehSessionDoc, BokehSessionState, BokehSessionStatus, RuntimeStateHandle};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::blob_store::BlobStore;
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_commit_context::OutputCommitContext;
use crate::output_store::{self, OutputManifest, DEFAULT_INLINE_THRESHOLD};

pub(crate) use runtime_doc::BOKEH_SESSION_MIME;
/// The keyed document kind session documents sync under (frame `0x0b`).
pub(crate) const BOKEH_SESSION_KIND: &str = "bokeh_session";
pub(crate) const BOKEH_PATCH_REQUEST: &str = "nteract_bokeh_patch_request";
pub(crate) const BOKEH_PATCH_REPLY: &str = "nteract_bokeh_patch_reply";
pub(crate) const BOKEH_FOLD_REQUEST: &str = "nteract_bokeh_fold_request";
pub(crate) const BOKEH_FOLD_REPLY: &str = "nteract_bokeh_fold_reply";
pub(crate) const BOKEH_CLOSE_REQUEST: &str = "nteract_bokeh_close_request";
pub(crate) const BOKEH_CLOSE_REPLY: &str = "nteract_bokeh_close_reply";
pub(crate) const BOKEH_DELTA: &str = "nteract_bokeh_delta";
pub(crate) const BOKEH_WIRE_SCHEMA_VERSION: u64 = 1;

/// A property or `doc_extras` value moved out of the session document.
pub(crate) const BOKEH_PROP_MEDIA_TYPE: &str = "application/vnd.nteract.bokeh-prop.v1+json";
/// One Bokeh-encoded column with its buffers inlined as base64, so the blob
/// is self-contained and a GC root needs no walk.
pub(crate) const BOKEH_COLUMN_MEDIA_TYPE: &str = "application/vnd.nteract.bokeh-column.v1+json";
pub(crate) const BOKEH_BUFFER_MEDIA_TYPE: &str = "application/octet-stream";

#[derive(Debug)]
pub(crate) struct RawBokehKernelMessage {
    pub(crate) msg_type: String,
    pub(crate) content: Value,
    #[allow(dead_code)]
    pub(crate) buffers: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BokehKernelPatchResponse {
    pub(crate) reply: BokehSessionPatchReply,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) error_output: Option<Value>,
}

/// A session whose display output is being committed.
pub(crate) struct PreparedInitialBokehSession {
    pub(crate) session_id: String,
    pub(crate) state: BokehSessionState,
    pub(crate) doc: BokehSessionDoc,
}

/// Build a session's epoch-0 document from the display payload's
/// `session_doc` and the RuntimeStateDoc record that names it.
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
    // The launcher omits `session_doc` when it will not serve the session
    // live; such a payload is a static render, not a malformed one.
    if payload.get("session_doc").is_none() {
        return Ok(None);
    }
    anyhow::ensure!(
        payload.get("schema_version").and_then(Value::as_u64) == Some(BOKEH_WIRE_SCHEMA_VERSION),
        "unsupported Bokeh session schema"
    );
    let session_id = required_str(payload, "session_id")?.to_string();
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
    let session_doc = payload
        .get("session_doc")
        .ok_or_else(|| anyhow::anyhow!("Bokeh session is missing session_doc"))?;

    let buffers =
        ingest::stored_buffers(payload.get("session_doc_buffers"), &context.blob_store).await?;
    let snapshot = ingest::snapshot_from_session_doc(
        &session_id,
        session_doc,
        &buffers,
        &ingest::BlobSink::new(&context.blob_store, &context.blob_publisher),
    )
    .await?;
    let mut doc = BokehSessionDoc::build(&snapshot, &context.kernel_actor_id)
        .map_err(|error| anyhow::anyhow!("build Bokeh session document: {error}"))?;

    let cell_id = context
        .state
        .read(|state_doc| {
            state_doc
                .get_execution(execution_id)
                .and_then(|execution| execution.cell_id)
        })
        .ok()
        .flatten()
        .ok_or_else(|| anyhow::anyhow!("Bokeh output execution is missing cell association"))?;

    Ok(Some(PreparedInitialBokehSession {
        state: BokehSessionState {
            output_id: manifest.output_id().to_string(),
            cell_id,
            execution_id: execution_id.to_string(),
            kernel_id: context.kernel_id.clone(),
            status: BokehSessionStatus::Connected,
            producer_name: required_str(producer, "name")?.to_string(),
            producer_version: optional_str(producer, "version").to_string(),
            bokeh_version: required_str(payload, "bokeh_version")?.to_string(),
            root_ids,
            epoch: snapshot.epoch,
            doc_heads: hex_heads(&doc.get_heads()),
            previous_heads: Vec::new(),
        },
        session_id,
        doc,
    }))
}

/// The session document holds `session_doc` once ingested, so the stored
/// output keeps only `document` (the render fallback a save refreshes).
pub(crate) fn strip_ingested_session_doc(nbformat_value: &Value) -> Option<Value> {
    let payload = nbformat_value.get("data")?.get(BOKEH_SESSION_MIME)?;
    if payload.get("session_doc").is_none() && payload.get("session_doc_buffers").is_none() {
        return None;
    }
    let mut stripped = nbformat_value.clone();
    if let Some(payload) = stripped
        .get_mut("data")
        .and_then(|data| data.get_mut(BOKEH_SESSION_MIME))
        .and_then(Value::as_object_mut)
    {
        payload.remove("session_doc");
        payload.remove("session_doc_buffers");
    }
    Some(stripped)
}

pub(crate) fn hex_heads(heads: &[automerge::ChangeHash]) -> Vec<String> {
    heads.iter().map(|head| head.to_string()).collect()
}

pub(crate) async fn append_callback_outputs(
    session_id: &str,
    response: &BokehKernelPatchResponse,
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<()> {
    // Interactive callbacks can run long after the owning execution reached
    // `ExecutionDone`, so they cannot participate in that execution's terminal
    // stream-ordering barrier. Append them to the durable owning execution
    // directly; RuntimeStateHandle serializes this write with other state edits.
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
            "schema_version": BOKEH_WIRE_SCHEMA_VERSION,
            "session_id": request.session_id,
            "transaction_id": request.transaction_id,
            "patch": request.patch,
            "buffers": descriptors,
        }),
        buffers,
    )
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
    let error_output = message.content.get("error").map(kernel_error_output);
    let reply = match required_str(&message.content, "status")? {
        "ok" => BokehSessionPatchReply::Accepted {
            session_id,
            transaction_id,
        },
        "error" => BokehSessionPatchReply::Error {
            session_id,
            transaction_id,
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

fn kernel_error_output(error: &Value) -> Value {
    json!({
        "output_type": "error",
        "ename": error.get("ename").and_then(Value::as_str).unwrap_or("BokehSessionError"),
        "evalue": error.get("evalue").and_then(Value::as_str).unwrap_or("Bokeh session callback failed"),
        "traceback": error.get("traceback").and_then(Value::as_array).cloned().unwrap_or_default(),
    })
}

pub(crate) fn kernel_error_text(error: Option<&Value>) -> String {
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

pub(crate) fn required_str<'a>(value: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Bokeh message is missing string {key}"))
}

fn optional_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn hex_sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::protocol::BokehSessionBuffer;

    #[test]
    fn patch_request_wire_keeps_buffer_identity_and_drops_revisions() {
        let request = BokehSessionPatchRequest {
            session_id: "session-1".to_string(),
            transaction_id: "tx-1".to_string(),
            patch: json!({"events": [{"kind": "MessageSent", "msg_type": "bokeh_event"}]}),
            buffers: vec![BokehSessionBuffer {
                id: "buffer-1".to_string(),
                data: vec![1, 2, 3],
            }],
            buffer_refs: Vec::new(),
        };
        let (content, buffers) = patch_request_wire(&request);
        assert_eq!(content["buffers"][0]["id"], "buffer-1");
        assert_eq!(content["buffers"][0]["buffer_index"], 0);
        assert_eq!(content["buffers"][0]["hash"], hex_sha256(&[1, 2, 3]));
        assert!(content.get("base_revision").is_none());
        assert_eq!(buffers[0].as_ref(), &[1, 2, 3]);
    }

    #[test]
    fn patch_reply_maps_status_and_callback_output() {
        let response = parse_patch_reply(RawBokehKernelMessage {
            msg_type: BOKEH_PATCH_REPLY.to_string(),
            content: json!({
                "status": "error", "session_id": "session-1", "transaction_id": "tx-1",
                "stdout": "out", "stderr": "",
                "error": {"ename": "ValueError", "evalue": "bad", "traceback": ["tb"]},
            }),
            buffers: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            response.reply,
            BokehSessionPatchReply::Error {
                session_id: "session-1".to_string(),
                transaction_id: "tx-1".to_string(),
                error: "ValueError: bad".to_string(),
            }
        );
        assert_eq!(response.stdout, "out");
        assert_eq!(response.error_output.unwrap()["ename"], "ValueError");
    }

    #[test]
    fn stored_output_drops_ingested_session_doc_but_keeps_document() {
        let output = json!({
            "output_type": "display_data",
            "data": {BOKEH_SESSION_MIME: {
                "session_id": "s", "document": {"roots": []},
                "session_doc": {"models": {}}, "session_doc_buffers": [],
            }},
        });
        let stripped = strip_ingested_session_doc(&output).unwrap();
        let payload = &stripped["data"][BOKEH_SESSION_MIME];
        assert!(payload.get("session_doc").is_none());
        assert!(payload.get("session_doc_buffers").is_none());
        assert_eq!(payload["document"], json!({"roots": []}));
        assert!(strip_ingested_session_doc(&stripped).is_none());
    }
}
