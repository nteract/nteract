use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

use automerge::sync;
#[cfg(test)]
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tracing::{info, warn};

use notebook_protocol::connection::{self, NotebookFrameType, TypedNotebookFrame};

use super::peer_notebook_sync::{apply_notebook_doc_frame, finish_notebook_doc_frame};
use super::{
    start_room_initial_load, NotebookRoom, RoomConnectionIdentity, RoomInitialLoadState,
    STATE_SYNC_COMPACT_THRESHOLD,
};

struct InitialLoadFrameDrain<'a> {
    framed_reader: &'a mut connection::FramedReader,
    deferred_frames: &'a mut VecDeque<TypedNotebookFrame>,
    connection_identity: &'a RoomConnectionIdentity,
}

/// Drain client acknowledgements while the room materializes.
///
/// Low-level Automerge changes remain accepted while UI/MCP mutation
/// capabilities are gated. Each frame is journaled by
/// `apply_notebook_doc_frame` before its reply is sent, and later staged source
/// batches merge normally because they retain their generation-owned actor.
async fn drain_buffered_initial_load_frames<W>(
    drain: &mut InitialLoadFrameDrain<'_>,
    writer: &mut W,
    room: &NotebookRoom,
    peer_state: &mut sync::State,
) -> Result<Option<bool>, String>
where
    W: AsyncWrite + Unpin,
{
    tokio::task::yield_now().await;
    let mut notebook_doc_converged = None;

    loop {
        let Some(frame) = drain.framed_reader.try_recv() else {
            break;
        };
        let frame = frame.map_err(|error| format!("Failed to read initial-load reply: {error}"))?;

        if frame.frame_type != NotebookFrameType::AutomergeSync {
            drain.deferred_frames.push_back(frame);
            continue;
        }

        let (effects, reply_encoded) =
            apply_notebook_doc_frame(room, peer_state, drain.connection_identity, &frame.payload)
                .await
                .map_err(|error| format!("Failed to apply initial-load reply: {error}"))?;
        notebook_doc_converged = Some(!effects.sync_reply_queued());

        if let Some(encoded) = reply_encoded {
            connection::send_typed_frame(writer, NotebookFrameType::AutomergeSync, &encoded)
                .await
                .map_err(|error| format!("Failed to send initial-load reply: {error}"))?;
        }

        finish_notebook_doc_frame(room, effects).await;
    }

    Ok(notebook_doc_converged)
}

/// Drain any final NotebookDoc frames when the room source reaches a terminal
/// failure. Earlier frames were already accepted and journaled progressively;
/// this closes the small boundary race before the connection reports failure.
async fn apply_failed_initial_load_notebook_frames<W>(
    drain: &mut InitialLoadFrameDrain<'_>,
    writer: &mut W,
    room: &NotebookRoom,
    peer_state: &mut sync::State,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    tokio::task::yield_now().await;

    let mut pending = std::mem::take(drain.deferred_frames);
    loop {
        while let Some(frame) = drain.framed_reader.try_recv() {
            pending.push_back(
                frame.map_err(|error| format!("Failed to read failed-load frame: {error}"))?,
            );
        }

        if pending.is_empty() {
            break;
        }

        while let Some(frame) = pending.pop_front() {
            if frame.frame_type != NotebookFrameType::AutomergeSync {
                drain.deferred_frames.push_back(frame);
                continue;
            }

            let (effects, reply_encoded) = apply_notebook_doc_frame(
                room,
                peer_state,
                drain.connection_identity,
                &frame.payload,
            )
            .await
            .map_err(|error| format!("Failed to preserve failed-load edit: {error}"))?;

            if let Some(encoded) = reply_encoded {
                connection::send_typed_frame(writer, NotebookFrameType::AutomergeSync, &encoded)
                    .await
                    .map_err(|error| format!("Failed to acknowledge failed-load edit: {error}"))?;
            }
            finish_notebook_doc_frame(room, effects).await;
        }
    }

    Ok(())
}

async fn send_initial_load_doc_delta<W>(
    writer: &mut W,
    room: &NotebookRoom,
    peer_state: &mut sync::State,
) -> anyhow::Result<bool>
where
    W: AsyncWrite + Unpin,
{
    let encoded = {
        let mut doc = room.doc.write().await;
        doc.generate_sync_message_recovering(peer_state, "room-initial-load")
            .map_err(|error| anyhow::anyhow!("initial-load sync generation failed: {error}"))?
            .map(|message| message.encode())
    };

    let sent = encoded.is_some();
    if let Some(encoded) = encoded {
        connection::send_typed_frame(writer, NotebookFrameType::AutomergeSync, &encoded)
            .await
            .map_err(|error| anyhow::anyhow!("initial-load sync send failed: {error}"))?;
    }
    Ok(sent)
}

struct InitialLoadSyncOutcome {
    initial_load_phase: notebook_protocol::protocol::InitialLoadPhaseWire,
    notebook_doc_phase: notebook_protocol::protocol::NotebookDocPhaseWire,
}

pub(crate) async fn send_session_status<W>(
    writer: &mut W,
    notebook_doc: notebook_protocol::protocol::NotebookDocPhaseWire,
    runtime_state: notebook_protocol::protocol::RuntimeStatePhaseWire,
    initial_load: notebook_protocol::protocol::InitialLoadPhaseWire,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    connection::send_typed_json_frame(
        writer,
        NotebookFrameType::SessionControl,
        &notebook_protocol::protocol::SessionControlMessage::SyncStatus(
            notebook_protocol::protocol::SessionSyncStatusWire {
                notebook_doc,
                runtime_state,
                initial_load,
            },
        ),
    )
    .await?;
    Ok(())
}

/// State carried from the initial notebook-doc sync into the steady-state loop.
///
/// See [`send_initial_notebook_doc_sync`]. `peer_state` tracks what the
/// daemon has already advertised about the notebook doc so subsequent
/// generate_sync_message calls compute correct deltas (including deltas
/// emitted by `streaming_load_cells`).
pub(crate) struct InitialSyncState {
    pub(crate) peer_state: sync::State,
}

