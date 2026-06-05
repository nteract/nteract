//! Process-isolated runtime agent.
//!
//! The runtime agent is a subprocess spawned by the coordinator (daemon) that
//! owns the kernel lifecycle, IOPub processing, execution queue, and
//! RuntimeStateDoc writes. It connects back to the daemon's Unix socket as a
//! regular peer.
//!
//! ## CRDT-driven execution
//!
//! The runtime agent does NOT receive execution requests via RPC. Instead, the
//! coordinator writes execution entries (with source code and sequence numbers)
//! to RuntimeStateDoc. The runtime agent discovers new entries via Automerge
//! sync and executes them in seq order.
//!
//! ## Protocol
//!
//! Standard peer protocol over Unix socket:
//! - Frame 0x00: AutomergeSync (NotebookDoc sync, for completions context)
//! - Frame 0x01: RuntimeAgentRequest (coordinator -> runtime agent)
//! - Frame 0x02: RuntimeAgentResponse (runtime agent -> coordinator)
//! - Frame 0x05: RuntimeStateSync (bidirectional, carries execution queue + outputs)
//!
//! ## Lifecycle
//!
//! 1. Runtime agent connects to daemon socket, sends `Handshake::RuntimeAgent`
//! 2. Initial sync for NotebookDoc and RuntimeStateDoc
//! 3. Runtime agent waits for `LaunchKernel` RPC
//! 4. Main select loop: socket frames, LifecycleSignals, WorkCommands, RuntimeStateDoc changes
//! 5. Watches for new `status=queued` execution entries after each sync
//! 6. On shutdown or daemon disconnect, runtime agent exits

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use notebook_doc::presence::PresenceState;
use notebook_protocol::connection::{
    FrameSink, FrameSource, FrameTransport, NotebookFrameType, PackageManager, UdsFrameTransport,
};
use notebook_protocol::protocol::{RuntimeAgentRequest, RuntimeAgentResponse};
use runtime_doc::{CommDocEntry, ExecutionState, RuntimeLifecycle, RuntimeStateDoc};
use runtime_doc::{KernelActivity, RuntimeStateHandle};
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, error, info, warn};

use crate::blob_store::BlobStore;
use crate::jupyter_kernel::JupyterKernel;
use crate::kernel_connection::{KernelConnection, KernelLaunchConfig, KernelSharedRefs};
use crate::kernel_state::KernelState;
use crate::output_prep::{LifecycleSignal, QueueCommandReceivers, WorkCommand};
use crate::protocol::QueueEntry;

mod echo_suppression;
use echo_suppression::EchoSuppressor;

/// Minimum interval between clean-EOF reconnect cycles on a recoverable
/// transport. `reconnect_with_backoff` only delays between *failed* connects;
/// this floor stops a sink that accepts a connection and then immediately
/// closes cleanly (a flapping/evicting cloud room) from spinning a reconnect
/// storm at network-RTT rate. Unused by the UDS transport (which tears down on
/// clean EOF rather than reconnecting).
const CLEAN_EOF_RECONNECT_FLOOR: std::time::Duration = std::time::Duration::from_secs(1);

/// Shared context for the runtime agent (no kernel -- kernel is owned locally).
struct RuntimeAgentContext {
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    broadcast_tx: broadcast::Sender<notebook_protocol::protocol::NotebookBroadcast>,
    presence: Arc<RwLock<PresenceState>>,
    presence_tx: broadcast::Sender<(String, Vec<u8>)>,
}

