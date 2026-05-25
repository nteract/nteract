//! `NotebookRequest::SendComm` handler.

use crate::blob_store::BlobStore;
use crate::notebook_sync_server::{send_runtime_agent_request, NotebookRoom};
use crate::protocol::NotebookResponse;
use notebook_protocol::protocol::CommRequestMessage;

const MAX_SEND_COMM_BUFFERS: usize = 1024;
const MAX_SEND_COMM_BUFFER_BYTES: usize = 256 * 1024 * 1024;

pub(crate) async fn handle(
    room: &NotebookRoom,
    message: Box<CommRequestMessage>,
) -> NotebookResponse {
    // Agent path: forward comm message via RPC
    let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
    if has_runtime_agent {
        let mut message = *message;
        if let Err(e) = resolve_comm_buffer_refs(&mut message, &room.blob_store).await {
            return NotebookResponse::Error {
                error: format!("Comm buffer ref error: {e}"),
            };
        }

        match send_runtime_agent_request(
            room,
            notebook_protocol::protocol::RuntimeAgentRequest::SendComm {
                message: Box::new(message),
            },
        )
        .await
        {
            Ok(_) => NotebookResponse::Ok {},
            Err(e) => NotebookResponse::Error {
                error: format!("Agent comm error: {}", e),
            },
        }
    } else {
        NotebookResponse::NoKernel {}
    }
}

