//! `NotebookRequest::ApplyBokehSessionPatch` handler.

use std::collections::HashSet;

use notebook_protocol::protocol::{
    BokehSessionBuffer, BokehSessionPatchReply, BokehSessionPatchRequest, RuntimeAgentRequest,
    RuntimeAgentResponse,
};
use runtime_doc::BokehSessionStatus;

use crate::blob_store::BlobStore;
use crate::bokeh_session::BOKEH_PATCH_TAIL_HARD_LIMIT;
use crate::notebook_sync_server::{send_runtime_agent_request, NotebookRoom};
use crate::protocol::NotebookResponse;

const MAX_BOKEH_PATCH_BUFFERS: usize = 256;
const MAX_BOKEH_PATCH_BUFFER_BYTES: usize = 100 * 1024 * 1024;

pub(crate) async fn handle(
    room: &NotebookRoom,
    mut request: BokehSessionPatchRequest,
) -> NotebookResponse {
    let Some(session) = room
        .state
        .read(|state_doc| state_doc.get_bokeh_session(&request.session_id))
        .ok()
        .flatten()
    else {
        return patch_error(&request, None, "unknown Bokeh session");
    };
    if session.status != BokehSessionStatus::Connected {
        return patch_error(
            &request,
            Some(session.head_revision),
            "Bokeh session is disconnected",
        );
    }
    if request.base_revision != session.head_revision {
        return NotebookResponse::BokehSessionPatch {
            reply: BokehSessionPatchReply::Stale {
                session_id: request.session_id,
                transaction_id: request.transaction_id,
                revision: session.head_revision,
            },
        };
    }
    if session.patch_tail.len() >= BOKEH_PATCH_TAIL_HARD_LIMIT {
        return patch_error(
            &request,
            Some(session.head_revision),
            "Bokeh session is checkpointing; retry after state resynchronizes",
        );
    }
    if request.transaction_id.is_empty() || !request.patch.is_object() {
        return patch_error(
            &request,
            Some(session.head_revision),
            "Bokeh patch requires a transaction id and object payload",
        );
    }
    if let Err(error) = resolve_buffer_refs(&mut request, &room.blob_store).await {
        return patch_error(&request, Some(session.head_revision), &error);
    }

    let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
    if !has_runtime_agent {
        return NotebookResponse::NoKernel {};
    }
    match send_runtime_agent_request(
        room,
        RuntimeAgentRequest::ApplyBokehSessionPatch {
            request: Box::new(request),
        },
    )
    .await
    {
        Ok(RuntimeAgentResponse::BokehSessionPatch { reply }) => {
            NotebookResponse::BokehSessionPatch { reply }
        }
        Ok(RuntimeAgentResponse::Error { error }) => NotebookResponse::Error { error },
        Ok(_) => NotebookResponse::Error {
            error: "Unexpected runtime agent response to Bokeh patch".to_string(),
        },
        Err(error) => NotebookResponse::Error {
            error: format!("Agent Bokeh patch error: {error}"),
        },
    }
}

async fn resolve_buffer_refs(
    request: &mut BokehSessionPatchRequest,
    blob_store: &BlobStore,
) -> Result<(), String> {
    if request.buffers.len() + request.buffer_refs.len() > MAX_BOKEH_PATCH_BUFFERS {
        return Err(format!(
            "Bokeh patch buffer count exceeds maximum {MAX_BOKEH_PATCH_BUFFERS}"
        ));
    }
    let mut ids = request
        .buffers
        .iter()
        .map(|buffer| buffer.id.clone())
        .collect::<HashSet<_>>();
    if ids.len() != request.buffers.len() {
        return Err("duplicate inline Bokeh buffer id".to_string());
    }
    let mut total_bytes = request
        .buffers
        .iter()
        .try_fold(0usize, |total, buffer| total.checked_add(buffer.data.len()));
    for buffer_ref in std::mem::take(&mut request.buffer_refs) {
        if !ids.insert(buffer_ref.id.clone()) {
            return Err(format!("duplicate Bokeh buffer id {}", buffer_ref.id));
        }
        let ref_size = usize::try_from(buffer_ref.size)
            .map_err(|_| format!("Bokeh buffer {} size exceeds platform usize", buffer_ref.id))?;
        total_bytes = total_bytes.and_then(|total| total.checked_add(ref_size));
        let projected_total =
            total_bytes.ok_or_else(|| "Bokeh patch buffer size overflow".to_string())?;
        if projected_total > MAX_BOKEH_PATCH_BUFFER_BYTES {
            return Err(format!(
                "Bokeh patch buffers exceed maximum {MAX_BOKEH_PATCH_BUFFER_BYTES} bytes"
            ));
        }
        let metadata = blob_store
            .get_meta(&buffer_ref.blob)
            .await
            .map_err(|error| {
                format!(
                    "failed to read Bokeh buffer {} metadata: {error}",
                    buffer_ref.id
                )
            })?
            .ok_or_else(|| format!("Bokeh buffer blob {} was not found", buffer_ref.blob))?;
        if metadata.size != buffer_ref.size {
            return Err(format!(
                "Bokeh buffer {} size mismatch: expected {}, got {}",
                buffer_ref.id, buffer_ref.size, metadata.size
            ));
        }
        let data = blob_store
            .get(&buffer_ref.blob)
            .await
            .map_err(|error| format!("failed to read Bokeh buffer {}: {error}", buffer_ref.id))?
            .ok_or_else(|| format!("Bokeh buffer blob {} was not found", buffer_ref.blob))?;
        if data.len() as u64 != buffer_ref.size {
            return Err(format!(
                "Bokeh buffer {} size mismatch: expected {}, got {}",
                buffer_ref.id,
                buffer_ref.size,
                data.len()
            ));
        }
        request.buffers.push(BokehSessionBuffer {
            id: buffer_ref.id,
            data: data.to_vec(),
        });
    }
    let total_bytes = total_bytes.ok_or_else(|| "Bokeh patch buffer size overflow".to_string())?;
    if total_bytes > MAX_BOKEH_PATCH_BUFFER_BYTES {
        return Err(format!(
            "Bokeh patch buffers exceed maximum {MAX_BOKEH_PATCH_BUFFER_BYTES} bytes"
        ));
    }
    Ok(())
}