/// Run the runtime agent, connecting to the daemon socket as a peer.
pub async fn run_runtime_agent(
    socket_path: PathBuf,
    notebook_id: String,
    runtime_agent_id: String,
    blob_root: PathBuf,
) -> anyhow::Result<()> {
    info!(
        "[runtime-agent] Starting runtime_agent_id={} notebook_id={} socket={}",
        runtime_agent_id,
        notebook_id,
        socket_path.display()
    );

    // -- 1. Connect to daemon socket ----------------------------------------

    // The sync wire is abstracted behind `FrameTransport`: the daemon uses the
    // UDS (Windows named-pipe) transport, while a hosted runtime peer will swap
    // in a cloud-WebSocket transport without touching the loop below. `connect`
    // owns the transport-specific dial + handshake.
    let transport =
        UdsFrameTransport::new(&socket_path, &notebook_id, &runtime_agent_id, &blob_root);
    let (mut frame_source, mut frame_sink) = transport.connect().await?;

    info!("[runtime-agent] Connected to daemon, handshake sent");

    // The transport hands back a cancel-safe `FrameSource` (backed by a
    // dedicated `FramedReader` actor) so the busy `select!` below stays
    // cancel-safe — a direct `read_exact` would otherwise drop bytes mid-read
    // whenever another arm wins, producing the runtime-agent ↔ daemon desync
    // captured in production logs as `frame too large: 538976288 bytes`.

    // -- 2. Bootstrap RuntimeStateDoc ---------------------------------------

    let state_doc = RuntimeStateDoc::try_new_with_actor(&runtime_agent_id)
        .map_err(|e| anyhow::anyhow!("create runtime-agent state doc: {e}"))?;
    let mut coordinator_sync_state = automerge::sync::State::new();
    let (state_changed_tx, mut state_changed_rx) = broadcast::channel::<()>(64);
    // Keep a clone of the sender for the reconnect "kick" path that needs
    // to force a sync round even when heads haven't changed.
    let state_kick_tx = state_changed_tx.clone();
    let state = RuntimeStateHandle::new(state_doc, state_changed_tx);

    // -- 3. Create local infrastructure -------------------------------------

    let blob_store = Arc::new(BlobStore::new(blob_root.clone()));
    let (broadcast_tx, _broadcast_rx) =
        broadcast::channel::<notebook_protocol::protocol::NotebookBroadcast>(16);
    let presence = Arc::new(RwLock::new(PresenceState::new()));
    let (presence_tx, _presence_rx) = broadcast::channel::<(String, Vec<u8>)>(16);

    let ctx = RuntimeAgentContext {
        state: state.clone(),
        blob_store,
        broadcast_tx: broadcast_tx.clone(),
        presence,
        presence_tx,
    };

    // -- Local variables owned by the select! loop (no mutex) ---------------

    let mut kernel: Option<JupyterKernel> = None;
    let mut interrupt_handle: Option<crate::jupyter_kernel::InterruptHandle> = None;
    let mut kernel_state = KernelState::new(state.clone());
    let mut seen_execution_ids = HashSet::new();
    let mut echo_suppressor = EchoSuppressor::default();
    // Timestamp of the last clean-EOF reconnect, used to enforce a floor
    // between reconnect cycles on a recoverable (cloud) transport so a flapping
    // sink can't drive a reconnect storm. Only set/read on that path; `None` on
    // the UDS transport, which never reconnects on clean EOF.
    let mut last_clean_reconnect: Option<tokio::time::Instant> = None;
    let mut lifecycle_rx: Option<mpsc::UnboundedReceiver<LifecycleSignal>> = None;
    let mut work_rx: Option<mpsc::Receiver<WorkCommand>> = None;

    // Async responses from spawned tasks (currently: SyncEnvironment).
    // Keeping these off the request handler's await frees the main loop to
    // forward state_changed_rx frames while `sync_dependencies` runs, so the
    // progress banner updates live instead of collapsing to one final write.
    let (async_response_tx, mut async_response_rx) =
        mpsc::channel::<notebook_protocol::protocol::RuntimeAgentResponseEnvelope>(4);

    // In-flight env-sync task. Only one SyncEnvironment may run at a time;
    // overlapping env mutations race on the same prefix. Launch/restart is
    // rejected while a sync is active for the same reason. Shutdown is allowed,
    // but it invalidates the sync generation so terminal progress does not
    // claim the now-shutdown kernel is ready.
    //
    // The atomic is shared between the main loop (which bumps it) and each
    // spawned task (which compares its captured generation before emitting
    // terminal events). u64 wraparound is a non-issue in practice.
    let sync_generation = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut inflight_sync: Option<tokio::task::JoinHandle<()>> = None;

    info!("[runtime-agent] Infrastructure ready, entering main loop");

    // -- 4. Main event loop -------------------------------------------------

    loop {
        tokio::select! {
            // Read frames from daemon socket (cancel-safe via FramedReader actor)
            maybe_frame = frame_source.recv_frame() => {
                match maybe_frame {
                    Some(Ok(typed_frame)) => {
                        match typed_frame.frame_type {
                            // RuntimeAgentRequest: envelope with correlation ID.
                            // Commands (fire-and-forget) get no response.
                            // Queries (Complete, GetHistory) echo the ID back.
                            NotebookFrameType::Request => {
                                if let Ok(envelope) = serde_json::from_slice::<
                                    notebook_protocol::protocol::RuntimeAgentRequestEnvelope,
                                >(&typed_frame.payload) {
                                    // Interrupt bypasses &mut kernel via InterruptHandle
                                    if matches!(envelope.request, RuntimeAgentRequest::InterruptExecution) {
                                        if let Some(ref handle) = interrupt_handle {
                                            let handle = handle.clone();
                                            let (interrupted, cleared) = kernel_state.interrupt();
                                            // Write cleared entries AND sweep any CRDT-synced
                                            // executions that haven't reached the local queue yet.
                                            // Only the agent does this sweep - the coordinator
                                            // intentionally does NOT, so that final state is
                                            // determined by the agent regardless of timing.
                                            mark_interrupted_executions_failed(
                                                &state,
                                                interrupted.as_ref(),
                                                &cleared,
                                            );
                                            // Interrupt kernel in background — don't block the loop
                                            tokio::spawn(async move {
                                                if let Err(e) = handle.interrupt().await {
                                                    warn!("[runtime-agent] Interrupt failed: {}", e);
                                                }
                                            });
                                        } else {
                                            warn!("[runtime-agent] Interrupt requested but no kernel running");
                                        }
                                        continue;
                                    }

                                    // SyncEnvironment runs `uv`/`conda` install, which can take
                                    // seconds. Handling it inline would starve the
                                    // state_changed_rx arm, so the coordinator wouldn't see
                                    // Installing/Solving/Download events until the install
                                    // finished. Snapshot the launched config and spawn.
                                    //
                                    // Reject overlapping syncs rather than aborting the task:
                                    // tokio::process children keep running when their waiting
                                    // future is dropped, so aborting would not stop the uv
                                    // install that is mutating the environment prefix.
                                    if let RuntimeAgentRequest::SyncEnvironment(env_kind) =
                                        &envelope.request
                                    {
                                        if inflight_sync.is_some() {
                                            if let Err(e) = send_runtime_agent_response(
                                                &mut frame_sink,
                                                envelope.id.clone(),
                                                RuntimeAgentResponse::Error {
                                                    error: "Environment sync already in progress"
                                                        .to_string(),
                                                },
                                            )
                                            .await
                                            {
                                                warn!(
                                                    "[runtime-agent] Failed to send busy SyncEnvironment response: {}",
                                                    e
                                                );
                                                break;
                                            }
                                            continue;
                                        }
                                        let generation = sync_generation
                                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                                            .wrapping_add(1);

                                        let snapshot = kernel.as_ref().map(|k| {
                                            (k.env_source().to_string(), k.launched_config().clone())
                                        });
                                        let env_kind = env_kind.clone();
                                        let id = envelope.id.clone();
                                        let state_for_task = ctx.state.clone();
                                        let tx = async_response_tx.clone();
                                        let gen_ref = sync_generation.clone();

                                        let handle = tokio::spawn(async move {
                                            let response = run_sync_environment(
                                                env_kind,
                                                snapshot,
                                                state_for_task,
                                                generation,
                                                gen_ref,
                                            )
                                            .await;
                                            let response = response.unwrap_or_else(|| {
                                                RuntimeAgentResponse::Error {
                                                    error: "Environment sync was superseded"
                                                        .to_string(),
                                                }
                                            });
                                            let envelope = notebook_protocol::protocol::RuntimeAgentResponseEnvelope {
                                                id,
                                                response,
                                            };
                                            if tx.send(envelope).await.is_err() {
                                                warn!(
                                                    "[runtime-agent] SyncEnvironment response channel closed before send",
                                                );
                                            }
                                        });
                                        inflight_sync = Some(handle);
                                        continue;
                                    }

                                    // Launch/restart would race against the active prefix
                                    // mutation, so reject it until the sync task sends its
                                    // response. Shutdown is allowed because the daemon-side
                                    // handler treats it as best-effort, but it still bumps
                                    // the generation so the sync task will skip terminal
                                    // Ready/Error writes after the kernel is gone.
                                    let is_launch_or_restart = matches!(
                                        &envelope.request,
                                        RuntimeAgentRequest::LaunchKernel { .. }
                                            | RuntimeAgentRequest::RestartKernel { .. }
                                    );
                                    if is_launch_or_restart && inflight_sync.is_some() {
                                        if let Err(e) = send_runtime_agent_response(
                                            &mut frame_sink,
                                            envelope.id.clone(),
                                            RuntimeAgentResponse::Error {
                                                error: "Environment sync in progress; retry after it completes"
                                                    .to_string(),
                                            },
                                        )
                                        .await
                                        {
                                            warn!(
                                                "[runtime-agent] Failed to send lifecycle busy response: {}",
                                                e
                                            );
                                            break;
                                        }
                                        continue;
                                    }

                                    if is_launch_or_restart
                                        || matches!(
                                            &envelope.request,
                                            RuntimeAgentRequest::ShutdownKernel
                                        )
                                    {
                                        sync_generation
                                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                    }

                                    let is_command = envelope.request.is_command();
                                    let id = envelope.id.clone();

                                    let (response, new_cmd_rx) = handle_runtime_agent_request(
                                        envelope.request,
                                        &ctx,
                                        &mut kernel,
                                        &mut kernel_state,
                                        &mut seen_execution_ids,
                                    ).await;

                                    if let Some(rx) = new_cmd_rx {
                                        lifecycle_rx = Some(rx.lifecycle_rx);
                                        work_rx = Some(rx.work_rx);
                                    }
                                    // Update interrupt handle after any request that may change kernel state
                                    interrupt_handle = kernel.as_ref().and_then(|k| k.interrupt_handle());

                                    // Only send response for queries (not commands)
                                    if !is_command {
                                        send_runtime_agent_response(&mut frame_sink, id, response).await?;
                                    }
                                }
                            }

                            // RuntimeStateSync -- apply coordinator's changes, check for new queue entries
                            // and forward frontend-originated comm state changes to kernel
                            NotebookFrameType::RuntimeStateSync => {
                                if let Ok(msg) = automerge::sync::Message::decode(&typed_frame.payload) {
                                    // Apply sync and extract data we need for async
                                    // work, all in one lock acquisition.
                                    let sync_result = ctx.state.with_doc(|sd| {
                                        // Snapshot comm state before applying sync so we can
                                        // detect frontend-originated widget state changes.
                                        let comms_before = sd.get_comms();

                                        // Per-change actor filter: diff comm state against a
                                        // foreign-only view of the post-sync doc.
                                        match sd.receive_sync_and_foreign_comms_recovering(
                                            &mut coordinator_sync_state,
                                            msg,
                                            |actor| !actor.to_bytes().starts_with(b"rt:kernel:"),
                                            "runtime-agent-state-receive",
                                        ) {
                                            Ok(view) if !view.applied_actors.is_empty() => {
                                                let queued = sd.get_queued_executions();
                                                let comm_updates = match view.foreign_comms {
                                                    Some(foreign_comms) => {
                                                        diff_comm_state(&comms_before, &foreign_comms)
                                                    }
                                                    None => {
                                                        debug!(
                                                            "[runtime-agent] Skipping comm forward: {} applied change(s) were all self-kernel echoes",
                                                            view.applied_actors.len()
                                                        );
                                                        Vec::new()
                                                    }
                                                };
                                                let comms_after = sd.get_comms();
                                                let superseded_hashes =
                                                    superseded_content_ref_hashes_by_comm(
                                                        &comms_before,
                                                        &comms_after,
                                                        &comm_updates,
                                                    );
                                                Ok(Some((queued, comm_updates, superseded_hashes)))
                                            }
                                            Ok(_) => Ok(None),
                                            Err(e) => {
                                                warn!(
                                                    "[runtime-agent] Failed to apply RuntimeStateSync: {}",
                                                    e
                                                );
                                                Err(e.into())
                                            }
                                        }
                                    });

                                    // Async work outside the lock
                                    match sync_result {
                                        Ok(Some((
                                            queued,
                                            comm_updates,
                                            superseded_hashes_by_comm,
                                        ))) => {
                                            if !comm_updates.is_empty() {
                                                if let Some(ref mut k) = kernel {
                                                    for (comm_id, delta) in &comm_updates {
                                                        let superseded_hashes =
                                                            superseded_hashes_by_comm
                                                                .get(comm_id)
                                                                .cloned()
                                                                .unwrap_or_default();
                                                        let Some(update) = prepare_comm_update(
                                                            comm_id,
                                                            delta,
                                                            &ctx.blob_store,
                                                            &mut echo_suppressor,
                                                        )
                                                        .await
                                                        else {
                                                            // The doc supersession already happened; even though no
                                                            // kernel send is needed for an echo, stale ephemeral blobs
                                                            // can be freed here. Failed kernel sends skip this cleanup
                                                            // below so the bytes remain available for a retry.
                                                            free_superseded_ephemeral_blobs(
                                                                &ctx.blob_store,
                                                                comm_id,
                                                                &superseded_hashes,
                                                            )
                                                            .await;
                                                            continue;
                                                        };
                                                        let RehydratedCommUpdate {
                                                            state,
                                                            buffer_paths,
                                                            buffers,
                                                            content_hashes,
                                                        } = update;
                                                        match k
                                                            .send_comm_update(
                                                                comm_id,
                                                                state,
                                                                buffer_paths,
                                                                buffers,
                                                            )
                                                            .await
                                                        {
                                                            Ok(()) => {
                                                                for hash in content_hashes {
                                                                    echo_suppressor.record_outgoing(
                                                                        comm_id, &hash,
                                                                    );
                                                                }
                                                                free_superseded_ephemeral_blobs(
                                                                    &ctx.blob_store,
                                                                    comm_id,
                                                                    &superseded_hashes,
                                                                )
                                                                .await;
                                                            }
                                                            Err(e) => {
                                                                warn!("[runtime-agent] Failed to forward comm state to kernel: {}", e);
                                                            }
                                                        }
                                                    }
                                                }
                                            }

                                            queue_synced_executions(
                                                queued,
                                                &mut seen_execution_ids,
                                                &mut kernel_state,
                                                kernel.as_mut(),
                                            )
                                            .await;
                                        }
                                        Ok(None) => {}
                                        Err(e) => {
                                            warn!("[runtime-agent] Closing after RuntimeStateSync failure: {}", e);
                                            break;
                                        }
                                    }

                                    // Send sync reply
                                    let reply_encoded = match ctx
                                        .state
                                        .generate_sync_message_recovering(
                                            &mut coordinator_sync_state,
                                            "runtime-agent-state-reply",
                                        ) {
                                            Ok(message) => message.map(|reply| reply.encode()),
                                            Err(e) => {
                                                warn!(
                                                    "[runtime-agent] Closing after RuntimeStateSync reply failure: {}",
                                                    e
                                                );
                                                break;
                                            }
                                        };
                                    if let Some(encoded) = reply_encoded {
                                        let _ = frame_sink.send_frame(
                                            NotebookFrameType::RuntimeStateSync,
                                            &encoded,
                                        ).await;
                                    }
                                }
                            }

                            // AutomergeSync (NotebookDoc -- for completions context)
                            NotebookFrameType::AutomergeSync => {
                                // The runtime agent doesn't need NotebookDoc state for execution
                                // (source comes from execution entries), but it may be
                                // useful for completions context in the future.
                                debug!("[runtime-agent] Received NotebookDoc sync frame (ignored for now)");
                            }

                            _ => {
                                debug!("[runtime-agent] Ignoring frame type {:?}", typed_frame.frame_type);
                            }
                        }
                    }
                    Some(Err(e)) => {
                        // A framing error here means one of two things:
                        //   - the daemon half-closed the sync stream (clean),
                        //     which we treat as a disconnect,
                        //   - or a byte-level desync corrupted the stream
                        //     (e.g. a stray writer, a massive length field
                        //     tripping the MAX_FRAME_SIZE cap).
                        // Either way the kernel state is still ours to own.
                        // Try to reconnect before tearing down the kernel —
                        // a brief network-side blip should not cost the user
                        // their session. Reconnection does a fresh handshake
                        // and a fresh Automerge sync state; the kernel,
                        // queue, seen_execution_ids, and local doc stay.
                        warn!(
                            "[runtime-agent] Socket read error: {} — reconnecting \
                             (kernel stays running)",
                            e
                        );
                        // Drop the old source before reconnecting so its
                        // background reader task exits cleanly.
                        drop(frame_source);
                        match reconnect_with_backoff(&transport).await {
                            Ok((new_source, new_sink)) => {
                                frame_source = new_source;
                                frame_sink = new_sink;
                                // The daemon creates a fresh sync state for
                                // each connection; match that or the doc
                                // won't converge.
                                coordinator_sync_state = automerge::sync::State::new();
                                // Kick off a full resync so the daemon gets
                                // everything the kernel produced while we
                                // were disconnected.
                                let _ = state_kick_tx.send(());
                                info!("[runtime-agent] Reconnected to daemon");
                                continue;
                            }
                            Err(reconnect_err) => {
                                error!(
                                    "[runtime-agent] Reconnect failed after retries: {}",
                                    reconnect_err
                                );
                                break;
                            }
                        }
                    }
                    None => {
                        // Clean EOF (peer half-closed). The teardown policy is
                        // transport-specific. For the daemon socket a clean
                        // close means the daemon is gone, so we tear the kernel
                        // down (historical behavior). For a cloud-WS sink a
                        // clean close is an idle timeout / eviction / blip and
                        // must NOT kill a healthy daemon-managed kernel — we
                        // reconnect and resync exactly like the framing-error
                        // path above. (lifecycle-analysis req #1)
                        if !transport.clean_eof_is_recoverable() {
                            info!("[runtime-agent] Daemon disconnected (EOF)");
                            break;
                        }
                        // Floor between reconnect cycles. `reconnect_with_backoff`
                        // only sleeps between *failed* connects; a sink that
                        // accepts the connection and then immediately closes
                        // cleanly every time (a flapping/evicting cloud room)
                        // would otherwise spin a reconnect storm at network-RTT
                        // rate. If the previous clean reconnect was very recent,
                        // wait out the floor before redialing.
                        if let Some(last) = last_clean_reconnect {
                            let since = last.elapsed();
                            if since < CLEAN_EOF_RECONNECT_FLOOR {
                                tokio::time::sleep(CLEAN_EOF_RECONNECT_FLOOR - since).await;
                            }
                        }
                        warn!(
                            "[runtime-agent] Sync sink closed cleanly — reconnecting \
                             (kernel stays running)"
                        );
                        drop(frame_source);
                        match reconnect_with_backoff(&transport).await {
                            Ok((new_source, new_sink)) => {
                                frame_source = new_source;
                                frame_sink = new_sink;
                                coordinator_sync_state = automerge::sync::State::new();
                                let _ = state_kick_tx.send(());
                                last_clean_reconnect = Some(tokio::time::Instant::now());
                                info!("[runtime-agent] Reconnected after clean close");
                                continue;
                            }
                            Err(reconnect_err) => {
                                error!(
                                    "[runtime-agent] Reconnect failed after retries: {}",
                                    reconnect_err
                                );
                                break;
                            }
                        }
                    }
                }
            }

            // Process lifecycle commands from kernel tasks. These are
            // control-plane signals and intentionally do not share the
            // bounded output/work queue.
            Some(signal) = async {
                match lifecycle_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                if let Err(e) = handle_lifecycle_signal(
                    signal,
                    &ctx,
                    &mut kernel,
                    &mut kernel_state,
                ).await {
                    warn!("[runtime-agent] Error handling lifecycle signal: {}", e);
                }
            }

            // Process bounded output/work commands from kernel tasks.
            Some(command) = async {
                match work_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                // If output work was selected while lifecycle signals were
                // also pending, drain lifecycle first so output transport
                // cannot sit ahead of idle/done/error/death processing.
                if let Some(rx) = lifecycle_rx.as_mut() {
                    if let Err(e) = drain_lifecycle_commands(
                        rx,
                        &ctx,
                        &mut kernel,
                        &mut kernel_state,
                    ).await {
                        warn!("[runtime-agent] Error draining lifecycle commands: {}", e);
                    }
                }
                if let Err(e) = handle_work_command(command, &mut kernel).await {
                    warn!("[runtime-agent] Error handling work command: {}", e);
                }
            }

            // Sync RuntimeStateDoc changes to coordinator
            _ = state_changed_rx.recv() => {
                while state_changed_rx.try_recv().is_ok() {}

                let encoded = match ctx
                    .state
                    .generate_sync_message_recovering(
                        &mut coordinator_sync_state,
                        "runtime-agent-state-outbound",
                    ) {
                        Ok(message) => message.map(|msg| msg.encode()),
                        Err(e) => {
                            warn!(
                                "[runtime-agent] Closing after outbound RuntimeStateSync failure: {}",
                                e
                            );
                            break;
                        }
                    };
                if let Some(encoded) = encoded {
                    if let Err(e) = frame_sink.send_frame(
                        NotebookFrameType::RuntimeStateSync,
                        &encoded,
                    ).await {
                        warn!("[runtime-agent] Failed to send RuntimeStateSync: {}", e);
                        break;
                    }
                }
            }

            // Responses from long-running spawned tasks (SyncEnvironment).
            Some(envelope) = async_response_rx.recv() => {
                inflight_sync = None;
                if let Err(e) = send_runtime_agent_response_envelope(&mut frame_sink, envelope).await {
                    warn!("[runtime-agent] Failed to send async response: {}", e);
                    break;
                }
            }
        }
    }

    // -- 5. Cleanup ---------------------------------------------------------

    info!("[runtime-agent] Shutting down");
    if let Some(ref mut k) = kernel {
        k.shutdown().await.ok();
    }

    Ok(())
}

