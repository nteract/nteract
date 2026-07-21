use super::blob_upload::{enqueue_put_blob, spawn_put_blob_worker, MultipartUploadState};
use super::peer_comments_sync::{
    forward_comments_doc_broadcast, handle_comments_doc_frame, send_initial_comments_doc_sync,
};
use super::peer_comms_sync::{
    forward_comms_doc_broadcast, handle_comms_doc_frame, send_initial_comms_doc_sync,
};
use super::peer_notebook_sync::{
    finish_notebook_doc_frame, forward_notebook_doc_broadcast, handle_notebook_doc_frame,
    queue_doc_sync,
};
use super::peer_pool_sync::{
    forward_pool_state_broadcast, handle_pool_state_frame, send_initial_pool_sync,
};
use super::peer_presence::{
    forward_presence_broadcast, handle_presence_frame, prune_stale_presence,
    send_initial_presence_snapshot,
};
use super::peer_runtime_sync::{forward_runtime_state_broadcast, handle_runtime_state_frame};
use super::peer_session::{
    send_hosted_bridge_status, send_initial_notebook_doc_sync, send_initial_runtime_state_sync,
    send_session_status, stream_initial_load_with_frame_drain, HandshakePhases, InitialSyncState,
    PeerSessionContext,
};
use super::peer_writer::{
    enqueue_notebook_request, queue_hosted_bridge_status, queue_session_status,
    spawn_peer_request_worker, spawn_peer_writer,
};
use super::*;
use std::collections::VecDeque;

async fn next_peer_frame(
    deferred_frames: &mut VecDeque<connection::TypedNotebookFrame>,
    framed_reader: &mut connection::FramedReader,
) -> Option<std::io::Result<connection::TypedNotebookFrame>> {
    if let Some(frame) = deferred_frames.pop_front() {
        Some(Ok(frame))
    } else {
        framed_reader.recv().await
    }
}