fn patch_error(
    request: &BokehSessionPatchRequest,
    revision: Option<u64>,
    error: &str,
) -> NotebookResponse {
    NotebookResponse::BokehSessionPatch {
        reply: BokehSessionPatchReply::Error {
            session_id: request.session_id.clone(),
            transaction_id: request.transaction_id.clone(),
            revision,
            error: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> BokehSessionPatchRequest {
        BokehSessionPatchRequest {
            session_id: "session-1".to_string(),
            transaction_id: "tx-1".to_string(),
            base_revision: 0,
            patch: serde_json::json!({"events": []}),
            buffers: Vec::new(),
            buffer_refs: Vec::new(),
        }
    }

    #[tokio::test]
    async fn buffer_refs_resolve_by_bokeh_id() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let blob = blob_store
            .put(b"large-buffer", "application/octet-stream")
            .await
            .expect("store blob");
        let mut request = request();
        request.buffers.push(BokehSessionBuffer {
            id: "inline".to_string(),
            data: vec![1, 2, 3],
        });
        request
            .buffer_refs
            .push(notebook_protocol::protocol::BokehSessionBufferRef {
                id: "blob-backed".to_string(),
                blob,
                size: 12,
                media_type: "application/octet-stream".to_string(),
            });

        resolve_buffer_refs(&mut request, &blob_store)
            .await
            .expect("resolve buffers");

        assert!(request.buffer_refs.is_empty());
        assert_eq!(request.buffers.len(), 2);
        assert_eq!(request.buffers[0].id, "inline");
        assert_eq!(request.buffers[1].id, "blob-backed");
        assert_eq!(request.buffers[1].data, b"large-buffer");
    }

    #[tokio::test]
    async fn buffer_refs_reject_duplicate_inline_ids() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let mut request = request();
        request.buffers = vec![
            BokehSessionBuffer {
                id: "same".to_string(),
                data: vec![1],
            },
            BokehSessionBuffer {
                id: "same".to_string(),
                data: vec![2],
            },
        ];

        let error = resolve_buffer_refs(&mut request, &blob_store)
            .await
            .expect_err("duplicate ids must fail");

        assert!(error.contains("duplicate inline"));
    }

    #[tokio::test]
    async fn buffer_refs_reject_advertised_oversize_before_blob_read() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let mut request = request();
        request
            .buffer_refs
            .push(notebook_protocol::protocol::BokehSessionBufferRef {
                id: "oversized".to_string(),
                blob: "missing".to_string(),
                size: (MAX_BOKEH_PATCH_BUFFER_BYTES + 1) as u64,
                media_type: "application/octet-stream".to_string(),
            });

        let error = resolve_buffer_refs(&mut request, &blob_store)
            .await
            .expect_err("oversized buffer must fail");

        assert!(error.contains("exceed maximum"));
    }

    #[tokio::test]
    async fn buffer_refs_reject_underreported_size_before_blob_read() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("blobs");
        let blob_store = BlobStore::with_ephemeral_cap(root.clone(), 0);
        let blob = blob_store
            .put(b"larger-than-advertised", "application/octet-stream")
            .await
            .expect("store blob");
        tokio::fs::remove_file(root.join(&blob[..2]).join(&blob[2..]))
            .await
            .expect("remove blob bytes while retaining metadata");
        let mut request = request();
        request
            .buffer_refs
            .push(notebook_protocol::protocol::BokehSessionBufferRef {
                id: "underreported".to_string(),
                blob,
                size: 1,
                media_type: "application/octet-stream".to_string(),
            });

        let error = resolve_buffer_refs(&mut request, &blob_store)
            .await
            .expect_err("underreported buffer must fail before reading its bytes");

        assert!(error.contains("size mismatch"));
        assert!(error.contains("got 22"));
    }
}
