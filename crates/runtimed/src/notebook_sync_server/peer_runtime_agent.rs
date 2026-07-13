use std::path::PathBuf;
use std::sync::Arc;

use notebook_protocol::connection::{send_typed_frame, FramedReader, NotebookFrameType};
use notebook_protocol::protocol::{NotebookBroadcast, RuntimeAgentResponse};
use tracing::{debug, info, warn};

use crate::async_outcome::{flatten_joined_result, JoinedResult};

use super::peer_runtime_sync::{persist_terminal_execution_records, runtime_file_save_fingerprint};
use super::peer_writer::spawn_peer_writer;
use super::{NotebookRoom, RuntimeAgentMessage, STATE_SYNC_COMPACT_THRESHOLD};

/// Apply one NotebookDoc sync frame from the runtime agent.
///
/// Runtime agents are trusted room peers, but their NotebookDoc changes still
/// cross the same durability boundary as human peers: the recovery journal is
/// committed before either a room broadcast or a sync reply can acknowledge
/// the changes. A failed journal append restores both the live document (with
/// its actor identity) and the Automerge sync state so the exact frame can be
/// replayed after the storage fault is repaired.
async fn apply_runtime_agent_notebook_doc_frame(
    room: &NotebookRoom,
    sync_state: &mut automerge::sync::State,
    payload: &[u8],
) -> anyhow::Result<Option<Vec<u8>>> {
    let message = automerge::sync::Message::decode(payload)
        .map_err(|error| anyhow::anyhow!("decode error: {error}"))?;
    let has_agent_changes = !message.changes.is_empty();
    let sync_state_before = sync_state.clone();

    let (persist_bytes, reply_encoded) = {
        let mut doc = room.doc.write().await;
        let rollback_state = has_agent_changes.then(|| (doc.save(), doc.get_actor_id()));
        let heads_before = doc.get_heads();

        doc.receive_sync_message_recovering(sync_state, message, "peer-runtime-agent-doc")
            .map_err(|error| anyhow::anyhow!("runtime-agent doc receive failed: {error}"))?;

        let changed = heads_before != doc.get_heads();
        if changed && has_agent_changes {
            let agent_changes = doc
                .doc_mut()
                .get_changes(&heads_before)
                .into_iter()
                .collect::<Vec<_>>();
            if let Err(error) = room.durability.commit_peer_changes(agent_changes) {
                let restored = rollback_state.as_ref().and_then(|(snapshot, actor)| {
                    notebook_doc::NotebookDoc::load_with_actor(snapshot, actor).ok()
                });
                let document_readable = restored.is_some();
                if let Some(restored) = restored {
                    *doc = restored;
                }
                *sync_state = sync_state_before;
                let document_heads = doc.get_heads_hex();
                let reason =
                    format!("journal commit failed before runtime-agent acknowledgement: {error}");
                room.durability.mark_degraded(reason.clone());
                room.lifecycle
                    .mark_degraded(reason.clone(), document_heads, document_readable);
                let _ = room.state.with_doc(|state| {
                    state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                        reason: reason.clone(),
                    }))
                });
                warn!("[notebook-sync] {reason}");
                return Err(anyhow::anyhow!(reason));
            }
        }

        if changed {
            // The append above is the visibility boundary for runtime-agent
            // changes. Other peers are notified only after it is durable.
            let _ = room.broadcasts.changed_tx.send(());
        }

        let persist_bytes = changed.then(|| doc.save());
        let reply_encoded = doc
            .generate_sync_message_recovering(sync_state, "peer-runtime-agent-doc-reply")
            .map_err(|error| anyhow::anyhow!("runtime-agent doc reply failed: {error}"))?
            .map(|reply| reply.encode());
        (persist_bytes, reply_encoded)
    };

    if let Some(bytes) = persist_bytes {
        room.persistence.enqueue_persist_bytes(bytes);
    }

    Ok(reply_encoded)
}