async fn send_runtime_agent_response<S: FrameSink>(
    sink: &mut S,
    id: String,
    response: RuntimeAgentResponse,
) -> anyhow::Result<()> {
    send_runtime_agent_response_envelope(
        sink,
        notebook_protocol::protocol::RuntimeAgentResponseEnvelope { id, response },
    )
    .await
}

async fn send_runtime_agent_response_envelope<S: FrameSink>(
    sink: &mut S,
    envelope: notebook_protocol::protocol::RuntimeAgentResponseEnvelope,
) -> anyhow::Result<()> {
    let json = serde_json::to_vec(&envelope)?;
    sink.send_frame(NotebookFrameType::Response, &json).await?;
    Ok(())
}

/// Attempt to reconnect via the transport with exponential backoff.
///
/// Called after a framing error on the existing sync stream. Preserves
/// the kernel state by staying alive across transient socket trouble
/// (rogue client writing to the socket, daemon restart, etc.). Gives up
/// after a bounded number of attempts so a genuinely-gone daemon still
/// lets the agent exit rather than spin forever. The transport owns the
/// dial + handshake, so this stays transport-agnostic.
async fn reconnect_with_backoff<T: FrameTransport>(
    transport: &T,
) -> anyhow::Result<(T::Source, T::Sink)> {
    const MAX_ATTEMPTS: u32 = 10;
    const BASE_DELAY_MS: u64 = 100;

    let mut last_err: Option<std::io::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match transport.connect().await {
            Ok(pair) => return Ok(pair),
            Err(e) => {
                let delay = BASE_DELAY_MS.saturating_mul(1 << (attempt - 1).min(6));
                warn!(
                    "[runtime-agent] Reconnect attempt {}/{} failed: {} (retrying in {}ms)",
                    attempt, MAX_ATTEMPTS, e, delay
                );
                last_err = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
    }
    Err(last_err
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow::anyhow!("reconnect gave up with no last error")))
}

async fn queue_synced_executions<K: KernelConnection>(
    queued: Vec<(String, ExecutionState)>,
    seen_execution_ids: &mut HashSet<String>,
    kernel_state: &mut KernelState,
    kernel: Option<&mut K>,
) -> usize {
    let Some(kernel) = kernel else {
        return 0;
    };

    let mut queued_count = 0;
    for (eid, exec) in queued {
        if seen_execution_ids.contains(&eid) {
            continue;
        }

        let Some(source) = exec.source else {
            debug!(
                "[runtime-agent] Deferred queued execution {} without source",
                eid
            );
            continue;
        };

        match kernel_state
            .queue_cell(eid.clone(), exec.cell_id.clone(), source, &mut *kernel)
            .await
        {
            Ok(_) => {
                seen_execution_ids.insert(eid.clone());
                queued_count += 1;
                info!("[runtime-agent] Queued execution {}", eid);
            }
            Err(e) => {
                warn!("[runtime-agent] Failed to queue execution {}: {}", eid, e);
            }
        }
    }

    queued_count
}

