//! Relay task — transparent byte pipe between frontend (WASM) and daemon.
//!
//! Unlike the sync task, the relay does not maintain a local Automerge document.
//! It does not participate in the Automerge sync protocol — the frontend owns
//! sync state and the relay forwards bytes in both directions, plus a native
//! presence heartbeat so host liveness does not depend on WebKit timers.
//!
//! ## Select loop
//!
//! Three arms:
//! 1. **Commands** from `RelayHandle` — send requests, forward frames
//! 2. **Incoming daemon frames** — route via pending map or pipe to frontend
//! 3. **Heartbeat** — send a native presence heartbeat to keep live desktop
//!    relay sockets from being mistaken for orphaned browser peers
//!
//! ## Request/response correlation
//!
//! Requests carry a correlation id (see `NotebookRequestEnvelope`). When a
//! Rust-side caller issues `SendRequest`, the relay:
//! 1. Generates a uuid id.
//! 2. Registers a `PendingEntry { reply, broadcast_tx }` in the pending map.
//! 3. Writes the `0x01` request envelope (with id) to the daemon socket.
//!
//! When a `0x02` response arrives on the socket, the relay parses the
//! envelope and looks up the id in the pending map. If a Rust caller
//! registered, the response is delivered via their oneshot. If the id is
//! unknown, the raw frame is piped to the frontend — a frontend-originated
//! request was waiting for it. This lets Rust and JS share the socket for
//! request/response without per-type Tauri commands.
//!
//! JS-originated requests arrive via `RelayCommand::ForwardFrame` with
//! frame type `0x01`; the relay forwards them unchanged and never looks at
//! the id. The frontend maintains its own pending map and matches responses
//! via the host transport's inbound frame stream.

use std::collections::HashMap;
use std::time::Duration;

use log::{debug, info, warn};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};

use notebook_protocol::connection::{self, NotebookFrameType};
use notebook_protocol::protocol::{
    NotebookBroadcast, NotebookRequest, NotebookRequestEnvelope, NotebookResponse,
    NotebookResponseEnvelope,
};

use crate::error::SyncError;
use crate::relay::RelayCommand;

/// Native heartbeat for relay clients (desktop/Tauri) so WebKit timer
/// throttling cannot make a live app look idle to the daemon.
const RELAY_HEARTBEAT_INTERVAL: Duration =
    Duration::from_millis(notebook_doc::presence::DEFAULT_HEARTBEAT_MS);

/// Configuration for the relay task.
pub struct RelayTaskConfig {
    /// Receives commands from `RelayHandle` (send_request, forward_frame).
    pub cmd_rx: mpsc::Receiver<RelayCommand>,

    /// Sends piped daemon frames to the frontend (e.g., Tauri webview).
    /// NOT optional — the relay always pipes.
    pub frame_tx: mpsc::UnboundedSender<Vec<u8>>,

    /// The notebook identifier (for logging).
    pub notebook_id: String,

    #[cfg(test)]
    pub heartbeat_interval: Option<Duration>,
}

/// A Rust-side caller awaiting a response for a specific correlation id.
struct PendingEntry {
    reply: oneshot::Sender<Result<NotebookResponse, SyncError>>,
    /// Progress broadcasts to deliver while the request is in flight
    /// (e.g., LaunchKernel env-creation progress). Optional.
    broadcast_tx: Option<tokio::sync::broadcast::Sender<NotebookBroadcast>>,
}

