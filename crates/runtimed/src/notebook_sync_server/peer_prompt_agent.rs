//! Coordinator-side connection plumbing for the prompt agent.
//!
//! The prompt agent is a second runtime-agent peer per room (handshake
//! capability `"prompt"`). It runs model prompts, not kernels, and only syncs
//! the RuntimeStateDoc. This module owns:
//!
//! - [`ensure_prompt_agent`]: idempotent, single-flight spawn of the agent.
//! - [`handle_prompt_agent_sync_connection`]: the sync loop for one connection.
//!
//! The daemon sends the agent no requests: work and Stop both reach it as
//! RuntimeStateDoc state (a dispatched prompt execution, its
//! `stop_requested` count). The prompt agent never touches kernel lifecycle,
//! presence or queue state, and its loss only fails executions with
//! capability `"prompt"`.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use notebook_protocol::connection::{send_typed_frame, FramedReader, NotebookFrameType};
use tracing::{debug, info, warn};

use crate::async_outcome::{
    flatten_joined_result, recv_oneshot_with_timeout, JoinedResult, TimedOneShot,
};

use super::peer_runtime_sync::{persist_terminal_execution_records, runtime_file_save_fingerprint};
use super::peer_writer::spawn_peer_writer;
use super::{NotebookRoom, STATE_SYNC_COMPACT_THRESHOLD};
use crate::prompt_cells::prompt_error_manifest;

/// How long `ensure_prompt_agent` waits for the spawned agent to connect and
/// acknowledge the initial RuntimeStateDoc.
const PROMPT_AGENT_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

type SpawnResult = Option<Result<(), String>>;

/// State of the single-flight spawn gate in
/// [`PromptAgentSlot`](super::PromptAgentSlot).
///
/// `Spawning` carries the receiver that waiters follow; the owner publishes
/// the result through the matching sender and resets the phase to `Idle`.
#[derive(Default)]
pub(crate) enum PromptSpawnPhase {
    #[default]
    Idle,
    Spawning(tokio::sync::watch::Receiver<SpawnResult>),
}

/// Resets the spawn phase to `Idle` when the owner finishes or is cancelled.
/// The phase is reset before the watch sender drops, so waiters woken by a
/// dropped sender find the gate open and can retry.
struct SpawnOwner<'a> {
    room: &'a NotebookRoom,
    tx: Option<tokio::sync::watch::Sender<SpawnResult>>,
}

impl SpawnOwner<'_> {
    fn finish(mut self, result: Result<(), String>) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Some(result));
        }
    }
}

impl Drop for SpawnOwner<'_> {
    fn drop(&mut self) {
        let mut phase = self
            .room
            .prompt_agent
            .spawn_phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *phase = PromptSpawnPhase::Idle;
    }
}

enum SpawnClaim<'a> {
    Owner(SpawnOwner<'a>),
    Waiter(tokio::sync::watch::Receiver<SpawnResult>),
}

fn claim_spawn(room: &NotebookRoom) -> SpawnClaim<'_> {
    let mut phase = room
        .prompt_agent
        .spawn_phase
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &*phase {
        PromptSpawnPhase::Spawning(rx) => SpawnClaim::Waiter(rx.clone()),
        PromptSpawnPhase::Idle => {
            let (tx, rx) = tokio::sync::watch::channel(None);
            *phase = PromptSpawnPhase::Spawning(rx);
            SpawnClaim::Owner(SpawnOwner { room, tx: Some(tx) })
        }
    }
}

/// True when the current prompt agent has a live sync connection.
async fn prompt_agent_connected(room: &NotebookRoom) -> bool {
    let slot = &room.prompt_agent;
    let current = slot.current_id.read().await;
    current.is_some() && slot.connected.load(Ordering::Acquire)
}

/// Make sure a prompt agent is running and connected for this room.
///
/// Idempotent and single-flight: concurrent callers share one spawn and all
/// observe its outcome. Returns a user-presentable error when the spawn fails
/// or the agent does not connect within 30 seconds.
pub(crate) async fn ensure_prompt_agent(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<crate::daemon::Daemon>,
) -> Result<(), String> {
    loop {
        if prompt_agent_connected(room).await {
            return Ok(());
        }
        match claim_spawn(room) {
            SpawnClaim::Owner(owner) => {
                let result = spawn_prompt_agent_and_wait(room, daemon).await;
                owner.finish(result.clone());
                return result;
            }
            SpawnClaim::Waiter(mut rx) => {
                let outcome = rx.wait_for(|value| value.is_some()).await;
                match outcome {
                    Ok(value) => {
                        if let Some(result) = value.clone() {
                            return result;
                        }
                    }
                    // The owner was cancelled before publishing a result; the
                    // gate is open again, so retry (and possibly own the spawn).
                    Err(_) => continue,
                }
            }
        }
    }
}