/// Handle a `RuntimeAgentRequest` and return a `RuntimeAgentResponse`.
///
/// Also returns optional command receivers when a kernel is launched/restarted
/// (the caller needs to install them in the select! loop).
///
/// Note: ExecuteCell is NOT handled here -- execution is CRDT-driven.
/// The coordinator writes execution entries to RuntimeStateDoc, and the
/// runtime agent picks them up via sync.
async fn handle_runtime_agent_request(
    request: RuntimeAgentRequest,
    ctx: &RuntimeAgentContext,
    kernel: &mut Option<JupyterKernel>,
    state: &mut KernelState,
    seen_execution_ids: &mut HashSet<String>,
) -> (RuntimeAgentResponse, Option<QueueCommandReceivers>) {
    match request {
        RuntimeAgentRequest::LaunchKernel {
            kernel_type,
            env_source,
            notebook_path,
            launched_config,
            kernel_ports,
            env_vars,
            redact_env_values_in_outputs,
        } => {
            info!(
                "[runtime-agent] LaunchKernel: type={} source={}",
                kernel_type, env_source
            );

            let pooled_env = launched_config.venv_path.as_ref().and_then(|venv| {
                launched_config
                    .python_path
                    .as_ref()
                    .map(|python| runtimed_client::PooledEnv {
                        env_type: if env_source.package_manager() == Some(PackageManager::Conda) {
                            runtimed_client::EnvType::Conda
                        } else {
                            runtimed_client::EnvType::Uv
                        },
                        venv_path: venv.clone(),
                        python_path: python.clone(),
                        prewarmed_packages: launched_config.prewarmed_packages.clone(),
                    })
            });

            let shared = KernelSharedRefs {
                state: ctx.state.clone(),
                blob_store: ctx.blob_store.clone(),
                broadcast_tx: ctx.broadcast_tx.clone(),
                presence: ctx.presence.clone(),
                presence_tx: ctx.presence_tx.clone(),
            };
            let launch_kernel_type = kernel_type.clone();
            let launch_env_source = env_source.as_str().to_string();
            let config = KernelLaunchConfig {
                kernel_type,
                env_source: env_source.as_str().to_string(),
                notebook_path: notebook_path.as_deref().map(PathBuf::from),
                launched_config,
                kernel_ports,
                env_vars: env_vars.into_iter().collect(),
                redact_env_values_in_outputs,
                pooled_env,
            };

            let launch_started = std::time::Instant::now();
            match JupyterKernel::launch(config, shared).await {
                Ok((k, rx)) => {
                    let es = k.env_source().to_string();
                    *kernel = Some(k);
                    state.reset();
                    state.set_idle();
                    info!(
                        "[runtime-agent] LaunchKernel completed: type={} source={} elapsed_ms={}",
                        launch_kernel_type,
                        launch_env_source,
                        launch_started.elapsed().as_millis()
                    );
                    let queued = ctx
                        .state
                        .read(|sd| sd.get_queued_executions())
                        .unwrap_or_default();
                    queue_synced_executions(queued, seen_execution_ids, state, kernel.as_mut())
                        .await;
                    (
                        RuntimeAgentResponse::KernelLaunched {
                            env_source: notebook_protocol::connection::EnvSource::parse(&es),
                        },
                        Some(rx),
                    )
                }
                Err(e) => {
                    warn!(
                        "[runtime-agent] LaunchKernel failed: type={} source={} elapsed_ms={} error={}",
                        launch_kernel_type,
                        launch_env_source,
                        launch_started.elapsed().as_millis(),
                        e
                    );
                    (
                        RuntimeAgentResponse::Error {
                            error: format!("Failed to launch kernel: {}", e),
                        },
                        None,
                    )
                }
            }
        }

        RuntimeAgentRequest::RestartKernel {
            kernel_type,
            env_source,
            notebook_path,
            launched_config,
            kernel_ports,
            env_vars,
            redact_env_values_in_outputs,
        } => {
            info!(
                "[runtime-agent] RestartKernel: type={} source={}",
                kernel_type, env_source
            );

            // Capture in-flight executions before shutdown so we can mark them
            // as failed in RuntimeStateDoc (the old kernel can't finish them).
            let interrupted_eid = state.executing_cell().cloned();
            let stale_queue: Vec<_> = state
                .queued_entries()
                .iter()
                .map(|e| e.execution_id.clone())
                .collect();

            // Shut down existing kernel
            if let Some(ref mut k) = kernel {
                k.shutdown().await.ok();
            }
            *kernel = None;

            // Clear seen execution IDs so new RunAllCells entries are picked up
            seen_execution_ids.clear();

            let pooled_env = launched_config.venv_path.as_ref().and_then(|venv| {
                launched_config
                    .python_path
                    .as_ref()
                    .map(|python| runtimed_client::PooledEnv {
                        env_type: if env_source.package_manager() == Some(PackageManager::Conda) {
                            runtimed_client::EnvType::Conda
                        } else {
                            runtimed_client::EnvType::Uv
                        },
                        venv_path: venv.clone(),
                        python_path: python.clone(),
                        prewarmed_packages: launched_config.prewarmed_packages.clone(),
                    })
            });

            let shared = KernelSharedRefs {
                state: ctx.state.clone(),
                blob_store: ctx.blob_store.clone(),
                broadcast_tx: ctx.broadcast_tx.clone(),
                presence: ctx.presence.clone(),
                presence_tx: ctx.presence_tx.clone(),
            };
            let launch_kernel_type = kernel_type.clone();
            let launch_env_source = env_source.as_str().to_string();
            let config = KernelLaunchConfig {
                kernel_type,
                env_source: env_source.as_str().to_string(),
                notebook_path: notebook_path.as_deref().map(PathBuf::from),
                launched_config,
                kernel_ports,
                env_vars: env_vars.into_iter().collect(),
                redact_env_values_in_outputs,
                pooled_env,
            };

            // Mark stale executions as failed in RuntimeStateDoc.
            // The old kernel is gone after shutdown, so these executions
            // can never complete — do this before launching the new kernel.
            if let Err(e) = ctx.state.with_doc(|sd| {
                if let Some(ref eid) = interrupted_eid {
                    sd.set_execution_done(eid, false)?;
                }
                for eid in &stale_queue {
                    sd.set_execution_done(eid, false)?;
                }
                // Defensive sweep: mark any execution entries stuck in
                // "running" or "queued" that the local KernelState missed
                // (e.g., entries from CRDT sync not yet processed locally).
                match sd.mark_inflight_executions_failed() {
                    Ok(orphans) if orphans > 0 => {
                        info!(
                            "[runtime-agent] Marked {orphans} orphaned execution(s) as failed on restart"
                        );
                    }
                    Err(e) => {
                        warn!("[runtime-state] {}", e);
                    }
                    _ => {}
                }
                sd.set_queue(None, &[])?;
                Ok(())
            }) {
                warn!("[runtime-state] {}", e);
            }

            let launch_started = std::time::Instant::now();
            match JupyterKernel::launch(config, shared).await {
                Ok((k, rx)) => {
                    let es = k.env_source().to_string();
                    *kernel = Some(k);
                    state.reset();
                    state.set_idle();
                    info!(
                        "[runtime-agent] RestartKernel completed: type={} source={} elapsed_ms={}",
                        launch_kernel_type,
                        launch_env_source,
                        launch_started.elapsed().as_millis()
                    );
                    (
                        RuntimeAgentResponse::KernelRestarted {
                            env_source: notebook_protocol::connection::EnvSource::parse(&es),
                        },
                        Some(rx),
                    )
                }
                Err(e) => {
                    warn!(
                        "[runtime-agent] RestartKernel failed: type={} source={} elapsed_ms={} error={}",
                        launch_kernel_type,
                        launch_env_source,
                        launch_started.elapsed().as_millis(),
                        e
                    );
                    (
                        RuntimeAgentResponse::Error {
                            error: format!("Failed to restart kernel: {}", e),
                        },
                        None,
                    )
                }
            }
        }

        RuntimeAgentRequest::InterruptExecution => {
            if let Some(ref mut k) = kernel {
                match k.interrupt().await {
                    Ok(()) => {
                        let (interrupted, cleared) = state.interrupt();
                        // Write cleared entries AND sweep CRDT-synced executions
                        // that haven't reached the local queue yet.
                        mark_interrupted_executions_failed(
                            &ctx.state,
                            interrupted.as_ref(),
                            &cleared,
                        );
                        (
                            RuntimeAgentResponse::InterruptAcknowledged { cleared },
                            None,
                        )
                    }
                    Err(e) => (
                        RuntimeAgentResponse::Error {
                            error: format!("Failed to interrupt: {}", e),
                        },
                        None,
                    ),
                }
            } else {
                (
                    RuntimeAgentResponse::Error {
                        error: "No kernel running".to_string(),
                    },
                    None,
                )
            }
        }

        RuntimeAgentRequest::ShutdownKernel => {
            if let Some(ref mut k) = kernel {
                k.shutdown().await.ok();
            }
            *kernel = None;
            (RuntimeAgentResponse::Ok, None)
        }

        RuntimeAgentRequest::SendComm { message } => {
            if let Some(ref mut k) = kernel {
                match k.send_comm_message(*message).await {
                    Ok(()) => (RuntimeAgentResponse::Ok, None),
                    Err(e) => (
                        RuntimeAgentResponse::Error {
                            error: format!("Failed to send comm: {}", e),
                        },
                        None,
                    ),
                }
            } else {
                (
                    RuntimeAgentResponse::Error {
                        error: "No kernel running".to_string(),
                    },
                    None,
                )
            }
        }

        RuntimeAgentRequest::Complete { code, cursor_pos } => {
            if let Some(ref mut k) = kernel {
                match k.complete(&code, cursor_pos).await {
                    Ok((items, cursor_start, cursor_end)) => (
                        RuntimeAgentResponse::CompletionResult {
                            items,
                            cursor_start,
                            cursor_end,
                        },
                        None,
                    ),
                    Err(e) => (
                        RuntimeAgentResponse::Error {
                            error: format!("Failed to complete: {}", e),
                        },
                        None,
                    ),
                }
            } else {
                (
                    RuntimeAgentResponse::Error {
                        error: "No kernel running".to_string(),
                    },
                    None,
                )
            }
        }

        RuntimeAgentRequest::GetHistory { pattern, n, unique } => {
            if let Some(ref mut k) = kernel {
                match k.get_history(pattern.as_deref(), n, unique).await {
                    Ok(entries) => (RuntimeAgentResponse::HistoryResult { entries }, None),
                    Err(e) => (
                        RuntimeAgentResponse::Error {
                            error: format!("Failed to get history: {}", e),
                        },
                        None,
                    ),
                }
            } else {
                (
                    RuntimeAgentResponse::Error {
                        error: "No kernel running".to_string(),
                    },
                    None,
                )
            }
        }

        RuntimeAgentRequest::SyncEnvironment(_) => {
            // The main select loop intercepts SyncEnvironment and spawns
            // `run_sync_environment` so it doesn't block state sync. This
            // arm is unreachable in practice, but keeps the match exhaustive.
            (
                RuntimeAgentResponse::Error {
                    error: "SyncEnvironment must be dispatched through run_sync_environment"
                        .to_string(),
                },
                None,
            )
        }
    }
}