/// Run the relay task.
///
/// Spawned as a background tokio task. Runs until the socket closes or all
/// handles are dropped (command channel closes).
pub async fn run<R, W>(mut config: RelayTaskConfig, reader: R, writer: W)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
{
    let mut writer = tokio::io::BufWriter::new(writer);

    let notebook_id = &config.notebook_id;
    let mut pending: HashMap<String, PendingEntry> = HashMap::new();
    let relay_heartbeat_interval = relay_heartbeat_interval(&config);

    info!("[relay] Started for {}", notebook_id);

    // Hand the read half to a dedicated FramedReader actor so the busy
    // `select!` below stays cancel-safe. `recv_typed_frame`'s internal
    // `read_exact` calls drop bytes when the future is cancelled
    // mid-read — production logs captured this as
    // `frame too large: 1818192238 bytes` (mid-payload text from a
    // streaming kernel output reinterpreted as a length prefix).
    // BufReader stays for syscall coalescing inside the actor task.
    let buffered = tokio::io::BufReader::new(reader);
    let mut framed_reader = connection::FramedReader::spawn(buffered, 16);
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + relay_heartbeat_interval,
        relay_heartbeat_interval,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        enum SelectResult {
            Command(Option<RelayCommand>),
            Frame(Option<std::io::Result<connection::TypedNotebookFrame>>),
            Heartbeat,
        }

        let select_result = tokio::select! {
            biased;
            _ = heartbeat.tick() => SelectResult::Heartbeat,
            // Prioritize incoming daemon frames (sync, broadcast, presence,
            // responses) over outgoing commands. Keeping frames flowing
            // prevents head divergence; commands can wait a tick.
            frame = framed_reader.recv() => SelectResult::Frame(frame),
            cmd = config.cmd_rx.recv() => SelectResult::Command(cmd),
        };

        match select_result {
            SelectResult::Command(None) => {
                info!(
                    "[relay] All handles dropped for {}, shutting down",
                    notebook_id
                );
                break;
            }

            SelectResult::Command(Some(cmd)) => match cmd {
                RelayCommand::SendRequest {
                    id,
                    request,
                    required_heads,
                    reply,
                    broadcast_tx,
                } => {
                    handle_send_request(
                        &mut writer,
                        &mut pending,
                        id,
                        request,
                        required_heads,
                        reply,
                        broadcast_tx,
                    )
                    .await;
                }

                RelayCommand::SendPutBlob { id, frame, reply } => {
                    handle_send_put_blob(&mut writer, &mut pending, id, frame, reply).await;
                }

                RelayCommand::CancelRequest { id } => {
                    // Caller gave up (timeout). Drop the pending entry so
                    // the map doesn't accumulate abandoned senders.
                    pending.remove(&id);
                }

                RelayCommand::ForwardFrame {
                    frame_type,
                    payload,
                    reply,
                } => {
                    let ft = NotebookFrameType::try_from(frame_type);
                    let result = match ft {
                        Ok(NotebookFrameType::SessionControl) => Err(SyncError::Protocol(
                            "SessionControl is daemon-originated only".into(),
                        )),
                        Ok(ft) => connection::send_typed_frame(&mut writer, ft, &payload)
                            .await
                            .map_err(SyncError::Io),
                        Err(_) => Err(SyncError::Protocol(format!(
                            "Unknown frame type: 0x{:02x}",
                            frame_type,
                        ))),
                    };
                    let _ = reply.send(result);
                }
            },

            SelectResult::Frame(Some(Ok(frame))) => {
                route_incoming_frame(&frame, &mut pending, &config.frame_tx);
            }

            SelectResult::Frame(Some(Err(e))) => {
                warn!("[relay] Read error for {}: {}", notebook_id, e);
                break;
            }

            SelectResult::Frame(None) => {
                info!("[relay] Daemon closed connection for {}", notebook_id);
                break;
            }

            SelectResult::Heartbeat => {
                if let Err(e) = send_relay_heartbeat(&mut writer).await {
                    warn!(
                        "[relay] Failed to send heartbeat for {}: {}",
                        notebook_id, e
                    );
                    break;
                }
            }
        }
    }

    // Any Rust callers still waiting get a Disconnected error so they
    // don't hang on a channel that will never deliver.
    for (_, entry) in pending.drain() {
        let _ = entry.reply.send(Err(SyncError::Disconnected));
    }

    info!("[relay] Stopped for {}", notebook_id);
}

fn relay_heartbeat_interval(_config: &RelayTaskConfig) -> Duration {
    #[cfg(test)]
    if let Some(interval) = _config.heartbeat_interval {
        return interval;
    }

    RELAY_HEARTBEAT_INTERVAL
}

async fn send_relay_heartbeat<W: AsyncWrite + Unpin>(writer: &mut W) -> Result<(), SyncError> {
    // Match the existing frontend/full-peer heartbeat identity. The daemon's
    // idle deadline is per socket and only needs an inbound Presence frame; it
    // is not keyed by this transient UX peer id.
    let payload = notebook_doc::presence::encode_heartbeat("local")
        .map_err(|e| SyncError::Protocol(format!("encode heartbeat: {e}")))?;
    connection::send_typed_frame(writer, NotebookFrameType::Presence, &payload)
        .await
        .map_err(SyncError::Io)
}

