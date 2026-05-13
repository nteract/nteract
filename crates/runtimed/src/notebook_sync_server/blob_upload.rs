use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use notebook_protocol::connection::NotebookFrameType;
use notebook_protocol::protocol::{
    BlobDurability, BlobUploadErrorKind, NotebookResponse, NotebookResponseEnvelope, PutBlobHeader,
};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::peer_writer::PeerWriter;
use crate::blob_store::BlobStore;

const PUT_BLOB_QUEUE_CAPACITY: usize = 1;

pub(super) struct PutBlobWorker {
    tx: mpsc::Sender<Vec<u8>>,
    in_flight: Arc<AtomicBool>,
    pub(super) handle: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Drop for PutBlobWorker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub(super) fn spawn_put_blob_worker(
    blob_store: Arc<BlobStore>,
    peer_writer: PeerWriter,
    notebook_id: String,
    peer_id: String,
) -> PutBlobWorker {
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(PUT_BLOB_QUEUE_CAPACITY);
    let in_flight = Arc::new(AtomicBool::new(false));
    let worker_in_flight = in_flight.clone();
    let handle = tokio::spawn(async move {
        while let Some(payload) = rx.recv().await {
            debug!(
                "[notebook-sync] Handling PutBlob peer={} notebook={} payload_bytes={}",
                peer_id,
                notebook_id,
                payload.len()
            );
            let result = handle_put_blob_frame(&payload, &blob_store, &peer_writer).await;
            worker_in_flight.store(false, Ordering::Release);
            result?;
        }
        Ok(())
    });
    PutBlobWorker {
        tx,
        in_flight,
        handle,
    }
}

pub(super) fn enqueue_put_blob(
    worker: &PutBlobWorker,
    peer_writer: &PeerWriter,
    payload: Vec<u8>,
    notebook_id: &str,
    peer_id: &str,
) -> anyhow::Result<()> {
    if worker.in_flight.swap(true, Ordering::AcqRel) {
        send_blob_upload_error(
            peer_writer,
            put_blob_request_id(&payload),
            BlobUploadErrorKind::TooManyInFlight,
        )?;
        return Ok(());
    }

    match worker.tx.try_send(payload) {
        Ok(()) => Ok(()),
        Err(mpsc::error::TrySendError::Full(payload)) => {
            worker.in_flight.store(false, Ordering::Release);
            send_blob_upload_error(
                peer_writer,
                put_blob_request_id(&payload),
                BlobUploadErrorKind::TooManyInFlight,
            )
        }
        Err(mpsc::error::TrySendError::Closed(_payload)) => {
            worker.in_flight.store(false, Ordering::Release);
            anyhow::bail!(
                "PutBlob worker stopped for notebook {} peer {}",
                notebook_id,
                peer_id
            )
        }
    }
}

pub(crate) async fn handle_put_blob_frame(
    payload: &[u8],
    blob_store: &Arc<BlobStore>,
    peer_writer: &PeerWriter,
) -> anyhow::Result<()> {
    let (header, body) = match PutBlobHeader::try_parse(payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            send_blob_upload_error(peer_writer, error.id, error.reason)?;
            return Ok(());
        }
    };

    match header {
        PutBlobHeader::Put {
            id,
            media_type,
            size,
            sha256,
            durability,
            purpose,
        } => {
            let durability = durability.unwrap_or(BlobDurability::Durable);
            debug!(
                "[notebook-sync] PutBlob id={} media_type={} size={} durability={:?} purpose={:?}",
                id, media_type, size, durability, purpose
            );
            if body.len() as u64 != size {
                send_blob_upload_error(peer_writer, Some(id), BlobUploadErrorKind::SizeMismatch)?;
                return Ok(());
            }

            let actual_sha256 = hex::encode(Sha256::digest(body));
            if actual_sha256 != sha256 {
                send_blob_upload_error(peer_writer, Some(id), BlobUploadErrorKind::HashMismatch)?;
                return Ok(());
            }

            match blob_store
                .put_with_durability(body, &media_type, durability)
                .await
            {
                Ok(hash) => {
                    send_blob_response(
                        peer_writer,
                        Some(id),
                        NotebookResponse::BlobStored {
                            hash,
                            size,
                            media_type,
                        },
                    )?;
                }
                Err(error) => {
                    warn!("[notebook-sync] PutBlob store failed: {}", error);
                    send_blob_upload_error(
                        peer_writer,
                        Some(id),
                        BlobUploadErrorKind::Io {
                            message: error.to_string(),
                        },
                    )?;
                }
            }
        }
    }

    Ok(())
}

