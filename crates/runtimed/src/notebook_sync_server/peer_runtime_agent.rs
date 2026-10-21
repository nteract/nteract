use std::path::PathBuf;
use std::sync::Arc;

use automerge::SaveOptions;
use notebook_doc::presence;
use notebook_protocol::connection::{send_typed_frame, FramedReader, NotebookFrameType};
use notebook_protocol::protocol::{
    NotebookBroadcast, RuntimeAgentRequest, RuntimeAgentRequestEnvelope, RuntimeAgentResponse,
};
use tracing::{debug, info, warn};

use crate::async_outcome::{flatten_joined_result, JoinedResult};

use super::peer_runtime_sync::{persist_terminal_execution_records, runtime_file_save_fingerprint};
use super::peer_writer::spawn_peer_writer;
use super::{
    admit_trusted_notebook_changes, update_kernel_presence_locked, NotebookRoom,
    RuntimeAgentMessage, TrustedNotebookChangeSource, STATE_SYNC_COMPACT_THRESHOLD,
};

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
        super::durability::run_blocking_durability_boundary(|| -> anyhow::Result<_> {
            let rollback_state = has_agent_changes.then(|| (doc.save(), doc.get_actor_id()));
            let preview_snapshot = has_agent_changes.then(|| {
                doc.doc_mut().save_with_options(SaveOptions {
                    deflate: true,
                    retain_orphans: false,
                })
            });
            let heads_before = doc.get_heads();

            let admitted_changes = if has_agent_changes {
                let Some((_, actor)) = rollback_state.as_ref() else {
                    anyhow::bail!("runtime-agent changes did not capture rollback state");
                };
                let Some(preview_snapshot) = preview_snapshot.as_ref() else {
                    anyhow::bail!("runtime-agent changes did not capture a clean preview");
                };
                // Reloading the preview from bytes intentionally excludes any
                // previously parked orphan queue from the live Automerge doc.
                let mut preview =
                    notebook_doc::NotebookDoc::load_with_actor(preview_snapshot, actor).map_err(
                        |error| anyhow::anyhow!("runtime-agent preview load failed: {error}"),
                    )?;
                let mut preview_sync_state = sync_state.clone();
                preview
                    .receive_sync_message_recovering(
                        &mut preview_sync_state,
                        message.clone(),
                        "peer-runtime-agent-doc-preview",
                    )
                    .map_err(|error| {
                        anyhow::anyhow!("runtime-agent doc preview failed: {error}")
                    })?;
                let unresolved = preview.doc_mut().get_missing_deps(&[]);
                if !unresolved.is_empty() {
                    anyhow::bail!(
                        "runtime-agent sync frame left {} unresolved dependencies",
                        unresolved.len()
                    );
                }
                let preview_changes = preview
                    .doc_mut()
                    .get_changes(&heads_before)
                    .into_iter()
                    .collect::<Vec<_>>();
                admit_trusted_notebook_changes(
                    preview_changes,
                    TrustedNotebookChangeSource::RuntimeAgent,
                )
            } else {
                admit_trusted_notebook_changes(
                    Vec::new(),
                    TrustedNotebookChangeSource::RuntimeAgent,
                )
            };

            doc.receive_sync_message_recovering(sync_state, message, "peer-runtime-agent-doc")
                .map_err(|error| anyhow::anyhow!("runtime-agent doc receive failed: {error}"))?;

            let applied_changes = doc
                .doc_mut()
                .get_changes(&heads_before)
                .into_iter()
                .collect::<Vec<_>>();
            let admitted_changes = match admitted_changes.reconcile_applied(applied_changes) {
                Ok(changes) => changes,
                Err(error) => {
                    if let (Some((_, actor)), Some(preview_snapshot)) =
                        (rollback_state.as_ref(), preview_snapshot.as_ref())
                    {
                        if let Ok(restored) =
                            notebook_doc::NotebookDoc::load_with_actor(preview_snapshot, actor)
                        {
                            *doc = restored;
                        }
                    }
                    *sync_state = sync_state_before.clone();
                    return Err(error.context(
                        "runtime-agent preview differed from live NotebookDoc application",
                    ));
                }
            };

            let changed = heads_before != doc.get_heads();
            if changed && has_agent_changes {
                if let Err(error) = room.durability.commit_peer_changes(admitted_changes) {
                    let restored = rollback_state.as_ref().and_then(|(snapshot, actor)| {
                        notebook_doc::NotebookDoc::load_with_actor(snapshot, actor).ok()
                    });
                    let document_readable = restored.is_some();
                    if let Some(restored) = restored {
                        *doc = restored;
                    }
                    *sync_state = sync_state_before;
                    let document_heads = doc.get_heads_hex();
                    let reason = format!(
                        "journal commit failed before runtime-agent acknowledgement: {error}"
                    );
                    room.durability.mark_degraded(
                        super::durability::DegradationKind::DurabilityBoundary,
                        reason.clone(),
                    );
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
            Ok((persist_bytes, reply_encoded))
        })?
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
/// 3. Enters a sync loop relaying frames bidirectionally
/// 4. Unblocks LaunchKernel after the agent acknowledges RuntimeStateDoc
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
        if !room.mark_runtime_agent_connected(&runtime_agent_id) {
            warn!(
                "[notebook-sync] Rejecting runtime agent {} after initial sync (launch provenance changed)",
                runtime_agent_id
            );
            return;
        }
        *tx_guard = Some(ra_tx);
    }

    // ── 4. Retain this generation's readiness notification ──────────
    // Provenance is already set by the spawn site (before spawn).
    // We do NOT re-set it here — doing so after the async sync work above
    // would create a window where a newer spawn's provenance could be
    // clobbered by this (potentially stale) connect handler.
    //
    // take() ensures at most one signal per spawn generation — a stale
    // runtime agent that passes provenance finds None here (no-op).
    // The initial sync frame can contain only heads. Launching before the
    // agent receives our changes makes its Running write concurrent with
    // Connecting, which can leave both replicas projecting Connecting.
    let mut connected_tx = room.pending_runtime_agent_connect_tx.lock().await.take();

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
        (
            tokio::sync::oneshot::Sender<RuntimeAgentResponse>,
            Option<Arc<()>>,
        ),
    > = std::collections::HashMap::new();
    let (agent_writer, mut writer_task) = spawn_peer_writer(
        writer,
        notebook_id.clone(),
        format!("runtime-agent:{runtime_agent_id}"),
    );

    let mut retirement_dirty = true;
    let mut retirement_sent = std::collections::HashSet::new();
    'sync: loop {
        if retirement_dirty {
            retirement_dirty = false;
            let retired = retired_bokeh_sessions_in_room(&room).await;
            match retired {
                Ok(retired) => {
                    for (kernel_id, session_ids) in retired {
                        let session_ids: Vec<_> = session_ids
                            .into_iter()
                            .filter(|session_id| {
                                retirement_sent.insert((kernel_id.clone(), session_id.clone()))
                            })
                            .collect();
                        if session_ids.is_empty() {
                            continue;
                        }
                        let envelope = RuntimeAgentRequestEnvelope {
                            id: uuid::Uuid::new_v4().to_string(),
                            request: RuntimeAgentRequest::RetireBokehSessions {
                                kernel_id,
                                session_ids,
                            },
                        };
                        if let Err(error) =
                            agent_writer.send_json(NotebookFrameType::Request, &envelope)
                        {
                            warn!("[bokeh-session] Failed to queue output retirement: {error}");
                            break 'sync;
                        }
                    }
                }
                Err(error) => warn!("[bokeh-session] Failed to inspect output retirement: {error}"),
            }
        }
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
                        retirement_dirty = true;
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
                                let state_acknowledged =
                                    sd.get_heads() == state_sync_state.shared_heads;
                                sd.generate_sync_message_recovering(
                                        &mut state_sync_state,
                                        "peer-runtime-agent-state-reply",
                                    )
                                    .map(|message| (message.map(|reply| reply.encode()), state_acknowledged))
                                    .map_err(Into::into)
                            });
                            let (reply_encoded, state_acknowledged) = match reply_encoded {
                                Ok(result) => result,
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
                            if state_acknowledged {
                                if let Some(tx) = connected_tx.take() {
                                    let _ = tx.send(());
                                    info!(
                                        "[notebook-sync] Runtime agent initial state acknowledged and ready: {}",
                                        runtime_agent_id
                                    );
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
                            if let Some((reply, _sync_lease)) = pending_replies.remove(&envelope.id) {
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
                retirement_dirty = true;
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
                retirement_dirty = true;
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
                let (envelope, reply_tx, sync_lease) = match msg {
                    RuntimeAgentMessage::Command(env) => (env, None, None),
                    RuntimeAgentMessage::Query(env, tx) => (env, Some(tx), None),
                    RuntimeAgentMessage::EnvironmentSyncQuery(env, tx, lease) => (env, Some(tx), Some(lease)),
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
                    pending_replies.insert(reply_id.clone(), (tx, sync_lease));
                }
                if let Err(e) = agent_writer.send_frame(
                    NotebookFrameType::Request,
                    json,
                ) {
                    warn!("[notebook-sync] Failed to queue runtime agent request: {}", e);
                    break;
                }
            }
        }
    }

    // Fence the disconnected agent before releasing pending or queued sync leases.
    cleanup_runtime_agent_disconnect(&room, &runtime_agent_id).await;

    // Drain any pending query replies so callers get an error instead of hanging.
    for (_id, (reply_tx, _sync_lease)) in pending_replies.drain() {
        let _ = reply_tx.send(RuntimeAgentResponse::Error {
            error: "Runtime agent disconnected".to_string(),
        });
    }

    drop(ra_rx);
    info!(
        "[notebook-sync] Runtime agent sync connection closed: {}",
        runtime_agent_id
    );
}