impl InitialSyncState {
    pub(crate) fn new() -> Self {
        Self {
            peer_state: sync::State::new(),
        }
    }
}

/// Generate and send the initial notebook-doc AutomergeSync frame.
///
/// Returns the `peer_state` so the rest of bootstrap (and streaming load)
/// continues from the same baseline and emits correct deltas.
pub(crate) async fn send_initial_notebook_doc_sync<W>(
    writer: &mut W,
    room: &Arc<NotebookRoom>,
) -> anyhow::Result<InitialSyncState>
where
    W: AsyncWrite + Unpin,
{
    let mut sync_state = InitialSyncState::new();

    // Encode the sync message inside the lock, then send outside it to avoid
    // holding the write lock across async I/O.
    let initial_encoded = {
        let mut doc = room.doc.write().await;
        match doc.generate_sync_message_recovering(&mut sync_state.peer_state, "initial-doc-sync") {
            Ok(message) => message.map(|msg| msg.encode()),
            Err(e) => {
                warn!("[notebook-sync] initial doc sync failed: {}", e);
                return Err(anyhow::anyhow!("initial doc sync failed: {e}"));
            }
        }
    };
    if let Some(encoded) = initial_encoded {
        connection::send_typed_frame(writer, NotebookFrameType::AutomergeSync, &encoded).await?;
    }

    Ok(sync_state)
}

/// Generate and send the initial RuntimeStateDoc sync frame.
///
/// The caller owns `state_peer_state` because the steady-state peer loop uses
/// the same sync state to compute later RuntimeStateDoc deltas.
pub(crate) async fn send_initial_runtime_state_sync<W>(
    writer: &mut W,
    room: &Arc<NotebookRoom>,
    state_peer_state: &mut sync::State,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    // Encode inside the RuntimeStateDoc lock, then send outside it to avoid
    // holding state while awaiting socket I/O.
    let initial_state_encoded = room
        .state
        .with_doc(|state_doc| {
            // Safety net: compact before initial sync if the doc grew too large.
            // 80 MiB leaves headroom under the 100 MiB frame limit.
            const COMPACTION_THRESHOLD: usize = 80 * 1024 * 1024;
            if state_doc.compact_if_oversized(COMPACTION_THRESHOLD) {
                info!("[notebook-sync] Compacted oversized RuntimeStateDoc before initial sync");
            }
            state_doc
                .generate_sync_message_bounded_encoded_recovering(
                    state_peer_state,
                    STATE_SYNC_COMPACT_THRESHOLD,
                    "initial-state-sync",
                )
                .map_err(|e| {
                    warn!("[notebook-sync] initial runtime state sync failed: {}", e);
                    runtime_doc::RuntimeStateError::from(e)
                })
        })
        .map_err(|e| anyhow::anyhow!("initial runtime state sync failed: {e}"))?;
    if let Some(encoded) = initial_state_encoded {
        connection::send_typed_frame(writer, NotebookFrameType::RuntimeStateSync, &encoded).await?;
    }

    Ok(())
}

/// Stream initial notebook file contents into the room before steady-state sync.
///
/// The caller passes `peer_state` from the initial notebook-doc sync so each
/// streamed batch can produce deltas from the same baseline.
///
/// Test-only wrapper that supplies an inert frame drain (exhausted framed
/// reader, no deferred frames, local connection identity) so ordering
/// invariants can be asserted on the writer side without a live client
/// stream.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(crate) async fn stream_initial_load<R, W>(
    _reader: &mut R,
    writer: &mut W,
    room: &Arc<NotebookRoom>,
    needs_load: Option<&Path>,
    execution_store_dir: &Path,
    peer_state: &mut sync::State,
    notebook_doc_phase: notebook_protocol::protocol::NotebookDocPhaseWire,
    runtime_state_phase: notebook_protocol::protocol::RuntimeStatePhaseWire,
    initial_load_phase: notebook_protocol::protocol::InitialLoadPhaseWire,
    client_protocol_version: u8,
) -> anyhow::Result<notebook_protocol::protocol::InitialLoadPhaseWire>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut framed_reader = connection::FramedReader::spawn(tokio::io::empty(), 1);
    let mut deferred_frames = VecDeque::new();
    let connection_identity = RoomConnectionIdentity::local(Some("mcp:test".to_string())).await?;
    Ok(stream_initial_load_inner(
        writer,
        room,
        needs_load,
        execution_store_dir,
        peer_state,
        notebook_doc_phase,
        runtime_state_phase,
        initial_load_phase,
        client_protocol_version,
        InitialLoadFrameDrain {
            framed_reader: &mut framed_reader,
            deferred_frames: &mut deferred_frames,
            connection_identity: &connection_identity,
        },
    )
    .await?
    .initial_load_phase)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn stream_initial_load_with_frame_drain<W>(
    framed_reader: &mut connection::FramedReader,
    writer: &mut W,
    deferred_frames: &mut VecDeque<TypedNotebookFrame>,
    room: &Arc<NotebookRoom>,
    needs_load: Option<&Path>,
    execution_store_dir: &Path,
    peer_state: &mut sync::State,
    notebook_doc_phase: &mut notebook_protocol::protocol::NotebookDocPhaseWire,
    runtime_state_phase: notebook_protocol::protocol::RuntimeStatePhaseWire,
    initial_load_phase: notebook_protocol::protocol::InitialLoadPhaseWire,
    client_protocol_version: u8,
    connection_identity: &RoomConnectionIdentity,
) -> anyhow::Result<notebook_protocol::protocol::InitialLoadPhaseWire>
where
    W: AsyncWrite + Unpin,
{
    let outcome = stream_initial_load_inner(
        writer,
        room,
        needs_load,
        execution_store_dir,
        peer_state,
        *notebook_doc_phase,
        runtime_state_phase,
        initial_load_phase,
        client_protocol_version,
        InitialLoadFrameDrain {
            framed_reader,
            deferred_frames,
            connection_identity,
        },
    )
    .await?;
    *notebook_doc_phase = outcome.notebook_doc_phase;
    Ok(outcome.initial_load_phase)
}