/// Spawn the prompt agent subprocess and wait for it to connect.
async fn spawn_prompt_agent_and_wait(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<crate::daemon::Daemon>,
) -> Result<(), String> {
    let slot = &room.prompt_agent;
    let agent_command = {
        let settings = daemon.settings.read().await;
        settings.get_all().prompt_agent_command
    };

    let nb_id = room.id.to_string();
    let runtime_agent_id = format!("prompt-agent:{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let socket_path = daemon.socket_path().clone();

    // Ordering mirrors the kernel agent: provenance -> generation -> oneshot ->
    // spawn, so a stale agent is rejected and the readiness signal exists
    // before the subprocess can connect.
    {
        let mut current = slot.current_id.write().await;
        *current = Some(runtime_agent_id.clone());
        slot.connected.store(false, Ordering::Release);
    }
    slot.generation.fetch_add(1, Ordering::AcqRel);
    let spawn_generation = slot.generation.load(Ordering::Acquire);
    let connect_rx = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        *slot.pending_connect_tx.lock().await = Some(tx);
        rx
    };

    info!(
        "[prompt-agent] Spawning prompt agent {} for notebook {}",
        runtime_agent_id, nb_id
    );
    let spawned = crate::runtime_agent_handle::RuntimeAgentHandle::spawn_prompt_agent(
        nb_id,
        runtime_agent_id.clone(),
        room.blob_store.root().to_path_buf(),
        socket_path,
        daemon.config.runtime_agent_exe.clone(),
        agent_command.clone(),
    )
    .await;
    let handle = match spawned {
        Ok(handle) => handle,
        Err(error) => {
            warn!("[prompt-agent] Failed to spawn prompt agent: {error}");
            reset_failed_spawn(room, &runtime_agent_id, spawn_generation).await;
            return Err(format!("Could not start the prompt agent: {error}"));
        }
    };

    // Room teardown clears provenance; a handle spawned after that must not
    // outlive it.
    let still_current = slot.current_id.read().await.as_deref() == Some(runtime_agent_id.as_str());
    if !still_current {
        drop(handle);
        return Err("The prompt agent was shut down while starting".to_string());
    }
    *slot.handle.lock().await = Some(handle);

    match recv_oneshot_with_timeout(connect_rx, PROMPT_AGENT_CONNECT_TIMEOUT).await {
        TimedOneShot::Received(()) => {
            info!("[prompt-agent] Prompt agent {runtime_agent_id} connected");
            Ok(())
        }
        TimedOneShot::SenderDropped => {
            warn!("[prompt-agent] Prompt agent {runtime_agent_id} connect cancelled");
            reset_failed_spawn(room, &runtime_agent_id, spawn_generation).await;
            Err("The prompt agent exited before it connected".to_string())
        }
        TimedOneShot::TimedOut => {
            warn!("[prompt-agent] Prompt agent {runtime_agent_id} did not connect within 30s");
            reset_failed_spawn(room, &runtime_agent_id, spawn_generation).await;
            Err(format!(
                "The prompt agent did not connect within {}s (is `{agent_command}` installed?)",
                PROMPT_AGENT_CONNECT_TIMEOUT.as_secs()
            ))
        }
    }
}

/// Undo a spawn that did not reach a connected agent. Only clears slot fields
/// still owned by `runtime_agent_id` / `generation`.
async fn reset_failed_spawn(room: &NotebookRoom, runtime_agent_id: &str, generation: u64) {
    let slot = &room.prompt_agent;
    {
        let mut current = slot.current_id.write().await;
        if current.as_deref() == Some(runtime_agent_id) {
            *current = None;
            slot.connected.store(false, Ordering::Release);
        }
    }
    if slot.generation.load(Ordering::Acquire) != generation {
        return;
    }
    *slot.pending_connect_tx.lock().await = None;
    *slot.handle.lock().await = None;
}

/// Drop everything the room holds for its prompt agent (room teardown and
/// daemon shutdown): the coordinator sender, the subprocess handle and
/// provenance, and fail any prompt execution that was still in flight (with a
/// visible `PromptError`).
///
/// The coordinator task ends when its sender is dropped, so it cannot
/// finalize the runs that this teardown just ended. They are finalized here,
/// synchronously, before the room is persisted: partial text becomes answer
/// cells (marked stopped) and empty streaming placeholders are removed.
///
/// Provenance is cleared first: the agent's connection then applies no more
/// of its frames, and its disconnect is stale and does not repeat the
/// cleanup. Kernel state is never touched.
pub(crate) async fn teardown_prompt_agent(room: &NotebookRoom) {
    // Ending the coordinator task: it exits once its channel closes.
    drop(
        room.prompt_coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take(),
    );
    let slot = &room.prompt_agent;
    {
        let mut current = slot.current_id.write().await;
        slot.connected.store(false, Ordering::Release);
        *current = None;
    }
    *slot.pending_connect_tx.lock().await = None;
    *slot.handle.lock().await = None;
    // Prompts that never reached the agent die with the room as well.
    fail_prompt_executions(room, FailScope::AllPrompts);
    crate::prompt_cells::resolve_stale_placeholders(room).await;
}