pub(crate) async fn resolve_comm_buffer_refs(
    message: &mut CommRequestMessage,
    blob_store: &BlobStore,
) -> Result<(), String> {
    if message.buffer_refs.is_empty() {
        return Ok(());
    }
    if message.buffers.len() > MAX_SEND_COMM_BUFFERS {
        return Err(format!(
            "inline buffer count {} exceeds maximum {MAX_SEND_COMM_BUFFERS}",
            message.buffers.len()
        ));
    }
    if message.buffer_refs.len() > MAX_SEND_COMM_BUFFERS {
        return Err(format!(
            "buffer ref count {} exceeds maximum {MAX_SEND_COMM_BUFFERS}",
            message.buffer_refs.len()
        ));
    }
    let inline_buffer_bytes = message
        .buffers
        .iter()
        .try_fold(0usize, |total, buffer| total.checked_add(buffer.len()))
        .ok_or_else(|| "inline buffer byte count overflowed".to_string())?;
    let ref_buffer_bytes = message
        .buffer_refs
        .iter()
        .try_fold(0usize, |total, buffer_ref| {
            total.checked_add(buffer_ref.size)
        })
        .ok_or_else(|| "buffer ref byte count overflowed".to_string())?;
    let aggregate_buffer_bytes = inline_buffer_bytes
        .checked_add(ref_buffer_bytes)
        .ok_or_else(|| "aggregate comm buffer byte count overflowed".to_string())?;
    if aggregate_buffer_bytes > MAX_SEND_COMM_BUFFER_BYTES {
        return Err(format!(
            "comm buffer bytes {aggregate_buffer_bytes} exceed maximum {MAX_SEND_COMM_BUFFER_BYTES}"
        ));
    }

    let max_ref_index = message
        .buffer_refs
        .iter()
        .map(|buffer_ref| buffer_ref.index)
        .max()
        .unwrap_or(0);
    if max_ref_index >= MAX_SEND_COMM_BUFFERS {
        return Err(format!(
            "buffer ref index {max_ref_index} exceeds maximum {}",
            MAX_SEND_COMM_BUFFERS - 1
        ));
    }
    let ref_buffer_len = max_ref_index
        .checked_add(1)
        .ok_or_else(|| format!("buffer ref index {max_ref_index} overflows buffer count"))?;
    let mut ordered_buffers = vec![None; std::cmp::max(message.buffers.len(), ref_buffer_len)];

    for (index, buffer) in std::mem::take(&mut message.buffers).into_iter().enumerate() {
        ordered_buffers[index] = Some(buffer);
    }

    for buffer_ref in &message.buffer_refs {
        if ordered_buffers[buffer_ref.index].is_some() {
            return Err(format!(
                "buffer index {} was provided both inline and by blob ref",
                buffer_ref.index
            ));
        }

        let meta = blob_store
            .get_meta(&buffer_ref.blob)
            .await
            .map_err(|e| format!("failed to read blob {}: {e}", buffer_ref.blob))?
            .ok_or_else(|| format!("missing blob {}", buffer_ref.blob))?;
        let actual_size: usize = meta
            .size
            .try_into()
            .map_err(|_| format!("blob {} size exceeds platform usize", buffer_ref.blob))?;
        if actual_size != buffer_ref.size {
            return Err(format!(
                "blob {} size mismatch: expected {}, got {}",
                buffer_ref.blob, buffer_ref.size, actual_size
            ));
        }

        let bytes = blob_store
            .get(&buffer_ref.blob)
            .await
            .map_err(|e| format!("failed to read blob {}: {e}", buffer_ref.blob))?
            .ok_or_else(|| format!("missing blob {}", buffer_ref.blob))?;

        if bytes.len() != buffer_ref.size {
            return Err(format!(
                "blob {} size mismatch: expected {}, got {}",
                buffer_ref.blob,
                buffer_ref.size,
                bytes.len()
            ));
        }

        ordered_buffers[buffer_ref.index] = Some(bytes);
    }

    let mut buffers = Vec::with_capacity(ordered_buffers.len());
    for (index, buffer) in ordered_buffers.into_iter().enumerate() {
        let buffer = buffer.ok_or_else(|| format!("missing buffer index {index}"))?;
        buffers.push(buffer);
    }

    message.buffers = buffers;
    message.buffer_refs.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{resolve_comm_buffer_refs, MAX_SEND_COMM_BUFFERS, MAX_SEND_COMM_BUFFER_BYTES};
    use crate::blob_store::BlobStore;
    use notebook_protocol::protocol::{BlobDurability, CommBufferRef, CommRequestMessage};

    fn comm_with_refs(buffer_refs: Vec<CommBufferRef>) -> CommRequestMessage {
        CommRequestMessage {
            header: serde_json::json!({"msg_type": "comm_msg"}),
            parent_header: None,
            metadata: serde_json::json!({}),
            content: serde_json::json!({}),
            buffers: Vec::new(),
            buffer_refs,
            channel: "shell".to_string(),
        }
    }

    #[tokio::test]
    async fn send_comm_buffer_refs_restore_kernel_buffer_order() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let first = blob_store
            .put_with_durability(
                b"first",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .expect("store first");
        let second = blob_store
            .put_with_durability(
                b"second",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .expect("store second");
        let mut message = comm_with_refs(vec![
            CommBufferRef {
                index: 1,
                blob: second,
                size: 6,
                media_type: Some("application/octet-stream".to_string()),
            },
            CommBufferRef {
                index: 0,
                blob: first,
                size: 5,
                media_type: Some("application/octet-stream".to_string()),
            },
        ]);

        resolve_comm_buffer_refs(&mut message, &blob_store)
            .await
            .expect("resolve refs");

        assert_eq!(message.buffers, vec![b"first".to_vec(), b"second".to_vec()]);
        assert!(message.buffer_refs.is_empty());
    }

    #[tokio::test]
    async fn send_comm_buffer_refs_reject_missing_blob() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let mut message = comm_with_refs(vec![CommBufferRef {
            index: 0,
            blob: "0".repeat(64),
            size: 5,
            media_type: None,
        }]);

        let err = resolve_comm_buffer_refs(&mut message, &blob_store)
            .await
            .expect_err("missing blob should fail");

        assert!(err.contains("missing blob"));
    }

    #[tokio::test]
    async fn send_comm_buffer_refs_reject_size_mismatch() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let blob = blob_store
            .put_with_durability(
                b"short",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .expect("store blob");
        let mut message = comm_with_refs(vec![CommBufferRef {
            index: 0,
            blob,
            size: 99,
            media_type: None,
        }]);

        let err = resolve_comm_buffer_refs(&mut message, &blob_store)
            .await
            .expect_err("size mismatch should fail");

        assert!(err.contains("size mismatch"));
    }

    #[tokio::test]
    async fn send_comm_buffer_refs_reject_oversized_index_before_allocation() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let mut message = comm_with_refs(vec![CommBufferRef {
            index: usize::MAX,
            blob: "0".repeat(64),
            size: 5,
            media_type: None,
        }]);

        let err = resolve_comm_buffer_refs(&mut message, &blob_store)
            .await
            .expect_err("oversized index should fail");

        assert!(err.contains("exceeds maximum"));
    }

    #[tokio::test]
    async fn send_comm_buffer_refs_reject_too_many_inline_buffers() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let blob = blob_store
            .put_with_durability(
                b"last",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .expect("store blob");
        let mut message = comm_with_refs(vec![CommBufferRef {
            index: MAX_SEND_COMM_BUFFERS,
            blob,
            size: 4,
            media_type: None,
        }]);
        message.buffers = vec![Vec::new(); MAX_SEND_COMM_BUFFERS + 1];

        let err = resolve_comm_buffer_refs(&mut message, &blob_store)
            .await
            .expect_err("too many inline buffers should fail");

        assert!(err.contains("inline buffer count"));
    }

    #[tokio::test]
    async fn send_comm_buffer_refs_reject_aggregate_bytes_before_blob_read() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let mut message = comm_with_refs(vec![CommBufferRef {
            index: 0,
            blob: "0".repeat(64),
            size: MAX_SEND_COMM_BUFFER_BYTES + 1,
            media_type: None,
        }]);

        let err = resolve_comm_buffer_refs(&mut message, &blob_store)
            .await
            .expect_err("oversized aggregate buffer bytes should fail");

        assert!(err.contains("comm buffer bytes"));
    }
}