/// Handle a runtime agent subprocess that connected back to the daemon's Unix socket.
///
/// The runtime agent is a special peer that owns the kernel for this notebook
/// room. It receives RPC requests (LaunchKernel, Interrupt, etc.) via frame
/// 0x01 and watches RuntimeStateDoc for queued executions via frame 0x05.
///
/// This handler:
/// 1. Performs initial NotebookDoc + RuntimeStateDoc + CommsDoc sync
/// 2. Sets up the `runtime_agent_request_tx` channel on the room
/// 3. Fires `runtime_agent_connected` to unblock LaunchKernel
/// 4. Enters a sync loop relaying frames bidirectionally
pub async fn handle_runtime_agent_sync_connection<R, W>(
    reader: R,
    mut writer: W,
    room: Arc<NotebookRoom>,
    notebook_id: String,
    runtime_agent_id: String,
    execution_store_dir: PathBuf,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    // Frames are received on a dedicated task so the busy `select!`
    // below stays cancel-safe — `recv_typed_frame`'s internal
    // `read_exact` calls would otherwise drop bytes mid-read whenever
    // another arm wins, desyncing the runtime-agent ↔ daemon stream.
    let mut framed_reader = FramedReader::spawn(reader, 16);

    info!(
        "[notebook-sync] Runtime agent sync connection: notebook={} runtime_agent={}",
        notebook_id, runtime_agent_id
    );

    // Validate provenance — reject stale agents.
    // None means no agent is expected (room was reset or no spawn in progress),
    // so reject unconditionally. Only the exact current agent ID is accepted.
    {
        let expected = room.current_runtime_agent_id.read().await;
        match expected.as_deref() {
            Some(expected_id) if expected_id == runtime_agent_id => {
                // Match — this is the agent we're waiting for.
            }
            other => {
                warn!(
                    "[notebook-sync] Rejecting runtime agent {} (provenance is {:?})",
                    runtime_agent_id, other
                );
                return;
            }
        }
    }

    // ── 1. Initial NotebookDoc sync ──────────────────────────────────
    // Scope the doc write guard so it drops before the async send
    // (deadlock prevention: no lock held across `.await`).
    let mut doc_sync_state = automerge::sync::State::new();
    let doc_sync_msg = {
        let mut doc = room.doc.write().await;
        // Generate our sync message (full doc state for fresh peer)
        match doc
            .generate_sync_message_recovering(&mut doc_sync_state, "peer-runtime-agent-doc-init")
        {
            Ok(message) => message.map(|msg| msg.encode()),
            Err(e) => {
                warn!(
                    "[notebook-sync] runtime-agent initial doc sync failed: {}",
                    e
                );
                return;
            }
        }
    };
    if let Some(encoded) = doc_sync_msg {
        if let Err(e) =
            send_typed_frame(&mut writer, NotebookFrameType::AutomergeSync, &encoded).await
        {
            warn!("[notebook-sync] Agent initial doc sync send failed: {}", e);
            return;
        }
    }

    // ── 2. Initial RuntimeStateDoc sync ──────────────────────────────
    // Uses bounded generation to compact if oversized (same 80 MiB threshold).
    let mut state_sync_state = automerge::sync::State::new();
    let state_sync_msg = match room.state.generate_sync_message_bounded_encoded_recovering(
        &mut state_sync_state,
        STATE_SYNC_COMPACT_THRESHOLD,
        "peer-runtime-agent-state-init",
    ) {
        Ok(message) => message,
        Err(e) => {
            warn!(
                "[notebook-sync] runtime-agent initial state sync failed: {}",
                e
            );
            return;
        }
    };
    if let Some(encoded) = state_sync_msg {
        if let Err(e) =
            send_typed_frame(&mut writer, NotebookFrameType::RuntimeStateSync, &encoded).await
        {
            warn!(
                "[notebook-sync] Agent initial state sync send failed: {}",
                e
            );
            return;
        }
    }

    // ── 2b. Initial CommsDoc sync ───────────────────────────────────
    let mut comms_sync_state = automerge::sync::State::new();
    let comms_sync_msg = match room.comms.generate_sync_message_bounded_encoded_recovering(
        &mut comms_sync_state,
        STATE_SYNC_COMPACT_THRESHOLD,
        "peer-runtime-agent-comms-init",
    ) {
        Ok(message) => message,
        Err(e) => {
            warn!(
                "[notebook-sync] runtime-agent initial CommsDoc sync failed: {}",
                e
            );
            return;
        }
    };
    if let Some(encoded) = comms_sync_msg {
        if let Err(e) =
            send_typed_frame(&mut writer, NotebookFrameType::CommsDocSync, &encoded).await
        {
            warn!(
                "[notebook-sync] Agent initial CommsDoc sync send failed: {}",
                e
            );
            return;
        }
    }

    // ── 3. Set up request channel ────────────────────────────────────
    let (ra_tx, mut ra_rx) = tokio::sync::mpsc::channel::<RuntimeAgentMessage>(16);
    {
        let mut tx_guard = room.runtime_agent_request_tx.lock().await;
        *tx_guard = Some(ra_tx);
    }

    // ── 4. Signal connected ─────────────────────────────────────────
    // Provenance is already set by the spawn site (before spawn).
    // We do NOT re-set it here — doing so after the async sync work above
    // would create a window where a newer spawn's provenance could be
    // clobbered by this (potentially stale) connect handler.
    //
    // take() ensures at most one signal per spawn generation — a stale
    // runtime agent that passes provenance finds None here (no-op).
    if let Some(tx) = room.pending_runtime_agent_connect_tx.lock().await.take() {
        let _ = tx.send(());
    }
    info!(
        "[notebook-sync] Runtime agent connected and ready: {}",
        runtime_agent_id
    );

    // ── 5. Sync loop ─────────────────────────────────────────────────
    let mut changed_rx = room.broadcasts.changed_tx.subscribe();
    let mut state_changed_rx = room.state.subscribe();
    let mut comms_changed_rx = room.comms.subscribe();
    let execution_store =
        runtimed_client::execution_store::ExecutionStore::new(execution_store_dir);
    let mut persisted_execution_records: std::collections::HashMap<
        String,
        runtimed_client::execution_store::ExecutionRecord,
    > = std::collections::HashMap::new();
    let mut pending_replies: std::collections::HashMap<
        String,
        tokio::sync::oneshot::Sender<RuntimeAgentResponse>,
    > = std::collections::HashMap::new();
    let (agent_writer, mut writer_task) = spawn_peer_writer(
        writer,
        notebook_id.clone(),
        format!("runtime-agent:{runtime_agent_id}"),
    );

    loop {
        tokio::select! {
            biased;

            writer_result = &mut writer_task.handle => {
                match flatten_joined_result(writer_result) {
                    JoinedResult::Completed(()) => {
                        info!("[notebook-sync] Runtime agent writer closed cleanly: {}", runtime_agent_id);
                    }
                    JoinedResult::Failed(e) => {
                        warn!("[notebook-sync] Runtime agent writer failed for {}: {}", runtime_agent_id, e);
                    }
                    JoinedResult::JoinFailed(e) => {
                        warn!("[notebook-sync] Runtime agent writer task stopped for {}: {}", runtime_agent_id, e);
                    }
                }
                break;
            }

            // Frames from runtime agent (cancel-safe via FramedReader actor)
            maybe_frame = framed_reader.recv() => {
                let typed_frame = match maybe_frame {
                    Some(Ok(frame)) => frame,
                    Some(Err(e)) => {
                        info!("[notebook-sync] Agent disconnected: {}", e);
                        break;
                    }
                    None => {
                        info!("[notebook-sync] Agent disconnected (EOF)");
                        break;
                    }
                };
                match typed_frame.frame_type {
                    NotebookFrameType::AutomergeSync => {
                        let reply_encoded = match apply_runtime_agent_notebook_doc_frame(
                            &room,
                            &mut doc_sync_state,
                            &typed_frame.payload,
                        ).await {
                            Ok(reply) => reply,
                            Err(e) => {
                                warn!("[notebook-sync] Agent doc sync failed: {}", e);
                                break;
                            }
                        };
                        if let Some(encoded) = reply_encoded {
                            if let Err(e) = agent_writer.send_frame(
                                NotebookFrameType::AutomergeSync,
                                encoded,
                            ) {
                                warn!("[notebook-sync] Failed to queue doc sync reply to runtime agent: {}", e);
                                break;
                            }
                        }
                    }
                    NotebookFrameType::RuntimeStateSync => {
                        if let Ok(msg) = automerge::sync::Message::decode(&typed_frame.payload) {
                            let mut state_changed = false;
                            let mut runtime_file_dirty = false;
                            let reply_encoded = room.state.with_doc(|sd| {
                                let before = runtime_file_save_fingerprint(sd);
                                match sd.receive_sync_message_with_changes_recovering(
                                    &mut state_sync_state,
                                    msg,
                                    "peer-runtime-agent-state",
                                ) {
                                    Ok(changed) => {
                                        if changed {
                                            state_changed = true;
                                            if runtime_file_save_fingerprint(sd) != before {
                                                runtime_file_dirty = true;
                                            }
                                            // Notification handled by with_doc heads check
                                        }
                                    }
                                    Err(e) => {
                                        warn!("[notebook-sync] Agent state sync receive failed: {}", e);
                                        return Err(e.into());
                                    }
                                }
                                sd.generate_sync_message_recovering(
                                        &mut state_sync_state,
                                        "peer-runtime-agent-state-reply",
                                    )
                                    .map(|message| message.map(|reply| reply.encode()))
                                    .map_err(Into::into)
                            });
                            let reply_encoded = match reply_encoded {
                                Ok(encoded) => encoded,
                                Err(e) => {
                                    warn!("[notebook-sync] Agent state sync failed: {}", e);
                                    break;
                                }
                            };
                            if let Some(encoded) = reply_encoded {
                                if let Err(e) = agent_writer.send_frame(
                                    NotebookFrameType::RuntimeStateSync,
                                    encoded,
                                ) {
                                    warn!("[notebook-sync] Failed to queue state sync reply to runtime agent: {}", e);
                                    break;
                                }
                            }
                            if state_changed {
                                if runtime_file_dirty {
                                    let _ = room.broadcasts.file_dirty_tx.send(());
                                }
                                persist_terminal_execution_records(
                                    &room,
                                    &execution_store,
                                    &mut persisted_execution_records,
                                ).await;
                            }
                        }
                    }
                    NotebookFrameType::CommsDocSync => {
                        if let Ok(msg) = automerge::sync::Message::decode(&typed_frame.payload) {
                            let mut comms_changed = false;
                            let reply_encoded = room.comms.with_doc(|comms_doc| {
                                match comms_doc.receive_sync_message_with_changes_recovering(
                                    &mut comms_sync_state,
                                    msg,
                                    "peer-runtime-agent-comms",
                                ) {
                                    Ok(changed) => {
                                        if changed {
                                            comms_changed = true;
                                        }
                                    }
                                    Err(e) => {
                                        warn!("[notebook-sync] Agent CommsDoc sync receive failed: {}", e);
                                        return Err(e.into());
                                    }
                                }
                                comms_doc
                                    .generate_sync_message_recovering(
                                        &mut comms_sync_state,
                                        "peer-runtime-agent-comms-reply",
                                    )
                                    .map(|message| message.map(|reply| reply.encode()))
                                    .map_err(Into::into)
                            });
                            let reply_encoded = match reply_encoded {
                                Ok(encoded) => encoded,
                                Err(e) => {
                                    warn!("[notebook-sync] Agent CommsDoc sync failed: {}", e);
                                    break;
                                }
                            };
                            if let Some(encoded) = reply_encoded {
                                if let Err(e) = agent_writer.send_frame(
                                    NotebookFrameType::CommsDocSync,
                                    encoded,
                                ) {
                                    warn!("[notebook-sync] Failed to queue CommsDoc sync reply to runtime agent: {}", e);
                                    break;
                                }
                            }
                            if comms_changed {
                                debug!("[notebook-sync] Runtime agent applied CommsDoc changes");
                            }
                        }
                    }
                    NotebookFrameType::Response => {
                        if let Ok(envelope) = serde_json::from_slice::<
                            notebook_protocol::protocol::RuntimeAgentResponseEnvelope,
                        >(&typed_frame.payload) {
                            if let Some(reply) = pending_replies.remove(&envelope.id) {
                                let _ = reply.send(envelope.response);
                            } else {
                                debug!("[notebook-sync] Agent response for unknown id: {}", envelope.id);
                            }
                        }
                    }
                    NotebookFrameType::Broadcast => {
                        match forward_runtime_agent_broadcast(
                            &room.broadcasts.kernel_broadcast_tx,
                            &typed_frame.payload,
                        ) {
                            Ok(0) => {
                                debug!(
                                    "[notebook-sync] Runtime agent broadcast had no subscribers"
                                );
                            }
                            Ok(_) => {}
                            Err(e) => {
                                warn!(
                                    "[notebook-sync] Dropping malformed runtime agent broadcast: {}",
                                    e
                                );
                            }
                        }
                    }
                    _ => {
                        debug!("[notebook-sync] Agent sent unexpected frame type: {:?}", typed_frame.frame_type);
                    }
                }
            }

            // NotebookDoc changes (from other peers) → sync to runtime agent
            _ = changed_rx.recv() => {
                while changed_rx.try_recv().is_ok() {}
                let mut doc = room.doc.write().await;
                match doc.generate_sync_message_recovering(
                    &mut doc_sync_state,
                    "peer-runtime-agent-doc-outbound",
                ) {
                    Ok(Some(msg)) => {
                        let encoded = msg.encode();
                        if let Err(e) = agent_writer.send_frame(
                            NotebookFrameType::AutomergeSync,
                            encoded,
                        ) {
                            warn!("[notebook-sync] Failed to queue doc sync to runtime agent: {}", e);
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        warn!("[notebook-sync] Agent outbound doc sync failed: {}", e);
                        break;
                    }
                }
            }

            // RuntimeStateDoc changes → sync to runtime agent
            _ = state_changed_rx.recv() => {
                while state_changed_rx.try_recv().is_ok() {}
                let encoded = match room
                    .state
                    .generate_sync_message_recovering(
                        &mut state_sync_state,
                        "peer-runtime-agent-state-outbound",
                    ) {
                        Ok(message) => message.map(|msg| msg.encode()),
                        Err(e) => {
                            warn!("[notebook-sync] Agent outbound state sync failed: {}", e);
                            break;
                        }
                    };
                if let Some(encoded) = encoded {
                    if let Err(e) = agent_writer.send_frame(
                        NotebookFrameType::RuntimeStateSync,
                        encoded,
                    ) {
                        warn!("[notebook-sync] Failed to queue state sync to runtime agent: {}", e);
                        break;
                    }
                }
            }

            // CommsDoc changes → sync to runtime agent
            _ = comms_changed_rx.recv() => {
                while comms_changed_rx.try_recv().is_ok() {}
                let encoded = match room
                    .comms
                    .generate_sync_message_recovering(
                        &mut comms_sync_state,
                        "peer-runtime-agent-comms-outbound",
                    ) {
                        Ok(message) => message.map(|msg| msg.encode()),
                        Err(e) => {
                            warn!("[notebook-sync] Agent outbound CommsDoc sync failed: {}", e);
                            break;
                        }
                    };
                if let Some(encoded) = encoded {
                    if let Err(e) = agent_writer.send_frame(
                        NotebookFrameType::CommsDocSync,
                        encoded,
                    ) {
                        warn!("[notebook-sync] Failed to queue CommsDoc sync to runtime agent: {}", e);
                        break;
                    }
                }
            }

            // Forward requests to the runtime agent. Commands are fire-and-forget;
            // queries register a pending reply keyed by correlation ID.
            Some(msg) = ra_rx.recv() => {
                let (envelope, reply_tx) = match msg {
                    RuntimeAgentMessage::Command(env) => (env, None),
                    RuntimeAgentMessage::Query(env, tx) => (env, Some(tx)),
                };
                let json = match serde_json::to_vec(&envelope) {
                    Ok(j) => j,
                    Err(e) => {
                        if let Some(tx) = reply_tx {
                            let _ = tx.send(RuntimeAgentResponse::Error {
                                error: format!("Serialize error: {}", e),
                            });
                        }
                        continue;
                    }
                };
                let reply_id = envelope.id.clone();
                if let Some(tx) = reply_tx {
                    pending_replies.insert(reply_id.clone(), tx);
                }
                if let Err(e) = agent_writer.send_frame(
                    NotebookFrameType::Request,
                    json,
                ) {
                    if let Some(tx) = pending_replies.remove(&reply_id) {
                        let _ = tx.send(RuntimeAgentResponse::Error {
                            error: format!("Send error: {}", e),
                        });
                    }
                    break;
                }
            }
        }
    }

    // Drain any pending query replies so callers get an error instead of hanging.
    for (_id, reply_tx) in pending_replies.drain() {
        let _ = reply_tx.send(RuntimeAgentResponse::Error {
            error: "Runtime agent disconnected".to_string(),
        });
    }

    // Cleanup: only clear state if we're still the current runtime agent.
    // A stale runtime agent disconnecting after a new one connected must not
    // clobber the new runtime agent's channel.
    //
    // Scope the id read guard so it drops before acquiring other locks
    // (deadlock prevention: no lock held across `.await`).
    let is_current = {
        let expected = room.current_runtime_agent_id.read().await;
        expected.as_deref() == Some(&runtime_agent_id)
    };
    if is_current {
        {
            let mut tx_guard = room.runtime_agent_request_tx.lock().await;
            *tx_guard = None;
        }
        // No need to signal "disconnected" — the oneshot was consumed on
        // connect. If the runtime agent dies before connecting, the oneshot
        // sender is dropped when pending_runtime_agent_connect_tx is replaced
        // by the next spawn, which resolves the receiver with Err.
        //
        // Clear runtime_agent_handle so LaunchKernel spawns a new runtime agent
        let mut guard = room.runtime_agent_handle.lock().await;
        *guard = None;
    }
    info!(
        "[notebook-sync] Runtime agent sync connection closed: {}",
        runtime_agent_id
    );
}

fn forward_runtime_agent_broadcast(
    tx: &tokio::sync::broadcast::Sender<NotebookBroadcast>,
    payload: &[u8],
) -> anyhow::Result<usize> {
    let broadcast = serde_json::from_slice::<NotebookBroadcast>(payload)?;
    validate_runtime_agent_broadcast(&broadcast)?;
    match tx.send(broadcast) {
        Ok(receiver_count) => Ok(receiver_count),
        Err(_) => Ok(0),
    }
}

fn validate_runtime_agent_broadcast(broadcast: &NotebookBroadcast) -> anyhow::Result<()> {
    match broadcast {
        NotebookBroadcast::Comm {
            msg_type, content, ..
        } => {
            // Runtime-agent broadcasts arrive over the authenticated runtime-agent
            // attachment. This guard validates the payload shape before peer fanout;
            // comm ownership remains part of that trusted attachment boundary.
            anyhow::ensure!(
                msg_type == "comm_msg" || msg_type == "comm_close",
                "runtime agent broadcast used unsupported comm msg_type {msg_type:?}"
            );
            anyhow::ensure!(
                content
                    .get("comm_id")
                    .and_then(|value| value.as_str())
                    .is_some(),
                "runtime agent broadcast comm payload missing comm_id"
            );
            Ok(())
        }
        NotebookBroadcast::BokehSessionPatch { patch } => {
            anyhow::ensure!(
                !patch.session_id.is_empty() && !patch.transaction_id.is_empty(),
                "runtime agent Bokeh patch is missing session or transaction identity"
            );
            anyhow::ensure!(
                patch.revision == patch.base_revision + 1,
                "runtime agent Bokeh patch revision is not contiguous"
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::blob_store::BlobStore;

    fn test_file_backed_room(tmp: &tempfile::TempDir) -> (uuid::Uuid, PathBuf, Arc<NotebookRoom>) {
        let notebook_id = uuid::Uuid::new_v4();
        let notebook_path = tmp.path().join("runtime-agent.ipynb");
        std::fs::write(
            &notebook_path,
            br#"{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}"#,
        )
        .expect("write source notebook");
        let room = Arc::new(NotebookRoom::new_fresh(
            notebook_id,
            Some(notebook_path),
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        (notebook_id, room.identity.persist_path.clone(), room)
    }

    async fn runtime_agent_change_frame(
        room: &NotebookRoom,
        server_state: &mut automerge::sync::State,
    ) -> Vec<u8> {
        let snapshot = {
            let mut doc = room.doc.write().await;
            let snapshot = doc.save();
            if let Some(initial) = doc
                .generate_sync_message_recovering(server_state, "runtime-agent-test-init")
                .expect("generate initial server sync")
            {
                let mut agent =
                    notebook_doc::NotebookDoc::load_with_actor(&snapshot, "runtime-agent:test")
                        .expect("load runtime-agent test document");
                let mut agent_state = automerge::sync::State::new();
                agent
                    .receive_sync_message_recovering(
                        &mut agent_state,
                        initial,
                        "runtime-agent-test-receive-init",
                    )
                    .expect("receive initial server sync");
                agent
                    .add_cell(0, "runtime-agent-cell", "code")
                    .expect("add runtime-agent cell");
                agent
                    .append_source("runtime-agent-cell", "answer = 42")
                    .expect("set runtime-agent cell source");
                return agent
                    .generate_sync_message_recovering(&mut agent_state, "runtime-agent-test-change")
                    .expect("generate runtime-agent change sync")
                    .expect("runtime-agent change message")
                    .encode();
            }
            snapshot
        };

        // Automerge currently produces an initial message for a fresh sync
        // state. Keep a fallback so the fixture remains valid if that protocol
        // optimization changes.
        let mut agent = notebook_doc::NotebookDoc::load_with_actor(&snapshot, "runtime-agent:test")
            .expect("load runtime-agent test document");
        let mut agent_state = automerge::sync::State::new();
        agent
            .add_cell(0, "runtime-agent-cell", "code")
            .expect("add runtime-agent cell");
        agent
            .append_source("runtime-agent-cell", "answer = 42")
            .expect("set runtime-agent cell source");
        agent
            .generate_sync_message_recovering(
                &mut agent_state,
                "runtime-agent-test-change-fallback",
            )
            .expect("generate runtime-agent fallback sync")
            .expect("runtime-agent fallback message")
            .encode()
    }

    #[tokio::test]
    async fn runtime_agent_doc_change_is_rolled_back_until_journal_commit() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let (notebook_id, persist_path, room) = test_file_backed_room(&tmp);
        let journal_path = persist_path.with_extension("recovery");
        std::fs::create_dir(&journal_path).expect("install journal write fault");

        let mut server_state = automerge::sync::State::new();
        let frame = runtime_agent_change_frame(&room, &mut server_state).await;
        let decoded = automerge::sync::Message::decode(&frame).expect("decode test frame");
        assert!(
            !decoded.changes.is_empty(),
            "fault must cover a changes-bearing sync frame"
        );
        let sync_state_before = server_state.clone();
        let (heads_before, actor_before) = {
            let mut doc = room.doc.write().await;
            (doc.get_heads(), doc.get_actor_id())
        };
        let mut changed_rx = room.broadcasts.changed_tx.subscribe();

        let error = apply_runtime_agent_notebook_doc_frame(&room, &mut server_state, &frame)
            .await
            .expect_err("journal fault must reject runtime-agent changes");
        assert!(error.to_string().contains("journal commit failed"));
        {
            let mut doc = room.doc.write().await;
            assert_eq!(doc.get_heads(), heads_before, "live document rolled back");
            assert_eq!(doc.get_actor_id(), actor_before, "room actor preserved");
            assert!(doc.get_cell("runtime-agent-cell").is_none());
        }
        assert_eq!(
            format!("{server_state:?}"),
            format!("{sync_state_before:?}"),
            "runtime-agent sync state rolled back for exact replay"
        );
        assert!(
            matches!(
                changed_rx.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "rejected changes must not be broadcast"
        );
        assert!(matches!(
            room.lifecycle.availability(),
            super::super::RoomAvailability::Degraded(_)
        ));
        let source_issue = room
            .state
            .with_doc(|state| Ok(state.read_state().file_checkpoint.source_issue))
            .expect("read runtime source issue");
        assert!(matches!(
            source_issue,
            Some(runtime_doc::FileSourceIssue::Degraded { .. })
        ));

        std::fs::remove_dir(&journal_path).expect("repair journal path");
        let _reply = apply_runtime_agent_notebook_doc_frame(&room, &mut server_state, &frame)
            .await
            .expect("exact frame should replay after storage repair");
        tokio::time::timeout(std::time::Duration::from_secs(1), changed_rx.recv())
            .await
            .expect("accepted change should broadcast")
            .expect("broadcast channel remains open");
        assert!(
            room.doc
                .read()
                .await
                .get_cell("runtime-agent-cell")
                .is_some(),
            "accepted runtime-agent change is visible"
        );

        drop(room);
        let source_path = tmp.path().join("runtime-agent.ipynb");
        let reopened = NotebookRoom::new_fresh(
            notebook_id,
            Some(source_path),
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("reopened-blobs"))),
            false,
        );
        assert!(
            reopened
                .doc
                .read()
                .await
                .get_cell("runtime-agent-cell")
                .is_some(),
            "acknowledged runtime-agent change survives journal recovery"
        );
    }

    #[tokio::test]
    async fn forwards_runtime_agent_broadcast_to_subscriber() {
        let (tx, mut rx) = tokio::sync::broadcast::channel(4);
        let broadcast = NotebookBroadcast::Comm {
            msg_type: "comm_msg".to_string(),
            content: serde_json::json!({
                "comm_id": "comm-1",
                "data": {
                    "method": "custom",
                    "content": { "type": "draw" }
                }
            }),
            buffers: vec![vec![1, 2, 3]],
        };
        let payload = serde_json::to_vec(&broadcast).expect("serialize broadcast");

        let receiver_count =
            forward_runtime_agent_broadcast(&tx, &payload).expect("forward broadcast");

        assert_eq!(receiver_count, 1);
        match rx.recv().await.expect("receive broadcast") {
            NotebookBroadcast::Comm {
                msg_type,
                content,
                buffers,
            } => {
                assert_eq!(msg_type, "comm_msg");
                assert_eq!(content["comm_id"], "comm-1");
                assert_eq!(content["data"]["content"]["type"], "draw");
                assert_eq!(buffers, vec![vec![1, 2, 3]]);
            }
            NotebookBroadcast::BokehSessionPatch { .. } => {
                panic!("expected comm broadcast")
            }
        }
    }

    #[test]
    fn rejects_malformed_runtime_agent_broadcast() {
        let (tx, _rx) = tokio::sync::broadcast::channel(4);

        forward_runtime_agent_broadcast(&tx, b"{not-json")
            .expect_err("malformed broadcast must fail");
    }

    #[test]
    fn rejects_runtime_agent_broadcast_with_non_comm_msg_type() {
        let (tx, _rx) = tokio::sync::broadcast::channel(4);
        let broadcast = NotebookBroadcast::Comm {
            msg_type: "status".to_string(),
            content: serde_json::json!({
                "comm_id": "comm-1",
            }),
            buffers: Vec::new(),
        };
        let payload = serde_json::to_vec(&broadcast).expect("serialize broadcast");

        forward_runtime_agent_broadcast(&tx, &payload)
            .expect_err("non-comm message type must fail");
    }

    #[test]
    fn rejects_runtime_agent_broadcast_without_comm_id() {
        let (tx, _rx) = tokio::sync::broadcast::channel(4);
        let broadcast = NotebookBroadcast::Comm {
            msg_type: "comm_msg".to_string(),
            content: serde_json::json!({
                "data": {
                    "method": "custom",
                    "content": { "type": "draw" }
                }
            }),
            buffers: Vec::new(),
        };
        let payload = serde_json::to_vec(&broadcast).expect("serialize broadcast");

        forward_runtime_agent_broadcast(&tx, &payload).expect_err("missing comm_id must fail");
    }

    #[test]
    fn accepts_runtime_agent_bokeh_noop_revision() {
        let broadcast = NotebookBroadcast::BokehSessionPatch {
            patch: Box::new(notebook_protocol::protocol::BokehSessionPatchEvent {
                session_id: "session-1".to_string(),
                transaction_id: "tx-button-click".to_string(),
                base_revision: 0,
                revision: 1,
                client_patch: None,
                server_patch: None,
                checkpoint: None,
            }),
        };

        validate_runtime_agent_broadcast(&broadcast).expect("valid no-op revision");
    }
}