#[allow(clippy::too_many_arguments)]
async fn stream_initial_load_inner<W>(
    writer: &mut W,
    room: &Arc<NotebookRoom>,
    needs_load: Option<&Path>,
    execution_store_dir: &Path,
    peer_state: &mut sync::State,
    mut notebook_doc_phase: notebook_protocol::protocol::NotebookDocPhaseWire,
    runtime_state_phase: notebook_protocol::protocol::RuntimeStatePhaseWire,
    initial_load_phase: notebook_protocol::protocol::InitialLoadPhaseWire,
    client_protocol_version: u8,
    mut frame_drain: InitialLoadFrameDrain<'_>,
) -> anyhow::Result<InitialLoadSyncOutcome>
where
    W: AsyncWrite + Unpin,
{
    let mut changed_rx = room.broadcasts.changed_tx.subscribe();
    let mut source_state_rx = if let Some(load_path) = needs_load {
        start_room_initial_load(
            room,
            load_path.to_path_buf(),
            execution_store_dir.to_path_buf(),
        );
        room.initial_load.subscribe_authoritative()
    } else if room.is_loading()
        || matches!(
            initial_load_phase,
            notebook_protocol::protocol::InitialLoadPhaseWire::Streaming
                | notebook_protocol::protocol::InitialLoadPhaseWire::Failed { .. }
        )
    {
        room.initial_load.subscribe_authoritative()
    } else {
        return Ok(InitialLoadSyncOutcome {
            initial_load_phase,
            notebook_doc_phase,
        });
    };

    let mut generation = source_state_rx.borrow().generation();
    let mut notebook_doc_converged = false;
    loop {
        let source_state = source_state_rx.borrow().clone();
        let state = crate::notebook_sync_server::RoomInitialLoad::project_state(&source_state);
        match state {
            RoomInitialLoadState::Ready {
                generation: settled_generation,
                ..
            } if settled_generation == generation => {
                // Close the race with the final batch notification. This is
                // also the completion signal for a valid zero-cell notebook.
                if send_initial_load_doc_delta(writer, room, peer_state).await? {
                    notebook_doc_converged = false;
                }
                if let Some(converged) =
                    drain_buffered_initial_load_frames(&mut frame_drain, writer, room, peer_state)
                        .await
                        .map_err(anyhow::Error::msg)?
                {
                    notebook_doc_converged = converged;
                }
                if notebook_doc_converged {
                    notebook_doc_phase =
                        notebook_protocol::protocol::NotebookDocPhaseWire::Interactive;
                }
                let phase = notebook_protocol::protocol::InitialLoadPhaseWire::Ready;
                if client_protocol_version >= 3 {
                    send_session_status(
                        writer,
                        notebook_doc_phase,
                        runtime_state_phase,
                        phase.clone(),
                    )
                    .await?;
                }
                return Ok(InitialLoadSyncOutcome {
                    initial_load_phase: phase,
                    notebook_doc_phase,
                });
            }
            RoomInitialLoadState::Failed {
                generation: settled_generation,
                reason,
            } if settled_generation == generation => {
                apply_failed_initial_load_notebook_frames(
                    &mut frame_drain,
                    writer,
                    room,
                    peer_state,
                )
                .await
                .map_err(anyhow::Error::msg)?;
                // Preserving buffered edits awaits room locks and transport.
                // An external watcher/save can reconcile the source and
                // advance Failed(g) to Ready(g+1) meanwhile. Never publish the
                // stale failure after that recovery; follow the new generation
                // from the top of the loop instead.
                let current_state = room.initial_load.state();
                if current_state.generation() != settled_generation {
                    generation = current_state.generation();
                    continue;
                }
                send_initial_load_doc_delta(writer, room, peer_state).await?;
                let phase = notebook_protocol::protocol::InitialLoadPhaseWire::Failed {
                    reason: reason.clone(),
                };
                if client_protocol_version >= 3 {
                    send_session_status(writer, notebook_doc_phase, runtime_state_phase, phase)
                        .await?;
                }
                return Err(anyhow::anyhow!("Initial materialization failed: {reason}"));
            }
            RoomInitialLoadState::Loading {
                generation: active_generation,
            } if active_generation == generation => {}
            ref newer if newer.generation() > generation => {
                // Explicit retry/reconciliation advances the room generation.
                // Follow that authoritative state instead of surfacing a stale
                // terminal result captured by this waiter.
                generation = newer.generation();
                continue;
            }
            other => {
                return Err(anyhow::anyhow!(
                    "Initial materialization generation changed while waiting: expected {}, observed {:?}",
                    generation,
                    other
                ));
            }
        }

        tokio::select! {
            changed = source_state_rx.changed() => {
                if changed.is_err() {
                    return Err(anyhow::anyhow!("Initial materialization state channel closed"));
                }
            }
            changed = changed_rx.recv() => {
                match changed {
                    Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if send_initial_load_doc_delta(writer, room, peer_state).await? {
                            notebook_doc_converged = false;
                        }
                        if let Some(converged) = drain_buffered_initial_load_frames(
                            &mut frame_drain,
                            writer,
                            room,
                            peer_state,
                        )
                        .await
                        .map_err(anyhow::Error::msg)?
                        {
                            notebook_doc_converged = converged;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err(anyhow::anyhow!("Notebook room closed during initial materialization"));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll};

    use notebook_protocol::protocol::{
        InitialLoadPhaseWire, NotebookDocPhaseWire, RuntimeStatePhaseWire, SessionControlMessage,
    };
    use tokio::io::AsyncWrite;
    use uuid::Uuid;

    use super::*;
    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::{
        apply_ipynb_changes, save_notebook_to_disk, RoomInitialLoad, RoomInitialLoadStart,
    };

    #[derive(Default)]
    struct CaptureWriter {
        bytes: Vec<u8>,
    }

    impl AsyncWrite for CaptureWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.bytes.extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[derive(Default)]
    struct FailFirstWrite {
        bytes: Vec<u8>,
        failed: bool,
        partial_room: Option<Arc<NotebookRoom>>,
        observed_partial_doc: bool,
        observed_partial_executions: bool,
    }

    impl FailFirstWrite {
        fn expecting_partial_state(room: &Arc<NotebookRoom>) -> Self {
            Self {
                partial_room: Some(Arc::clone(room)),
                ..Self::default()
            }
        }
    }

    impl AsyncWrite for FailFirstWrite {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if !self.failed {
                self.failed = true;
                if let Some(room) = self.partial_room.clone() {
                    let doc = room
                        .doc
                        .try_read()
                        .expect("notebook doc lock should be released before socket write");
                    assert!(
                        doc.cell_count() > 0,
                        "injected write failure should happen after partial cells are loaded"
                    );
                    drop(doc);
                    self.observed_partial_doc = true;

                    let observed_partial_executions = room
                        .state
                        .with_doc(|state_doc| Ok(!state_doc.read_state().executions.is_empty()))
                        .expect("runtime state doc should be readable before injected failure");
                    assert!(
                        observed_partial_executions,
                        "injected write failure should happen after partial executions are loaded"
                    );
                    self.observed_partial_executions = true;
                }
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "injected first write failure",
                )));
            }
            self.bytes.extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    fn test_room(tmp: &tempfile::TempDir) -> Arc<NotebookRoom> {
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        Arc::new(NotebookRoom::new_fresh(
            Uuid::new_v4(),
            None,
            tmp.path(),
            blob_store,
            true,
        ))
    }

    fn empty_projection(generation: u64) -> Arc<runtimed_client::protocol::NotebookProjection> {
        Arc::new(runtimed_client::protocol::NotebookProjection {
            schema_version: runtimed_client::protocol::NOTEBOOK_PROJECTION_SCHEMA_VERSION,
            load_generation: generation,
            notebook_id: "test-notebook".to_string(),
            notebook_path: None,
            cells: Vec::new(),
            dependencies: Vec::new(),
            runtime: Default::default(),
            source_state: Default::default(),
            availability: runtimed_client::protocol::NotebookAvailabilityProjection {
                phase: runtimed_client::protocol::NotebookAvailabilityPhase::Attached,
                generation,
                document_heads: Vec::new(),
                projection_heads: Vec::new(),
                capabilities: runtimed_client::protocol::NotebookCapabilities {
                    read: false,
                    mutate: false,
                    execute: false,
                },
                reason: None,
            },
            readiness: runtimed_client::protocol::NotebookReadiness {
                projection: false,
                document: false,
                runtime: false,
            },
            projection_complete: true,
            projection_heads: vec![format!("projection-head-{generation}")],
            notebook_heads: vec![format!("projection-head-{generation}")],
            runtime_state_heads: Vec::new(),
            captured_at: chrono::Utc::now(),
        })
    }

    async fn write_one_cell_notebook(path: &Path) {
        tokio::fs::write(
            path,
            r##"{
                "nbformat": 4,
                "nbformat_minor": 5,
                "metadata": {},
                "cells": [
                    {
                        "id": "loaded-cell",
                        "cell_type": "code",
                        "metadata": {},
                        "source": "x = 1",
                        "execution_count": 7,
                        "outputs": [
                            {
                                "output_type": "stream",
                                "name": "stdout",
                                "text": "hello\n"
                            }
                        ]
                    }
                ]
            }"##,
        )
        .await
        .unwrap();
    }

    fn frame_types(bytes: &[u8]) -> Vec<NotebookFrameType> {
        let mut types = Vec::new();
        let mut offset = 0;
        while offset < bytes.len() {
            let len = u32::from_be_bytes(
                bytes[offset..offset + 4]
                    .try_into()
                    .expect("frame length prefix"),
            ) as usize;
            offset += 4;
            let frame = &bytes[offset..offset + len];
            offset += len;
            types.push(NotebookFrameType::try_from(frame[0]).expect("known frame type"));
        }
        types
    }

    fn decode_session_statuses(bytes: &[u8]) -> Vec<SessionControlMessage> {
        let mut statuses = Vec::new();
        let mut offset = 0;
        while offset < bytes.len() {
            let len = u32::from_be_bytes(
                bytes[offset..offset + 4]
                    .try_into()
                    .expect("frame length prefix"),
            ) as usize;
            offset += 4;
            let frame = &bytes[offset..offset + len];
            offset += len;

            if frame[0] == NotebookFrameType::SessionControl as u8 {
                statuses.push(serde_json::from_slice(&frame[1..]).expect("session control json"));
            }
        }
        statuses
    }

    #[tokio::test(flavor = "current_thread")]
    async fn room_initial_load_coalesces_waiters_on_one_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("source.ipynb");
        write_one_cell_notebook(&load_path).await;

        let authoritative = room.initial_load.subscribe_authoritative();
        start_room_initial_load(&room, load_path.clone(), tmp.path().to_path_buf());
        let first_generation = authoritative.borrow().generation();
        assert_eq!(
            room.initial_load.state(),
            RoomInitialLoadState::Loading {
                generation: first_generation
            }
        );

        start_room_initial_load(&room, load_path, tmp.path().to_path_buf());
        assert_eq!(
            room.initial_load.state().generation(),
            first_generation,
            "all waiters must observe the same source generation"
        );

        let settled = room.initial_load.wait_until_settled().await;
        assert_eq!(
            settled,
            RoomInitialLoadState::Ready {
                generation: first_generation,
                cell_count: 1,
            }
        );
        assert_eq!(room.doc.read().await.cell_count(), 1);
    }

    #[tokio::test]
    async fn dropping_unfinished_source_claim_terminalizes_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("cancelled.ipynb");
        room.initial_load.mark_required();
        let claim = crate::notebook_sync_server::claim_room_initial_load(&room, load_path)
            .expect("required source generation should be claimable");
        let generation = claim.generation();

        drop(claim);

        let settled = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            room.initial_load.wait_until_settled(),
        )
        .await
        .expect("cancelled source claim must wake waiters");
        assert!(matches!(
            settled,
            RoomInitialLoadState::Failed {
                generation: observed,
                reason,
            } if observed == generation && reason.contains("ended before completion")
        ));
        assert!(room.load_failed());
    }

    #[tokio::test]
    async fn unwinding_source_owner_terminalizes_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        room.initial_load.mark_required();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _claim = crate::notebook_sync_server::claim_room_initial_load(
                &room,
                tmp.path().join("panicked.ipynb"),
            )
            .expect("required source generation should be claimable");
            panic!("injected source owner panic");
        }));

        assert!(result.is_err());
        assert!(matches!(
            room.initial_load.state(),
            RoomInitialLoadState::Failed { reason, .. }
                if reason.contains("ended before completion")
        ));
    }

    #[tokio::test]
    async fn later_open_can_retry_failed_pristine_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("retry.ipynb");

        start_room_initial_load(&room, load_path.clone(), tmp.path().to_path_buf());
        assert!(matches!(
            room.initial_load.wait_until_settled().await,
            RoomInitialLoadState::Failed { generation: 1, .. }
        ));

        write_one_cell_notebook(&load_path).await;
        assert!(
            crate::notebook_sync_server::retry_failed_room_initial_load_if_safe(
                &room,
                load_path,
                tmp.path().to_path_buf(),
            )
            .await,
            "a failed generation with no published or peer changes is safe to retry"
        );

        assert!(matches!(
            room.initial_load.wait_until_settled().await,
            RoomInitialLoadState::Ready {
                generation: 2,
                cell_count: 1,
            }
        ));
        assert_eq!(room.doc.read().await.cell_count(), 1);
        assert!(!room.load_failed());
    }

    #[tokio::test]
    async fn failed_generation_with_live_edits_is_not_replayed() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("do-not-replay.ipynb");

        start_room_initial_load(&room, load_path.clone(), tmp.path().to_path_buf());
        assert!(matches!(
            room.initial_load.wait_until_settled().await,
            RoomInitialLoadState::Failed { generation: 1, .. }
        ));
        {
            let mut doc = room.doc.write().await;
            doc.add_cell(0, "peer-cell", "code").unwrap();
            doc.update_source("peer-cell", "peer truth").unwrap();
        }
        write_one_cell_notebook(&load_path).await;

        assert!(
            !crate::notebook_sync_server::retry_failed_room_initial_load_if_safe(
                &room,
                load_path,
                tmp.path().to_path_buf(),
            )
            .await,
            "automatic replay must stop once the live document contains edits"
        );
        assert!(matches!(
            room.initial_load.state(),
            RoomInitialLoadState::Failed { generation: 1, .. }
        ));
        assert_eq!(
            room.doc
                .read()
                .await
                .get_cell("peer-cell")
                .expect("peer edit must be preserved")
                .source,
            "peer truth"
        );
    }

    #[tokio::test]
    async fn late_waiter_observes_ready_generation_after_loading_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        room.initial_load.mark_required();
        let start = room.initial_load.begin();
        let RoomInitialLoadStart::Started { generation } = start else {
            panic!("pending load should be claimable");
        };
        assert!(room.lifecycle.publish_recovered_projection_ready(
            generation,
            empty_projection(generation),
            Vec::new(),
        ));
        assert!(room.initial_load.complete_ready(generation, 0));

        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();
        let phase = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            None,
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect("late waiter should consume the sticky terminal state");

        assert_eq!(phase, InitialLoadPhaseWire::Ready);
    }

    #[tokio::test]
    async fn peer_write_failure_does_not_cancel_or_roll_back_room_load() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("source.ipynb");
        write_one_cell_notebook(&load_path).await;
        let mut reader = tokio::io::empty();
        let mut writer = FailFirstWrite::expecting_partial_state(&room);
        let mut peer_state = sync::State::new();

        let err = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect_err("injected peer write failure should drop only this waiter");

        assert!(
            err.to_string()
                .contains("initial-load sync send failed: injected first write failure"),
            "error should preserve the peer transport failure"
        );
        assert!(writer.observed_partial_doc);
        assert!(writer.observed_partial_executions);

        let settled = room.initial_load.wait_until_settled().await;
        assert!(matches!(
            settled,
            RoomInitialLoadState::Ready { cell_count: 1, .. }
        ));
        assert_eq!(
            room.doc.read().await.cell_count(),
            1,
            "peer transport failure must not clear authoritative room cells"
        );
        room.state
            .with_doc(|state_doc| {
                assert!(
                    !state_doc.read_state().executions.is_empty(),
                    "peer transport failure must not clear room runtime state"
                );
                Ok(())
            })
            .unwrap();
        assert!(!room.load_failed());
        assert!(decode_session_statuses(&writer.bytes).is_empty());
    }

    #[tokio::test]
    async fn stream_initial_load_v2_client_suppresses_session_status_frames() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("source.ipynb");
        write_one_cell_notebook(&load_path).await;
        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();

        let phase = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            2,
        )
        .await
        .expect("valid notebook should stream successfully");

        assert_eq!(phase, InitialLoadPhaseWire::Ready);
        let emitted_frame_types = frame_types(&writer.bytes);
        assert!(
            !emitted_frame_types.is_empty(),
            "pre-v3 success must still emit document sync frames"
        );
        assert!(
            decode_session_statuses(&writer.bytes).is_empty(),
            "pre-v3 clients must not receive SessionControl frames"
        );
        assert!(
            emitted_frame_types
                .iter()
                .all(|frame_type| *frame_type == NotebookFrameType::AutomergeSync),
            "pre-v3 success should only emit Automerge sync frames"
        );
    }

    #[tokio::test]
    async fn stream_initial_load_v2_transport_failure_does_not_fail_source() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("source.ipynb");
        write_one_cell_notebook(&load_path).await;
        let mut reader = tokio::io::empty();
        let mut writer = FailFirstWrite::expecting_partial_state(&room);
        let mut peer_state = sync::State::new();

        stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            2,
        )
        .await
        .expect_err("injected write failure should fail streaming load");

        assert!(writer.observed_partial_doc);
        assert!(writer.observed_partial_executions);
        assert!(
            writer.bytes.is_empty(),
            "pre-v3 transport failure must not emit SessionControl frames"
        );
        assert!(matches!(
            room.initial_load.wait_until_settled().await,
            RoomInitialLoadState::Ready { cell_count: 1, .. }
        ));
        assert_eq!(room.doc.read().await.cell_count(), 1);
    }

    #[tokio::test]
    async fn stream_initial_load_missing_file_emits_failed_status() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("does-not-exist.ipynb");
        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();

        let err = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect_err("missing file should fail streaming load");

        assert!(
            err.to_string()
                .contains("Initial materialization failed: Failed to read notebook"),
            "missing file should preserve the load failure reason"
        );

        let statuses = decode_session_statuses(&writer.bytes);
        assert_eq!(statuses.len(), 1);
        let SessionControlMessage::SyncStatus(status) = &statuses[0];
        match &status.initial_load {
            InitialLoadPhaseWire::Failed { reason } => {
                assert!(
                    reason.contains("Failed to read notebook"),
                    "failed status should include the missing-file reason: {reason}"
                );
            }
            other => panic!("expected failed initial load status, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn late_waiter_observes_sticky_failed_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        room.initial_load.mark_required();
        let start = room.initial_load.begin();
        let RoomInitialLoadStart::Started { generation } = start else {
            panic!("pending load should be claimable");
        };
        assert!(room
            .initial_load
            .complete_failed(generation, "source became unreadable".to_string()));

        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();
        let error = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            None,
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect_err("late waiter must observe the room's sticky failure");

        assert!(error
            .to_string()
            .contains("Initial materialization failed: source became unreadable"));
        let statuses = decode_session_statuses(&writer.bytes);
        assert_eq!(statuses.len(), 1);
        let SessionControlMessage::SyncStatus(status) = &statuses[0];
        assert_eq!(
            status.initial_load,
            InitialLoadPhaseWire::Failed {
                reason: "source became unreadable".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn failed_generation_preserves_journaled_peer_changes_before_terminal_status() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        {
            let mut doc = room.doc.write().await;
            doc.add_cell(0, "progressive-cell", "code").unwrap();
            doc.update_source("progressive-cell", "source batch")
                .unwrap();
        }

        let mut peer_state = sync::State::new();
        let initial = room
            .doc
            .write()
            .await
            .generate_sync_message_recovering(&mut peer_state, "test-failed-load-initial")
            .unwrap()
            .expect("room should publish the progressive cell");
        let mut client_doc = notebook_doc::NotebookDoc::bootstrap(
            notebook_doc::TextEncoding::Utf16CodeUnit,
            "mcp:test",
        );
        let mut client_state = sync::State::new();
        client_doc
            .receive_sync_message_recovering(&mut client_state, initial, "test-failed-load-client")
            .unwrap();
        for round in 0..32 {
            let from_client = client_doc
                .generate_sync_message_recovering(
                    &mut client_state,
                    &format!("test-failed-load-client-converge-{round}"),
                )
                .unwrap();
            let from_room = room
                .doc
                .write()
                .await
                .generate_sync_message_recovering(
                    &mut peer_state,
                    &format!("test-failed-load-room-converge-{round}"),
                )
                .unwrap();
            if from_client.is_none() && from_room.is_none() {
                break;
            }
            if let Some(message) = from_client {
                room.doc
                    .write()
                    .await
                    .receive_sync_message_recovering(
                        &mut peer_state,
                        message,
                        "test-failed-load-room-receive",
                    )
                    .unwrap();
            }
            if let Some(message) = from_room {
                client_doc
                    .receive_sync_message_recovering(
                        &mut client_state,
                        message,
                        "test-failed-load-client-receive",
                    )
                    .unwrap();
            }
        }

        client_doc
            .update_source("progressive-cell", "edited before source failure")
            .unwrap();
        let peer_edit = client_doc
            .generate_sync_message_recovering(&mut client_state, "test-failed-load-edit")
            .unwrap()
            .expect("client edit should produce a sync message");
        assert!(
            !peer_edit.changes.is_empty(),
            "regression requires a change-bearing frame deferred by bootstrap"
        );
        let empty_ack = sync::Message {
            heads: peer_edit.heads.clone(),
            need: peer_edit.need.clone(),
            have: peer_edit.have.clone(),
            changes: sync::ChunkList::empty(),
            flags: peer_edit.flags,
            version: peer_edit.version.clone(),
        };
        let edit_payload = peer_edit.encode();
        let ack_payload = empty_ack.encode();

        let mut wire = Vec::new();
        connection::send_typed_frame(&mut wire, NotebookFrameType::AutomergeSync, &edit_payload)
            .await
            .unwrap();
        connection::send_typed_frame(&mut wire, NotebookFrameType::AutomergeSync, &ack_payload)
            .await
            .unwrap();
        let mut framed_reader = connection::FramedReader::spawn(std::io::Cursor::new(wire), 4);
        let identity = RoomConnectionIdentity::local(Some("mcp:test".to_string()))
            .await
            .unwrap();
        let mut deferred_frames = VecDeque::new();
        let mut writer = CaptureWriter::default();
        let convergence = drain_buffered_initial_load_frames(
            &mut InitialLoadFrameDrain {
                framed_reader: &mut framed_reader,
                deferred_frames: &mut deferred_frames,
                connection_identity: &identity,
            },
            &mut writer,
            &room,
            &mut peer_state,
        )
        .await
        .unwrap();

        assert_eq!(convergence, Some(true));
        assert!(
            deferred_frames.is_empty(),
            "NotebookDoc frames must be accepted and journaled during loading"
        );
        assert_eq!(
            room.doc
                .read()
                .await
                .get_cell("progressive-cell")
                .unwrap()
                .source,
            "edited before source failure",
            "the later ACK must causally follow the accepted peer edit"
        );

        room.initial_load.mark_required();
        let start = room.initial_load.begin();
        let RoomInitialLoadStart::Started { generation } = start else {
            panic!("pending load should be claimable");
        };
        assert!(room
            .initial_load
            .complete_failed(generation, "source batch failed".to_string()));
        room.mark_load_failed();

        let mut notebook_doc_phase = NotebookDocPhaseWire::Syncing;
        let error = stream_initial_load_with_frame_drain(
            &mut framed_reader,
            &mut writer,
            &mut deferred_frames,
            &room,
            None,
            tmp.path(),
            &mut peer_state,
            &mut notebook_doc_phase,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
            &identity,
        )
        .await
        .expect_err("the source generation remains terminally failed");

        assert!(error
            .to_string()
            .contains("Initial materialization failed: source batch failed"));
        assert_eq!(
            room.doc
                .read()
                .await
                .get_cell("progressive-cell")
                .unwrap()
                .source,
            "edited before source failure",
            "terminal source failure must not discard an already-deferred peer edit"
        );
        assert!(deferred_frames.is_empty());
        let statuses = decode_session_statuses(&writer.bytes);
        assert_eq!(statuses.len(), 1);
        let SessionControlMessage::SyncStatus(status) = &statuses[0];
        assert!(matches!(
            status.initial_load,
            InitialLoadPhaseWire::Failed { .. }
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn late_waiter_follows_recovery_that_races_failed_frame_drain() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        room.initial_load.mark_required();
        let start = room.initial_load.begin();
        let RoomInitialLoadStart::Started { generation } = start else {
            panic!("pending load should be claimable");
        };
        assert!(room
            .initial_load
            .complete_failed(generation, "transient failure".to_string()));
        room.mark_load_failed();

        let mut framed_reader = connection::FramedReader::spawn(tokio::io::empty(), 1);
        let mut deferred_frames = VecDeque::new();
        let identity = RoomConnectionIdentity::local(Some("mcp:test".to_string()))
            .await
            .unwrap();
        let recovery_room = Arc::clone(&room);
        let recovery = tokio::spawn(async move {
            // The task cannot run until the stream yields in
            // `apply_failed_initial_load_notebook_frames`.
            recovery_room.mark_load_recovered(0).await.unwrap();
        });
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();
        let mut notebook_doc_phase = NotebookDocPhaseWire::Syncing;
        let phase = stream_initial_load_with_frame_drain(
            &mut framed_reader,
            &mut writer,
            &mut deferred_frames,
            &room,
            None,
            tmp.path(),
            &mut peer_state,
            &mut notebook_doc_phase,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
            &identity,
        )
        .await
        .expect("waiter should follow the recovered generation");

        recovery.await.unwrap();
        assert_eq!(phase, InitialLoadPhaseWire::Ready);
        assert!(matches!(
            room.initial_load.state(),
            RoomInitialLoadState::Ready {
                generation: recovered,
                cell_count: 0,
            } if recovered == generation + 1
        ));
        let statuses = decode_session_statuses(&writer.bytes);
        assert_eq!(statuses.len(), 1);
        let SessionControlMessage::SyncStatus(status) = &statuses[0];
        assert_eq!(status.initial_load, InitialLoadPhaseWire::Ready);
    }

    #[tokio::test]
    async fn source_preparation_failure_leaves_live_doc_untouched_and_preserves_source_file() {
        let tmp = tempfile::tempdir().unwrap();
        let load_path = tmp.path().join("partial.ipynb");
        let source_bytes = br##"{
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": [
                {"id":"one","cell_type":"code","metadata":{},"source":"1","execution_count":null,"outputs":[]},
                {"id":"two","cell_type":"code","metadata":{},"source":"2","execution_count":null,"outputs":[]},
                {"id":"three","cell_type":"code","metadata":{},"source":"3","execution_count":null,"outputs":[]},
                {"id":"bad","cell_type":"markdown","metadata":{},"source":"![x](attachment:bad)","attachments":{"bad":"not-a-mime-bundle"}}
            ]
        }"##;
        tokio::fs::write(&load_path, source_bytes).await.unwrap();
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let room = Arc::new(NotebookRoom::new_fresh(
            Uuid::new_v4(),
            Some(load_path.clone()),
            tmp.path(),
            blob_store,
            false,
        ));
        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();

        let error = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect_err("malformed fourth-cell attachment should fail the source");

        assert!(error
            .to_string()
            .contains("attachment bad must be a MIME bundle"));
        assert!(matches!(
            room.initial_load.state(),
            RoomInitialLoadState::Failed { .. }
        ));
        assert_eq!(
            room.doc.read().await.cell_count(),
            0,
            "source preparation must finish before the first live change is published"
        );
        assert!(room.load_failed());

        let save_error = save_notebook_to_disk(&room, None)
            .await
            .expect_err("failed-source persistence guard must reject in-place save");
        assert!(matches!(
            save_error,
            crate::notebook_sync_server::SaveError::CheckpointBlocked {
                reason: notebook_protocol::protocol::SaveBlockedReason::SourceDegraded { .. },
                ..
            }
        ));
        assert_eq!(tokio::fs::read(&load_path).await.unwrap(), source_bytes);
    }

    #[tokio::test]
    async fn valid_zero_cell_notebook_publishes_explicit_ready_count() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("empty.ipynb");
        tokio::fs::write(
            &load_path,
            r#"{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[]}"#,
        )
        .await
        .unwrap();
        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();

        let phase = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect("valid empty notebook should settle successfully");

        assert_eq!(phase, InitialLoadPhaseWire::Ready);
        let state = room.initial_load.state();
        let RoomInitialLoadState::Ready {
            generation,
            cell_count,
        } = state
        else {
            panic!("expected explicit Ready state, got {state:?}");
        };
        assert_eq!(cell_count, 0);
        assert!(matches!(
            room.initial_load.begin(),
            RoomInitialLoadStart::Observing {
                generation: observed
            } if observed == generation
        ));
    }

    #[test]
    fn stale_completion_cannot_publish_over_retry_generation() {
        let initial_load = RoomInitialLoad::default();
        let start = initial_load.begin();
        let RoomInitialLoadStart::Started { generation: first } = start else {
            panic!("first source claim should start");
        };
        assert!(initial_load.complete_failed(first, "retry me".to_string()));

        let second = initial_load
            .retry_failed_claimed()
            .expect("failed source can retry");
        assert!(matches!(
            initial_load.begin(),
            RoomInitialLoadStart::Observing { generation } if generation == second
        ));
        assert!(
            !initial_load.complete_ready(first, 99),
            "stale completion must not overwrite the current generation"
        );
        assert_eq!(
            initial_load.state(),
            RoomInitialLoadState::Loading { generation: second }
        );
    }

    #[test]
    fn external_recovery_advances_failed_generation_to_ready() {
        let initial_load = RoomInitialLoad::default();
        initial_load.mark_required();
        let start = initial_load.begin();
        let RoomInitialLoadStart::Started { generation: failed } = start else {
            panic!("required load should start");
        };
        assert!(initial_load.complete_failed(failed, "retry me".to_string()));

        let recovered = initial_load
            .recover_failed(3, empty_projection(failed + 1))
            .expect("external reconciliation should publish recovery");
        assert_eq!(recovered, failed + 1);
        assert_eq!(
            initial_load.state(),
            RoomInitialLoadState::Ready {
                generation: recovered,
                cell_count: 3,
            }
        );
        assert!(
            !initial_load.complete_ready(failed, 99),
            "the failed source generation must not overwrite recovered room truth"
        );
    }

    #[tokio::test]
    async fn stream_initial_load_success_orders_doc_sync_before_ready_status() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("source.ipynb");
        write_one_cell_notebook(&load_path).await;
        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();

        let phase = stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect("valid notebook should stream successfully");

        assert_eq!(phase, InitialLoadPhaseWire::Ready);
        assert!(!room.is_loading(), "successful load should finish loading");
        let cells = room.doc.read().await.get_cells();
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].id, "loaded-cell");
        assert_eq!(cells[0].source, "x = 1");

        let frame_types = frame_types(&writer.bytes);
        assert!(
            frame_types.len() >= 2,
            "success should emit at least one doc sync followed by Ready"
        );
        assert_eq!(
            frame_types.last(),
            Some(&NotebookFrameType::SessionControl),
            "Ready must be the final bootstrap frame"
        );
        assert!(
            frame_types[..frame_types.len() - 1]
                .iter()
                .all(|frame_type| *frame_type == NotebookFrameType::AutomergeSync),
            "all frames before Ready must be document sync frames"
        );

        let statuses = decode_session_statuses(&writer.bytes);
        assert_eq!(statuses.len(), 1);
        let SessionControlMessage::SyncStatus(status) = &statuses[0];
        assert_eq!(status.notebook_doc, NotebookDocPhaseWire::Syncing);
        assert_eq!(status.runtime_state, RuntimeStatePhaseWire::Syncing);
        assert_eq!(status.initial_load, InitialLoadPhaseWire::Ready);
    }

    #[tokio::test]
    async fn stream_initial_load_success_records_non_null_execution_count() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let load_path = tmp.path().join("source.ipynb");
        write_one_cell_notebook(&load_path).await;
        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();

        stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect("valid notebook should stream successfully");

        let execution_id = room
            .doc
            .read()
            .await
            .get_execution_id("loaded-cell")
            .expect("loaded code cell should point at an execution");

        room.state
            .with_doc(|state_doc| {
                let state = state_doc.read_state();
                let execution = state
                    .executions
                    .get(&execution_id)
                    .expect("loaded code cell should have an execution record");
                assert_eq!(execution.execution_count, Some(7));
                Ok(())
            })
            .unwrap();
    }

    #[tokio::test]
    async fn stream_initial_load_seeds_file_watcher_source_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        let load_path = tmp.path().join("source.ipynb");
        write_one_cell_notebook(&load_path).await;
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let room = Arc::new(NotebookRoom::new_fresh(
            Uuid::new_v4(),
            Some(load_path.clone()),
            tmp.path(),
            blob_store,
            false,
        ));
        let mut reader = tokio::io::empty();
        let mut writer = CaptureWriter::default();
        let mut peer_state = sync::State::new();

        stream_initial_load(
            &mut reader,
            &mut writer,
            &room,
            Some(&load_path),
            tmp.path(),
            &mut peer_state,
            NotebookDocPhaseWire::Syncing,
            RuntimeStatePhaseWire::Syncing,
            InitialLoadPhaseWire::Streaming,
            4,
        )
        .await
        .expect("valid notebook should stream successfully");

        assert_eq!(
            room.persistence
                .last_save_sources
                .read()
                .await
                .get("loaded-cell")
                .map(String::as_str),
            Some("x = 1"),
            "streaming load should seed the file-watcher baseline"
        );

        {
            let mut doc = room.doc.write().await;
            doc.update_source("loaded-cell", "print('edited')")
                .expect("live edit should update source");
        }

        let external_cells = vec![notebook_doc::CellSnapshot {
            id: "loaded-cell".to_string(),
            cell_type: "code".to_string(),
            position: "80".to_string(),
            source: "x = 1".to_string(),
            execution_count: "7".to_string(),
            metadata: serde_json::json!({}),
            resolved_assets: HashMap::new(),
            attachments: HashMap::new(),
        }];

        let changed = apply_ipynb_changes(
            &room,
            &external_cells,
            &HashMap::new(),
            &HashMap::new(),
            true,
        )
        .await;
        assert!(
            !changed,
            "unchanged disk contents should not roll back an immediate live edit"
        );

        let cells = room.doc.read().await.get_cells();
        assert_eq!(cells[0].source, "print('edited')");
    }
}
