use std::sync::Arc;

use automerge::ChangeHash;
use tokio::io::AsyncWrite;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use notebook_protocol::connection::{self, NotebookFrameType};

use super::blob_upload::{maybe_handle_blob_upload_request, MultipartUploadState};
use super::NotebookRoom;
use crate::requests::{handle_notebook_request, request_label};

pub(super) const PEER_OUTBOUND_QUEUE_CAPACITY: usize = 1024;
const PEER_REQUEST_QUEUE_CAPACITY: usize = 64;
const SLOW_PEER_REQUEST: std::time::Duration = std::time::Duration::from_secs(30);
const REQUIRED_HEADS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

struct OutboundFrame {
    lane: PeerEgressLane,
    frame_type: NotebookFrameType,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PeerEgressLane {
    Reliable,
    Ephemeral,
}

impl PeerEgressLane {
    pub(super) fn classify(frame_type: NotebookFrameType) -> Self {
        match frame_type {
            NotebookFrameType::Broadcast | NotebookFrameType::Presence => Self::Ephemeral,
            NotebookFrameType::AutomergeSync
            | NotebookFrameType::Request
            | NotebookFrameType::Response
            | NotebookFrameType::RuntimeStateSync
            | NotebookFrameType::PoolStateSync
            | NotebookFrameType::SessionControl
            | NotebookFrameType::PutBlob => Self::Reliable,
        }
    }
}

#[derive(Clone)]
pub(super) struct PeerWriter {
    reliable_tx: mpsc::Sender<OutboundFrame>,
    ephemeral_tx: mpsc::Sender<OutboundFrame>,
}

pub(super) struct PeerWriterTask {
    pub(super) handle: tokio::task::JoinHandle<anyhow::Result<()>>,
}

pub(super) struct PeerRequestWorker {
    tx: mpsc::Sender<notebook_protocol::protocol::NotebookRequestEnvelope>,
    pub(super) handle: tokio::task::JoinHandle<anyhow::Result<()>>,
}

#[derive(Debug)]
pub(super) enum RequestEnqueueError {
    Full(Box<notebook_protocol::protocol::NotebookRequestEnvelope>),
    Closed(Box<notebook_protocol::protocol::NotebookRequestEnvelope>),
}

impl Drop for PeerWriterTask {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl Drop for PeerRequestWorker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl PeerWriter {
    fn tx_for_lane(&self, lane: PeerEgressLane) -> &mpsc::Sender<OutboundFrame> {
        match lane {
            PeerEgressLane::Reliable => &self.reliable_tx,
            PeerEgressLane::Ephemeral => &self.ephemeral_tx,
        }
    }

    pub(super) fn send_frame(
        &self,
        frame_type: NotebookFrameType,
        payload: Vec<u8>,
    ) -> anyhow::Result<()> {
        let lane = PeerEgressLane::classify(frame_type);
        self.tx_for_lane(lane)
            .try_send(OutboundFrame {
                lane,
                frame_type,
                payload,
            })
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(frame) => {
                    warn!(
                        frame_type = ?frame.frame_type,
                        lane = ?frame.lane,
                        "[notebook-sync] Peer outbound queue full"
                    );
                    anyhow::anyhow!(
                        "peer outbound queue full while sending {:?} frame on {:?} lane",
                        frame.frame_type,
                        frame.lane
                    )
                }
                mpsc::error::TrySendError::Closed(frame) => {
                    warn!(
                        frame_type = ?frame.frame_type,
                        lane = ?frame.lane,
                        "[notebook-sync] Peer writer stopped"
                    );
                    anyhow::anyhow!(
                        "peer writer stopped before sending {:?} frame on {:?} lane",
                        frame.frame_type,
                        frame.lane
                    )
                }
            })
    }

    pub(super) fn send_json<T>(
        &self,
        frame_type: NotebookFrameType,
        value: &T,
    ) -> anyhow::Result<()>
    where
        T: serde::Serialize,
    {
        let payload = serde_json::to_vec(value)?;
        self.send_frame(frame_type, payload)
    }

    /// Number of free slots in the reliable outbound lane.
    ///
    /// `PEER_OUTBOUND_QUEUE_CAPACITY - reliable_capacity()` gives the number
    /// of reliable frames waiting to be flushed to the socket — useful as a
    /// backpressure signal before request responses are enqueued.
    pub(super) fn reliable_capacity(&self) -> usize {
        self.reliable_tx.capacity()
    }
}