/// Register a Rust-side PutBlob request in the pending map and write the binary
/// frame to the daemon. If the write fails, the entry is evicted and the error
/// is delivered on the caller's oneshot.
async fn handle_send_put_blob<W: AsyncWrite + Unpin>(
    writer: &mut W,
    pending: &mut HashMap<String, PendingEntry>,
    id: String,
    frame: Vec<u8>,
    reply: oneshot::Sender<Result<NotebookResponse, SyncError>>,
) {
    pending.insert(
        id.clone(),
        PendingEntry {
            reply,
            broadcast_tx: None,
        },
    );

    if let Err(e) = connection::send_typed_frame(writer, NotebookFrameType::PutBlob, &frame).await {
        if let Some(entry) = pending.remove(&id) {
            let _ = entry.reply.send(Err(SyncError::Io(e)));
        }
    }
}

/// Register a Rust-side request in the pending map and write the envelope
/// to the daemon. If the write fails, the entry is evicted and the error
/// is delivered on the caller's oneshot.
async fn handle_send_request<W: AsyncWrite + Unpin>(
    writer: &mut W,
    pending: &mut HashMap<String, PendingEntry>,
    id: String,
    request: NotebookRequest,
    required_heads: Vec<String>,
    reply: oneshot::Sender<Result<NotebookResponse, SyncError>>,
    broadcast_tx: Option<tokio::sync::broadcast::Sender<NotebookBroadcast>>,
) {
    let envelope = NotebookRequestEnvelope {
        id: Some(id.clone()),
        required_heads,
        request,
    };

    let payload = match serde_json::to_vec(&envelope) {
        Ok(p) => p,
        Err(e) => {
            let _ = reply.send(Err(SyncError::Serialization(e.to_string())));
            return;
        }
    };

    // Register BEFORE sending so a fast daemon response can't arrive before
    // the pending entry is in place.
    pending.insert(
        id.clone(),
        PendingEntry {
            reply,
            broadcast_tx,
        },
    );

    if let Err(e) = connection::send_typed_frame(writer, NotebookFrameType::Request, &payload).await
    {
        if let Some(entry) = pending.remove(&id) {
            let _ = entry.reply.send(Err(SyncError::Io(e)));
        }
    }
}

/// Dispatch an incoming frame from the daemon.
///
/// Response frames with a known correlation id are delivered to the
/// matching Rust caller. Response frames with no id, or with an id we
/// didn't register, are piped to the frontend — a JS caller is the likely
/// owner. Broadcast frames are both delivered to any subscribed request
/// (for progress updates on long-running calls) and piped to the frontend.
/// Everything else is piped to the frontend.
fn route_incoming_frame(
    frame: &connection::TypedNotebookFrame,
    pending: &mut HashMap<String, PendingEntry>,
    frame_tx: &mpsc::UnboundedSender<Vec<u8>>,
) {
    match frame.frame_type {
        NotebookFrameType::Response => {
            match serde_json::from_slice::<NotebookResponseEnvelope>(&frame.payload) {
                Ok(envelope) => {
                    let entry = envelope.id.as_deref().and_then(|id| pending.remove(id));
                    if let Some(entry) = entry {
                        let _ = entry.reply.send(Ok(envelope.response));
                    } else {
                        // Unknown id (or missing) — must belong to a frontend
                        // request. Pipe the whole frame so the frontend's pending
                        // map can match on the envelope's id.
                        pipe_frame(frame_tx, frame);
                    }
                }
                Err(e) => {
                    warn!("[relay] Malformed response envelope: {}", e);
                    // Pipe anyway so the frontend can surface / log it.
                    pipe_frame(frame_tx, frame);
                }
            }
        }

        NotebookFrameType::Broadcast => {
            // If any in-flight request subscribed to progress broadcasts,
            // deliver there too (e.g., LaunchKernel env-creation phases).
            let broadcast: Option<NotebookBroadcast> = serde_json::from_slice(&frame.payload).ok();
            if let Some(bc) = broadcast.as_ref() {
                for entry in pending.values() {
                    if let Some(tx) = &entry.broadcast_tx {
                        let _ = tx.send(bc.clone());
                    }
                }
            }
            pipe_frame(frame_tx, frame);
        }

        _ => pipe_frame(frame_tx, frame),
    }
}