async fn retired_bokeh_sessions_in_room(
    room: &NotebookRoom,
) -> Result<std::collections::HashMap<String, Vec<String>>, runtime_doc::RuntimeStateError> {
    // ExecuteCell/RunAll hold this write lock across runtime admission and
    // pointer replacement. Taking it first excludes their half-written state.
    // No async blob reads or viewer state enter the retirement decision.
    let doc = room.doc.read().await;
    room.state.read(|state| retired_bokeh_sessions(&doc, state))
}

/// A session is live while any current notebook cell references its output.
/// Historical execution records and viewer presence do not own live resources.
fn retired_bokeh_sessions(
    doc: &notebook_doc::NotebookDoc,
    state: &runtime_doc::RuntimeStateDoc,
) -> std::collections::HashMap<String, Vec<String>> {
    let sessions: Vec<_> = state
        .get_bokeh_sessions()
        .into_iter()
        .filter(|(_, session)| session.status == runtime_doc::BokehSessionStatus::Connected)
        .collect();
    if sessions.is_empty() {
        return std::collections::HashMap::new();
    }
    let live_executions: std::collections::HashSet<_> = doc
        .get_cell_ids()
        .iter()
        .filter_map(|cell_id| doc.get_execution_id(cell_id))
        .collect();
    let outputs: Vec<_> = live_executions
        .iter()
        .flat_map(|id| state.get_outputs(id))
        .collect();
    let mut retired = std::collections::HashMap::<String, Vec<String>>::new();
    for (session_id, session) in sessions {
        let original = state.get_output(&session.execution_id, &session.output_id);
        let original_payload = original
            .as_ref()
            .and_then(|output| output.get("data"))
            .and_then(|data| data.get(runtime_doc::BOKEH_SESSION_MIME));
        let referenced = outputs.iter().any(|output| {
            let Some(payload) = output
                .get("data")
                .and_then(|data| data.get(runtime_doc::BOKEH_SESSION_MIME))
            else {
                return false;
            };
            if let Some(id) = output
                .get("metadata")
                .and_then(|metadata| metadata.get(runtime_doc::BOKEH_SESSION_MIME))
                .and_then(|metadata| metadata.get("session_id"))
                .and_then(serde_json::Value::as_str)
            {
                // An update may retain output_id while replacing the Bokeh
                // session. Conversely, copied outputs may mint a new id.
                return id == session_id;
            }
            output.get("output_id").and_then(serde_json::Value::as_str)
                == Some(session.output_id.as_str())
                || original_payload == Some(payload)
        });
        if !referenced {
            retired
                .entry(session.kernel_id)
                .or_default()
                .push(session_id);
        }
    }
    retired
}

