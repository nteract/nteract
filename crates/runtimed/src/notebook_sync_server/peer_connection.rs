use super::peer_eviction::handle_peer_disconnect;
use super::peer_loop::run_sync_loop_v2;
use super::peer_presence::cleanup_presence_on_disconnect;
use super::*;
use anyhow::Context;
use runtime_doc::RuntimeLifecycle;

/// Identity and environment facts that are immutable for the lifetime of one
/// peer connection. The handshake handler that resolved the room constructs
/// this once, and the whole sync-loop call chain reads it as a single value.
/// Per-call state (readers, writers, Automerge `peer_state`) stays in plain
/// parameters.
pub(crate) struct PeerConnectionContext {
    pub(crate) room: Arc<NotebookRoom>,
    pub(crate) rooms: NotebookRooms,
    pub(crate) notebook_id: String,
    pub(crate) daemon: std::sync::Arc<crate::daemon::Daemon>,
    /// Unique id for this peer connection, minted at handshake time so
    /// presence registration and disconnect cleanup name the same peer.
    pub(crate) peer_id: String,
    pub(crate) connection_identity: RoomConnectionIdentity,
    /// Protocol version from the client preamble. v4 is required at
    /// connection setup, so SessionControl frames are always supported.
    pub(crate) client_protocol_version: u8,
    /// Runtime used for kernel auto-launch. Usually the user's default;
    /// CreateNotebook overrides it with the explicitly requested runtime.
    pub(crate) default_runtime: crate::runtime::Runtime,
    pub(crate) default_python_env: crate::settings_doc::PythonEnvType,
    /// Project context for untitled-notebook detection; also published as the
    /// local workstation attachment for non-hosted rooms.
    pub(crate) working_dir: Option<PathBuf>,
    /// File to stream into a fresh room before steady-state sync.
    pub(crate) needs_load: Option<PathBuf>,
}

impl PeerConnectionContext {
    /// Execution-store directory for this connection. Derived from the
    /// daemon the context already carries so the two cannot disagree.
    pub(crate) fn execution_store_dir(&self) -> &Path {
        &self.daemon.config.execution_store_dir
    }
}