impl PeerRequestWorker {
    pub(super) fn enqueue(
        &self,
        envelope: notebook_protocol::protocol::NotebookRequestEnvelope,
    ) -> Result<(), RequestEnqueueError> {
        self.tx.try_send(envelope).map_err(|e| match e {
            mpsc::error::TrySendError::Full(envelope) => {
                RequestEnqueueError::Full(Box::new(envelope))
            }
            mpsc::error::TrySendError::Closed(envelope) => {
                RequestEnqueueError::Closed(Box::new(envelope))
            }
        })
    }
}

pub(super) fn spawn_peer_writer<W>(
    mut writer: W,
    notebook_id: String,
    peer_id: String,
) -> (PeerWriter, PeerWriterTask)
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (reliable_tx, mut reliable_rx) =
        mpsc::channel::<OutboundFrame>(PEER_OUTBOUND_QUEUE_CAPACITY);
    let (ephemeral_tx, mut ephemeral_rx) =
        mpsc::channel::<OutboundFrame>(PEER_OUTBOUND_QUEUE_CAPACITY);
    let handle = tokio::spawn(async move {
        let mut reliable_open = true;
        let mut ephemeral_open = true;
        while let Some(frame) = recv_next_outbound_frame(
            &mut reliable_rx,
            &mut ephemeral_rx,
            &mut reliable_open,
            &mut ephemeral_open,
        )
        .await
        {
            connection::send_typed_frame(&mut writer, frame.frame_type, &frame.payload)
                .await
                .map_err(|e| {
                    anyhow::anyhow!(
                        "failed to write {:?} frame on {:?} lane to peer {} for {}: {}",
                        frame.frame_type,
                        frame.lane,
                        peer_id,
                        notebook_id,
                        e
                    )
                })?;
        }
        Ok(())
    });
    (
        PeerWriter {
            reliable_tx,
            ephemeral_tx,
        },
        PeerWriterTask { handle },
    )
}

async fn recv_next_outbound_frame(
    reliable_rx: &mut mpsc::Receiver<OutboundFrame>,
    ephemeral_rx: &mut mpsc::Receiver<OutboundFrame>,
    reliable_open: &mut bool,
    ephemeral_open: &mut bool,
) -> Option<OutboundFrame> {
    loop {
        if *reliable_open {
            match reliable_rx.try_recv() {
                Ok(frame) => return Some(frame),
                Err(mpsc::error::TryRecvError::Empty) => {}
                Err(mpsc::error::TryRecvError::Disconnected) => *reliable_open = false,
            }
        }
        if !*reliable_open && !*ephemeral_open {
            return None;
        }

        tokio::select! {
            biased;

            frame = reliable_rx.recv(), if *reliable_open => {
                match frame {
                    Some(frame) => return Some(frame),
                    None => *reliable_open = false,
                }
            }

            frame = ephemeral_rx.recv(), if *ephemeral_open => {
                match frame {
                    Some(frame) => return Some(frame),
                    None => *ephemeral_open = false,
                }
            }
        }
    }
}

