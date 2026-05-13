use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::sync::oneshot;
use tracing::{debug, info, warn};

use crate::async_outcome::{recv_oneshot_with_timeout, TimedOneShot};
use crate::task_supervisor::spawn_best_effort;

use super::{
    flush_launched_deps_to_metadata, rename_env_dir_to_unified_hash, save_notebook_to_disk,
    send_runtime_agent_request, should_preserve_env_on_eviction, CapturedEnvRuntime, NotebookRoom,
    NotebookRooms,
};

/// Handle a peer disconnecting from a room.
///
/// When the last peer leaves we tear down the kernel and clean up the
/// environment, but the room stays resident in `notebook_rooms` and in
/// `path_index` so a reconnecting peer finds the same doc, outputs, and
/// file binding intact. The ghost-room reaper in `daemon.rs` removes the
/// room from the maps only after a long no-peer, no-kernel idle window.
///
/// Concretely, "kernel teardown" runs:
///   - synchronous flush of the persist debouncer,
///   - `ShutdownKernel` RPC to the runtime agent (with timeout),
///   - clear `runtime_agent_handle` and `runtime_agent_request_tx`,
///   - flush hot-installed dependencies into notebook metadata,
///   - one final autosave of the `.ipynb`,
///   - rename the env directory to the post-flush unified hash,
///   - delete the env directory unless the room holds a preserved env.
///
/// The autosave debouncer and the `.ipynb` / project-file watchers are
/// left alive: `get_or_create_room_result` reuses the existing room on
/// reconnect without rebinding them, so tearing them down here would
/// silently drop autosave coverage for the resumed session. The reaper
/// shuts them down when it actually removes the room.
pub(super) async fn handle_peer_disconnect(
    room: &Arc<NotebookRoom>,
    rooms: NotebookRooms,
    notebook_id: &str,
    peer_id: &str,
    daemon: &Arc<crate::daemon::Daemon>,
) {
    // Peer disconnected — decrement and possibly tear down the kernel.
    let remaining = room
        .connections
        .active_peers
        .fetch_sub(1, Ordering::Relaxed)
        - 1;
    if remaining == 0 {
        // Schedule delayed teardown check. This handles:
        // 1. Grace period during auto-launch (client may reconnect)
        // 2. Kernel running with no peers (idle timeout)
        // Without this, kernels would leak indefinitely.
        let teardown_delay = daemon.room_eviction_delay().await;
        let rooms_for_teardown = rooms.clone();
        let room_for_teardown = room.clone();
        let notebook_id_for_teardown = notebook_id.to_string();
        // Snapshot the connection generation at scheduling time. Any
        // peer that reconnects between now and the destructive shutdown
        // RPC bumps this counter; the teardown task re-checks it under
        // the rooms lock just before killing the kernel and aborts if a
        // reconnect happened. Without this guard, the kernel-shutdown
        // RPC can race a fast reconnect and tear down the kernel for a
        // peer that has already joined and seen `has_kernel=true`
        // (skipping auto-launch).
        let teardown_generation = room.connections.connection_generation();

        info!(
            "[notebook-sync] All peers disconnected from room {} (uuid={}, peer_id={}), scheduling kernel teardown in {:?}",
            notebook_id, room.id, peer_id, teardown_delay
        );

        spawn_best_effort("room-kernel-teardown", async move {
            // Outer loop wraps the teardown attempt so a flush timeout can
            // back off and retry rather than leak the kernel indefinitely.
            // Exits either by cancelling (peers reconnected) or by
            // completing teardown.
            let mut delay = teardown_delay;
            let mut flush_retries: u32 = 0;
            loop {
                tokio::time::sleep(delay).await;

                // Check if peers reconnected during the delay
                if room_for_teardown
                    .connections
                    .active_peers
                    .load(Ordering::Relaxed)
                    > 0
                {
                    info!(
                        "[notebook-sync] Kernel teardown cancelled for {} (peers reconnected)",
                        notebook_id_for_teardown
                    );
                    return;
                }

                // Force a synchronous flush of the persist debouncer BEFORE
                // we touch the kernel. The room stays resident across kernel
                // teardown, so the historical "fast reconnect lands in a
                // post-removal window" race no longer applies — but the
                // flush is still load-bearing because hot-installed deps
                // and any unflushed edits should be on disk before kernel
                // RPC starts unwinding things.
                //
                // On timeout or write failure we back off and retry. The
                // room stays resident, so retrying is cheap and a reconnect
                // still finds the live in-memory doc.
                const FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
                const FLUSH_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(30);
                let mut flush_ok = true;
                let mut flush_failure_kind: Option<&'static str> = None;
                if let Some(ref d) = room_for_teardown.persistence.debouncer {
                    let (ack_tx, ack_rx) = oneshot::channel::<bool>();
                    if d.flush_request_tx.send(ack_tx).is_ok() {
                        match recv_oneshot_with_timeout(ack_rx, FLUSH_TIMEOUT).await {
                            TimedOneShot::Received(true) => {}
                            TimedOneShot::Received(false) => {
                                flush_ok = false;
                                flush_failure_kind = Some("write error");
                            }
                            TimedOneShot::SenderDropped => {
                                // Debouncer dropped the ack sender without
                                // replying — task already exited (e.g. a
                                // previous teardown flushed and closed). Any
                                // pending bytes went through the shutdown path.
                                debug!(
                                    "[notebook-sync] Kernel-teardown flush ack dropped for {} (debouncer exited)",
                                    notebook_id_for_teardown
                                );
                            }
                            TimedOneShot::TimedOut => {
                                flush_ok = false;
                                flush_failure_kind = Some("timeout");
                            }
                        }
                    }
                }
                if !flush_ok {
                    flush_retries += 1;
                    warn!(
                        "[notebook-sync] Kernel-teardown flush failed for {} ({}; attempt {}); retrying in {:?}",
                        notebook_id_for_teardown,
                        flush_failure_kind.unwrap_or("unknown"),
                        flush_retries,
                        FLUSH_RETRY_DELAY
                    );
                    delay = FLUSH_RETRY_DELAY;
                    continue;
                }
                if flush_retries > 0 {
                    info!(
                        "[notebook-sync] Kernel-teardown flush succeeded for {} after {} retr{}",
                        notebook_id_for_teardown,
                        flush_retries,
                        if flush_retries == 1 { "y" } else { "ies" }
                    );
                }
                break;
            }

            // Re-check the peer count AND the connection generation under
            // the rooms lock. A peer that reconnected since we scheduled
            // this teardown bumps the generation; even if it disconnected
            // again before this check, the generation move tells us the
            // room was touched and we should re-verify intent rather than
            // killing a kernel an in-flight or recent peer expected. The
            // room stays in the map either way; we only gate the
            // kernel-side teardown on "no peers AND no reconnect since
            // scheduling."
            let should_teardown = {
                let _rooms_guard = rooms_for_teardown.lock().await;
                let no_peers = room_for_teardown
                    .connections
                    .active_peers
                    .load(Ordering::Relaxed)
                    == 0;
                let same_generation =
                    room_for_teardown.connections.connection_generation() == teardown_generation;
                no_peers && same_generation
            }; // rooms lock dropped here

            if !should_teardown {
                debug!(
                    "[notebook-sync] Kernel teardown skipped for {} (peers reconnected during flush)",
                    notebook_id_for_teardown
                );
                return;
            }

            info!(
                "[notebook-sync] Kernel teardown starting for {} (uuid={})",
                notebook_id_for_teardown, room_for_teardown.id
            );

            // Shut down runtime agent subprocess if running. RuntimeAgentHandle::spawn
            // moves Child into a background task, so kill_on_drop doesn't
            // trigger on room drop — we need explicit shutdown via RPC.
            //
            // Right before each destructive step that reaches into the
            // runtime agent we revalidate the connection generation: a
            // peer that reconnected between the flush-success check
            // above and now invalidates the teardown decision. Without
            // this, the ShutdownKernel RPC can fire for a kernel a
            // newly-joined peer is already using (and which they
            // skipped auto-launch for because they saw has_kernel=true).
            let still_valid = {
                let _rooms_guard = rooms_for_teardown.lock().await;
                let no_peers = room_for_teardown
                    .connections
                    .active_peers
                    .load(Ordering::Relaxed)
                    == 0;
                let same_generation =
                    room_for_teardown.connections.connection_generation() == teardown_generation;
                no_peers && same_generation
            };
            if !still_valid {
                debug!(
                    "[notebook-sync] Kernel teardown aborted for {} (peer reconnected just before shutdown RPC)",
                    notebook_id_for_teardown
                );
                return;
            }
            {
                let has_runtime_agent = room_for_teardown
                    .runtime_agent_request_tx
                    .lock()
                    .await
                    .is_some();
                if has_runtime_agent {
                    // Timeout the shutdown RPC — a dead/stuck agent shouldn't
                    // block teardown forever.
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        send_runtime_agent_request(
                            &room_for_teardown,
                            notebook_protocol::protocol::RuntimeAgentRequest::ShutdownKernel,
                        ),
                    )
                    .await
                    {
                        Ok(_) => {}
                        Err(_) => {
                            warn!(
                                "[notebook-sync] Runtime agent shutdown timed out for {}, force-dropping",
                                notebook_id_for_teardown
                            );
                        }
                    }
                    // Drop the handle so it tears down the runtime-agent ownership group
                    // and removes the matching manifest only after cleanup succeeds.
                    {
                        let mut guard = room_for_teardown.runtime_agent_handle.lock().await;
                        *guard = None;
                    }
                    {
                        let mut tx = room_for_teardown.runtime_agent_request_tx.lock().await;
                        *tx = None;
                    }
                }
            }

            // Flush launched_config deps → metadata.runt.{uv,conda}.dependencies
            // before env cleanup and final save. This captures any packages
            // the user hot-installed during the session so they land in
            // the .ipynb, and feeds the preserve-predicate below with the
            // up-to-date dep list so the unified-hash path check points
            // at the right directory.
            //
            // The launched config carries deps for at most one runtime
            // (UV xor Conda), and `effective_user_deps_from_launched`
            // gates strictly on that — so at most one flush happens per
            // teardown. We record which runtime flushed so the rename
            // step below uses the right hash function.
            let launched_snapshot = room_for_teardown
                .runtime_agent_launched_config
                .read()
                .await
                .clone();
            let mut flushed_runtime: Option<CapturedEnvRuntime> = None;
            let mut save_succeeded = false;
            if let Some(ref launched) = launched_snapshot {
                let has_saved_path = room_for_teardown.file_binding.has_saved_path().await;
                let env_source = room_for_teardown
                    .state
                    .read(|sd| sd.read_state().kernel.env_source.clone())
                    .unwrap_or_default();
                let project_backed = matches!(
                    env_source.as_str(),
                    "pixi:toml" | "uv:pyproject" | "conda:env_yml"
                );
                if has_saved_path && !project_backed {
                    for runtime in [CapturedEnvRuntime::Uv, CapturedEnvRuntime::Conda] {
                        if flush_launched_deps_to_metadata(&room_for_teardown, launched, runtime)
                            .await
                        {
                            flushed_runtime = Some(runtime);
                        }
                    }
                    if flushed_runtime.is_some() {
                        info!(
                            "[notebook-sync] Flushed hot-sync deps into metadata for {}",
                            notebook_id_for_teardown
                        );
                        // Persist to disk now — autosave already saw the
                        // teardown and is about to flush, but writing
                        // here keeps the env-dir rename below correct
                        // even if autosave is wedged.
                        match save_notebook_to_disk(&room_for_teardown, None).await {
                            Ok(_) => save_succeeded = true,
                            Err(e) => warn!(
                                "[notebook-sync] Failed to persist hot-sync deps to {}: {} — skipping env-dir rename",
                                notebook_id_for_teardown, e
                            ),
                        }
                    }
                } else if project_backed {
                    debug!(
                        "[notebook-sync] Skipping launched dep metadata flush for project-backed env {}",
                        env_source
                    );
                }
            }

            // Autosave + file watchers stay alive across kernel teardown so
            // `get_or_create_room_result` reuses the resident room on
            // reconnect without rebinding them. The ghost reaper shuts them
            // down at the point the room is actually removed from the map.
            // With no peers driving doc edits, the debouncer/watchers sit
            // idle and cost nothing.

            // Rename the env dir to match the post-flush unified
            // hash so the next reopen's `unified_env_on_disk` lookup
            // finds it. Skip the rename when save failed — leaving
            // disk metadata on the old hash while the env moved to
            // the new one would defeat the next reopen. Kernel is
            // already dead at this point (runtime agent was shut
            // down above), so the rename is safe.
            if let Some(runtime) = flushed_runtime {
                if save_succeeded {
                    let current = room_for_teardown
                        .runtime_agent_env_path
                        .read()
                        .await
                        .clone();
                    if let Some(current_path) = current {
                        let metadata_after = {
                            let doc = room_for_teardown.doc.read().await;
                            doc.get_metadata_snapshot()
                        };
                        let new_path = rename_env_dir_to_unified_hash(
                            &current_path,
                            metadata_after.as_ref(),
                            runtime,
                            &kernel_env::uv::default_cache_dir_uv(),
                            &kernel_env::conda::default_cache_dir_conda(),
                        )
                        .await;
                        if new_path != current_path {
                            let mut ep = room_for_teardown.runtime_agent_env_path.write().await;
                            *ep = Some(new_path);
                        }
                    }
                }
            }

            // Clean up the environment directory on teardown — unless
            // the room holds a captured env bound to a saved .ipynb.
            //
            // Pool envs (`runtimed-{uv,conda,pixi}-*`) and captured envs
            // for untitled notebooks are orphaned once the kernel is gone:
            // pool envs were mutated with the notebook's deps and can't
            // be returned, and captured envs with no saved .ipynb have
            // no persistent `env_id` reference. Both delete eagerly.
            //
            // Captured envs for saved notebooks are the reopen cache.
            // Preserve them so the next launch's `unified_env_on_disk`
            // lookup hits the cached env instead of rebuilding from the
            // pool. A future age-based GC sweeps envs whose notebook
            // hasn't been opened in a long time.
            //
            // Use pool_env_root() to normalise pixi paths — their
            // venv_path is nested (e.g. .pixi/envs/default) but we
            // operate on the top-level runtimed-pixi-* directory.
            {
                let env_path = room_for_teardown
                    .runtime_agent_env_path
                    .read()
                    .await
                    .clone();
                if let Some(ref path) = env_path {
                    let has_saved_path = room_for_teardown.file_binding.has_saved_path().await;
                    let metadata = {
                        let doc = room_for_teardown.doc.read().await;
                        doc.get_metadata_snapshot()
                    };
                    let preserve = should_preserve_env_on_eviction(
                        has_saved_path,
                        path,
                        metadata.as_ref(),
                        &kernel_env::uv::default_cache_dir_uv(),
                        &kernel_env::conda::default_cache_dir_conda(),
                    );
                    if preserve {
                        info!(
                            "[notebook-sync] Preserving captured env {:?} on kernel teardown (saved notebook)",
                            path
                        );
                    } else {
                        let root = crate::paths::pool_env_root(path);
                        let cache_dir = crate::paths::default_cache_dir();
                        if !crate::is_within_cache_dir(&root, &cache_dir) {
                            warn!(
                                "[notebook-sync] Refusing to delete env {:?} on kernel teardown (not within cache dir)",
                                root
                            );
                        } else if root.exists() {
                            info!(
                                "[notebook-sync] Cleaning up env {:?} on kernel teardown",
                                root
                            );
                            if let Err(e) = tokio::fs::remove_dir_all(&root).await {
                                warn!(
                                    "[notebook-sync] Failed to clean up env {:?} on kernel teardown: {}",
                                    root, e
                                );
                            }
                        }
                    }
                    // Clear the env-path slot now that the directory is
                    // gone (or has been intentionally preserved under a
                    // new unified-hash name). Leaving the old path here
                    // would mis-report the env to `runt env clean` and
                    // friends once the dir no longer exists.
                    if !preserve {
                        let mut ep = room_for_teardown.runtime_agent_env_path.write().await;
                        *ep = None;
                    }
                }
            }

            // Stamp the room as "kernel torn down at now" so the ghost
            // reaper can find it. If a peer raced in between the last
            // peer-count check and now, their reconnect path zeroes this
            // back out — the reaper re-checks `active_peers == 0` under
            // the lock before sweeping.
            room_for_teardown.connections.stamp_kernel_torn_down_now();

            info!(
                "[notebook-sync] Kernel torn down for {}; room held for resume",
                notebook_id_for_teardown
            );
        });
    } else {
        info!(
            "[notebook-sync] Client disconnected from room {} (uuid={}, peer_id={}): {} peer{} remaining",
            notebook_id,
            room.id,
            peer_id,
            remaining,
            if remaining == 1 { "" } else { "s" }
        );
    }
}