/// Typed frames sync loop with first-byte type indicator.
///
/// Handles both Automerge sync messages and NotebookRequest messages.
/// This protocol supports daemon-owned kernel execution.
///
/// Takes `reader` by value because the post-streaming-load main loop
/// hands it to a `FramedReader` actor; from that point the read half
/// belongs to the dedicated reader task, not this select loop.
pub(crate) async fn run_sync_loop_v2<R, W>(
    reader: R,
    mut writer: W,
    ctx: &PeerConnectionContext,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let room = &ctx.room;
    let daemon = &ctx.daemon;
    let notebook_id = ctx.notebook_id.as_str();
    let peer_id = ctx.peer_id.as_str();
    let connection_identity = &ctx.connection_identity;
    let client_protocol_version = ctx.client_protocol_version;

    // Hand the reader off to a dedicated FramedReader actor before bootstrap.
    // The initial file-backed load can then safely wait for client sync replies
    // between batches without risking partial-frame cancellation.
    let mut framed_reader = connection::FramedReader::spawn(reader, 16);
    let mut deferred_frames = VecDeque::new();

    // Subscribe before sending bootstrap traffic so any writes that land
    // during connection setup are still observed as steady-state deltas.
    let mut changed_rx = room.broadcasts.changed_tx.subscribe();
    let mut kernel_broadcast_rx = room.broadcasts.kernel_broadcast_tx.subscribe();
    let mut presence_rx = room.broadcasts.presence_tx.subscribe();
    let mut state_changed_rx = room.state.subscribe();
    let mut comms_changed_rx = room.comms.subscribe();
    let mut comments_changed_rx = room.comments.subscribe();
    let mut hosted_bridge_status_rx = room.broadcasts.hosted_bridge_status_tx.subscribe();

    // PoolDoc — global daemon pool state (UV/Conda availability, errors).
    let mut pool_changed_rx = daemon.pool_doc_changed.subscribe();

    let needs_load = ctx.needs_load.as_deref();
    let room_load_state = room.initial_load.state();
    let room_load_in_progress = room_load_state.is_loading();
    let mut phases = HandshakePhases {
        notebook_doc: notebook_protocol::protocol::NotebookDocPhaseWire::Pending,
        runtime_state: notebook_protocol::protocol::RuntimeStatePhaseWire::Pending,
        initial_load: match &room_load_state {
            RoomInitialLoadState::Loading { .. } | RoomInitialLoadState::Failed { .. } => {
                notebook_protocol::protocol::InitialLoadPhaseWire::Streaming
            }
            RoomInitialLoadState::NotNeeded { .. } | RoomInitialLoadState::Ready { .. }
                if needs_load.is_some() =>
            {
                notebook_protocol::protocol::InitialLoadPhaseWire::Streaming
            }
            RoomInitialLoadState::NotNeeded { .. } | RoomInitialLoadState::Ready { .. } => {
                notebook_protocol::protocol::InitialLoadPhaseWire::NotNeeded
            }
        },
    };

    if client_protocol_version >= 3 {
        send_session_status(&mut writer, &phases).await?;
    }
    if client_protocol_version >= 4 {
        let status = *hosted_bridge_status_rx.borrow_and_update();
        send_hosted_bridge_status(&mut writer, status).await?;
    }

    // Fresh file-backed rooms stream the file itself as the initial doc sync.
    // Sending an empty-doc handshake first leaves Automerge with an in-flight
    // message and can collapse the visible cell batches into one final update.
    let defer_initial_doc_sync_for_file_load = if needs_load.is_some() || room_load_in_progress {
        let doc = room.doc.read().await;
        doc.cell_count() == 0
    } else {
        false
    };
    let InitialSyncState { mut peer_state } = if defer_initial_doc_sync_for_file_load {
        InitialSyncState::new()
    } else {
        send_initial_notebook_doc_sync(&mut writer, room).await?
    };
    phases.notebook_doc = notebook_protocol::protocol::NotebookDocPhaseWire::Syncing;
    if client_protocol_version >= 3 {
        send_session_status(&mut writer, &phases).await?;
    }

    let mut state_peer_state = sync::State::new();
    let mut comms_peer_state = sync::State::new();
    let mut comments_peer_state = sync::State::new();
    let mut pool_peer_state = sync::State::new();
    let mut persisted_execution_records: std::collections::HashMap<
        String,
        runtimed_client::execution_store::ExecutionRecord,
    > = std::collections::HashMap::new();
    let execution_store = runtimed_client::execution_store::ExecutionStore::new(
        ctx.execution_store_dir().to_path_buf(),
    );

    send_initial_runtime_state_sync(&mut writer, room, &mut state_peer_state).await?;
    phases.runtime_state = notebook_protocol::protocol::RuntimeStatePhaseWire::Syncing;
    if client_protocol_version >= 3 {
        send_session_status(&mut writer, &phases).await?;
    }

    send_initial_comms_doc_sync(&mut writer, room, &mut comms_peer_state).await?;
    send_initial_comments_doc_sync(&mut writer, room, &mut comments_peer_state).await?;

    let session = PeerSessionContext {
        room,
        needs_load,
        execution_store_dir: ctx.execution_store_dir(),
        connection_identity,
        client_protocol_version,
    };
    stream_initial_load_with_frame_drain(
        &mut framed_reader,
        &mut writer,
        &mut deferred_frames,
        &session,
        &mut peer_state,
        &mut phases,
    )
    .await?;

    send_initial_pool_sync(&mut writer, daemon, &mut pool_peer_state).await?;

    // CommSync broadcast is no longer needed. Late joiners receive widget
    // state via RuntimeStateDoc CRDT sync, and the frontend CRDT watcher
    // synthesizes comm_open messages.

    send_initial_presence_snapshot(&mut writer, room, peer_id).await?;

    // Periodic pruning of stale presence peers (e.g. clients that silently dropped).
    let prune_period = std::time::Duration::from_millis(presence::DEFAULT_HEARTBEAT_MS);
    let mut prune_interval = tokio::time::interval(prune_period);
    prune_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Bootstrap sends stay synchronous so initial load failures surface to the
    // caller. Once steady state starts, socket writes move to a single ordered
    // writer task; the peer loop must keep draining client frames even when the
    // client is temporarily slow to read daemon frames.
    let (peer_writer, mut writer_task) =
        spawn_peer_writer(writer, notebook_id.to_string(), peer_id.to_string());
    let multipart_uploads = MultipartUploadState::new(&room.blob_store);
    let mut request_worker = spawn_peer_request_worker(
        room.clone(),
        daemon.clone(),
        peer_writer.clone(),
        multipart_uploads.clone(),
        notebook_id.to_string(),
        peer_id.to_string(),
        connection_identity.actor_label().as_str().to_string(),
    );
    let mut put_blob_worker = spawn_put_blob_worker(
        room.blob_store.clone(),
        peer_writer.clone(),
        multipart_uploads,
        notebook_id.to_string(),
        peer_id.to_string(),
    );

    // Idle peer timeout: disconnect peers that stop sending inbound frames.
    // This is the safety net for orphaned connections where the remote process
    // exited without closing its socket (e.g. proxy runtime teardown race).
    let idle_peer_timeout = daemon.idle_peer_timeout();
    let idle_deadline = tokio::time::sleep(idle_peer_timeout);
    tokio::pin!(idle_deadline);

    // Steady state: exchange client frames and broadcast room changes.
    loop {
        tokio::select! {
            biased;

            writer_result = &mut writer_task.handle => {
                return match writer_result {
                    Ok(result) => result,
                    Err(e) => Err(anyhow::anyhow!(
                        "peer writer task stopped for {}: {}",
                        notebook_id,
                        e
                    )),
                };
            }

            request_worker_result = &mut request_worker.handle => {
                return match request_worker_result {
                    Ok(result) => result,
                    Err(e) => Err(anyhow::anyhow!(
                        "peer request worker stopped for {}: {}",
                        notebook_id,
                        e
                    )),
                };
            }

            put_blob_worker_result = &mut put_blob_worker.handle => {
                return match put_blob_worker_result {
                    Ok(result) => result,
                    Err(e) => Err(anyhow::anyhow!(
                        "PutBlob worker stopped for {}: {}",
                        notebook_id,
                        e
                    )),
                };
            }

            // Idle peer timeout: no inbound frames within the deadline.
            // Fires when the remote peer is an orphan (process exited without
            // closing the socket) or genuinely idle beyond the configured limit.
            _ = &mut idle_deadline => {
                warn!(
                    "[notebook-sync] Idle peer timeout for {} (peer_id={}, no inbound frames for {:?})",
                    notebook_id, peer_id, idle_peer_timeout
                );
                return Ok(());
            }

            // Incoming message from this client (cancel-safe via FramedReader actor)
            maybe_frame = next_peer_frame(&mut deferred_frames, &mut framed_reader) => {
                let frame = match maybe_frame {
                    Some(Ok(frame)) => frame,
                    Some(Err(e)) => return Err(e.into()),
                    None => return Ok(()), // clean EOF
                };
                // Reset idle deadline only for frames that represent genuine
                // client intent — Request (tool calls) and Presence (cursor/focus).
                // Automerge sync and state sync frames are reflexive: the daemon
                // sends changes, the client ACKs. That loop would keep an orphan
                // peer alive forever because daemon-side writes trigger client
                // responses indefinitely.
                if matches!(
                    frame.frame_type,
                    NotebookFrameType::Request | NotebookFrameType::Presence | NotebookFrameType::PutBlob
                ) {
                    idle_deadline.as_mut().reset(tokio::time::Instant::now() + idle_peer_timeout);
                }
                match frame.frame_type {
                            NotebookFrameType::AutomergeSync => {
                                let notebook_doc_effects = handle_notebook_doc_frame(
                                    room,
                                    &mut peer_state,
                                    connection_identity,
                                    &peer_writer,
                                    &frame.payload,
                                )
                                .await?;

                                // A queued reply means the joiner has not acknowledged
                                // the daemon's current NotebookDoc yet.
                                if !notebook_doc_effects.sync_reply_queued()
                                    && phases.notebook_doc
                                    != notebook_protocol::protocol::NotebookDocPhaseWire::Interactive
                                {
                                    phases.notebook_doc =
                                        notebook_protocol::protocol::NotebookDocPhaseWire::Interactive;
                                    if client_protocol_version >= 3 {
                                        queue_session_status(&peer_writer, &phases)?;
                                    }
                                }

                                // Keep session status queued before these awaits so the sync reply
                                // and readiness transition remain adjacent on the peer writer.
                                finish_notebook_doc_frame(room, notebook_doc_effects).await;
                            }

                            NotebookFrameType::Request => {
                                enqueue_notebook_request(
                                    &request_worker,
                                    &peer_writer,
                                    &frame.payload,
                                    notebook_id,
                                    peer_id,
                                    connection_identity.scope(),
                                )?;
                            }

                            NotebookFrameType::Presence => {
                                handle_presence_frame(
                                    room,
                                    peer_id,
                                    connection_identity,
                                    &peer_writer,
                                    &frame.payload,
                                )
                                .await?;
                            }

                            NotebookFrameType::RuntimeStateSync => {
                                if !handle_runtime_state_frame(
                                    room,
                                    &mut state_peer_state,
                                    &peer_writer,
                                    &frame.payload,
                                    &execution_store,
                                    &mut persisted_execution_records,
                                    connection_identity,
                                )
                                .await?
                                {
                                    continue;
                                }

                                if phases.runtime_state
                                    != notebook_protocol::protocol::RuntimeStatePhaseWire::Ready
                                {
                                    phases.runtime_state =
                                        notebook_protocol::protocol::RuntimeStatePhaseWire::Ready;
                                    if client_protocol_version >= 3 {
                                        queue_session_status(&peer_writer, &phases)?;
                                    }
                                }
                            }

                            NotebookFrameType::CommsDocSync => {
                                if !handle_comms_doc_frame(
                                    room,
                                    &mut comms_peer_state,
                                    &peer_writer,
                                    &frame.payload,
                                    connection_identity,
                                )
                                .await?
                                {
                                    continue;
                                }
                            }

                            NotebookFrameType::CommentsDocSync => {
                                // A comments-sync failure must never take down the
                                // notebook connection. Drop the offending frame and
                                // keep the peer editing; comments degrade alone.
                                match handle_comments_doc_frame(
                                    room,
                                    &mut comments_peer_state,
                                    &peer_writer,
                                    &frame.payload,
                                    connection_identity,
                                )
                                .await
                                {
                                    Ok(true) => {}
                                    Ok(false) => continue,
                                    Err(e) => {
                                        warn!(
                                            "[notebook-sync] CommentsDoc frame error (dropping frame, keeping connection): {}",
                                            e
                                        );
                                        continue;
                                    }
                                }
                            }

                            NotebookFrameType::PoolStateSync => {
                                if !handle_pool_state_frame(
                                    daemon,
                                    &mut pool_peer_state,
                                    &peer_writer,
                                    &frame.payload,
                                )
                                .await?
                                {
                                    continue;
                                }
                            }

                            NotebookFrameType::Response
                            | NotebookFrameType::Broadcast
                            | NotebookFrameType::SessionControl => {
                                // Clients shouldn't send these
                                warn!(
                                    "[notebook-sync] Unexpected frame type from client: {:?}",
                                    frame.frame_type
                                );
                            }

                            NotebookFrameType::PutBlob => {
                                enqueue_put_blob(
                                    &put_blob_worker,
                                    &peer_writer,
                                    frame.payload,
                                    notebook_id,
                                    peer_id,
                                    connection_identity.scope(),
                                )?;
                            }
                        }
            }

            // Another peer changed the document — push update to this client
            _ = changed_rx.recv() => {
                forward_notebook_doc_broadcast(room, &mut peer_state, &peer_writer).await?;
            }

            // RuntimeStateDoc changed — push update to this client
            result = state_changed_rx.recv() => {
                if !forward_runtime_state_broadcast(
                    room,
                    peer_id,
                    &mut state_peer_state,
                    &peer_writer,
                    result,
                )
                .await?
                {
                    return Ok(());
                }
            }

            result = hosted_bridge_status_rx.changed(), if client_protocol_version >= 4 => {
                if result.is_err() {
                    return Ok(());
                }
                let status = *hosted_bridge_status_rx.borrow_and_update();
                queue_hosted_bridge_status(&peer_writer, status)?;
            }

            // CommsDoc changed — push widget state updates to this client
            result = comms_changed_rx.recv() => {
                if !forward_comms_doc_broadcast(
                    room,
                    peer_id,
                    &mut comms_peer_state,
                    &peer_writer,
                    result,
                )
                .await?
                {
                    return Ok(());
                }
            }

            // CommentsDoc changed. Push comment thread updates to this client.
            result = comments_changed_rx.recv() => {
                if !forward_comments_doc_broadcast(
                    room,
                    peer_id,
                    &mut comments_peer_state,
                    &peer_writer,
                    result,
                )
                .await?
                {
                    return Ok(());
                }
            }

            // PoolDoc changed — push update to this client
            result = pool_changed_rx.recv() => {
                if !forward_pool_state_broadcast(
                    daemon,
                    peer_id,
                    &mut pool_peer_state,
                    &peer_writer,
                    result,
                )
                .await?
                {
                    return Ok(());
                }
            }

            // Presence update from another peer — forward to this client
            result = presence_rx.recv() => {
                if !forward_presence_broadcast(room, peer_id, &peer_writer, result).await? {
                    return Ok(());
                }
            }

            // Kernel broadcast event — forward to this client
            result = kernel_broadcast_rx.recv() => {
                match result {
                    Ok(broadcast) => {
                        peer_writer.send_json(NotebookFrameType::Broadcast, &broadcast)?;
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!(
                            "[notebook-sync] Peer lagged {} kernel broadcasts, sending doc sync to catch up",
                            n
                        );
                        // The peer missed some broadcasts (outputs, status changes).
                        // The Automerge doc contains the persisted state, so send a
                        // sync message to catch the peer up on any missed output data.
                        queue_doc_sync(
                            room,
                            &mut peer_state,
                            &peer_writer,
                        )
                        .await?;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        // Broadcast channel closed — room is being evicted
                        return Ok(());
                    }
                }
            }

            // Prune stale presence peers that haven't heartbeated within the TTL.
            // Each connection's loop is proof-of-life for its own peer, so we
            // mark ourselves seen before pruning to avoid false self-eviction
            // (idle-but-connected peers don't send frames).
            _ = prune_interval.tick() => {
                prune_stale_presence(room, peer_id).await;
            }
        }
    }
}