pub(super) fn spawn_peer_request_worker(
    room: Arc<NotebookRoom>,
    daemon: Arc<crate::daemon::Daemon>,
    writer: PeerWriter,
    multipart_uploads: MultipartUploadState,
    notebook_id: String,
    peer_id: String,
    submitter_actor_label: String,
) -> PeerRequestWorker {
    let (tx, mut rx) = mpsc::channel::<notebook_protocol::protocol::NotebookRequestEnvelope>(
        PEER_REQUEST_QUEUE_CAPACITY,
    );
    let handle = tokio::spawn(async move {
        while let Some(envelope) = rx.recv().await {
            let label = request_label(&envelope.request);
            let req_id = envelope.id.as_deref().unwrap_or("-");
            let writer_reliable_queue_depth =
                PEER_OUTBOUND_QUEUE_CAPACITY - writer.reliable_capacity();
            debug!(
                "[notebook-sync] Request {} id={} peer={} notebook={} writer_reliable_queue={}",
                label, req_id, peer_id, notebook_id, writer_reliable_queue_depth,
            );

            let start = std::time::Instant::now();
            let response = match wait_for_required_heads(&room, &envelope.required_heads).await {
                Ok(()) => {
                    if let Some(response) = maybe_handle_blob_upload_request(
                        &multipart_uploads,
                        &room.blob_store,
                        &envelope.request,
                    )
                    .await
                    {
                        response
                    } else {
                        handle_notebook_request(
                            &room,
                            envelope.request,
                            daemon.clone(),
                            Some(submitter_actor_label.as_str()),
                        )
                        .await
                    }
                }
                Err(error) => notebook_protocol::protocol::NotebookResponse::Error { error },
            };
            let elapsed = start.elapsed();
            if elapsed >= SLOW_PEER_REQUEST {
                let response_kind = std::mem::discriminant(&response);
                warn!(
                    request = label,
                    id = req_id,
                    peer = %peer_id,
                    notebook = %notebook_id,
                    elapsed_ms = elapsed.as_millis(),
                    writer_reliable_queue_depth,
                    ?response_kind,
                    "Slow notebook peer request"
                );
            }
            debug!(
                "[notebook-sync] Request {} id={} completed in {:?}",
                label, req_id, elapsed,
            );

            let reply = notebook_protocol::protocol::NotebookResponseEnvelope {
                id: envelope.id,
                response,
            };
            writer
                .send_json(NotebookFrameType::Response, &reply)
                .map_err(|e| {
                    anyhow::anyhow!(
                        "failed to queue response to peer {} for {}: {}",
                        peer_id,
                        notebook_id,
                        e
                    )
                })?;
        }
        Ok(())
    });
    PeerRequestWorker { tx, handle }
}

async fn wait_for_required_heads(
    room: &NotebookRoom,
    required_heads: &[String],
) -> Result<(), String> {
    if required_heads.is_empty() {
        return Ok(());
    }

    let heads = parse_required_heads(required_heads)?;
    let mut changed_rx = room.broadcasts.changed_tx.subscribe();

    tokio::time::timeout(REQUIRED_HEADS_TIMEOUT, async {
        loop {
            {
                let mut doc = room.doc.write().await;
                let has_all_heads = heads
                    .iter()
                    .all(|head| doc.doc_mut().get_change_by_hash(head).is_some());
                if has_all_heads {
                    return Ok(());
                }
            }

            match changed_rx.recv().await {
                Ok(()) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return Err("Required notebook heads could not be observed".to_string());
                }
            }
        }
    })
    .await
    .map_err(|_| "Timed out waiting for required notebook heads".to_string())?
}

fn parse_required_heads(required_heads: &[String]) -> Result<Vec<ChangeHash>, String> {
    required_heads
        .iter()
        .map(|head| {
            head.parse::<ChangeHash>()
                .map_err(|_| "Request contained an invalid required notebook head".to_string())
        })
        .collect()
}

pub(super) fn enqueue_notebook_request(
    request_worker: &PeerRequestWorker,
    writer: &PeerWriter,
    payload: &[u8],
    notebook_id: &str,
    peer_id: &str,
) -> anyhow::Result<()> {
    let envelope: notebook_protocol::protocol::NotebookRequestEnvelope =
        serde_json::from_slice(payload)?;
    debug!(
        "[notebook-sync] Enqueuing {} id={} peer={} notebook={}",
        request_label(&envelope.request),
        envelope.id.as_deref().unwrap_or("-"),
        peer_id,
        notebook_id,
    );

    if let Err(e) = request_worker.enqueue(envelope) {
        match e {
            RequestEnqueueError::Full(envelope) => {
                warn!(
                    "[notebook-sync] Peer request queue full for {} (peer_id={})",
                    notebook_id, peer_id
                );
                queue_request_error(writer, envelope.id.clone(), "Peer request queue full")?;
            }
            RequestEnqueueError::Closed(envelope) => {
                warn!(
                    "[notebook-sync] Peer request worker stopped for {} (peer_id={})",
                    notebook_id, peer_id
                );
                queue_request_error(writer, envelope.id.clone(), "Peer request worker stopped")?;
                anyhow::bail!("peer request worker stopped for {}", notebook_id);
            }
        }
    }
    Ok(())
}

pub(super) fn queue_request_error(
    writer: &PeerWriter,
    id: Option<String>,
    error: impl Into<String>,
) -> anyhow::Result<()> {
    writer.send_json(
        NotebookFrameType::Response,
        &notebook_protocol::protocol::NotebookResponseEnvelope {
            id,
            response: notebook_protocol::protocol::NotebookResponse::Error {
                error: error.into(),
            },
        },
    )
}

