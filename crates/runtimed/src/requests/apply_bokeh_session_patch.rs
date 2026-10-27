//! `NotebookRequest::ApplyBokehSessionPatch` and `GetBokehSessionData`
//! handlers.

use std::collections::HashSet;

use notebook_protocol::protocol::{
    BokehSessionBuffer, BokehSessionPatchReply, BokehSessionPatchRequest, RuntimeAgentRequest,
    RuntimeAgentResponse,
};
use runtime_doc::BokehSessionStatus;

use crate::blob_store::BlobStore;
use crate::notebook_sync_server::{send_runtime_agent_request, NotebookRoom};
use crate::protocol::NotebookResponse;

const MAX_BOKEH_PATCH_BUFFERS: usize = 256;
const MAX_BOKEH_PATCH_BUFFER_BYTES: usize = 100 * 1024 * 1024;

/// Event kinds a peer may send. Property changes travel through the session
/// document; anything else would bypass its ingress rules.
const ONE_OFF_EVENT_KINDS: &[&str] = &["MessageSent", "ColumnsStreamed", "ColumnsPatched"];

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
        return patch_error(&request, "unknown Bokeh session");
    };
    if session.status != BokehSessionStatus::Connected {
        return patch_error(&request, "Bokeh session is disconnected");
    }
    if request.transaction_id.is_empty() || !request.patch.is_object() {
        return patch_error(
            &request,
            "Bokeh patch requires a transaction id and object payload",
        );
    }
    if let Err(error) = validate_one_off_events(&request.patch) {
        return patch_error(&request, &error);
    }
    if let Err(error) = resolve_buffer_refs(&mut request, &room.blob_store).await {
        return patch_error(&request, &error);
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

/// `NotebookRequest::GetBokehSessionData`: the late-joiner data tail, which
/// lives with the runtime agent's session documents. Only writer
/// connections (`request_folds`) may make the kernel fold, so viewers cannot
/// queue kernel work.
pub(crate) async fn handle_get_data(
    room: &NotebookRoom,
    session_id: String,
    source_ids: Option<Vec<String>>,
    request_folds: bool,
) -> NotebookResponse {
    let record = room
        .state
        .read(|state_doc| state_doc.get_bokeh_session(&session_id))
        .ok()
        .flatten();
    let known = record
        .as_ref()
        .is_some_and(|session| session.status == BokehSessionStatus::Connected);
    if !known || room.runtime_agent_request_tx.lock().await.is_none() {
        // No kernel, no tail: a frozen session's columns/ refs are final.
        return NotebookResponse::BokehSessionData {
            data: notebook_protocol::protocol::BokehSessionDataTail {
                epoch: record.map(|session| session.epoch).unwrap_or_default(),
                session_id,
                ..Default::default()
            },
        };
    }
    match send_runtime_agent_request(
        room,
        RuntimeAgentRequest::GetBokehSessionData {
            session_id,
            source_ids,
            request_folds,
        },
    )
    .await
    {
        Ok(RuntimeAgentResponse::BokehSessionData { data }) => {
            NotebookResponse::BokehSessionData { data }
        }
        Ok(RuntimeAgentResponse::Error { error }) => NotebookResponse::Error { error },
        Ok(_) => NotebookResponse::Error {
            error: "Unexpected runtime agent response to Bokeh data request".to_string(),
        },
        Err(error) => NotebookResponse::Error {
            error: format!("Agent Bokeh data error: {error}"),
        },
    }
}

fn validate_one_off_events(patch: &serde_json::Value) -> Result<(), String> {
    let events = patch
        .get("events")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Bokeh patch requires an events list".to_string())?;
    for event in events {
        let kind = event
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !ONE_OFF_EVENT_KINDS.contains(&kind) {
            return Err(format!(
                "Bokeh {kind:?} events go through the session document, not patch requests"
            ));
        }
    }
    Ok(())
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

fn patch_error(request: &BokehSessionPatchRequest, error: &str) -> NotebookResponse {
    NotebookResponse::BokehSessionPatch {
        reply: BokehSessionPatchReply::Error {
            session_id: request.session_id.clone(),
            transaction_id: request.transaction_id.clone(),
            error: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::notebook_sync_server::RuntimeAgentMessage;
    use runtime_doc::BokehSessionState;

    fn request() -> BokehSessionPatchRequest {
        BokehSessionPatchRequest {
            session_id: "session-1".to_string(),
            transaction_id: "tx-1".to_string(),
            patch: serde_json::json!({"events": [{
                "kind": "MessageSent", "msg_type": "bokeh_event",
                "msg_data": {"type": "event", "name": "button_click", "values": {"model": {"id": "p1001"}}},
            }]}),
            buffers: Vec::new(),
            buffer_refs: Vec::new(),
        }
    }

    fn test_room() -> (tempfile::TempDir, NotebookRoom) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        );
        room.state
            .with_doc(|doc| {
                doc.put_bokeh_session(
                    "session-1",
                    &BokehSessionState {
                        output_id: "output-1".to_string(),
                        cell_id: "cell-1".to_string(),
                        execution_id: "exec-1".to_string(),
                        kernel_id: "kernel-1".to_string(),
                        status: BokehSessionStatus::Connected,
                        producer_name: "panel".to_string(),
                        producer_version: "1.9.4".to_string(),
                        bokeh_version: "3.9.1".to_string(),
                        root_ids: vec!["p1001".to_string()],
                        epoch: 0,
                        doc_heads: vec!["a".repeat(64)],
                        previous_heads: Vec::new(),
                    },
                )
            })
            .expect("session");
        (tmp, room)
    }

    fn session(room: &NotebookRoom) -> BokehSessionState {
        room.state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read session")
            .expect("session exists")
    }

    #[tokio::test]
    async fn one_off_events_reach_the_runtime_unchanged() {
        let (_tmp, room) = test_room();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        let mut request = request();
        request.buffers.push(BokehSessionBuffer {
            id: "buffer-1".to_string(),
            data: vec![1, 2, 3],
        });
        let reply = BokehSessionPatchReply::Accepted {
            session_id: request.session_id.clone(),
            transaction_id: request.transaction_id.clone(),
        };
        let runtime = async {
            let message = rx.recv().await.expect("forwarded request");
            let RuntimeAgentMessage::Query(envelope, reply_tx) = message else {
                panic!("patch must wait for a runtime reply");
            };
            let RuntimeAgentRequest::ApplyBokehSessionPatch { request: forwarded } =
                envelope.request
            else {
                panic!("expected Bokeh patch request");
            };
            assert_eq!(*forwarded, request);
            reply_tx
                .send(RuntimeAgentResponse::BokehSessionPatch {
                    reply: reply.clone(),
                })
                .expect("send runtime reply");
        };
        let (response, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(handle(&room, request.clone()), runtime)
        })
        .await
        .expect("handler forwards");
        let NotebookResponse::BokehSessionPatch { reply: actual } = response else {
            panic!("expected Bokeh patch response");
        };
        assert_eq!(actual, reply);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn patch_requires_connected_session_one_off_events_and_valid_payload() {
        for case in [
            "unknown",
            "disconnected",
            "closed",
            "transaction",
            "payload",
            "model_changed",
            "buffers",
        ] {
            let (_tmp, room) = test_room();
            let (tx, mut rx) = tokio::sync::mpsc::channel(1);
            *room.runtime_agent_request_tx.lock().await = Some(tx);
            let mut request = request();
            let mut state = session(&room);
            let expected = match case {
                "unknown" => {
                    request.session_id = "missing".to_string();
                    "unknown Bokeh session"
                }
                "disconnected" | "closed" => {
                    state.status = if case == "closed" {
                        BokehSessionStatus::Closed
                    } else {
                        BokehSessionStatus::Disconnected
                    };
                    "disconnected"
                }
                "transaction" => {
                    request.transaction_id.clear();
                    "transaction id"
                }
                "payload" => {
                    request.patch = serde_json::Value::Null;
                    "object payload"
                }
                "model_changed" => {
                    request.patch = serde_json::json!({"events": [{
                        "kind": "ModelChanged", "model": {"id": "p1001"}, "attr": "value", "new": 1,
                    }]});
                    "session document"
                }
                "buffers" => {
                    request.buffers = vec![
                        BokehSessionBuffer {
                            id: "duplicate".to_string(),
                            data: vec![1],
                        };
                        2
                    ];
                    "duplicate inline"
                }
                _ => unreachable!(),
            };
            room.state
                .with_doc(|doc| doc.put_bokeh_session("session-1", &state))
                .unwrap();

            let response = handle(&room, request.clone()).await;

            let NotebookResponse::BokehSessionPatch {
                reply:
                    BokehSessionPatchReply::Error {
                        session_id,
                        transaction_id,
                        error,
                    },
            } = response
            else {
                panic!("{case}: expected Bokeh patch error, got {response:?}");
            };
            assert_eq!(session_id, request.session_id, "{case}");
            assert_eq!(transaction_id, request.transaction_id, "{case}");
            assert!(error.contains(expected), "{case}: {error}");
            assert!(
                rx.try_recv().is_err(),
                "{case}: rejected patch was forwarded"
            );
        }
    }

    #[tokio::test]
    async fn patch_without_runtime_returns_no_kernel() {
        let (_tmp, room) = test_room();
        assert!(matches!(
            handle(&room, request()).await,
            NotebookResponse::NoKernel {}
        ));
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