/// Run a hot-sync install outside the main select loop.
///
/// The caller snapshots the kernel's `(env_source, launched_config)` before
/// spawning so we don't borrow the kernel across the install. Progress phases
/// flow through [`RuntimeDocProgressHandler`] into the runtime-agent's
/// RuntimeStateDoc, which the main loop forwards to the coordinator live.
///
/// `generation` is the sync generation this task owns; `current_generation`
/// is a shared atomic bumped by the main loop on kernel lifecycle transitions
/// and on any newer SyncEnvironment request. Returning `None` signals the task
/// was superseded: the caller drops the response so a stale id doesn't
/// correlate to the coordinator's latest request, and the final Ready/Error
/// is skipped so we don't clobber a fresher `env.progress` write.
async fn run_sync_environment(
    env_kind: notebook_protocol::protocol::EnvKind,
    kernel_snapshot: Option<(String, notebook_protocol::protocol::LaunchedEnvConfig)>,
    state: RuntimeStateHandle,
    generation: u64,
    current_generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
) -> Option<RuntimeAgentResponse> {
    info!(
        "[runtime-agent] SyncEnvironment[gen={}]: installing {:?}",
        generation,
        env_kind.packages()
    );

    let is_current = || current_generation.load(std::sync::atomic::Ordering::SeqCst) == generation;

    let Some((es, launched)) = kernel_snapshot else {
        return Some(RuntimeAgentResponse::Error {
            error: "No kernel running".to_string(),
        });
    };

    // Deno doesn't support hot-sync — requires kernel restart.
    if es == "deno" {
        return Some(RuntimeAgentResponse::Error {
            error: "Hot-sync not supported for Deno environments. Kernel restart required."
                .to_string(),
        });
    }

    let Some(venv_path) = launched.venv_path.clone() else {
        return Some(RuntimeAgentResponse::Error {
            error: "No venv path available".to_string(),
        });
    };
    let Some(python_path) = launched.python_path.clone() else {
        return Some(RuntimeAgentResponse::Error {
            error: "No python path available".to_string(),
        });
    };

    let handler: std::sync::Arc<dyn kernel_env::ProgressHandler> = std::sync::Arc::new(
        crate::inline_env::RuntimeDocProgressHandler::new(state.clone()),
    );

    match env_kind {
        notebook_protocol::protocol::EnvKind::Uv { packages } => {
            let uv_env = kernel_env::uv::UvEnvironment {
                venv_path: venv_path.clone(),
                python_path: python_path.clone(),
            };
            match kernel_env::uv::sync_dependencies(&uv_env, &packages, handler.clone()).await {
                Ok(()) => {
                    if !is_current() {
                        debug!(
                            "[runtime-agent] SyncEnvironment[gen={}] superseded before Ready",
                            generation
                        );
                        return None;
                    }
                    // Terminal Ready phase so the frontend banner clears.
                    // `sync_dependencies` emits InstallComplete, which is not a
                    // terminal state for `projectEnvProgress`; Ready is.
                    handler.on_progress(
                        "uv",
                        kernel_env::EnvProgressPhase::Ready {
                            env_path: venv_path.to_string_lossy().into_owned(),
                            python_path: python_path.to_string_lossy().into_owned(),
                        },
                    );
                    Some(RuntimeAgentResponse::EnvironmentSynced {
                        synced_packages: packages,
                    })
                }
                Err(e) => {
                    error!(
                        "[runtime-agent] Failed to sync UV packages {:?}: {}",
                        packages, e
                    );
                    if !is_current() {
                        return None;
                    }
                    let msg = format!("Failed to install packages: {}", e);
                    handler.on_progress(
                        "uv",
                        kernel_env::EnvProgressPhase::Error {
                            message: msg.clone(),
                        },
                    );
                    Some(RuntimeAgentResponse::Error { error: msg })
                }
            }
        }
        notebook_protocol::protocol::EnvKind::Conda { packages, channels } => {
            let conda_env = kernel_env::conda::CondaEnvironment {
                env_path: venv_path.clone(),
                python_path: python_path.clone(),
            };
            let conda_deps = kernel_env::conda::CondaDependencies {
                dependencies: packages.clone(),
                channels: if channels.is_empty() {
                    vec!["conda-forge".to_string()]
                } else {
                    channels
                },
                python: None,
                env_id: None,
            };
            match kernel_env::conda::sync_dependencies(&conda_env, &conda_deps, handler.clone())
                .await
            {
                Ok(()) => {
                    if !is_current() {
                        debug!(
                            "[runtime-agent] SyncEnvironment[gen={}] superseded before Ready",
                            generation
                        );
                        return None;
                    }
                    handler.on_progress(
                        "conda",
                        kernel_env::EnvProgressPhase::Ready {
                            env_path: venv_path.to_string_lossy().into_owned(),
                            python_path: python_path.to_string_lossy().into_owned(),
                        },
                    );
                    Some(RuntimeAgentResponse::EnvironmentSynced {
                        synced_packages: packages,
                    })
                }
                Err(e) => {
                    error!(
                        "[runtime-agent] Failed to sync Conda packages {:?} with channels {:?}: {}",
                        packages, conda_deps.channels, e
                    );
                    if !is_current() {
                        return None;
                    }
                    let msg = format!("Failed to install packages: {}", e);
                    handler.on_progress(
                        "conda",
                        kernel_env::EnvProgressPhase::Error {
                            message: msg.clone(),
                        },
                    );
                    Some(RuntimeAgentResponse::Error { error: msg })
                }
            }
        }
    }
}

/// Handle a control-plane lifecycle signal from the kernel's tasks.
///
/// Lifecycle signals are rare (zero or one per execution), unbounded-channel,
/// and must not be dropped. See `execution-pipeline.md` Decision 2.
async fn handle_lifecycle_signal(
    signal: LifecycleSignal,
    ctx: &RuntimeAgentContext,
    kernel: &mut Option<JupyterKernel>,
    state: &mut KernelState,
) -> anyhow::Result<()> {
    match signal {
        LifecycleSignal::ExecutionDone { execution_id } => {
            debug!("[runtime-agent] ExecutionDone for {}", execution_id);
            if let Some(ref mut k) = kernel {
                if let Err(e) = state.execution_done(&execution_id, k).await {
                    warn!("[runtime-agent] execution_done error: {}", e);
                }
            }
        }

        LifecycleSignal::KernelIdle { execution_id } => {
            if let Some(ref mut k) = kernel {
                if let Err(e) = state.kernel_idle(execution_id.as_deref(), k).await {
                    warn!("[runtime-agent] kernel_idle error: {}", e);
                }
            }
        }

        LifecycleSignal::CellError { execution_id } => {
            debug!("[runtime-agent] CellError: execution={}", execution_id);
            if state.mark_execution_error(&execution_id) {
                let cleared = state.clear_queue();
                if let Err(e) = ctx.state.with_doc(|sd| {
                    for entry in &cleared {
                        sd.set_execution_done(&entry.execution_id, false)?;
                    }
                    sd.set_queue(None, &[])?;
                    Ok(())
                }) {
                    warn!("[runtime-state] {}", e);
                }
            }
        }

        LifecycleSignal::KernelDied => {
            warn!("[runtime-agent] Kernel died");
            if let Some(ref mut k) = kernel {
                k.shutdown().await.ok();
            }
            *kernel = None;
            let (interrupted, cleared) = state.kernel_died();
            if let Err(e) = ctx.state.with_doc(|sd| {
                if let Some(ref eid) = interrupted {
                    sd.set_execution_done(eid, false)?;
                }
                for entry in &cleared {
                    sd.set_execution_done(&entry.execution_id, false)?;
                }
                // Generic kernel-died path — no specific typed reason. Clear
                // any stale error_reason from a prior failure so the frontend
                // doesn't misreport this death as (say) a repeat
                // missing_ipykernel incident.
                sd.set_lifecycle_with_error(&RuntimeLifecycle::Error, None)?;
                sd.set_queue(None, &[])?;
                Ok(())
            }) {
                warn!("[runtime-state] {}", e);
            }
        }
    }

    Ok(())
}