/// User-facing reason of a prompt that was running when the agent went away.
const AGENT_STOPPED_MESSAGE: &str = "The prompt agent stopped unexpectedly";
/// User-facing reason of a prompt that was queued for the agent but never
/// started.
const AGENT_DISCONNECTED_MESSAGE: &str = "The prompt agent disconnected before answering";

/// Which prompt executions an agent loss fails.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FailScope {
    /// Running ones and ones already handed to the agent (they carry their
    /// context). Prompts still waiting for cells above are left for the
    /// coordinator, which starts a new agent when they dispatch.
    Dispatched,
    /// Every non-terminal prompt execution (the room is going away).
    AllPrompts,
}

/// End the prompt executions an agent loss orphaned: each gets a
/// `PromptError` output and status `error` (never a silent `cancelled`).
/// Selection and writes are one document step, so a prompt dispatched
/// meanwhile is neither missed nor lost.
fn fail_prompt_executions(room: &NotebookRoom, scope: FailScope) {
    let result = room.state.with_doc(|sd| {
        let running = sd
            .get_prompt_executions("running")
            .into_iter()
            .map(|(execution_id, _)| (execution_id, AGENT_STOPPED_MESSAGE));
        let queued = sd
            .get_prompt_executions("queued")
            .into_iter()
            .filter(|(_, execution)| {
                scope == FailScope::AllPrompts || execution.context_blob.is_some()
            })
            .map(|(execution_id, _)| (execution_id, AGENT_DISCONNECTED_MESSAGE));
        let orphaned: Vec<_> = running.chain(queued).collect();
        for (execution_id, message) in &orphaned {
            sd.append_output(execution_id, &prompt_error_manifest(message))?;
            sd.set_execution_done(execution_id, false)?;
        }
        let failed = orphaned.len();
        if failed > 0 {
            warn!("[prompt-agent] Failed {failed} prompt execution(s) after losing the agent");
        }
        Ok(())
    });
    if let Err(error) = result {
        warn!("[prompt-agent] Failed to end prompt executions: {error}");
    }
}