/// Pipe a daemon frame to the frontend.
///
/// Forwards sync, broadcast, presence, runtime-state, pool-state,
/// session-control, AND
/// response (`0x02`) frames. Frontend requests rely on `0x02` reaching the
/// JS side so the frontend's pending map can correlate the response.
///
/// Request and PutBlob frames are never piped outbound to the frontend — the
/// frontend sends them; the daemon never emits them to a client.
///
/// Distinct from the daemon's CLI "pipe mode"
/// (`crates/runtimed/tests/integration.rs::test_pipe_mode_only_pipes_allowed_frame_types`),
/// which is a debug tap that intentionally drops `Response`. Same verb, two
/// different audiences. Punchlist WP-5.
fn pipe_frame(frame_tx: &mpsc::UnboundedSender<Vec<u8>>, frame: &connection::TypedNotebookFrame) {
    match frame.frame_type {
        NotebookFrameType::AutomergeSync
        | NotebookFrameType::Broadcast
        | NotebookFrameType::Presence
        | NotebookFrameType::RuntimeStateSync
        | NotebookFrameType::CommsDocSync
        | NotebookFrameType::CommentsDocSync
        | NotebookFrameType::PoolStateSync
        | NotebookFrameType::SessionControl
        | NotebookFrameType::Response => {
            let mut bytes = vec![frame.frame_type as u8];
            bytes.extend_from_slice(&frame.payload);
            let _ = frame_tx.send(bytes);
        }
        NotebookFrameType::Request | NotebookFrameType::PutBlob => {
            debug!(
                "[relay] Not piping {:?} frame (outbound only) — {} bytes",
                frame.frame_type,
                frame.payload.len()
            );
        }
    }
}