/// Handle a best-effort work command (kernel-facing widget replay).
///
/// Work commands ride the bounded channel and can be shed under load. See
/// `execution-pipeline.md` Decision 4.
async fn handle_work_command(
    command: WorkCommand,
    kernel: &mut Option<JupyterKernel>,
) -> anyhow::Result<()> {
    match command {
        WorkCommand::SendCommUpdate {
            comm_id,
            state: comm_state,
            buffer_paths,
            buffers,
        } => {
            if let Some(ref mut k) = kernel {
                if let Err(e) = k
                    .send_comm_update(&comm_id, comm_state, buffer_paths, buffers)
                    .await
                {
                    warn!("[runtime-agent] Failed to send comm update: {}", e);
                }
            }
        }
    }

    Ok(())
}

async fn drain_lifecycle_commands(
    rx: &mut mpsc::UnboundedReceiver<LifecycleSignal>,
    ctx: &RuntimeAgentContext,
    kernel: &mut Option<JupyterKernel>,
    state: &mut KernelState,
) -> anyhow::Result<usize> {
    let mut drained = 0;
    // Channel type guarantees only lifecycle signals arrive here. The previous
    // runtime debug_assert!(command.is_lifecycle()) is now structural.
    while let Ok(signal) = rx.try_recv() {
        handle_lifecycle_signal(signal, ctx, kernel, state).await?;
        drained += 1;
    }
    Ok(drained)
}

fn mark_interrupted_executions_failed(
    state: &RuntimeStateHandle,
    interrupted: Option<&QueueEntry>,
    cleared: &[QueueEntry],
) {
    if let Err(e) = state.with_doc(|sd| {
        if let Some(entry) = interrupted {
            sd.set_execution_done(&entry.execution_id, false)?;
        }
        for entry in cleared {
            sd.set_execution_done(&entry.execution_id, false)?;
        }
        sd.mark_inflight_executions_failed()?;
        sd.set_queue(None, &[])?;
        sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
        Ok(())
    }) {
        warn!("[runtime-state] {}", e);
    }
}

/// Diff two comm state snapshots, returning `(comm_id, changed_properties)` pairs.
///
/// Only diffs existing comms (new comms originate from kernel `comm_open` and
/// don't need forwarding back). Returns a minimal delta per comm -- only
/// properties whose values actually changed.
fn diff_comm_state(
    before: &HashMap<String, CommDocEntry>,
    after: &HashMap<String, CommDocEntry>,
) -> Vec<(String, serde_json::Value)> {
    let mut updates = Vec::new();
    for (comm_id, after_entry) in after {
        if let Some(before_entry) = before.get(comm_id) {
            if let (Some(before_obj), Some(after_obj)) = (
                before_entry.state.as_object(),
                after_entry.state.as_object(),
            ) {
                let mut delta = serde_json::Map::new();
                for (key, after_val) in after_obj {
                    match before_obj.get(key) {
                        Some(before_val) if before_val == after_val => {}
                        _ => {
                            delta.insert(key.clone(), after_val.clone());
                        }
                    }
                }
                if !delta.is_empty() {
                    updates.push((comm_id.clone(), serde_json::Value::Object(delta)));
                }
            }
        }
    }
    updates
}

fn superseded_content_ref_hashes_by_comm(
    before: &HashMap<String, CommDocEntry>,
    after: &HashMap<String, CommDocEntry>,
    comm_updates: &[(String, serde_json::Value)],
) -> HashMap<String, Vec<String>> {
    // BlobStore is content-addressed across the document, so identical hashes
    // still referenced by another comm must stay live.
    let live_hashes_after = content_ref_hashes_in_comms(after);
    let mut superseded = HashMap::new();

    for (comm_id, _) in comm_updates {
        let Some(before_entry) = before.get(comm_id) else {
            continue;
        };
        let mut hashes = HashSet::new();
        for (_, hash) in collect_content_refs(&before_entry.state) {
            if !live_hashes_after.contains(&hash) {
                hashes.insert(hash);
            }
        }
        if !hashes.is_empty() {
            superseded.insert(comm_id.clone(), hashes.into_iter().collect());
        }
    }

    superseded
}

fn content_ref_hashes_in_comms(comms: &HashMap<String, CommDocEntry>) -> HashSet<String> {
    let mut hashes = HashSet::new();
    for entry in comms.values() {
        for (_, hash) in collect_content_refs(&entry.state) {
            hashes.insert(hash);
        }
    }
    hashes
}

async fn free_superseded_ephemeral_blobs(blob_store: &BlobStore, comm_id: &str, hashes: &[String]) {
    for hash in hashes {
        match blob_store.delete_if_ephemeral(hash).await {
            Ok(true) => {
                debug!(
                    "[runtime-agent] Freed superseded ephemeral blob {} for comm_id={}",
                    hash, comm_id
                );
            }
            Ok(false) => {}
            Err(e) => {
                warn!(
                    "[runtime-agent] Failed to free superseded ephemeral blob {} for comm_id={}: {}",
                    hash, comm_id, e
                );
            }
        }
    }
}

struct RehydratedCommUpdate {
    state: serde_json::Value,
    buffer_paths: Vec<Vec<String>>,
    buffers: Vec<Vec<u8>>,
    content_hashes: Vec<String>,
}

async fn prepare_comm_update(
    comm_id: &str,
    delta: &serde_json::Value,
    blob_store: &BlobStore,
    echo_suppressor: &mut EchoSuppressor,
) -> Option<RehydratedCommUpdate> {
    let content_refs = collect_content_refs(delta);
    if content_refs
        .iter()
        .any(|(_, hash)| echo_suppressor.is_recent_echo(comm_id, hash))
    {
        debug!(
            "[runtime-agent] Suppressing echoed binary comm update for comm_id={}",
            comm_id
        );
        return None;
    }

    let mut state = delta.clone();
    let mut buffer_paths = Vec::new();
    let mut buffers = Vec::new();
    let mut content_hashes = Vec::new();

    for (path, hash) in content_refs {
        set_json_path(&mut state, &path, serde_json::Value::Null);
        match blob_store.get(&hash).await {
            Ok(Some(bytes)) => {
                buffer_paths.push(path);
                buffers.push(bytes);
                content_hashes.push(hash);
            }
            Ok(None) => {
                warn!(
                    "[runtime-agent] Missing blob {} for widget comm update; skipping buffer",
                    hash
                );
            }
            Err(e) => {
                warn!(
                    "[runtime-agent] Failed to read blob {} for widget comm update: {}",
                    hash, e
                );
            }
        }
    }

    Some(RehydratedCommUpdate {
        state,
        buffer_paths,
        buffers,
        content_hashes,
    })
}

fn collect_content_refs(delta: &serde_json::Value) -> Vec<(Vec<String>, String)> {
    let mut refs = Vec::new();
    collect_content_refs_at(delta, &mut Vec::new(), &mut refs);
    refs
}

fn collect_content_refs_at(
    value: &serde_json::Value,
    path: &mut Vec<String>,
    refs: &mut Vec<(Vec<String>, String)>,
) {
    if let Some(hash) = strict_content_ref_hash(value) {
        refs.push((path.clone(), hash.to_string()));
        return;
    }

    match value {
        serde_json::Value::Object(obj) => {
            for (key, child) in obj {
                path.push(key.clone());
                collect_content_refs_at(child, path, refs);
                path.pop();
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                path.push(index.to_string());
                collect_content_refs_at(child, path, refs);
                path.pop();
            }
        }
        _ => {}
    }
}

fn strict_content_ref_hash(value: &serde_json::Value) -> Option<&str> {
    let obj = value.as_object()?;
    if obj.len() != 3 {
        return None;
    }
    let blob = obj.get("blob")?.as_str()?;
    let _size = obj.get("size")?.as_u64()?;
    let _media_type = obj.get("media_type")?.as_str()?;
    Some(blob)
}