fn send_blob_upload_error(
    peer_writer: &PeerWriter,
    id: Option<String>,
    reason: BlobUploadErrorKind,
) -> anyhow::Result<()> {
    send_blob_response(
        peer_writer,
        id,
        NotebookResponse::BlobUploadError { reason },
    )
}

fn put_blob_request_id(payload: &[u8]) -> Option<String> {
    match PutBlobHeader::try_parse(payload) {
        Ok((header, _body)) => Some(header.id().to_string()),
        Err(error) => error.id,
    }
}

#[cfg(test)]
impl PutBlobWorker {
    fn for_test_busy(tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self {
            tx,
            in_flight: Arc::new(AtomicBool::new(true)),
            handle: tokio::spawn(std::future::pending::<anyhow::Result<()>>()),
        }
    }
}

fn send_blob_response(
    peer_writer: &PeerWriter,
    id: Option<String>,
    response: NotebookResponse,
) -> anyhow::Result<()> {
    peer_writer.send_json(
        NotebookFrameType::Response,
        &NotebookResponseEnvelope { id, response },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::connection;
    use notebook_protocol::protocol::{NotebookResponse, NotebookResponseEnvelope};

    fn payload(id: &str, media_type: &str, size: u64, sha256: &str, body: &[u8]) -> Vec<u8> {
        payload_with_durability(id, media_type, size, sha256, body, None)
    }

    fn payload_with_durability(
        id: &str,
        media_type: &str,
        size: u64,
        sha256: &str,
        body: &[u8],
        durability: Option<BlobDurability>,
    ) -> Vec<u8> {
        let header = serde_json::json!({
            "op": "put",
            "id": id,
            "media_type": media_type,
            "size": size,
            "sha256": sha256,
            "durability": durability,
        });
        let header_bytes = serde_json::to_vec(&header).expect("header serializes");
        let mut payload = Vec::new();
        payload.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
        payload.extend_from_slice(&header_bytes);
        payload.extend_from_slice(body);
        payload
    }

    fn disk_blob_exists(store: &BlobStore, hash: &str) -> bool {
        let shard_dir = store.root().join(&hash[..2]);
        let rest = &hash[2..];
        let blob_path = shard_dir.join(rest);
        let meta_path = shard_dir.join(format!("{rest}.meta"));
        blob_path.exists() && meta_path.exists()
    }

    async fn run_handler(
        payload: &[u8],
    ) -> (
        tempfile::TempDir,
        Arc<BlobStore>,
        NotebookResponseEnvelope,
        super::super::peer_writer::PeerWriterTask,
    ) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());

        handle_put_blob_frame(payload, &blob_store, &peer_writer)
            .await
            .expect("handler succeeds");

        let frame = connection::recv_typed_frame(&mut reader)
            .await
            .expect("frame read succeeds")
            .expect("response frame");
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        let envelope = serde_json::from_slice(&frame.payload).expect("response envelope");

        (tmp, blob_store, envelope, writer_task)
    }

    #[tokio::test]
    async fn put_blob_success_stores_blob_and_replies() {
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-1", "application/octet-stream", 3, &sha256, body);

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-1"));
        match envelope.response {
            NotebookResponse::BlobStored {
                hash,
                size,
                media_type,
            } => {
                assert_eq!(hash, sha256);
                assert_eq!(size, 3);
                assert_eq!(media_type, "application/octet-stream");
                assert_eq!(
                    blob_store.get(&hash).await.unwrap().as_deref(),
                    Some(&body[..])
                );
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn put_blob_ephemeral_success_keeps_blob_out_of_disk_store() {
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload_with_durability(
            "blob-ephemeral",
            "application/octet-stream",
            3,
            &sha256,
            body,
            Some(BlobDurability::Ephemeral),
        );

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-ephemeral"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobStored { ref hash, .. } if hash == &sha256
        ));
        assert_eq!(
            blob_store.get(&sha256).await.unwrap().as_deref(),
            Some(&body[..])
        );
        assert!(!disk_blob_exists(&blob_store, &sha256));
    }

    #[tokio::test]
    async fn put_blob_hash_mismatch_replies_without_storing() {
        let wrong_hash = "0".repeat(64);
        let request_payload = payload("blob-2", "application/octet-stream", 3, &wrong_hash, b"abc");

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-2"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::HashMismatch
            }
        ));
        assert!(blob_store.get(&wrong_hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn put_blob_size_mismatch_replies_without_storing() {
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-3", "application/octet-stream", 4, &sha256, body);

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-3"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::SizeMismatch
            }
        ));
        assert!(blob_store.get(&sha256).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn put_blob_invalid_header_replies_with_parse_error() {
        let mut request_payload = Vec::new();
        request_payload.extend_from_slice(&64_u32.to_be_bytes());
        request_payload.extend_from_slice(b"{\"op\":\"put\"");

        let (_tmp, _blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id, None);
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::InvalidHeader
            }
        ));
    }

    #[tokio::test]
    async fn put_blob_repeat_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, _writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-repeat", "text/plain", 3, &sha256, body);

        handle_put_blob_frame(&request_payload, &blob_store, &peer_writer)
            .await
            .unwrap();
        handle_put_blob_frame(&request_payload, &blob_store, &peer_writer)
            .await
            .unwrap();

        for _ in 0..2 {
            let frame = connection::recv_typed_frame(&mut reader)
                .await
                .unwrap()
                .unwrap();
            let envelope: NotebookResponseEnvelope =
                serde_json::from_slice(&frame.payload).unwrap();
            assert_eq!(envelope.id.as_deref(), Some("blob-repeat"));
            assert!(matches!(
                envelope.response,
                NotebookResponse::BlobStored { ref hash, .. } if hash == &sha256
            ));
        }
        assert_eq!(
            blob_store.get(&sha256).await.unwrap().as_deref(),
            Some(&body[..])
        );
    }

    #[tokio::test]
    async fn put_blob_concurrent_two_peers_store_and_reply_independently() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let body_a = b"peer-a";
        let hash_a = hex::encode(Sha256::digest(body_a));
        let payload_a = payload("blob-a", "text/plain", body_a.len() as u64, &hash_a, body_a);
        let body_b = b"peer-b";
        let hash_b = hex::encode(Sha256::digest(body_b));
        let payload_b = payload("blob-b", "text/plain", body_b.len() as u64, &hash_b, body_b);

        let (mut reader_a, writer_a) = tokio::io::duplex(1024 * 1024);
        let (peer_writer_a, _task_a) =
            super::super::peer_writer::spawn_peer_writer(writer_a, "notebook".into(), "a".into());
        let (mut reader_b, writer_b) = tokio::io::duplex(1024 * 1024);
        let (peer_writer_b, _task_b) =
            super::super::peer_writer::spawn_peer_writer(writer_b, "notebook".into(), "b".into());

        let (result_a, result_b) = tokio::join!(
            handle_put_blob_frame(&payload_a, &blob_store, &peer_writer_a),
            handle_put_blob_frame(&payload_b, &blob_store, &peer_writer_b)
        );
        result_a.unwrap();
        result_b.unwrap();

        let frame_a = connection::recv_typed_frame(&mut reader_a)
            .await
            .unwrap()
            .unwrap();
        let envelope_a: NotebookResponseEnvelope =
            serde_json::from_slice(&frame_a.payload).unwrap();
        let frame_b = connection::recv_typed_frame(&mut reader_b)
            .await
            .unwrap()
            .unwrap();
        let envelope_b: NotebookResponseEnvelope =
            serde_json::from_slice(&frame_b.payload).unwrap();

        assert_eq!(envelope_a.id.as_deref(), Some("blob-a"));
        assert!(matches!(
            envelope_a.response,
            NotebookResponse::BlobStored { ref hash, .. } if hash == &hash_a
        ));
        assert_eq!(envelope_b.id.as_deref(), Some("blob-b"));
        assert!(matches!(
            envelope_b.response,
            NotebookResponse::BlobStored { ref hash, .. } if hash == &hash_b
        ));
        assert_eq!(
            blob_store.get(&hash_a).await.unwrap().as_deref(),
            Some(&body_a[..])
        );
        assert_eq!(
            blob_store.get(&hash_b).await.unwrap().as_deref(),
            Some(&body_b[..])
        );
    }

    #[tokio::test]
    async fn put_blob_busy_worker_replies_without_blocking_peer_loop() {
        let (worker_tx, _worker_rx) = mpsc::channel(PUT_BLOB_QUEUE_CAPACITY);
        let worker = PutBlobWorker::for_test_busy(worker_tx);
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, _writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-busy", "text/plain", body.len() as u64, &sha256, body);

        let start = std::time::Instant::now();
        enqueue_put_blob(&worker, &peer_writer, request_payload, "notebook", "peer")
            .expect("busy worker should report a structured response");
        assert!(
            start.elapsed() < std::time::Duration::from_millis(50),
            "busy worker should not block the peer loop"
        );

        let frame = connection::recv_typed_frame(&mut reader)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        let envelope: NotebookResponseEnvelope = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(envelope.id.as_deref(), Some("blob-busy"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::TooManyInFlight
            }
        ));
    }
}