/// Per-request-type timeouts — exported so `RelayHandle::send_request` can
/// wrap its oneshot await in the same bound that the old inline read loop
/// used to enforce.
pub fn request_timeout(request: &NotebookRequest) -> Duration {
    let secs = match request {
        NotebookRequest::LaunchKernel { .. } => 300,
        NotebookRequest::SyncEnvironment { .. } => 300,
        // Completions use 7s — the daemon's kernel-level timeout is 5s,
        // so the daemon always responds within ~5s under normal operation.
        NotebookRequest::Complete { .. } => 7,
        _ => 30,
    };
    Duration::from_secs(secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::protocol::{BlobUploadErrorKind, PutBlobHeader, PutBlobResult};
    use sha2::{Digest, Sha256};

    async fn spawn_relay_for_test() -> (
        crate::relay::RelayHandle,
        tokio::io::ReadHalf<tokio::io::DuplexStream>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
    ) {
        let (client, daemon) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client);
        let (daemon_read, daemon_write) = tokio::io::split(daemon);
        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
        let handle = crate::relay::RelayHandle::new(cmd_tx, "notebook-test".to_string());

        tokio::spawn(run(
            RelayTaskConfig {
                cmd_rx,
                frame_tx,
                notebook_id: "notebook-test".to_string(),
                heartbeat_interval: None,
            },
            client_read,
            client_write,
        ));

        (handle, daemon_read, daemon_write)
    }

    async fn spawn_relay_for_test_with_heartbeat_interval(
        heartbeat_interval: Duration,
    ) -> (
        crate::relay::RelayHandle,
        tokio::io::ReadHalf<tokio::io::DuplexStream>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
    ) {
        let (client, daemon) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client);
        let (daemon_read, daemon_write) = tokio::io::split(daemon);
        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
        let handle = crate::relay::RelayHandle::new(cmd_tx, "notebook-test".to_string());

        tokio::spawn(run(
            RelayTaskConfig {
                cmd_rx,
                frame_tx,
                notebook_id: "notebook-test".to_string(),
                heartbeat_interval: Some(heartbeat_interval),
            },
            client_read,
            client_write,
        ));

        (handle, daemon_read, daemon_write)
    }

    async fn recv_request_for_test(
        daemon_read: &mut tokio::io::ReadHalf<tokio::io::DuplexStream>,
    ) -> NotebookRequestEnvelope {
        let frame = connection::recv_typed_frame(daemon_read)
            .await
            .expect("read request frame")
            .expect("request frame");
        assert_eq!(frame.frame_type, NotebookFrameType::Request);
        serde_json::from_slice(&frame.payload).expect("parse request")
    }

    async fn send_response_for_test(
        daemon_write: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
        id: Option<String>,
        response: NotebookResponse,
    ) {
        let envelope = NotebookResponseEnvelope { id, response };
        connection::send_typed_frame(
            daemon_write,
            NotebookFrameType::Response,
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .await
        .expect("send response");
    }

    #[tokio::test]
    async fn relay_task_sends_native_presence_heartbeat() {
        let (_handle, mut daemon_read, _daemon_write) =
            spawn_relay_for_test_with_heartbeat_interval(Duration::from_millis(5)).await;

        let frame = tokio::time::timeout(
            Duration::from_millis(100),
            connection::recv_typed_frame(&mut daemon_read),
        )
        .await
        .expect("heartbeat frame timed out")
        .expect("read heartbeat frame")
        .expect("heartbeat frame");

        assert_eq!(frame.frame_type, NotebookFrameType::Presence);
        let message =
            notebook_doc::presence::decode_message(&frame.payload).expect("decode heartbeat");
        assert!(matches!(
            message,
            notebook_doc::presence::PresenceMessage::Heartbeat { peer_id } if peer_id == "local"
        ));
    }

    #[tokio::test]
    async fn relay_handle_put_blob_one_shot_routes_response_by_id() {
        let (handle, mut daemon_read, mut daemon_write) = spawn_relay_for_test().await;
        let upload = tokio::spawn({
            let handle = handle.clone();
            async move { handle.put_blob_one_shot(b"abc", "text/plain").await }
        });

        let frame = connection::recv_typed_frame(&mut daemon_read)
            .await
            .expect("read PutBlob frame")
            .expect("PutBlob frame");
        assert_eq!(frame.frame_type, NotebookFrameType::PutBlob);
        let (header, body) = PutBlobHeader::try_parse(&frame.payload).expect("parse PutBlob");
        assert_eq!(body, b"abc");
        let id = header.id().to_string();

        match header {
            PutBlobHeader::Put {
                media_type,
                size,
                sha256,
                ..
            } => {
                assert_eq!(media_type, "text/plain");
                assert_eq!(size, 3);
                assert_eq!(
                    sha256,
                    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                );
            }
            PutBlobHeader::Part { .. } => panic!("expected one-shot PutBlob header"),
        }

        let response = NotebookResponseEnvelope {
            id: Some(id),
            response: NotebookResponse::BlobStored {
                hash: "hash123".to_string(),
                size: 3,
                media_type: "text/plain".to_string(),
            },
        };
        let payload = serde_json::to_vec(&response).expect("serialize response");
        connection::send_typed_frame(&mut daemon_write, NotebookFrameType::Response, &payload)
            .await
            .expect("send response");

        let result = upload.await.expect("join upload").expect("upload succeeds");
        assert_eq!(
            result,
            PutBlobResult {
                blob: "hash123".to_string(),
                size: 3,
                media_type: "text/plain".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn relay_handle_put_blob_one_shot_surfaces_blob_upload_error() {
        let (handle, mut daemon_read, mut daemon_write) = spawn_relay_for_test().await;
        let upload = tokio::spawn({
            let handle = handle.clone();
            async move { handle.put_blob_one_shot(b"abc", "text/plain").await }
        });

        let frame = connection::recv_typed_frame(&mut daemon_read)
            .await
            .expect("read PutBlob frame")
            .expect("PutBlob frame");
        let (header, _) = PutBlobHeader::try_parse(&frame.payload).expect("parse PutBlob");
        let response = NotebookResponseEnvelope {
            id: Some(header.id().to_string()),
            response: NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::TooManyInFlight,
            },
        };
        let payload = serde_json::to_vec(&response).expect("serialize response");
        connection::send_typed_frame(&mut daemon_write, NotebookFrameType::Response, &payload)
            .await
            .expect("send response");

        let error = upload
            .await
            .expect("join upload")
            .expect_err("upload returns error");
        match error {
            SyncError::BlobUpload(BlobUploadErrorKind::TooManyInFlight) => {}
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn relay_handle_put_blob_multipart_sequences_control_and_part_frames() {
        let (handle, mut daemon_read, mut daemon_write) = spawn_relay_for_test().await;
        let upload = tokio::spawn({
            let handle = handle.clone();
            async move { handle.put_blob_multipart(b"abcdef", "text/plain").await }
        });

        let create_frame = connection::recv_typed_frame(&mut daemon_read)
            .await
            .expect("read create request")
            .expect("create request");
        assert_eq!(create_frame.frame_type, NotebookFrameType::Request);
        let create_envelope: NotebookRequestEnvelope =
            serde_json::from_slice(&create_frame.payload).expect("parse create request");
        let create_id = create_envelope.id.clone().expect("create id");
        match create_envelope.request {
            NotebookRequest::CreateBlobUpload {
                media_type,
                size,
                part_size,
                ..
            } => {
                assert_eq!(media_type, "text/plain");
                assert_eq!(size, 6);
                assert_eq!(part_size, None);
            }
            other => panic!("unexpected create request: {other:?}"),
        }
        let create_response = NotebookResponseEnvelope {
            id: Some(create_id),
            response: NotebookResponse::BlobUploadCreated {
                upload_id: "upload-1".to_string(),
                part_size: 3,
                expires_at: "2026-05-13T00:00:00Z".to_string(),
            },
        };
        connection::send_typed_frame(
            &mut daemon_write,
            NotebookFrameType::Response,
            &serde_json::to_vec(&create_response).unwrap(),
        )
        .await
        .expect("send create response");

        for expected in [(1, b"abc".as_slice()), (2, b"def".as_slice())] {
            let frame = connection::recv_typed_frame(&mut daemon_read)
                .await
                .expect("read part frame")
                .expect("part frame");
            assert_eq!(frame.frame_type, NotebookFrameType::PutBlob);
            let (header, body) = PutBlobHeader::try_parse(&frame.payload).expect("parse part");
            let (part_number, expected_body) = expected;
            assert_eq!(body, expected_body);
            let id = header.id().to_string();
            let sha256 = hex::encode(Sha256::digest(expected_body));
            match header {
                PutBlobHeader::Part {
                    upload_id,
                    part_number: actual_part_number,
                    size,
                    sha256: header_sha256,
                    ..
                } => {
                    assert_eq!(upload_id, "upload-1");
                    assert_eq!(actual_part_number, part_number);
                    assert_eq!(size, expected_body.len() as u64);
                    assert_eq!(header_sha256, sha256);
                }
                PutBlobHeader::Put { .. } => panic!("expected multipart part header"),
            }
            let response = NotebookResponseEnvelope {
                id: Some(id),
                response: NotebookResponse::BlobPartStored {
                    upload_id: "upload-1".to_string(),
                    part_number,
                    sha256,
                },
            };
            connection::send_typed_frame(
                &mut daemon_write,
                NotebookFrameType::Response,
                &serde_json::to_vec(&response).unwrap(),
            )
            .await
            .expect("send part response");
        }

        let complete_frame = connection::recv_typed_frame(&mut daemon_read)
            .await
            .expect("read complete request")
            .expect("complete request");
        assert_eq!(complete_frame.frame_type, NotebookFrameType::Request);
        let complete_envelope: NotebookRequestEnvelope =
            serde_json::from_slice(&complete_frame.payload).expect("parse complete request");
        let complete_id = complete_envelope.id.clone().expect("complete id");
        match complete_envelope.request {
            NotebookRequest::CompleteBlobUpload { upload_id, parts } => {
                assert_eq!(upload_id, "upload-1");
                assert_eq!(parts.len(), 2);
                assert_eq!(parts[0].part_number, 1);
                assert_eq!(parts[0].size, 3);
                assert_eq!(parts[1].part_number, 2);
                assert_eq!(parts[1].size, 3);
            }
            other => panic!("unexpected complete request: {other:?}"),
        }
        let complete_response = NotebookResponseEnvelope {
            id: Some(complete_id),
            response: NotebookResponse::BlobStored {
                hash: "final-hash".to_string(),
                size: 6,
                media_type: "text/plain".to_string(),
            },
        };
        connection::send_typed_frame(
            &mut daemon_write,
            NotebookFrameType::Response,
            &serde_json::to_vec(&complete_response).unwrap(),
        )
        .await
        .expect("send complete response");

        let result = upload.await.expect("join upload").expect("upload succeeds");
        assert_eq!(
            result,
            PutBlobResult {
                blob: "final-hash".to_string(),
                size: 6,
                media_type: "text/plain".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn relay_handle_put_blob_multipart_rejects_zero_part_size_and_aborts() {
        let (handle, mut daemon_read, mut daemon_write) = spawn_relay_for_test().await;
        let upload = tokio::spawn({
            let handle = handle.clone();
            async move { handle.put_blob_multipart(b"abcdef", "text/plain").await }
        });

        let create_envelope = recv_request_for_test(&mut daemon_read).await;
        let create_id = create_envelope.id.clone().expect("create id");
        match create_envelope.request {
            NotebookRequest::CreateBlobUpload { .. } => {}
            other => panic!("unexpected create request: {other:?}"),
        }
        send_response_for_test(
            &mut daemon_write,
            Some(create_id),
            NotebookResponse::BlobUploadCreated {
                upload_id: "upload-zero".to_string(),
                part_size: 0,
                expires_at: "2026-05-13T00:00:00Z".to_string(),
            },
        )
        .await;

        let abort_envelope = recv_request_for_test(&mut daemon_read).await;
        let abort_id = abort_envelope.id.clone().expect("abort id");
        match abort_envelope.request {
            NotebookRequest::AbortBlobUpload { upload_id } => {
                assert_eq!(upload_id, "upload-zero");
            }
            other => panic!("unexpected abort request: {other:?}"),
        }
        send_response_for_test(
            &mut daemon_write,
            Some(abort_id),
            NotebookResponse::BlobUploadAborted {
                upload_id: "upload-zero".to_string(),
            },
        )
        .await;

        let error = upload
            .await
            .expect("join upload")
            .expect_err("upload returns protocol error");
        match error {
            SyncError::Protocol(message) => {
                assert!(message.contains("part_size: 0"), "{message}");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn relay_handle_put_blob_multipart_aborts_after_part_error() {
        let (handle, mut daemon_read, mut daemon_write) = spawn_relay_for_test().await;
        let upload = tokio::spawn({
            let handle = handle.clone();
            async move { handle.put_blob_multipart(b"abcdef", "text/plain").await }
        });

        let create_envelope = recv_request_for_test(&mut daemon_read).await;
        let create_id = create_envelope.id.clone().expect("create id");
        send_response_for_test(
            &mut daemon_write,
            Some(create_id),
            NotebookResponse::BlobUploadCreated {
                upload_id: "upload-fail".to_string(),
                part_size: 3,
                expires_at: "2026-05-13T00:00:00Z".to_string(),
            },
        )
        .await;

        let part_frame = connection::recv_typed_frame(&mut daemon_read)
            .await
            .expect("read part frame")
            .expect("part frame");
        assert_eq!(part_frame.frame_type, NotebookFrameType::PutBlob);
        let (part_header, _) = PutBlobHeader::try_parse(&part_frame.payload).expect("parse part");
        send_response_for_test(
            &mut daemon_write,
            Some(part_header.id().to_string()),
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::PartHashMismatch,
            },
        )
        .await;

        let abort_envelope = recv_request_for_test(&mut daemon_read).await;
        let abort_id = abort_envelope.id.clone().expect("abort id");
        match abort_envelope.request {
            NotebookRequest::AbortBlobUpload { upload_id } => {
                assert_eq!(upload_id, "upload-fail");
            }
            other => panic!("unexpected abort request: {other:?}"),
        }
        send_response_for_test(
            &mut daemon_write,
            Some(abort_id),
            NotebookResponse::BlobUploadAborted {
                upload_id: "upload-fail".to_string(),
            },
        )
        .await;

        let error = upload
            .await
            .expect("join upload")
            .expect_err("upload returns part error");
        match error {
            SyncError::BlobUpload(BlobUploadErrorKind::PartHashMismatch) => {}
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