async fn cleanup_runtime_agent_disconnect(room: &NotebookRoom, runtime_agent_id: &str) -> bool {
    let disconnect_generation = room
        .runtime_agent_generation
        .load(std::sync::atomic::Ordering::Acquire);
    let env_source = room
        .active_kernel_launch()
        .map(|launch| launch.env_source.as_str().to_string())
        .unwrap_or_default();
    let is_current = {
        let (mut presence_state, mut request_tx) = tokio::join!(
            room.broadcasts.presence.write(),
            room.runtime_agent_request_tx.lock()
        );
        let disconnected = room.disconnect_runtime_agent_and_commit_terminal(
            runtime_agent_id,
            || {
                update_kernel_presence_locked(
                    &mut presence_state,
                    &room.broadcasts.presence_tx,
                    presence::KernelStatus::Errored,
                    &env_source,
                );
            },
            |sd| {
                sd.set_lifecycle_with_error_details(
                    &runtime_doc::RuntimeLifecycle::Error,
                    None,
                    Some("Runtime agent disconnected"),
                )
            },
        );
        if disconnected {
            *request_tx = None;
        }
        disconnected
    };
    if is_current {
        {
            let mut current = room.current_runtime_agent_id.write().await;
            if current.as_deref() == Some(runtime_agent_id) {
                *current = None;
            }
        }
        // No need to signal "disconnected" — the oneshot was consumed on
        // connect. If the runtime agent dies before connecting, the oneshot
        // sender is dropped when pending_runtime_agent_connect_tx is replaced
        // by the next spawn, which resolves the receiver with Err.
        //
        // Clear runtime_agent_handle so LaunchKernel spawns a new runtime agent
        let mut guard = room.runtime_agent_handle.lock().await;
        if room
            .runtime_agent_generation
            .load(std::sync::atomic::Ordering::Acquire)
            == disconnect_generation
        {
            *guard = None;
        }
    }
    is_current
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
        NotebookBroadcast::EnvironmentSelectionChanged { .. } => {
            anyhow::bail!("environment selection is owned by the local daemon, not a runtime agent")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use automerge::{transaction::Transactable, ReadDoc, ROOT};

    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::KernelLaunchCommitRejection;

    fn bokeh_retirement_fixture() -> (notebook_doc::NotebookDoc, runtime_doc::RuntimeStateDoc) {
        let mut doc = notebook_doc::NotebookDoc::new("bokeh-retirement");
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.set_execution_id("cell-1", Some("exec-1")).unwrap();
        let mut state = runtime_doc::RuntimeStateDoc::new();
        state
            .create_execution_with_source_provenance(
                "exec-1",
                "panel_output",
                0,
                None,
                Some("cell-1"),
            )
            .unwrap();
        state
            .append_output(
                "exec-1",
                &serde_json::json!({
                    "output_type": "display_data", "output_id": "output-1",
                    "data": {runtime_doc::BOKEH_SESSION_MIME: {"blob": "descriptor", "size": 2000}},
                    "metadata": {runtime_doc::BOKEH_SESSION_MIME: {"session_id": "session-1"}}
                }),
            )
            .unwrap();
        state
            .put_bokeh_session(
                "session-1",
                &serde_json::from_value(serde_json::json!({
                    "output_id": "output-1", "execution_id": "exec-1", "cell_id": "cell-1",
                    "kernel_id": "kernel-1", "status": "connected", "head_revision": 0,
                    "producer_name": "panel", "producer_version": "1", "bokeh_version": "3"
                }))
                .unwrap(),
            )
            .unwrap();
        (doc, state)
    }

    #[test]
    fn bokeh_retirement_replacement_clear_and_delete() {
        for operation in [
            "replace",
            "clear",
            "delete",
            "clear_output",
            "replace_output",
            "replace_bokeh_output",
        ] {
            let (mut doc, mut state) = bokeh_retirement_fixture();
            assert!(retired_bokeh_sessions(&doc, &state).is_empty());
            match operation {
                "replace" => {
                    doc.set_execution_id("cell-1", Some("exec-2")).unwrap();
                }
                "clear" => {
                    doc.set_execution_id("cell-1", None).unwrap();
                }
                "delete" => {
                    doc.delete_cell("cell-1").unwrap();
                }
                "clear_output" => {
                    state.set_outputs("exec-1", &[]).unwrap();
                }
                "replace_output" => {
                    state.set_outputs("exec-1", &[serde_json::json!({
                    "output_type": "display_data", "output_id": "output-1", "data": {"text/plain": {"inline": "replaced"}}
                })]).unwrap();
                }
                "replace_bokeh_output" => {
                    let mut replacement = state.get_outputs("exec-1").remove(0);
                    replacement["metadata"][runtime_doc::BOKEH_SESSION_MIME]["session_id"] =
                        serde_json::json!("replacement-session");
                    state.set_outputs("exec-1", &[replacement]).unwrap();
                }
                _ => unreachable!(),
            }
            assert_eq!(
                retired_bokeh_sessions(&doc, &state)["kernel-1"],
                vec!["session-1"],
                "{operation}"
            );
        }
    }

    #[test]
    fn bokeh_retirement_keeps_shared_executions_and_copied_outputs() {
        let (mut doc, mut state) = bokeh_retirement_fixture();
        doc.add_cell(1, "cell-2", "code").unwrap();
        doc.set_execution_id("cell-2", Some("exec-1")).unwrap();
        doc.delete_cell("cell-1").unwrap();
        assert!(retired_bokeh_sessions(&doc, &state).is_empty());

        state
            .create_execution_with_source_provenance("exec-copy", "copy", 1, None, Some("cell-2"))
            .unwrap();
        let mut copy = state.get_outputs("exec-1").remove(0);
        copy["output_id"] = serde_json::json!("copied-output");
        copy["data"][runtime_doc::BOKEH_SESSION_MIME] =
            serde_json::json!({"blob": "new-descriptor", "size": 3000});
        state.append_output("exec-copy", &copy).unwrap();
        doc.set_execution_id("cell-2", Some("exec-copy")).unwrap();
        state.set_outputs("exec-1", &[]).unwrap();
        assert!(
            retired_bokeh_sessions(&doc, &state).is_empty(),
            "session metadata protects copied outputs even after the original is cleared"
        );
        doc.delete_cell("cell-2").unwrap();
        assert_eq!(
            retired_bokeh_sessions(&doc, &state)["kernel-1"],
            vec!["session-1"]
        );
    }

    #[test]
    fn bokeh_retirement_viewer_reload_and_multiple_viewers_keep_outputs_live() {
        let (mut doc, state) = bokeh_retirement_fixture();
        let snapshot = doc.save();
        let viewer_a = notebook_doc::NotebookDoc::load_with_actor(&snapshot, "viewer-a").unwrap();
        let viewer_b = notebook_doc::NotebookDoc::load_with_actor(&snapshot, "viewer-b").unwrap();
        assert!(retired_bokeh_sessions(&viewer_a, &state).is_empty());
        assert!(retired_bokeh_sessions(&viewer_b, &state).is_empty());
        drop(viewer_a);
        let reloaded =
            notebook_doc::NotebookDoc::load_with_actor(&snapshot, "reloaded-viewer").unwrap();
        assert!(retired_bokeh_sessions(&doc, &state).is_empty());
        assert!(retired_bokeh_sessions(&reloaded, &state).is_empty());
    }

    #[tokio::test]
    async fn bokeh_retirement_waits_for_execution_pointer_admission() {
        use std::future::Future;
        let tmp = tempfile::TempDir::new().unwrap();
        let (_, _, room) = test_file_backed_room(&tmp);
        let (notebook, state) = bokeh_retirement_fixture();
        let mut retirement = Box::pin(retired_bokeh_sessions_in_room(&room));
        {
            let mut doc = room.doc.write().await;
            // Simulate the execution-admission interval: RuntimeStateDoc has
            // work/output, but the coordinator still holds the NotebookDoc
            // write lock while installing its authoritative execution pointer.
            room.state
                .with_doc(|current| {
                    *current = state;
                    Ok(())
                })
                .unwrap();
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(retirement.as_mut().poll(&mut cx).is_pending());
            *doc = notebook;
        }
        assert!(retirement.await.unwrap().is_empty());
    }

    #[test]
    fn bokeh_retirement_initial_output_sync_and_late_publication() {
        let (mut doc, mut agent) = bokeh_retirement_fixture();
        let mut coordinator = runtime_doc::RuntimeStateDoc::new();
        let mut sender = automerge::sync::State::new();
        let mut receiver = automerge::sync::State::new();
        // The NotebookDoc execution pointer can arrive before RuntimeStateDoc.
        assert!(retired_bokeh_sessions(&doc, &coordinator).is_empty());
        for _ in 0..8 {
            if let Some(msg) = agent.generate_sync_message(&mut sender) {
                coordinator
                    .receive_sync_message_with_changes(&mut receiver, msg)
                    .unwrap();
                assert!(
                    retired_bokeh_sessions(&doc, &coordinator).is_empty(),
                    "a session and its output arrive atomically"
                );
            }
            if let Some(msg) = coordinator.generate_sync_message(&mut receiver) {
                agent
                    .receive_sync_message_with_changes(&mut sender, msg)
                    .unwrap();
            }
        }
        assert!(coordinator.get_bokeh_session("session-1").is_some());
        // The reverse ordering is also safe: the native coordinator stamps
        // the notebook pointer before it admits the execution to the agent.
        // A late session publication for a genuinely retired execution closes.
        doc.set_execution_id("cell-1", Some("exec-2")).unwrap();
        assert_eq!(
            retired_bokeh_sessions(&doc, &coordinator)["kernel-1"],
            vec!["session-1"]
        );
    }

    #[tokio::test]
    async fn runtime_agent_ready_waits_for_initial_state_acknowledgement() {
        assert_runtime_agent_initial_state_acknowledgement(false).await;
    }

    #[tokio::test]
    async fn environment_sync_fence_outlives_caller_until_response_or_disconnect() {
        use notebook_protocol::connection::recv_typed_frame;
        use notebook_protocol::protocol::{EnvKind, RuntimeAgentResponseEnvelope};
        use std::future::Future;
        use tokio::io::AsyncWriteExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let (id, _, room) = test_file_backed_room(&tmp);
        let agent_id = "runtime-agent:sync-fence-test";
        room.expect_runtime_agent(agent_id);
        *room.current_runtime_agent_id.write().await = Some(agent_id.into());
        let (coordinator_socket, agent_socket) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = tokio::io::split(coordinator_socket);
        let mut peer = Box::pin(handle_runtime_agent_sync_connection(
            reader,
            writer,
            room.clone(),
            id.to_string(),
            agent_id.into(),
            tmp.path().join("executions"),
        ));
        let (mut reader, mut writer) = tokio::io::split(agent_socket);
        tokio::select! {
            () = &mut peer => panic!("peer disconnected before publishing request channel"),
            result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while room.runtime_agent_request_tx.lock().await.is_none() {
                    tokio::task::yield_now().await;
                }
            }) => result.unwrap(),
        }

        for disconnect in [false, true] {
            let caller = tokio::spawn({
                let room = room.clone();
                async move {
                    let _lease = room.local_environment_selection.begin_sync().unwrap();
                    super::super::send_runtime_agent_request(
                        &room,
                        RuntimeAgentRequest::SyncEnvironment(EnvKind::Uv {
                            packages: vec!["numpy".into()],
                        }),
                    )
                    .await
                }
            });
            let request = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let frame = recv_typed_frame(&mut reader).await.unwrap().unwrap();
                    if frame.frame_type == NotebookFrameType::Request {
                        break serde_json::from_slice(&frame.payload).unwrap();
                    }
                }
            });
            let envelope: RuntimeAgentRequestEnvelope = tokio::select! {
                () = &mut peer => panic!("peer disconnected before forwarding query"),
                result = request => result.unwrap(),
            };
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            assert!(room.local_environment_selection.begin_apply(0).is_err());
            if disconnect {
                writer.shutdown().await.unwrap();
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    loop {
                        {
                            let _handle = room.runtime_agent_handle.try_lock().unwrap();
                            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
                            assert!(peer.as_mut().poll(&mut cx).is_pending());
                        }
                        if room.current_runtime_agent_id.read().await.is_none() {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                assert!(
                    room.local_environment_selection.begin_apply(2).is_err(),
                    "disconnect must retain the sync fence until agent resources are cleared"
                );
            } else {
                let response = RuntimeAgentResponseEnvelope {
                    id: envelope.id,
                    response: RuntimeAgentResponse::EnvironmentSynced {
                        synced_packages: vec!["numpy".into()],
                    },
                };
                send_typed_frame(
                    &mut writer,
                    NotebookFrameType::Response,
                    &serde_json::to_vec(&response).unwrap(),
                )
                .await
                .unwrap();
                let released = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    while room.local_environment_selection.sync_lease().is_some() {
                        tokio::task::yield_now().await;
                    }
                });
                tokio::select! {
                    () = &mut peer => panic!("peer disconnected before replying"),
                    result = released => result.unwrap(),
                }
                assert!(room.local_environment_selection.begin_apply(0).is_ok());
                assert!(room.runtime_agent_request_tx.lock().await.is_some());
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), peer)
            .await
            .unwrap();
        assert!(room.current_runtime_agent_id.read().await.is_none());
        assert!(room.runtime_agent_request_tx.lock().await.is_none());
        assert!(room.local_environment_selection.begin_apply(2).is_ok());
    }

    #[tokio::test]
    async fn runtime_agent_ready_recovers_from_bloom_false_positive() {
        assert_runtime_agent_initial_state_acknowledgement(true).await;
    }

    async fn assert_runtime_agent_initial_state_acknowledgement(force_bloom_false_positive: bool) {
        use notebook_protocol::connection::recv_typed_frame;
        use runtime_doc::{KernelActivity, RuntimeLifecycle, RuntimeStateDoc};

        let tmp = tempfile::TempDir::new().unwrap();
        let (id, _, room) = test_file_backed_room(&tmp);
        let agent_id = "runtime-agent:startup-test";
        room.expect_runtime_agent(agent_id);
        *room.current_runtime_agent_id.write().await = Some(agent_id.into());
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Connecting))
            .unwrap();
        let (connected_tx, mut connected_rx) = tokio::sync::oneshot::channel();
        *room.pending_runtime_agent_connect_tx.lock().await = Some(connected_tx);
        let (coordinator_socket, agent_socket) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = tokio::io::split(coordinator_socket);
        let task = tokio::spawn(handle_runtime_agent_sync_connection(
            reader,
            writer,
            room.clone(),
            id.to_string(),
            agent_id.into(),
            tmp.path().join("executions"),
        ));
        let (mut reader, mut writer) = tokio::io::split(agent_socket);
        let mut agent = RuntimeStateDoc::new_with_actor(agent_id);
        let mut peer = automerge::sync::State::new();

        // The first state frame advertises heads but carries no changes. It
        // must not authorize LaunchKernel against the agent's seed document.
        for _ in 0..3 {
            let frame = recv_typed_frame(&mut reader).await.unwrap().unwrap();
            if frame.frame_type == NotebookFrameType::RuntimeStateSync {
                let message = automerge::sync::Message::decode(&frame.payload).unwrap();
                assert!(message.changes.is_empty());
                agent
                    .receive_sync_message_with_changes(&mut peer, message)
                    .unwrap();
            }
        }
        let reply = agent.generate_sync_message(&mut peer).unwrap();
        send_typed_frame(
            &mut writer,
            NotebookFrameType::RuntimeStateSync,
            &reply.encode(),
        )
        .await
        .unwrap();
        let frame = recv_typed_frame(&mut reader).await.unwrap().unwrap();
        assert_eq!(frame.frame_type, NotebookFrameType::RuntimeStateSync);
        assert!(matches!(
            connected_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        agent
            .receive_sync_message_with_changes(
                &mut peer,
                automerge::sync::Message::decode(&frame.payload).unwrap(),
            )
            .unwrap();
        assert_eq!(
            agent.read_state().kernel.lifecycle,
            RuntimeLifecycle::Connecting
        );
        let acknowledgement = agent.generate_sync_message(&mut peer).unwrap();
        send_typed_frame(
            &mut writer,
            NotebookFrameType::RuntimeStateSync,
            &acknowledgement.encode(),
        )
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), &mut connected_rx)
            .await
            .unwrap()
            .unwrap();

        // A launch after readiness causally replaces Connecting at both peers.
        agent
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        let running_heads = agent.get_heads();
        if force_bloom_false_positive {
            // Model a Bloom false positive: the coordinator's summary claims
            // to contain the new Running change even though it has not seen it.
            let hashes: Vec<_> = agent
                .doc_mut()
                .get_changes(&[])
                .into_iter()
                .map(|change| change.hash())
                .collect();
            for have in peer.their_have.as_mut().unwrap() {
                have.bloom = automerge::sync::BloomFilter::from_hashes(hashes.iter());
            }
        }
        let update = agent.generate_sync_message(&mut peer).unwrap();
        if force_bloom_false_positive {
            assert!(update.changes.is_empty());
        }
        send_typed_frame(
            &mut writer,
            NotebookFrameType::RuntimeStateSync,
            &update.encode(),
        )
        .await
        .unwrap();
        let mut requested_running_change = false;
        loop {
            let frame = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                recv_typed_frame(&mut reader),
            )
            .await
            .unwrap()
            .unwrap()
            .unwrap();
            if frame.frame_type == NotebookFrameType::RuntimeStateSync {
                let message = automerge::sync::Message::decode(&frame.payload).unwrap();
                requested_running_change |=
                    message.need.iter().any(|hash| running_heads.contains(hash));
                agent
                    .receive_sync_message_with_changes(&mut peer, message)
                    .unwrap();
                // Keep participating like the real runtime agent: a Bloom
                // false positive can require a reply to an explicit `need`.
                if let Some(reply) = agent.generate_sync_message(&mut peer) {
                    send_typed_frame(
                        &mut writer,
                        NotebookFrameType::RuntimeStateSync,
                        &reply.encode(),
                    )
                    .await
                    .unwrap();
                }
                if room
                    .state
                    .read(|sd| sd.read_state().kernel.lifecycle)
                    .unwrap()
                    == RuntimeLifecycle::Running(KernelActivity::Idle)
                {
                    break;
                }
            }
        }
        if force_bloom_false_positive {
            assert!(requested_running_change);
        }
        assert_eq!(
            agent.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );
        task.abort();
        let _ = task.await;
    }

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

    async fn runtime_agent_change_frame(room: &NotebookRoom) -> Vec<u8> {
        let (snapshot, initial_heads) = {
            let mut doc = room.doc.write().await;
            let snapshot = doc.save();
            let initial_heads = doc.get_heads();
            (snapshot, initial_heads)
        };
        let mut agent = notebook_doc::NotebookDoc::load_with_actor(&snapshot, "runtime-agent:test")
            .expect("load runtime-agent test document");
        agent
            .add_cell(0, "runtime-agent-cell", "code")
            .expect("add runtime-agent cell");
        agent
            .append_source("runtime-agent-cell", "answer = 42")
            .expect("set runtime-agent cell source");
        let heads = agent.get_heads();
        let changes = agent
            .doc_mut()
            .get_changes(&initial_heads)
            .into_iter()
            .collect::<Vec<_>>();
        assert!(!changes.is_empty(), "fixture must author notebook changes");
        automerge::sync::Message {
            heads,
            need: Vec::new(),
            have: Vec::new(),
            changes: changes
                .iter()
                .map(|change| change.raw_bytes().to_vec())
                .collect::<Vec<_>>()
                .into(),
            flags: None,
            version: automerge::sync::MessageVersion::V1,
        }
        .encode()
    }

    #[tokio::test]
    async fn current_runtime_agent_disconnect_fences_in_flight_success_projection() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let (_, _, room) = test_file_backed_room(&tmp);
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        room.expect_runtime_agent("agent-1");
        assert!(room.mark_runtime_agent_connected("agent-1"));
        let (request_tx, _request_rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(request_tx);
        let attempt = match room.try_begin_auto_launch() {
            crate::notebook_sync_server::AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("launch should be admitted"),
        };

        assert!(cleanup_runtime_agent_disconnect(&room, "agent-1").await);
        assert!(room.current_runtime_agent_id.read().await.is_none());
        assert!(room.runtime_agent_request_tx.lock().await.is_none());

        let projection_ran = std::cell::Cell::new(false);
        let cancelled_attempt =
            match attempt.succeed_with_agent("agent-1", || projection_ran.set(true)) {
                Err((attempt, KernelLaunchCommitRejection::Cancelled)) => attempt,
                Err((_, rejection)) => panic!("expected cancellation, got {rejection:?}"),
                Ok(()) => panic!("disconnect must fence launch success"),
            };
        assert!(!projection_ran.get());
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            runtime_doc::RuntimeLifecycle::Error
        );
        let presence_state = room.broadcasts.presence.read().await;
        let daemon = presence_state.peers().get("daemon").unwrap();
        match daemon.channels.get(&presence::Channel::KernelState) {
            Some(presence::ChannelData::KernelState(data)) => {
                assert_eq!(data.status, presence::KernelStatus::Errored)
            }
            other => panic!("expected errored kernel presence, got {other:?}"),
        }
        drop(presence_state);
        cancelled_attempt.finish_cancelled();
    }

    #[tokio::test]
    async fn stale_runtime_agent_disconnect_preserves_replacement_channel() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let (_, _, room) = test_file_backed_room(&tmp);
        *room.current_runtime_agent_id.write().await = Some("replacement".to_string());
        room.expect_runtime_agent("replacement");
        assert!(room.mark_runtime_agent_connected("replacement"));
        let (request_tx, _request_rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(request_tx);

        assert!(!cleanup_runtime_agent_disconnect(&room, "stale").await);
        assert_eq!(
            room.current_runtime_agent_id.read().await.as_deref(),
            Some("replacement")
        );
        assert!(room.runtime_agent_request_tx.lock().await.is_some());
    }

    #[tokio::test]
    async fn runtime_agent_doc_change_is_rolled_back_until_journal_commit() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let (notebook_id, persist_path, room) = test_file_backed_room(&tmp);
        let journal_path = persist_path.with_extension("recovery");
        std::fs::create_dir(&journal_path).expect("install journal write fault");

        let mut server_state = automerge::sync::State::new();
        let frame = runtime_agent_change_frame(&room).await;
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

    async fn assert_runtime_agent_frame_cannot_activate_a_previously_parked_change(
        version: automerge::sync::MessageVersion,
    ) {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let (_, _, room) = test_file_backed_room(&tmp);
        let mut server_state = automerge::sync::State::new();

        let (snapshot, initial_heads) = {
            let mut doc = room.doc.write().await;
            let snapshot = doc.save();
            let initial_heads = doc.get_heads();
            (snapshot, initial_heads)
        };
        let mut agent = notebook_doc::NotebookDoc::load_with_actor(&snapshot, "runtime-agent:test")
            .expect("load runtime-agent test document");

        agent
            .doc_mut()
            .put(ROOT, "runtime-dependency", true)
            .expect("author dependency change");
        let dependency_heads = agent.get_heads();
        let dependency_changes = agent
            .doc_mut()
            .get_changes(&initial_heads)
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(dependency_changes.len(), 1);
        let agent_with_dependency = agent.save();
        let mut attacker =
            notebook_doc::NotebookDoc::load_with_actor(&agent_with_dependency, "untrusted:parked")
                .expect("load attacker branch");
        attacker
            .doc_mut()
            .put(ROOT, "parked-change", true)
            .expect("author parked change");
        let parked_changes = attacker
            .doc_mut()
            .get_changes(&dependency_heads)
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(parked_changes.len(), 1);

        let unresolved_frame = automerge::sync::Message {
            heads: attacker.get_heads(),
            need: Vec::new(),
            have: Vec::new(),
            changes: parked_changes
                .iter()
                .map(|change| change.raw_bytes().to_vec())
                .collect::<Vec<_>>()
                .into(),
            flags: None,
            version: automerge::sync::MessageVersion::V1,
        }
        .encode();
        let sync_state_before = format!("{server_state:?}");
        let unresolved_error =
            apply_runtime_agent_notebook_doc_frame(&room, &mut server_state, &unresolved_frame)
                .await
                .expect_err("orphan-only frame must not be acknowledged");
        assert!(unresolved_error
            .to_string()
            .contains("unresolved dependencies"));
        assert_eq!(format!("{server_state:?}"), sync_state_before);

        let heads_before = {
            let mut doc = room.doc.write().await;
            let heads = doc.get_heads();
            doc.doc_mut()
                .apply_changes(parked_changes)
                .expect("Automerge parks unresolved changes without an error");
            assert_eq!(doc.get_heads(), heads, "parked change is not yet applied");
            heads
        };
        // Construct the exact dependency frame. Generating it through the normal
        // sync exchange would use a Bloom filter, whose intentional false-positive
        // rate can omit this change and make the security regression probabilistic.
        let changes = match &version {
            automerge::sync::MessageVersion::V1 => dependency_changes
                .iter()
                .map(|change| change.raw_bytes().to_vec())
                .collect::<Vec<_>>()
                .into(),
            automerge::sync::MessageVersion::V2 => agent_with_dependency.into(),
        };
        let frame = automerge::sync::Message {
            heads: dependency_heads,
            need: Vec::new(),
            have: Vec::new(),
            changes,
            flags: None,
            version,
        }
        .encode();

        let error = apply_runtime_agent_notebook_doc_frame(&room, &mut server_state, &frame)
            .await
            .expect_err("trusted frame must not sweep in a parked change");
        assert!(error.to_string().contains("preview differed"));
        let mut doc = room.doc.write().await;
        assert_eq!(doc.get_heads(), heads_before);
        assert!(doc
            .doc_mut()
            .get(ROOT, "runtime-dependency")
            .expect("read dependency")
            .is_none());
        assert!(doc
            .doc_mut()
            .get(ROOT, "parked-change")
            .expect("read parked change")
            .is_none());
    }

    #[tokio::test]
    async fn runtime_agent_v1_frame_cannot_activate_a_previously_parked_change() {
        assert_runtime_agent_frame_cannot_activate_a_previously_parked_change(
            automerge::sync::MessageVersion::V1,
        )
        .await;
    }

    #[tokio::test]
    async fn runtime_agent_v2_frame_cannot_activate_a_previously_parked_change() {
        assert_runtime_agent_frame_cannot_activate_a_previously_parked_change(
            automerge::sync::MessageVersion::V2,
        )
        .await;
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
            NotebookBroadcast::BokehSessionPatch { .. }
            | NotebookBroadcast::EnvironmentSelectionChanged { .. } => {
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
    fn runtime_agent_cannot_publish_local_environment_selection() {
        let (tx, mut rx) = tokio::sync::broadcast::channel(4);
        let payload = serde_json::to_vec(&NotebookBroadcast::EnvironmentSelectionChanged {
            selection: Default::default(),
        })
        .unwrap();
        let error = forward_runtime_agent_broadcast(&tx, &payload).unwrap_err();
        assert!(error.to_string().contains("owned by the local daemon"));
        assert!(rx.try_recv().is_err());
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