/// Handle a prompt agent subprocess that connected back to the daemon socket.
///
/// 1. Validates provenance against `room.prompt_agent.current_id`.
/// 2. Performs the initial RuntimeStateDoc sync (the agent needs no
///    NotebookDoc or CommsDoc).
/// 3. Marks the agent connected and, once it acknowledged the initial state,
///    signals the spawn in flight.
/// 4. Relays RuntimeStateDoc sync until the agent disconnects or is replaced
///    (its frames are no longer applied once `current_id` names another
///    agent), then fails its in-flight executions.
pub(crate) async fn handle_prompt_agent_sync_connection<R, W>(
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
    // Frames are read on a dedicated task so the `select!` below stays
    // cancel-safe (see the kernel handler).
    let mut framed_reader = FramedReader::spawn(reader, 16);

    info!(
        "[prompt-agent] Prompt agent sync connection: notebook={} agent={}",
        notebook_id, runtime_agent_id
    );

    // Only the exact id the coordinator spawned is accepted.
    {
        let expected = room.prompt_agent.current_id.read().await;
        match expected.as_deref() {
            Some(expected_id) if expected_id == runtime_agent_id => {}
            other => {
                warn!(
                    "[prompt-agent] Rejecting prompt agent {} (provenance is {:?})",
                    runtime_agent_id, other
                );
                return;
            }
        }
    }

    // ── 1. Initial RuntimeStateDoc sync ──────────────────────────────
    let mut state_sync_state = automerge::sync::State::new();
    let state_sync_msg = match room.state.generate_sync_message_bounded_encoded_recovering(
        &mut state_sync_state,
        STATE_SYNC_COMPACT_THRESHOLD,
        "peer-prompt-agent-state-init",
    ) {
        Ok(message) => message,
        Err(e) => {
            warn!("[prompt-agent] initial state sync failed: {}", e);
            return;
        }
    };
    if let Some(encoded) = state_sync_msg {
        if let Err(e) =
            send_typed_frame(&mut writer, NotebookFrameType::RuntimeStateSync, &encoded).await
        {
            warn!("[prompt-agent] initial state sync send failed: {}", e);
            return;
        }
    }

    // ── 2. Mark connected (only while still the current agent) ───────
    let still_current = {
        let current = room.prompt_agent.current_id.read().await;
        let still_current = current.as_deref() == Some(runtime_agent_id.as_str());
        if still_current {
            room.prompt_agent.connected.store(true, Ordering::Release);
        }
        still_current
    };
    if !still_current {
        warn!(
            "[prompt-agent] Rejecting prompt agent {} after initial sync (provenance changed)",
            runtime_agent_id
        );
        return;
    }
    // take() gives at most one readiness signal per spawn generation.
    let mut connected_tx = room.prompt_agent.pending_connect_tx.lock().await.take();

    // ── 3. Sync loop ─────────────────────────────────────────────────
    let mut state_changed_rx = room.state.subscribe();
    let execution_store =
        runtimed_client::execution_store::ExecutionStore::new(execution_store_dir);
    let mut persisted_execution_records: std::collections::HashMap<
        String,
        runtimed_client::execution_store::ExecutionRecord,
    > = std::collections::HashMap::new();
    let (agent_writer, mut writer_task) = spawn_peer_writer(
        writer,
        notebook_id.clone(),
        format!("prompt-agent:{runtime_agent_id}"),
    );

    loop {
        tokio::select! {
            biased;

            writer_result = &mut writer_task.handle => {
                match flatten_joined_result(writer_result) {
                    JoinedResult::Completed(()) => {
                        info!("[prompt-agent] writer closed cleanly: {}", runtime_agent_id);
                    }
                    JoinedResult::Failed(e) => {
                        warn!("[prompt-agent] writer failed for {}: {}", runtime_agent_id, e);
                    }
                    JoinedResult::JoinFailed(e) => {
                        warn!("[prompt-agent] writer task stopped for {}: {}", runtime_agent_id, e);
                    }
                }
                break;
            }

            maybe_frame = framed_reader.recv() => {
                let typed_frame = match maybe_frame {
                    Some(Ok(frame)) => frame,
                    Some(Err(e)) => {
                        info!("[prompt-agent] disconnected: {}", e);
                        break;
                    }
                    None => {
                        info!("[prompt-agent] disconnected (EOF)");
                        break;
                    }
                };
                match typed_frame.frame_type {
                    NotebookFrameType::RuntimeStateSync => {
                        let Ok(msg) = automerge::sync::Message::decode(&typed_frame.payload) else {
                            continue;
                        };
                        let mut state_changed = false;
                        let mut runtime_file_dirty = false;
                        // Holding the provenance guard across the (synchronous)
                        // apply fences this agent: once teardown or a respawn
                        // replaced it, none of its frames lands, so a late
                        // frame cannot overwrite the failure teardown wrote.
                        let applied = {
                            let current = room.prompt_agent.current_id.read().await;
                            (current.as_deref() == Some(runtime_agent_id.as_str())).then(|| {
                                room.state.with_doc(|sd| {
                                let before = runtime_file_save_fingerprint(sd);
                                let changed = sd
                                    .receive_sync_message_with_changes_recovering(
                                        &mut state_sync_state,
                                        msg,
                                        "peer-prompt-agent-state",
                                    )
                                    .map_err(|e| {
                                        warn!("[prompt-agent] state sync receive failed: {}", e);
                                        e
                                    })?;
                                if changed {
                                    state_changed = true;
                                    runtime_file_dirty = runtime_file_save_fingerprint(sd) != before;
                                }
                                let state_acknowledged =
                                    sd.get_heads() == state_sync_state.shared_heads;
                                let reply = sd
                                    .generate_sync_message_recovering(
                                        &mut state_sync_state,
                                        "peer-prompt-agent-state-reply",
                                    )?
                                    .map(|reply| reply.encode());
                                Ok((reply, state_acknowledged))
                            })
                            })
                        };
                        let Some(applied) = applied else {
                            info!("[prompt-agent] {} was replaced; closing", runtime_agent_id);
                            break;
                        };
                        let (reply_encoded, state_acknowledged) = match applied {
                            Ok(result) => result,
                            Err(e) => {
                                warn!("[prompt-agent] state sync failed: {}", e);
                                break;
                            }
                        };
                        if let Some(encoded) = reply_encoded {
                            if let Err(e) = agent_writer
                                .send_frame(NotebookFrameType::RuntimeStateSync, encoded)
                            {
                                warn!("[prompt-agent] failed to queue state sync reply: {}", e);
                                break;
                            }
                        }
                        if state_acknowledged {
                            if let Some(tx) = connected_tx.take() {
                                let _ = tx.send(());
                                info!(
                                    "[prompt-agent] initial state acknowledged and ready: {}",
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
                            )
                            .await;
                        }
                    }
                    other => {
                        // The prompt agent has no NotebookDoc, CommsDoc,
                        // keyed documents or requests; anything else is
                        // ignored.
                        debug!("[prompt-agent] ignoring frame type {:?}", other);
                    }
                }
            }

            // RuntimeStateDoc changes (dispatched prompts, stops) -> agent.
            _ = state_changed_rx.recv() => {
                while state_changed_rx.try_recv().is_ok() {}
                let encoded = match room.state.generate_sync_message_recovering(
                    &mut state_sync_state,
                    "peer-prompt-agent-state-outbound",
                ) {
                    Ok(message) => message.map(|msg| msg.encode()),
                    Err(e) => {
                        warn!("[prompt-agent] outbound state sync failed: {}", e);
                        break;
                    }
                };
                if let Some(encoded) = encoded {
                    if let Err(e) =
                        agent_writer.send_frame(NotebookFrameType::RuntimeStateSync, encoded)
                    {
                        warn!("[prompt-agent] failed to queue state sync: {}", e);
                        break;
                    }
                }
            }
        }
    }

    if cleanup_prompt_agent_disconnect(&room, &runtime_agent_id).await {
        // The failures written by the cleanup are terminal states; persist
        // them like the kernel handler persists its agent-loss freeze.
        persist_terminal_execution_records(
            &room,
            &execution_store,
            &mut persisted_execution_records,
        )
        .await;
    }

    info!(
        "[prompt-agent] Prompt agent sync connection closed: {}",
        runtime_agent_id
    );
}

/// Disconnect cleanup. Returns true when `runtime_agent_id` was the current
/// prompt agent (a stale agent's disconnect is a no-op).
///
/// When current: running and dispatched prompt executions become `error`
/// with a `PromptError` output and the slot is cleared. The coordinator
/// (still alive) then finalizes them. Kernel lifecycle, presence and queue
/// state are never touched.
async fn cleanup_prompt_agent_disconnect(room: &NotebookRoom, runtime_agent_id: &str) -> bool {
    let slot = &room.prompt_agent;
    let disconnect_generation = slot.generation.load(Ordering::Acquire);
    let is_current = {
        // Held only across the synchronous body: runtime-state writes happen
        // while provenance is still ours, so a replacement spawn cannot
        // interleave.
        let mut current = slot.current_id.write().await;
        if current.as_deref() == Some(runtime_agent_id) {
            fail_prompt_executions(room, FailScope::Dispatched);
            *current = None;
            slot.connected.store(false, Ordering::Release);
            true
        } else {
            false
        }
    };
    if is_current {
        // Clear the handle only if no newer spawn replaced it meanwhile.
        let mut handle = slot.handle.lock().await;
        if slot.generation.load(Ordering::Acquire) == disconnect_generation {
            *handle = None;
        }
    }
    is_current
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::blob_store::BlobStore;
    use runtime_doc::RuntimeStateDoc;

    fn test_room(tmp: &tempfile::TempDir) -> (uuid::Uuid, Arc<NotebookRoom>) {
        let notebook_id = uuid::Uuid::new_v4();
        let notebook_path = tmp.path().join("prompt-agent.ipynb");
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
        (notebook_id, room)
    }

    /// Seed one kernel execution and prompt executions: dispatched to the
    /// agent (has a context) but not started, running, and still waiting
    /// for the coordinator to dispatch (no context).
    fn seed_executions(room: &NotebookRoom) {
        room.state
            .with_doc(|sd| {
                sd.create_execution_with_source_provenance(
                    "kernel-queued",
                    "1 + 1",
                    1,
                    None,
                    Some("cell-k"),
                )?;
                sd.create_execution_with_capability(
                    "prompt-queued",
                    "question one",
                    2,
                    None,
                    Some("prompt-cell-1"),
                    runtime_doc::CAPABILITY_PROMPT,
                )?;
                sd.set_execution_context("prompt-queued", "hash")?;
                sd.create_execution_with_capability(
                    "prompt-running",
                    "question two",
                    3,
                    None,
                    Some("prompt-cell-2"),
                    runtime_doc::CAPABILITY_PROMPT,
                )?;
                sd.set_execution_running("prompt-running")?;
                sd.create_execution_with_capability(
                    "prompt-waiting",
                    "question three",
                    4,
                    None,
                    Some("prompt-cell-3"),
                    runtime_doc::CAPABILITY_PROMPT,
                )
                .map(|_| ())
            })
            .unwrap();
    }

    fn connected(room: &NotebookRoom) -> bool {
        room.prompt_agent.connected.load(Ordering::Acquire)
    }

    /// Run the connection handler for `agent_id` over an in-memory socket
    /// and exchange sync messages until it signals readiness. Returns the
    /// handler task, the agent's doc, its sync state and its socket halves.
    async fn connect_agent(
        tmp: &tempfile::TempDir,
        id: uuid::Uuid,
        room: &Arc<NotebookRoom>,
        agent_id: &str,
    ) -> ConnectedAgent {
        let (connected_tx, mut connected_rx) = tokio::sync::oneshot::channel();
        *room.prompt_agent.pending_connect_tx.lock().await = Some(connected_tx);

        let (coordinator_socket, agent_socket) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = tokio::io::split(coordinator_socket);
        let task = tokio::spawn(handle_prompt_agent_sync_connection(
            reader,
            writer,
            room.clone(),
            id.to_string(),
            agent_id.into(),
            tmp.path().join("executions"),
        ));
        let (agent_reader, writer) = tokio::io::split(agent_socket);
        // FramedReader::recv is cancel-safe, so it may sit in a select! arm.
        let mut agent = ConnectedAgent {
            task,
            reader: FramedReader::spawn(agent_reader, 16),
            writer,
            doc: RuntimeStateDoc::new_with_actor(agent_id),
            peer: automerge::sync::State::new(),
        };

        // No keyed-doc capabilities frame: the first frame is state sync.
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), agent.reader.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(frame.frame_type, NotebookFrameType::RuntimeStateSync);
        agent.receive(&frame.payload);
        // Heads alone do not acknowledge the coordinator's changes.
        assert!(matches!(
            connected_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        // Keep exchanging sync messages until the coordinator is acknowledged.
        let ready = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                agent.send().await;
                tokio::select! {
                    result = &mut connected_rx => break result.unwrap(),
                    frame = agent.reader.recv() => {
                        let frame = frame.unwrap().unwrap();
                        if frame.frame_type == NotebookFrameType::RuntimeStateSync {
                            agent.receive(&frame.payload);
                        }
                    }
                }
            }
        })
        .await;
        ready.expect("readiness after initial state acknowledgement");
        agent
    }

    struct ConnectedAgent {
        task: tokio::task::JoinHandle<()>,
        reader: FramedReader,
        writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
        doc: RuntimeStateDoc,
        peer: automerge::sync::State,
    }

    impl ConnectedAgent {
        fn receive(&mut self, payload: &[u8]) {
            self.doc
                .receive_sync_message_with_changes(
                    &mut self.peer,
                    automerge::sync::Message::decode(payload).unwrap(),
                )
                .unwrap();
        }

        async fn send(&mut self) {
            if let Some(message) = self.doc.generate_sync_message(&mut self.peer) {
                send_typed_frame(
                    &mut self.writer,
                    NotebookFrameType::RuntimeStateSync,
                    &message.encode(),
                )
                .await
                .unwrap();
            }
        }
    }

    fn status(room: &NotebookRoom, execution_id: &str) -> String {
        room.state
            .read(|sd| sd.get_execution(execution_id).unwrap().status)
            .unwrap()
    }

    /// The `PromptError` message of an execution's only output.
    fn prompt_error(room: &NotebookRoom, execution_id: &str) -> String {
        let outputs = room.state.read(|sd| sd.get_outputs(execution_id)).unwrap();
        assert_eq!(outputs.len(), 1, "{execution_id}: {outputs:?}");
        assert_eq!(outputs[0]["output_type"], "error");
        assert_eq!(outputs[0]["ename"], "PromptError");
        outputs[0]["evalue"].as_str().unwrap().to_string()
    }

    /// An agent is rejected without touching the slot, whether another
    /// agent or none at all is expected.
    #[tokio::test]
    async fn rejects_an_unexpected_agent() {
        for expected in [Some("prompt-agent:expected"), None] {
            let tmp = tempfile::TempDir::new().unwrap();
            let (id, room) = test_room(&tmp);
            *room.prompt_agent.current_id.write().await = expected.map(String::from);
            let (coordinator_socket, _agent_socket) = tokio::io::duplex(64 * 1024);
            let (reader, writer) = tokio::io::split(coordinator_socket);
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                handle_prompt_agent_sync_connection(
                    reader,
                    writer,
                    room.clone(),
                    id.to_string(),
                    "prompt-agent:other".into(),
                    tmp.path().join("executions"),
                ),
            )
            .await
            .expect("handler returns after rejecting");
            assert!(!connected(&room));
            assert_eq!(
                room.prompt_agent.current_id.read().await.as_deref(),
                expected,
                "a rejected agent must not change the expected provenance"
            );
        }
    }

    #[tokio::test]
    async fn ready_after_initial_state_acknowledgement_and_cleans_up_on_disconnect() {
        use tokio::io::AsyncWriteExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let (id, room) = test_room(&tmp);
        let agent_id = "prompt-agent:startup-test";
        *room.prompt_agent.current_id.write().await = Some(agent_id.into());
        seed_executions(&room);

        let mut agent = connect_agent(&tmp, id, &room, agent_id).await;
        assert!(connected(&room));
        assert!(prompt_agent_connected(&room).await);
        // The agent sees the dispatched prompt in its synced copy.
        assert!(agent
            .doc
            .get_execution("prompt-queued")
            .is_some_and(|e| e.context_blob.is_some()));

        // Disconnect: prompt executions end, kernel execution is untouched.
        agent.writer.shutdown().await.unwrap();
        drop(agent.writer);
        drop(agent.reader);
        tokio::time::timeout(std::time::Duration::from_secs(5), agent.task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status(&room, "prompt-queued"), "error");
        assert_eq!(status(&room, "prompt-running"), "error");
        assert_eq!(status(&room, "kernel-queued"), "queued");
        assert!(room.prompt_agent.current_id.read().await.is_none());
        assert!(!connected(&room));
        assert!(room.prompt_agent.handle.lock().await.is_none());
    }

    /// Teardown fences the agent before it fails the executions: frames the
    /// agent sends afterwards (here: "prompt-running" done) are not applied,
    /// so they cannot flip the failure back to `done`.
    #[tokio::test]
    async fn frames_from_a_torn_down_agent_are_not_applied() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (id, room) = test_room(&tmp);
        let agent_id = "prompt-agent:fenced";
        *room.prompt_agent.current_id.write().await = Some(agent_id.into());
        seed_executions(&room);
        let mut agent = connect_agent(&tmp, id, &room, agent_id).await;

        teardown_prompt_agent(&room).await;
        assert_eq!(status(&room, "prompt-running"), "error");

        agent
            .doc
            .set_execution_done("prompt-running", true)
            .unwrap();
        agent.send().await;
        tokio::time::timeout(std::time::Duration::from_secs(5), agent.task)
            .await
            .expect("the fenced connection closes")
            .unwrap();
        let running = room
            .state
            .read(|sd| sd.get_execution("prompt-running"))
            .unwrap()
            .unwrap();
        assert_eq!(running.status, "error");
        assert_eq!(running.success, Some(false));
    }

    #[tokio::test]
    async fn disconnect_cleanup_fails_dispatched_prompt_executions_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (_, room) = test_room(&tmp);
        *room.prompt_agent.current_id.write().await = Some("prompt-agent:a".into());
        room.prompt_agent.connected.store(true, Ordering::Release);
        seed_executions(&room);

        assert!(cleanup_prompt_agent_disconnect(&room, "prompt-agent:a").await);

        // Never a silent `cancelled`: both end as `error` with a PromptError.
        assert_eq!(status(&room, "prompt-queued"), "error");
        assert_eq!(
            prompt_error(&room, "prompt-queued"),
            "The prompt agent disconnected before answering"
        );
        assert_eq!(status(&room, "prompt-running"), "error");
        assert_eq!(
            prompt_error(&room, "prompt-running"),
            "The prompt agent stopped unexpectedly"
        );
        // Not yet dispatched: the coordinator will dispatch it later.
        assert_eq!(status(&room, "prompt-waiting"), "queued");
        assert_eq!(status(&room, "kernel-queued"), "queued");
        assert!(room.prompt_agent.current_id.read().await.is_none());
        assert!(!connected(&room));
        // The kernel agent slot was never involved.
        assert!(room.current_runtime_agent_id.read().await.is_none());
    }

    #[tokio::test]
    async fn stale_agent_disconnect_is_a_no_op() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (_, room) = test_room(&tmp);
        *room.prompt_agent.current_id.write().await = Some("prompt-agent:replacement".into());
        room.prompt_agent.connected.store(true, Ordering::Release);
        seed_executions(&room);

        assert!(!cleanup_prompt_agent_disconnect(&room, "prompt-agent:stale").await);

        assert_eq!(
            room.prompt_agent.current_id.read().await.as_deref(),
            Some("prompt-agent:replacement")
        );
        assert!(connected(&room));
        assert_eq!(status(&room, "prompt-queued"), "queued");
        assert_eq!(status(&room, "prompt-running"), "running");
    }

    /// A spawn that timed out must not leave the agent marked connected, or
    /// the next spawn would look connected before its agent is.
    #[tokio::test]
    async fn a_failed_spawn_clears_the_connected_flag() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (_, room) = test_room(&tmp);
        *room.prompt_agent.current_id.write().await = Some("prompt-agent:slow".into());
        room.prompt_agent.connected.store(true, Ordering::Release);
        let generation = room.prompt_agent.generation.load(Ordering::Acquire);

        reset_failed_spawn(&room, "prompt-agent:slow", generation).await;

        assert!(room.prompt_agent.current_id.read().await.is_none());
        assert!(!connected(&room));
        assert!(!prompt_agent_connected(&room).await);
    }

    #[tokio::test]
    async fn teardown_clears_the_slot_and_fails_prompt_executions() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (_, room) = test_room(&tmp);
        *room.prompt_agent.current_id.write().await = Some("prompt-agent:a".into());
        room.prompt_agent.connected.store(true, Ordering::Release);
        let (coordinator_tx, mut coordinator_rx) = tokio::sync::mpsc::unbounded_channel();
        *room.prompt_coordinator.lock().unwrap() = Some(coordinator_tx);
        seed_executions(&room);

        teardown_prompt_agent(&room).await;

        assert!(room.prompt_agent.current_id.read().await.is_none());
        assert!(!connected(&room));
        assert!(room.prompt_coordinator.lock().unwrap().is_none());
        assert!(
            coordinator_rx.recv().await.is_none(),
            "the coordinator channel must close"
        );
        assert_eq!(status(&room, "prompt-queued"), "error");
        assert_eq!(status(&room, "prompt-running"), "error");
        assert_eq!(status(&room, "prompt-waiting"), "error");
        assert_eq!(
            prompt_error(&room, "prompt-running"),
            "The prompt agent stopped unexpectedly"
        );
        assert_eq!(status(&room, "kernel-queued"), "queued");
        // A later disconnect of the torn-down agent is stale.
        assert!(!cleanup_prompt_agent_disconnect(&room, "prompt-agent:a").await);
    }

    /// Teardown mid-stream: the coordinator cannot finalize (its sender is
    /// gone), so teardown turns partial text into stopped answer cells and
    /// removes the empty placeholder.
    #[tokio::test]
    async fn teardown_finalizes_streaming_placeholders() {
        use crate::prompt_cells::{answer_is_streaming, prompt_response_metadata};

        let tmp = tempfile::TempDir::new().unwrap();
        let (_, room) = test_room(&tmp);
        *room.prompt_agent.current_id.write().await = Some("prompt-agent:a".into());
        {
            let mut doc = room.doc.write().await;
            for (index, id) in ["ph-partial", "ph-empty"].into_iter().enumerate() {
                doc.add_cell(index, id, "markdown").unwrap();
            }
            doc.set_cell_metadata(
                "ph-partial",
                &prompt_response_metadata("prompt-cell-2", "prompt-running", 0, true, false),
            )
            .unwrap();
            doc.set_cell_metadata(
                "ph-empty",
                &prompt_response_metadata("prompt-cell-1", "prompt-queued", 0, true, false),
            )
            .unwrap();
        }
        seed_executions(&room);
        room.state
            .with_doc(|sd| {
                sd.append_output(
                    "prompt-running",
                    &serde_json::json!({
                        "output_type": "display_data",
                        "output_id": "answer",
                        "data": {"text/markdown": {"inline": "half an answer"}},
                        "metadata": {},
                    }),
                )
                .map(|_| ())
            })
            .unwrap();

        teardown_prompt_agent(&room).await;

        let cells = room.doc.read().await.get_cells();
        assert!(!cells.iter().any(answer_is_streaming), "{cells:?}");
        assert!(cells.iter().all(|c| c.id != "ph-empty"));
        assert_eq!(cells.len(), 1, "the empty placeholder is removed");
        assert_eq!(cells[0].source, "half an answer");
        assert_eq!(
            cells[0].metadata["nteract"]["prompt_response"]["stopped"],
            true
        );
    }

    #[tokio::test]
    async fn spawn_gate_is_single_flight_and_resets_when_the_owner_is_dropped() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (_, room) = test_room(&tmp);

        let owner = match claim_spawn(&room) {
            SpawnClaim::Owner(owner) => owner,
            SpawnClaim::Waiter(_) => panic!("first claim must own the spawn"),
        };
        let mut waiter = match claim_spawn(&room) {
            SpawnClaim::Waiter(rx) => rx,
            SpawnClaim::Owner(_) => panic!("second claim must wait"),
        };
        owner.finish(Err("boom".into()));
        let outcome = waiter
            .wait_for(|value| value.is_some())
            .await
            .unwrap()
            .clone();
        assert_eq!(outcome, Some(Err("boom".to_string())));
        // Finishing reset the phase, so the next claim owns a fresh spawn.
        let owner = match claim_spawn(&room) {
            SpawnClaim::Owner(owner) => owner,
            SpawnClaim::Waiter(_) => panic!("gate must reopen after finish"),
        };
        let mut waiter = match claim_spawn(&room) {
            SpawnClaim::Waiter(rx) => rx,
            SpawnClaim::Owner(_) => panic!("second claim must wait"),
        };
        // A cancelled owner closes the channel and reopens the gate.
        drop(owner);
        assert!(waiter.wait_for(|value| value.is_some()).await.is_err());
        assert!(matches!(claim_spawn(&room), SpawnClaim::Owner(_)));
    }
}