pub(super) fn queue_session_status(
    writer: &PeerWriter,
    notebook_doc: notebook_protocol::protocol::NotebookDocPhaseWire,
    runtime_state: notebook_protocol::protocol::RuntimeStatePhaseWire,
    initial_load: notebook_protocol::protocol::InitialLoadPhaseWire,
) -> anyhow::Result<()> {
    writer.send_json(
        NotebookFrameType::SessionControl,
        &notebook_protocol::protocol::SessionControlMessage::SyncStatus(
            notebook_protocol::protocol::SessionSyncStatusWire {
                notebook_doc,
                runtime_state,
                initial_load,
            },
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::blob_store::BlobStore;
    use crate::protocol::{NotebookRequest, NotebookResponse};
    use runtime_doc::RuntimeLifecycle;
    use tokio::sync::oneshot;
    use uuid::Uuid;

    fn test_peer_writer_with_capacities(
        reliable_capacity: usize,
        ephemeral_capacity: usize,
    ) -> (
        PeerWriter,
        mpsc::Receiver<OutboundFrame>,
        mpsc::Receiver<OutboundFrame>,
    ) {
        let (reliable_tx, reliable_rx) = mpsc::channel::<OutboundFrame>(reliable_capacity);
        let (ephemeral_tx, ephemeral_rx) = mpsc::channel::<OutboundFrame>(ephemeral_capacity);
        (
            PeerWriter {
                reliable_tx,
                ephemeral_tx,
            },
            reliable_rx,
            ephemeral_rx,
        )
    }

    fn test_room() -> Arc<NotebookRoom> {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        Arc::new(NotebookRoom::new_fresh(
            Uuid::new_v4(),
            None,
            tmp.path(),
            blob_store,
            true,
        ))
    }

    #[tokio::test]
    async fn required_heads_are_satisfied_by_present_change_history() {
        let room = test_room();
        let heads = {
            let mut doc = room.doc.write().await;
            doc.add_cell(0, "cell-1", "code").expect("add cell");
            doc.get_heads_hex()
        };

        wait_for_required_heads(&room, &heads)
            .await
            .expect("present heads should satisfy the causal gate");
    }

    #[tokio::test]
    async fn required_heads_wait_until_change_history_arrives() {
        let room = test_room();
        let mut incoming = {
            let mut doc = room.doc.write().await;
            doc.fork_with_actor("test:incoming")
        };
        incoming
            .add_cell(0, "cell-1", "code")
            .expect("add incoming cell");
        let heads = incoming.get_heads_hex();

        let wait_room = room.clone();
        let wait_heads = heads.clone();
        let waiter =
            tokio::spawn(async move { wait_for_required_heads(&wait_room, &wait_heads).await });

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(
            !waiter.is_finished(),
            "missing heads should keep the causal gate pending"
        );

        {
            let mut doc = room.doc.write().await;
            doc.merge(&mut incoming).expect("merge incoming change");
        }
        let _ = room.broadcasts.changed_tx.send(());

        waiter
            .await
            .expect("wait task should not panic")
            .expect("merged heads should satisfy the causal gate");
    }

    #[tokio::test]
    async fn execute_cell_request_does_not_publish_startup_queue_before_required_heads() {
        let room = test_room();
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Resolving))
            .expect("set startup lifecycle");

        let mut incoming = {
            let mut doc = room.doc.write().await;
            doc.fork_with_actor("test:incoming")
        };
        incoming
            .add_cell(0, "cell-1", "code")
            .expect("add incoming cell");
        incoming
            .update_source("cell-1", "print('queued after sync')")
            .expect("update incoming source");
        let heads = incoming.get_heads_hex();

        let request_room = room.clone();
        let request_heads = heads.clone();
        let request = tokio::spawn(async move {
            wait_for_required_heads(&request_room, &request_heads)
                .await
                .expect("required heads should eventually arrive");
            crate::requests::execute_cell::handle_with_submitter(
                &request_room,
                "cell-1".to_string(),
                None,
                Some("user:test/agent"),
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(
            !request.is_finished(),
            "execute request should stay behind the missing required_heads gate"
        );
        let state = room.state.read(|sd| sd.read_state()).unwrap();
        assert!(
            state.executions.is_empty(),
            "missing NotebookDoc heads must not create RuntimeStateDoc executions"
        );
        assert!(
            state.queue.executing.is_none() && state.queue.queued.is_empty(),
            "missing NotebookDoc heads must not publish startup queue state"
        );
        drop(state);

        {
            let mut doc = room.doc.write().await;
            doc.merge(&mut incoming).expect("merge incoming change");
        }
        let _ = room.broadcasts.changed_tx.send(());

        let response = tokio::time::timeout(std::time::Duration::from_secs(1), request)
            .await
            .expect("execute request should finish after heads arrive")
            .expect("execute task should not panic");
        let (cell_id, execution_id) = match response {
            NotebookResponse::CellQueued {
                cell_id,
                execution_id,
            } => (cell_id, execution_id),
            other => panic!("expected CellQueued after heads arrive, got {other:?}"),
        };
        assert_eq!(cell_id, "cell-1");

        let state = room.state.read(|sd| sd.read_state()).unwrap();
        let execution = state
            .executions
            .get(&execution_id)
            .expect("queued execution should exist after accepted request");
        assert_eq!(execution.status, "queued");
        assert_eq!(
            execution.source.as_deref(),
            Some("print('queued after sync')")
        );
        assert_eq!(execution.cell_id.as_deref(), Some("cell-1"));
        assert_eq!(
            execution.submitted_by_actor_label.as_deref(),
            Some("user:test/agent")
        );
        let queued_ids: Vec<&str> = state
            .queue
            .queued
            .iter()
            .map(|entry| entry.execution_id.as_str())
            .collect();
        assert_eq!(queued_ids, vec![execution_id.as_str()]);
        drop(state);

        let cell_execution_id = {
            let doc = room.doc.read().await;
            doc.get_execution_id("cell-1")
        };
        assert_eq!(cell_execution_id.as_deref(), Some(execution_id.as_str()));
    }

    #[tokio::test]
    async fn peer_egress_lane_classifies_reliable_and_ephemeral_frames() {
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::AutomergeSync),
            PeerEgressLane::Reliable
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::Request),
            PeerEgressLane::Reliable
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::Response),
            PeerEgressLane::Reliable
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::RuntimeStateSync),
            PeerEgressLane::Reliable
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::PoolStateSync),
            PeerEgressLane::Reliable
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::SessionControl),
            PeerEgressLane::Reliable
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::Presence),
            PeerEgressLane::Ephemeral
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::Broadcast),
            PeerEgressLane::Ephemeral
        );
        assert_eq!(
            PeerEgressLane::classify(NotebookFrameType::PutBlob),
            PeerEgressLane::Reliable
        );
    }

    #[tokio::test]
    async fn peer_writer_preserves_sync_before_session_status_barrier() {
        let (writer, mut reliable_rx, _ephemeral_rx) = test_peer_writer_with_capacities(2, 2);

        writer
            .send_frame(NotebookFrameType::RuntimeStateSync, vec![1])
            .expect("runtime sync should enqueue");
        queue_session_status(
            &writer,
            notebook_protocol::protocol::NotebookDocPhaseWire::Interactive,
            notebook_protocol::protocol::RuntimeStatePhaseWire::Ready,
            notebook_protocol::protocol::InitialLoadPhaseWire::Ready,
        )
        .expect("session status should enqueue after runtime sync");

        let sync_frame = reliable_rx
            .try_recv()
            .expect("runtime sync should remain first in FIFO");
        assert_eq!(sync_frame.frame_type, NotebookFrameType::RuntimeStateSync);
        assert_eq!(sync_frame.lane, PeerEgressLane::Reliable);

        let status_frame = reliable_rx
            .try_recv()
            .expect("session status should remain behind the sync frame");
        assert_eq!(status_frame.frame_type, NotebookFrameType::SessionControl);
        assert_eq!(status_frame.lane, PeerEgressLane::Reliable);
    }

    #[tokio::test]
    async fn peer_writer_full_error_reports_frame_lane() {
        let (writer, _reliable_rx, _ephemeral_rx) = test_peer_writer_with_capacities(1, 1);

        writer
            .send_frame(NotebookFrameType::Presence, vec![1])
            .expect("first ephemeral frame should fill the queue");

        let err = writer
            .send_frame(NotebookFrameType::Broadcast, vec![2])
            .expect_err("full queue should reject immediately");
        let message = err.to_string();
        assert!(message.contains("Broadcast frame"));
        assert!(message.contains("Ephemeral lane"));
    }

    #[tokio::test]
    async fn ephemeral_queue_pressure_does_not_reject_reliable_frames() {
        let (writer, mut reliable_rx, _ephemeral_rx) = test_peer_writer_with_capacities(1, 1);

        writer
            .send_frame(NotebookFrameType::Presence, vec![1])
            .expect("first ephemeral frame should fill the ephemeral lane");
        let err = writer
            .send_frame(NotebookFrameType::Broadcast, vec![2])
            .expect_err("full ephemeral lane should reject another ephemeral frame");
        assert!(err.to_string().contains("Ephemeral lane"));

        writer
            .send_frame(NotebookFrameType::Response, vec![3])
            .expect("reliable frame should still enqueue");
        let frame = reliable_rx
            .try_recv()
            .expect("reliable lane should receive the response");
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        assert_eq!(frame.lane, PeerEgressLane::Reliable);
    }

    #[tokio::test]
    async fn peer_writer_scheduler_prefers_reliable_frames() {
        let (writer, mut reliable_rx, mut ephemeral_rx) = test_peer_writer_with_capacities(2, 2);

        writer
            .send_frame(NotebookFrameType::Presence, vec![1])
            .expect("ephemeral frame should enqueue");
        writer
            .send_frame(NotebookFrameType::Response, vec![2])
            .expect("reliable frame should enqueue");

        let mut reliable_open = true;
        let mut ephemeral_open = true;
        let first = recv_next_outbound_frame(
            &mut reliable_rx,
            &mut ephemeral_rx,
            &mut reliable_open,
            &mut ephemeral_open,
        )
        .await
        .expect("scheduler should return a frame");
        assert_eq!(first.frame_type, NotebookFrameType::Response);

        let second = recv_next_outbound_frame(
            &mut reliable_rx,
            &mut ephemeral_rx,
            &mut reliable_open,
            &mut ephemeral_open,
        )
        .await
        .expect("scheduler should return the remaining frame");
        assert_eq!(second.frame_type, NotebookFrameType::Presence);
    }

    #[tokio::test]
    async fn peer_writer_enqueue_does_not_wait_for_socket_drain() {
        let (server, client) = tokio::io::duplex(16);
        let (writer, mut task) =
            spawn_peer_writer(server, "notebook".to_string(), "peer".to_string());

        writer
            .send_frame(NotebookFrameType::AutomergeSync, vec![1; 4096])
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(
            !task.handle.is_finished(),
            "writer task should be backpressured by the socket"
        );

        for index in 0..32 {
            writer
                .send_frame(NotebookFrameType::Presence, vec![index])
                .unwrap();
        }

        drop(writer);
        drop(client);

        let result = tokio::time::timeout(std::time::Duration::from_secs(1), &mut task.handle)
            .await
            .expect("writer task should observe the closed socket")
            .expect("writer task should not panic");
        assert!(
            result.is_err(),
            "closed socket should surface as a writer task error"
        );
    }

    #[tokio::test]
    async fn peer_request_enqueue_reports_full_without_waiting_for_worker() {
        let (tx, mut rx) = mpsc::channel::<notebook_protocol::protocol::NotebookRequestEnvelope>(1);
        let (started_tx, started_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let _first = rx.recv().await;
            let _ = started_tx.send(());
            std::future::pending::<anyhow::Result<()>>().await
        });
        let worker = PeerRequestWorker { tx, handle };

        worker
            .enqueue(notebook_protocol::protocol::NotebookRequestEnvelope {
                id: Some("first".to_string()),
                required_heads: Vec::new(),
                request: NotebookRequest::GetDocBytes {},
            })
            .expect("first request should enqueue");
        started_rx.await.expect("worker should start first request");
        worker
            .enqueue(notebook_protocol::protocol::NotebookRequestEnvelope {
                id: Some("second".to_string()),
                required_heads: Vec::new(),
                request: NotebookRequest::GetDocBytes {},
            })
            .expect("second request should fill the queue");

        let start = std::time::Instant::now();
        let err = worker
            .enqueue(notebook_protocol::protocol::NotebookRequestEnvelope {
                id: Some("third".to_string()),
                required_heads: Vec::new(),
                request: NotebookRequest::GetDocBytes {},
            })
            .expect_err("full queue should reject immediately");
        assert!(
            start.elapsed() < std::time::Duration::from_millis(50),
            "request enqueue should not wait for the busy worker"
        );
        assert!(matches!(err, RequestEnqueueError::Full(_)));
    }

    #[tokio::test]
    async fn enqueue_notebook_request_rejects_malformed_payload_without_reply() {
        let (request_tx, _request_rx) =
            mpsc::channel::<notebook_protocol::protocol::NotebookRequestEnvelope>(1);
        let request_worker = PeerRequestWorker {
            tx: request_tx,
            handle: tokio::spawn(std::future::pending::<anyhow::Result<()>>()),
        };
        let (writer, mut reliable_rx, _ephemeral_rx) = test_peer_writer_with_capacities(1, 1);

        let err =
            enqueue_notebook_request(&request_worker, &writer, b"not json", "notebook", "peer")
                .expect_err("malformed request payload should fail");
        assert!(err.to_string().contains("expected ident"));
        assert!(
            reliable_rx.try_recv().is_err(),
            "malformed envelopes have no request id to echo"
        );
    }

    #[tokio::test]
    async fn enqueue_notebook_request_reports_full_queue_to_peer() {
        let (request_tx, _request_rx) =
            mpsc::channel::<notebook_protocol::protocol::NotebookRequestEnvelope>(1);
        request_tx
            .try_send(notebook_protocol::protocol::NotebookRequestEnvelope {
                id: Some("first".to_string()),
                required_heads: Vec::new(),
                request: NotebookRequest::GetDocBytes {},
            })
            .expect("queue should accept first request");
        let request_worker = PeerRequestWorker {
            tx: request_tx,
            handle: tokio::spawn(std::future::pending::<anyhow::Result<()>>()),
        };
        let (writer, mut reliable_rx, _ephemeral_rx) = test_peer_writer_with_capacities(1, 1);

        let payload = serde_json::to_vec(&notebook_protocol::protocol::NotebookRequestEnvelope {
            id: Some("second".to_string()),
            required_heads: Vec::new(),
            request: NotebookRequest::GetDocBytes {},
        })
        .unwrap();
        enqueue_notebook_request(&request_worker, &writer, &payload, "notebook", "peer")
            .expect("full queue should be reported to the peer without failing the loop");

        let frame = reliable_rx
            .try_recv()
            .expect("full queue should enqueue an error response");
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        let reply: notebook_protocol::protocol::NotebookResponseEnvelope =
            serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(reply.id.as_deref(), Some("second"));
        assert!(matches!(
            reply.response,
            notebook_protocol::protocol::NotebookResponse::Error { ref error }
                if error == "Peer request queue full"
        ));
    }

    #[tokio::test]
    async fn enqueue_notebook_request_reports_closed_worker_then_fails() {
        let (request_tx, request_rx) =
            mpsc::channel::<notebook_protocol::protocol::NotebookRequestEnvelope>(1);
        drop(request_rx);
        let request_worker = PeerRequestWorker {
            tx: request_tx,
            handle: tokio::spawn(std::future::pending::<anyhow::Result<()>>()),
        };
        let (writer, mut reliable_rx, _ephemeral_rx) = test_peer_writer_with_capacities(1, 1);

        let payload = serde_json::to_vec(&notebook_protocol::protocol::NotebookRequestEnvelope {
            id: Some("closed".to_string()),
            required_heads: Vec::new(),
            request: NotebookRequest::GetDocBytes {},
        })
        .unwrap();
        let err = enqueue_notebook_request(&request_worker, &writer, &payload, "notebook", "peer")
            .expect_err("closed worker should stop the peer loop");
        assert_eq!(err.to_string(), "peer request worker stopped for notebook");

        let frame = reliable_rx
            .try_recv()
            .expect("closed worker should enqueue an error response before failing");
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        let reply: notebook_protocol::protocol::NotebookResponseEnvelope =
            serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(reply.id.as_deref(), Some("closed"));
        assert!(matches!(
            reply.response,
            notebook_protocol::protocol::NotebookResponse::Error { ref error }
                if error == "Peer request worker stopped"
        ));
    }
}