/// Handle a single notebook sync client connection.
///
/// The caller has already consumed the handshake frame and resolved the room.
/// This function owns connection setup, initial metadata/trust seeding,
/// capability negotiation, optional autolaunch, and disconnect cleanup. The
/// steady-state typed-frame select loop lives in `peer_loop`.
///
/// When the connection closes (client disconnect or error), the peer count
/// is decremented. If it reaches zero, the room is evicted and any pending
/// doc bytes are flushed via debounced persistence.
///
/// If `skip_capabilities` is true, the ProtocolCapabilities frame is not sent.
/// This is used for OpenNotebook/CreateNotebook handshakes where the protocol
/// is already communicated in the NotebookConnectionInfo response.
/// If `typed_capabilities` is true, the capabilities bootstrap is carried in a
/// typed SessionControl frame instead of a standalone untyped JSON frame.
pub(crate) async fn handle_notebook_sync_connection<R, W>(
    reader: R,
    mut writer: W,
    ctx: PeerConnectionContext,
    initial_metadata: Option<String>,
    skip_capabilities: bool,
    typed_capabilities: bool,
    // True if this is a newly-created notebook at a non-existent path.
    // Used to enable auto-launch for notebooks created via `runt notebook newfile.ipynb`.
    created_new_at_path: bool,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let room = &ctx.room;
    let notebook_id = ctx.notebook_id.as_str();
    // Claim the room for this peer before any other await. Bumping the
    // generation here protects against two ghost-room reaper races:
    //   1. The reaper has already snapshotted candidates and is between
    //      snapshot and remove pass — the remove pass re-checks
    //      generation under the rooms lock and bails because we moved
    //      it.
    //   2. A reaper sweep arrives during the awaited setup below — the
    //      remove pass observes the bumped generation and bails before
    //      removing the room out from under this connection.
    // Clearing the teardown timestamp here keeps a brand-new reaper
    // cycle from snapshotting this room as a candidate while we are
    // still attaching.
    room.connections.bump_connection_generation();
    room.connections.clear_kernel_torn_down();

    // Set working_dir on the room if provided (for untitled notebook project detection)
    if let Some(wd) = &ctx.working_dir {
        let update_workstation_directory = room.file_binding.path().await.is_none();
        {
            let mut room_wd = room.identity.working_dir.write().await;
            *room_wd = Some(wd.clone());
        }

        if update_workstation_directory && !room.is_hosted() {
            // Hosted rooms must not write local workstation state into the
            // cloud-authoritative RuntimeStateDoc.
            super::workstation_attachment::publish_local_workstation_attachment_for_working_dir(
                &room.state,
                Some(wd.as_path()),
            );
        }
    }

    // Seed initial metadata into the Automerge doc if provided and doc has no metadata yet.
    // This ensures the kernelspec is available before auto-launch decides which kernel to use.
    let mut metadata_seeded = false;
    if let Some(ref metadata_json) = initial_metadata {
        match serde_json::from_str::<NotebookMetadataSnapshot>(metadata_json) {
            Ok(snapshot) => {
                let mut doc = room.doc.write().await;
                if doc.get_metadata_snapshot().is_none() {
                    let rollback_actor = doc.get_actor_id();
                    let rollback_snapshot = doc.save();
                    let baseline_heads = doc.get_heads();
                    match doc.set_metadata_snapshot(&snapshot) {
                        Ok(()) => {
                            super::durability::commit_daemon_notebook_mutation(
                                room,
                                &mut doc,
                                &baseline_heads,
                                &rollback_snapshot,
                                &rollback_actor,
                                "handshake initial metadata",
                            )
                            .map_err(anyhow::Error::msg)?;
                            metadata_seeded = true;
                            info!(
                                "[notebook-sync] Seeded initial metadata from handshake for {}",
                                notebook_id
                            );
                        }
                        Err(e) => {
                            warn!("[notebook-sync] Failed to seed initial metadata: {}", e);
                        }
                    }
                }
            }
            Err(e) => {
                warn!(
                    "[notebook-sync] Failed to parse initial metadata JSON for {}: {}",
                    notebook_id, e
                );
            }
        }
    }
    if metadata_seeded {
        // Notify only after the journal commit succeeded and the document
        // guard was released, so existing peers cannot observe an
        // uncommitted handshake mutation.
        let _ = room.broadcasts.changed_tx.send(());
    }

    // Write trust state to RuntimeStateDoc so frontend can read it reactively.
    // Start with room.trust_state (from disk at room creation), then re-verify
    // from the doc in case initial_metadata was just seeded with a trust signature.
    //
    // Scope the trust_state read guard so it drops before acquiring state_doc
    // write lock (deadlock prevention: no lock held across `.await`).
    {
        let trust_state = room.trust_state.read().await;
        write_trust_to_runtime_state(room, &trust_state);
    }
    // Re-verify trust from doc metadata — picks up trust signatures that were
    // written to the Automerge doc (e.g., from a previous approval or from
    // initial_metadata seeded above).
    check_and_update_trust_state(room).await;

    room.connections
        .active_peers
        .fetch_add(1, Ordering::Relaxed);
    room.connections.had_peers.store(true, Ordering::Relaxed);
    // Resuming a room that the ghost-room reaper might otherwise sweep:
    // clear the inactive-since timestamp so the reaper can't pick this
    // room off between now and the next kernel teardown.
    room.connections.clear_kernel_torn_down();
    // Bump the connection generation so any in-flight kernel-teardown
    // task that snapshotted the previous value aborts before destroying
    // a kernel this peer might still want, and so the ghost reaper
    // notices the touch even if `active_peers` ping-pongs back to zero
    // before the reaper's remove pass.
    room.connections.bump_connection_generation();
    let peers = room.connections.active_peers.load(Ordering::Relaxed);
    info!(
        "[notebook-sync] Client connected to room {} ({} peer{})",
        notebook_id,
        peers,
        if peers == 1 { "" } else { "s" }
    );

    // Auto-launch kernel if this is the first peer and notebook is trusted
    if peers == 1 {
        // Check if notebook_id is a UUID (new unsaved notebook) vs a file path
        let path_snapshot = room.file_binding.path().await;
        let is_new_notebook = path_snapshot.as_ref().is_none_or(|p| !p.exists())
            && uuid::Uuid::parse_str(notebook_id).is_ok();

        // Scope the trust_state read guard so it drops before
        // `has_kernel()` which acquires another lock (deadlock prevention).
        let trust_status = {
            let trust_state = room.trust_state.read().await;
            trust_state.status.clone()
        };
        let has_kernel = room.has_kernel().await;
        // If a kernel-teardown task is in its destructive section,
        // `has_kernel()` may currently return `true` but the runtime
        // agent is about to be killed. Treat that as "no kernel" for
        // the auto-launch decision: a fresh launch is what the peer
        // needs once teardown completes. `auto_launch_kernel` itself
        // re-checks the handle slot once teardown clears it, so this
        // doesn't fight with teardown — it just stops the peer from
        // sitting with a doomed kernel forever.
        let kernel_being_torn_down = room
            .connections
            .kernel_teardown_destructive
            .load(Ordering::Acquire);
        let effective_has_kernel = has_kernel && !kernel_being_torn_down;
        // The hosted flag outlives bridge teardown, so a formerly-bridged room
        // can never auto-launch a local kernel.
        let is_hosted = room.is_hosted();
        let should_auto_launch = !is_hosted
            && !effective_has_kernel
            && matches!(
                trust_status,
                runt_trust::TrustStatus::Trusted | runt_trust::TrustStatus::NoDependencies
            )
            // For existing files: trust must be verified (Trusted or NoDependencies)
            // For new notebooks (UUID, no file): NoDependencies is safe to auto-launch
            // For newly-created notebooks at a path: also safe to auto-launch
            && (path_snapshot.as_ref().is_some_and(|p| p.exists())
                || is_new_notebook
                || created_new_at_path);

        if should_auto_launch {
            // Single-flight admission: at most one auto-launch attempt per
            // room. A connect that loses admission observes the in-flight
            // attempt (or the previous failure) through RuntimeStateDoc, so
            // a client reconnect loop cannot spawn agents at connect
            // frequency. The gate check happens before the Resolving write
            // so a skipped connect cannot mask a failed attempt's Error
            // lifecycle.
            match room.try_begin_auto_launch() {
                super::room::AutoLaunchAdmission::Admitted(attempt) => {
                    info!(
                        "[notebook-sync] Auto-launching kernel for notebook {} (trust: {:?}, new: {})",
                        notebook_id, trust_status, is_new_notebook
                    );
                    // Write Resolving immediately so clients never see stale NotStarted
                    if let Err(e) = room
                        .state
                        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Resolving))
                    {
                        warn!("[runtime-state] {}", e);
                    }
                    // Spawn auto-launch in background so we don't block sync
                    let room_clone = room.clone();
                    let panic_room = room.clone();
                    let notebook_id_clone = notebook_id.to_string();
                    let daemon_clone = ctx.daemon.clone();
                    let default_runtime = ctx.default_runtime.clone();
                    let default_python_env = ctx.default_python_env.clone();
                    spawn_supervised(
                        "auto-launch-kernel",
                        async move {
                            auto_launch_kernel(
                                &room_clone,
                                &notebook_id_clone,
                                default_runtime,
                                default_python_env,
                                daemon_clone,
                                attempt,
                            )
                            .await;
                        },
                        move |_| {
                            let r = panic_room;
                            // with_doc is sync (std::sync::Mutex), so no need for tokio::spawn
                            // to acquire the lock. But spawn_supervised's panic handler runs
                            // outside async context, so we still need spawn for the closure.
                            tokio::spawn(async move {
                                // Auto-launch panic, no specific typed reason. Clear
                                // any stale error_reason so the frontend prompt isn't
                                // stuck on an earlier missing_ipykernel, etc.
                                if let Err(e) = r.state.with_doc(|sd| {
                                    sd.set_lifecycle_with_error(&RuntimeLifecycle::Error, None)
                                }) {
                                    tracing::warn!("[runtime-state] {}", e);
                                }
                            });
                        },
                    );
                }
                super::room::AutoLaunchAdmission::InFlight => {
                    debug!(
                        "[notebook-sync] Auto-launch skipped for {}: attempt already in flight",
                        notebook_id
                    );
                }
                super::room::AutoLaunchAdmission::CoolingDown { remaining } => {
                    debug!(
                        "[notebook-sync] Auto-launch skipped for {}: cooling down after failed attempt ({}ms remaining)",
                        notebook_id,
                        remaining.as_millis()
                    );
                }
            }
        } else if !has_kernel && matches!(trust_status, runt_trust::TrustStatus::Untrusted) {
            // Kernel blocked on trust approval — write this to RuntimeStateDoc
            // so the frontend shows "Awaiting Trust Approval" instead of "Initializing"
            info!(
                "[notebook-sync] Kernel blocked on trust approval for {} (trust: {:?})",
                notebook_id, trust_status
            );
            if let Err(e) = room
                .state
                .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::AwaitingTrust))
            {
                warn!("[runtime-state] {}", e);
            }
        } else {
            info!(
                "[notebook-sync] Auto-launch skipped for {} (trust: {:?}, has_kernel: {}, path_exists: {}, is_new: {}, created_at_path: {})",
                notebook_id, trust_status, has_kernel,
                path_snapshot.as_ref().is_some_and(|p| p.exists()), is_new_notebook, created_new_at_path
            );
        }
    }

    // Send capabilities response unless already sent via NotebookConnectionInfo.
    if !skip_capabilities {
        let comments_doc_id = room
            .comments
            .read(|doc| doc.comments_doc_id())
            .context("read comments doc id for notebook sync capabilities")?;
        let comments_notebook_ref = room
            .comments
            .read(|doc| doc.notebook_ref())
            .context("read comments notebook ref for notebook sync capabilities")?
            .map(serde_json::to_value)
            .transpose()
            .context("serialize comments notebook ref for notebook sync capabilities")?;
        let caps = connection::ProtocolCapabilities::v4(Some(crate::daemon_version().to_string()))
            .with_identity(
                ctx.connection_identity.actor_label().as_str(),
                ctx.connection_identity.scope().as_str(),
            )
            .with_comments_doc_identity(comments_doc_id, comments_notebook_ref);
        if typed_capabilities {
            connection::send_typed_bootstrap_frame(
                &mut writer,
                &connection::ConnectionBootstrap::protocol_capabilities(caps),
            )
            .await?;
        } else {
            connection::send_json_frame(&mut writer, &caps).await?;
        }
    }

    let result = run_sync_loop_v2(reader, writer, &ctx).await;

    // Always clean up presence on disconnect, whether the sync loop
    // exited cleanly (Ok) or with an error (Err). The peer_id is a
    // connection-lifetime fact on the context, so it is always
    // available here. remove_peer is a no-op for unknown peers
    // (e.g. error before any presence was registered).
    cleanup_presence_on_disconnect(room, &ctx.peer_id).await;

    handle_peer_disconnect(
        room,
        ctx.rooms.clone(),
        notebook_id,
        &ctx.peer_id,
        &ctx.daemon,
    )
    .await;

    result
}