fn set_json_path(root: &mut serde_json::Value, path: &[String], value: serde_json::Value) {
    if path.is_empty() {
        *root = value;
        return;
    }

    let mut current = root;
    for segment in &path[..path.len() - 1] {
        current = match current {
            serde_json::Value::Object(obj) => match obj.get_mut(segment) {
                Some(next) => next,
                None => return,
            },
            serde_json::Value::Array(items) => match segment
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get_mut(index))
            {
                Some(next) => next,
                None => return,
            },
            _ => return,
        };
    }

    let last = &path[path.len() - 1];
    match current {
        serde_json::Value::Object(obj) => {
            obj.insert(last.clone(), value);
        }
        serde_json::Value::Array(items) => {
            if let Some(slot) = last
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get_mut(index))
            {
                *slot = value;
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel_connection::{KernelConnection, KernelLaunchConfig, KernelSharedRefs};
    use crate::output_prep::queue_command_channels;
    use crate::protocol::CompletionItem;
    use anyhow::Result;
    use notebook_protocol::protocol::{BlobDurability, LaunchedEnvConfig};
    use std::path::PathBuf;

    /// Minimal mock kernel for testing queue/state logic without ZeroMQ.
    struct MockKernel;

    impl KernelConnection for MockKernel {
        async fn launch(
            _config: KernelLaunchConfig,
            _shared: KernelSharedRefs,
        ) -> Result<(Self, QueueCommandReceivers)> {
            unimplemented!()
        }
        async fn execute(&mut self, _: &str, _: Option<&str>, _: &str) -> Result<()> {
            Ok(())
        }
        async fn interrupt(&mut self) -> Result<()> {
            Ok(())
        }
        async fn shutdown(&mut self) -> Result<()> {
            Ok(())
        }
        async fn send_comm_message(
            &mut self,
            _: notebook_protocol::protocol::CommRequestMessage,
        ) -> Result<()> {
            Ok(())
        }
        async fn send_comm_update(
            &mut self,
            _: &str,
            _: serde_json::Value,
            _: Vec<Vec<String>>,
            _: Vec<Vec<u8>>,
        ) -> Result<()> {
            Ok(())
        }
        async fn complete(
            &mut self,
            _: &str,
            _: usize,
        ) -> Result<(Vec<CompletionItem>, usize, usize)> {
            Ok((vec![], 0, 0))
        }
        async fn get_history(
            &mut self,
            _: Option<&str>,
            _: i32,
            _: bool,
        ) -> Result<Vec<crate::protocol::HistoryEntry>> {
            Ok(vec![])
        }
        fn kernel_type(&self) -> &str {
            "python"
        }
        fn env_source(&self) -> &str {
            "test"
        }
        fn launched_config(&self) -> &LaunchedEnvConfig {
            Box::leak(Box::new(LaunchedEnvConfig::default()))
        }
        fn env_path(&self) -> Option<&PathBuf> {
            None
        }
        fn is_connected(&self) -> bool {
            true
        }
        fn update_launched_uv_deps(&mut self, _: Vec<String>) {}
    }

    fn comm_entry(state: serde_json::Value) -> CommDocEntry {
        CommDocEntry {
            target_name: "jupyter.widget".to_string(),
            model_module: "anywidget".to_string(),
            model_name: "AnyModel".to_string(),
            state,
            outputs: Vec::new(),
            seq: 0,
            capture_msg_id: String::new(),
        }
    }

    /// Build test fixtures: RuntimeAgentContext + KernelState wired to the same doc.
    fn test_fixtures() -> (RuntimeAgentContext, KernelState, RuntimeStateHandle) {
        let (state_changed_tx, _) = broadcast::channel(64);
        let handle = RuntimeStateHandle::new(RuntimeStateDoc::new(), state_changed_tx);
        let (broadcast_tx, _) = broadcast::channel(64);
        let (presence_tx, _) = broadcast::channel(16);
        let blob_store = Arc::new(BlobStore::new(std::env::temp_dir().join("test-blobs")));
        let presence = Arc::new(RwLock::new(PresenceState::new()));

        let ctx = RuntimeAgentContext {
            state: handle.clone(),
            blob_store,
            broadcast_tx: broadcast_tx.clone(),
            presence,
            presence_tx,
        };
        let state = KernelState::new(handle.clone());
        (ctx, state, handle)
    }

    #[tokio::test]
    async fn queued_execution_seen_before_kernel_launch_is_not_dropped() {
        let (_ctx, mut state, handle) = test_fixtures();
        let mut seen_execution_ids = HashSet::new();

        handle
            .with_doc(|sd| sd.create_execution_with_source("e-prelaunch", "print('ready')", 0))
            .unwrap();

        let queued = handle.read(|sd| sd.get_queued_executions()).unwrap();
        let queued_count = queue_synced_executions(
            queued,
            &mut seen_execution_ids,
            &mut state,
            None::<&mut MockKernel>,
        )
        .await;

        assert_eq!(queued_count, 0);
        assert!(seen_execution_ids.is_empty());
        let pending = handle
            .read(|sd| sd.get_execution("e-prelaunch").unwrap())
            .unwrap();
        assert_eq!(pending.status, "queued");

        state.set_idle();
        let mut mock = MockKernel;
        let queued = handle.read(|sd| sd.get_queued_executions()).unwrap();
        let queued_count =
            queue_synced_executions(queued, &mut seen_execution_ids, &mut state, Some(&mut mock))
                .await;

        assert_eq!(queued_count, 1);
        assert!(seen_execution_ids.contains("e-prelaunch"));
        assert_eq!(
            state.executing_cell().map(String::as_str),
            Some("e-prelaunch")
        );
        let running = handle
            .read(|sd| sd.get_execution("e-prelaunch").unwrap())
            .unwrap();
        assert_eq!(running.status, "running");
    }

    #[tokio::test]
    async fn kernel_died_marks_inflight_executions_as_failed_in_state_doc() {
        let (ctx, mut state, handle) = test_fixtures();
        let mut mock = MockKernel;
        state.set_idle();

        // Queue two cells: c1 starts executing, c2 stays queued
        state
            .queue_cell("e1".into(), None, "x=1".into(), &mut mock)
            .await
            .unwrap();
        state
            .queue_cell("e2".into(), None, "x=2".into(), &mut mock)
            .await
            .unwrap();

        // Verify initial state in doc
        {
            let e1 = handle.read(|sd| sd.get_execution("e1").unwrap()).unwrap();
            assert_eq!(e1.status, "running");
            let e2 = handle.read(|sd| sd.get_execution("e2").unwrap()).unwrap();
            assert_eq!(e2.status, "queued");
        }

        // Simulate kernel death
        handle_lifecycle_signal(
            LifecycleSignal::KernelDied,
            &ctx,
            &mut None::<JupyterKernel>,
            &mut state,
        )
        .await
        .unwrap();

        // Both executions should now be marked as error in RuntimeStateDoc
        let e1 = handle.read(|sd| sd.get_execution("e1").unwrap()).unwrap();
        assert_eq!(e1.status, "error");
        assert_eq!(e1.success, Some(false));

        let e2 = handle.read(|sd| sd.get_execution("e2").unwrap()).unwrap();
        assert_eq!(e2.status, "error");
        assert_eq!(e2.success, Some(false));

        // Queue should be cleared
        let queue = handle.read(|sd| sd.read_state()).unwrap();
        assert!(queue.queue.executing.is_none());
        assert!(queue.queue.queued.is_empty());

        // Kernel lifecycle should be Error
        assert_eq!(queue.kernel.lifecycle, RuntimeLifecycle::Error);
    }

    #[tokio::test]
    async fn kernel_died_with_no_inflight_executions_clears_state() {
        let (ctx, mut state, handle) = test_fixtures();
        state.set_idle();

        // No cells queued — just fire KernelDied
        handle_lifecycle_signal(
            LifecycleSignal::KernelDied,
            &ctx,
            &mut None::<JupyterKernel>,
            &mut state,
        )
        .await
        .unwrap();

        let rs = handle.read(|sd| sd.read_state()).unwrap();
        assert_eq!(rs.kernel.lifecycle, RuntimeLifecycle::Error);
        assert!(rs.queue.executing.is_none());
        assert!(rs.queue.queued.is_empty());
    }

    #[tokio::test]
    async fn lifecycle_drain_runs_before_queued_work() {
        let (ctx, mut state, handle) = test_fixtures();
        state.set_idle();
        let (lifecycle_tx, work_tx, mut receivers) = queue_command_channels(1);

        work_tx
            .try_send(WorkCommand::SendCommUpdate {
                comm_id: "comm-a".to_string(),
                state: serde_json::json!({ "outputs": [] }),
                buffer_paths: vec![],
                buffers: vec![],
            })
            .expect("work queue should accept one item");
        lifecycle_tx
            .send(LifecycleSignal::KernelDied)
            .expect("lifecycle channel should be open");

        let drained = drain_lifecycle_commands(
            &mut receivers.lifecycle_rx,
            &ctx,
            &mut None::<JupyterKernel>,
            &mut state,
        )
        .await
        .expect("lifecycle drain should succeed");

        assert_eq!(drained, 1);
        let rs = handle.read(|sd| sd.read_state()).unwrap();
        assert_eq!(rs.kernel.lifecycle, RuntimeLifecycle::Error);
        assert!(receivers.work_rx.try_recv().is_ok());
    }

    /// Simulate the interrupt+execute race: a concurrent execute_cell creates
    /// an execution entry in RuntimeStateDoc that the runtime agent's local
    /// queue doesn't know about yet. The interrupt handler must mark ALL
    /// in-flight entries as failed, not just the ones in the local queue.
    #[tokio::test]
    async fn interrupt_marks_crdt_synced_executions_not_in_local_queue() {
        let (_ctx, mut state, handle) = test_fixtures();
        let mut mock = MockKernel;
        state.set_idle();

        // Cell A is executing via the normal queue path
        state
            .queue_cell("eA".into(), None, "while True: pass".into(), &mut mock)
            .await
            .unwrap();
        assert!(state.executing_cell().is_some());

        // Simulate a concurrent execute_cell: the coordinator wrote an
        // execution entry directly to RuntimeStateDoc, but CRDT sync hasn't
        // delivered it to the runtime agent's local queue yet.
        handle
            .with_doc(|sd| sd.create_execution_with_source("eB", "1 + 1", 1))
            .unwrap();

        // Verify eB is "queued" in the doc but NOT in the local queue
        let eb = handle.read(|sd| sd.get_execution("eB").unwrap()).unwrap();
        assert_eq!(eb.status, "queued");
        assert!(state.queued_entries().is_empty()); // Only cA is executing, no queue

        // Simulate interrupt: clear local executing/queue state and mark every
        // in-flight CRDT execution failed.
        let (interrupted, cleared) = state.interrupt();
        assert_eq!(
            interrupted.as_ref().map(|e| e.execution_id.as_str()),
            Some("eA")
        );
        assert!(cleared.is_empty());
        mark_interrupted_executions_failed(&handle, interrupted.as_ref(), &cleared);

        // eA (executing) should be marked failed by mark_inflight
        let ea = handle.read(|sd| sd.get_execution("eA").unwrap()).unwrap();
        assert_eq!(ea.status, "error");
        assert_eq!(ea.success, Some(false));

        // eB (CRDT-only, not in local queue) should ALSO be marked failed
        let eb = handle.read(|sd| sd.get_execution("eB").unwrap()).unwrap();
        assert_eq!(eb.status, "error");
        assert_eq!(eb.success, Some(false));

        let rs = handle.read(|sd| sd.read_state()).unwrap();
        assert!(rs.queue.executing.is_none());
        assert!(rs.queue.queued.is_empty());
        assert_eq!(
            rs.kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );
    }

    /// After interrupt, CellError from the interrupted cell should be a
    /// no-op for queue clearing (queue is already empty).
    #[tokio::test]
    async fn cell_error_after_interrupt_is_noop_for_queue() {
        let (ctx, mut state, handle) = test_fixtures();
        let mut mock = MockKernel;
        state.set_idle();

        // Queue cell A (executing) and cell B (queued)
        state
            .queue_cell("eA".into(), None, "while True: pass".into(), &mut mock)
            .await
            .unwrap();
        state
            .queue_cell("eB".into(), None, "1 + 1".into(), &mut mock)
            .await
            .unwrap();

        // Simulate interrupt: clear executing and queued work.
        let (interrupted, cleared) = state.interrupt();
        assert_eq!(
            interrupted.as_ref().map(|e| e.execution_id.as_str()),
            Some("eA")
        );
        assert_eq!(cleared.len(), 1); // cB
        assert_eq!(cleared[0].execution_id, "eB");
        mark_interrupted_executions_failed(&handle, interrupted.as_ref(), &cleared);

        // Now simulate CellError from the interrupted cell A
        handle_lifecycle_signal(
            LifecycleSignal::CellError {
                execution_id: "eA".to_string(),
            },
            &ctx,
            &mut None::<JupyterKernel>,
            &mut state,
        )
        .await
        .unwrap();

        // Both should be error
        let ea = handle.read(|sd| sd.get_execution("eA").unwrap()).unwrap();
        assert_eq!(ea.status, "error");
        let eb = handle.read(|sd| sd.get_execution("eB").unwrap()).unwrap();
        assert_eq!(eb.status, "error");

        // A stale CellError from eA must not poison the next execution.
        let mut mock = MockKernel;
        state
            .queue_cell("eC".into(), None, "1 + 1".into(), &mut mock)
            .await
            .unwrap();
        assert!(state.executing_cell().is_none());
        assert_eq!(state.queued_entries().len(), 1);
        state.kernel_idle(Some("eA"), &mut mock).await.unwrap();
        state.execution_done("eC", &mut mock).await.unwrap();
        let ec = handle.read(|sd| sd.get_execution("eC").unwrap()).unwrap();
        assert_eq!(ec.status, "done");
        assert_eq!(ec.success, Some(true));
    }

    #[tokio::test]
    async fn prepare_comm_update_rehydrates_content_refs_to_buffers() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put(&[1, 2, 3, 4], "application/octet-stream")
            .await
            .unwrap();
        let delta = serde_json::json!({
            "selection": {
                "view": {
                    "blob": hash,
                    "size": 4,
                    "media_type": "application/octet-stream"
                },
                "dtype": "uint32",
                "shape": [1]
            }
        });
        let mut suppressor = EchoSuppressor::default();

        let update = prepare_comm_update("comm-a", &delta, &blob_store, &mut suppressor)
            .await
            .expect("update should not be suppressed");

        assert_eq!(
            update.state,
            serde_json::json!({
                "selection": {
                    "view": null,
                    "dtype": "uint32",
                    "shape": [1]
                }
            })
        );
        assert_eq!(
            update.buffer_paths,
            vec![vec!["selection".to_string(), "view".to_string()]]
        );
        assert_eq!(update.buffers, vec![vec![1, 2, 3, 4]]);
        assert_eq!(update.content_hashes, vec![hash]);
    }

    #[tokio::test]
    async fn prepare_comm_update_ignores_non_strict_content_ref_shape() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put(&[1], "application/octet-stream")
            .await
            .unwrap();
        let delta = serde_json::json!({
            "value": {
                "blob": hash,
                "size": 1,
                "media_type": "application/octet-stream",
                "extra": true
            }
        });
        let mut suppressor = EchoSuppressor::default();

        let update = prepare_comm_update("comm-a", &delta, &blob_store, &mut suppressor)
            .await
            .expect("update should not be suppressed");

        assert_eq!(update.state, delta);
        assert!(update.buffer_paths.is_empty());
        assert!(update.buffers.is_empty());
        assert!(update.content_hashes.is_empty());
    }

    #[tokio::test]
    async fn prepare_comm_update_drops_recent_echoes() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put(&[1], "application/octet-stream")
            .await
            .unwrap();
        let delta = serde_json::json!({
            "selection": {
                "blob": hash,
                "size": 1,
                "media_type": "application/octet-stream"
            }
        });
        let mut suppressor = EchoSuppressor::default();
        suppressor.record_outgoing("comm-a", &hash);

        let update = prepare_comm_update("comm-a", &delta, &blob_store, &mut suppressor).await;

        assert!(update.is_none());
    }

    #[tokio::test]
    async fn prepare_comm_update_or_supersession_frees_replaced_ephemeral_blob() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put_with_durability(
                b"old",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .unwrap();
        let before_state = serde_json::json!({
            "selection": {
                "view": { "blob": hash, "size": 3, "media_type": "application/octet-stream" }
            }
        });
        let after_state = serde_json::json!({ "selection": null });
        let before = HashMap::from([("comm-a".to_string(), comm_entry(before_state))]);
        let after = HashMap::from([("comm-a".to_string(), comm_entry(after_state))]);
        let updates = vec![(
            "comm-a".to_string(),
            serde_json::json!({ "selection": null }),
        )];

        let superseded = superseded_content_ref_hashes_by_comm(&before, &after, &updates);
        free_superseded_ephemeral_blobs(&blob_store, "comm-a", superseded.get("comm-a").unwrap())
            .await;

        assert!(blob_store.get(&hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn supersession_keeps_durable_blob() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put_with_durability(b"old", "application/octet-stream", BlobDurability::Durable)
            .await
            .unwrap();
        let before_state = serde_json::json!({
            "selection": {
                "view": { "blob": hash, "size": 3, "media_type": "application/octet-stream" }
            }
        });
        let after_state = serde_json::json!({ "selection": null });
        let before = HashMap::from([("comm-a".to_string(), comm_entry(before_state))]);
        let after = HashMap::from([("comm-a".to_string(), comm_entry(after_state))]);
        let updates = vec![(
            "comm-a".to_string(),
            serde_json::json!({ "selection": null }),
        )];

        let superseded = superseded_content_ref_hashes_by_comm(&before, &after, &updates);
        free_superseded_ephemeral_blobs(&blob_store, "comm-a", superseded.get("comm-a").unwrap())
            .await;

        assert_eq!(
            blob_store.get(&hash).await.unwrap().as_deref(),
            Some(&b"old"[..])
        );
    }

    #[tokio::test]
    async fn supersession_handles_within_comm_path_move() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put_with_durability(
                b"old",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .unwrap();
        let content_ref = serde_json::json!({ "blob": hash, "size": 3, "media_type": "application/octet-stream" });
        let before_state = serde_json::json!({ "a": { "view": content_ref.clone() } });
        let after_state = serde_json::json!({ "b": { "view": content_ref } });
        let before = HashMap::from([("comm-a".to_string(), comm_entry(before_state))]);
        let after = HashMap::from([("comm-a".to_string(), comm_entry(after_state))]);
        let updates = vec![(
            "comm-a".to_string(),
            serde_json::json!({ "a": null, "b": {} }),
        )];

        let superseded = superseded_content_ref_hashes_by_comm(&before, &after, &updates);

        assert!(superseded.get("comm-a").is_none_or(Vec::is_empty));
        assert_eq!(
            blob_store.get(&hash).await.unwrap().as_deref(),
            Some(&b"old"[..])
        );
    }

    #[tokio::test]
    async fn supersession_keeps_hash_referenced_by_another_comm() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put_with_durability(
                b"old",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .unwrap();
        let content_ref = serde_json::json!({ "blob": hash, "size": 3, "media_type": "application/octet-stream" });
        let before = HashMap::from([
            (
                "comm-a".to_string(),
                comm_entry(serde_json::json!({ "selection": { "view": content_ref.clone() } })),
            ),
            (
                "comm-b".to_string(),
                comm_entry(serde_json::json!({ "selection": { "view": content_ref.clone() } })),
            ),
        ]);
        let after = HashMap::from([
            (
                "comm-a".to_string(),
                comm_entry(serde_json::json!({ "selection": null })),
            ),
            (
                "comm-b".to_string(),
                comm_entry(serde_json::json!({ "selection": { "view": content_ref } })),
            ),
        ]);
        let updates = vec![(
            "comm-a".to_string(),
            serde_json::json!({ "selection": null }),
        )];

        let superseded = superseded_content_ref_hashes_by_comm(&before, &after, &updates);

        assert!(superseded.get("comm-a").is_none_or(Vec::is_empty));
        assert_eq!(
            blob_store.get(&hash).await.unwrap().as_deref(),
            Some(&b"old"[..])
        );
    }

    #[tokio::test]
    async fn supersession_skipped_on_kernel_send_failure() {
        let temp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(temp.path().join("blobs"));
        let hash = blob_store
            .put_with_durability(
                b"old",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .unwrap();
        let before_state = serde_json::json!({
            "selection": {
                "view": { "blob": hash, "size": 3, "media_type": "application/octet-stream" }
            }
        });
        let after_state = serde_json::json!({ "selection": null });
        let before = HashMap::from([("comm-a".to_string(), comm_entry(before_state))]);
        let after = HashMap::from([("comm-a".to_string(), comm_entry(after_state))]);
        let updates = vec![(
            "comm-a".to_string(),
            serde_json::json!({ "selection": null }),
        )];

        let superseded = superseded_content_ref_hashes_by_comm(&before, &after, &updates);
        assert_eq!(superseded.get("comm-a"), Some(&vec![hash.clone()]));
        // Production only calls free_superseded_ephemeral_blobs after a
        // successful send_comm_update or an echo-suppressed update. A failed
        // kernel send keeps the blob available for a possible retry.

        assert_eq!(
            blob_store.get(&hash).await.unwrap().as_deref(),
            Some(&b"old"[..])
        );
    }
}
