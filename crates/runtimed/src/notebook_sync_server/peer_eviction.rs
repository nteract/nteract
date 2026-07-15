use std::sync::atomic::Ordering;
use std::sync::Arc;

use tracing::{debug, info, warn};

use crate::async_outcome::{recv_oneshot_with_timeout, TimedOneShot};
use crate::task_supervisor::spawn_best_effort;

use super::{
    flush_launched_deps_to_metadata, rename_env_dir_to_unified_hash, save_notebook_to_disk,
    send_runtime_agent_request, should_preserve_env_on_eviction, CapturedEnvRuntime, NotebookRoom,
    NotebookRooms, RoomInitialLoad, RoomInitialLoadState,
};

/// Last-peer teardown must never wait forever on the owner-lived source task.
/// If this deadline wins, kernel and environment cleanup still proceed while
/// every `.ipynb` mutation is skipped. This is intentionally not a deadline on
/// materialization itself: a large but progressing load remains room-owned.
const LAST_PEER_NOTEBOOK_WRITE_SETTLE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(120);

async fn wait_for_initial_load_before_notebook_writes(
    initial_load: &RoomInitialLoad,
    timeout: std::time::Duration,
) -> Option<RoomInitialLoadState> {
    let state = initial_load.state();
    if !state.is_loading() {
        return Some(state);
    }

    tokio::time::timeout(timeout, initial_load.wait_until_settled())
        .await
        .ok()
}

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
            // Generation fence: teardown may proceed only while the room
            // has no peers AND the connection generation still matches
            // the snapshot taken at scheduling time. A fast reconnect
            // bumps the generation, so a stale teardown never shoots a
            // kernel the reconnected peer now owns. Evaluate this only
            // inside a `serialize_with` critical section so the reads
            // are consistent with connect-path mutations.
            let teardown_fence_holds = || {
                let no_peers = room_for_teardown
                    .connections
                    .active_peers
                    .load(Ordering::Relaxed)
                    == 0;
                let same_generation =
                    room_for_teardown.connections.connection_generation() == teardown_generation;
                no_peers && same_generation
            };

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

                // Force a synchronous flush of the persist debouncer before
                // kernel teardown. Hot-installed deps and any unflushed edits
                // should be on disk before kernel RPC starts unwinding things.
                //
                // On timeout or write failure we back off and retry. The
                // room stays resident, so retrying is cheap and a reconnect
                // still finds the live in-memory doc.
                const FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
                const FLUSH_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(30);
                let mut flush_ok = true;
                let mut flush_failure_kind: Option<&'static str> = None;
                if let Some(ack_rx) = room_for_teardown.persistence.request_flush() {
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
            let should_teardown = rooms_for_teardown
                .serialize_with(&teardown_fence_holds)
                .await;

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
            // Atomically check no-peers + same-generation AND flip the
            // `kernel_teardown_destructive` latch under the rooms lock.
            // The connect path reads this latch when deciding whether to
            // skip auto-launch on `has_kernel=true`: if it's set, the
            // visible kernel is about to die and the peer must
            // auto-launch a fresh kernel rather than use the stale
            // handle. Setting it under the rooms lock together with
            // the peer-count / generation check makes the connect path
            // observe a consistent "destructive teardown in progress"
            // state if (and only if) we will actually proceed below.
            let still_valid = rooms_for_teardown
                .serialize_with(|| {
                    let ok = teardown_fence_holds();
                    if ok {
                        room_for_teardown
                            .connections
                            .kernel_teardown_destructive
                            .store(true, Ordering::Release);
                    }
                    ok
                })
                .await;
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
            // Destructive section done: handle slot is empty, so any
            // peer-connect path that runs `has_kernel()` from here on
            // sees `false` and can auto-launch. Clear the latch so we
            // don't keep the connect path in "force auto-launch" mode
            // unnecessarily.
            room_for_teardown
                .connections
                .kernel_teardown_destructive
                .store(false, Ordering::Release);

            // Initial file materialization is room-owned and can outlive the
            // peer that caused it to start. Never project the room's partial
            // document back into the source `.ipynb`: doing so can combine a
            // prefix of loaded cells with hot dependency metadata and replace
            // the complete file on disk. Bound only teardown's wait; the
            // owner-lived source task may still make legitimate progress after
            // a slow filesystem or large notebook delays it.
            //
            // Kernel shutdown above is deliberately independent. On timeout or
            // source failure we skip only notebook writes, then continue env
            // cleanup below.
            let has_saved_path = room_for_teardown.file_binding.has_saved_path().await;
            let notebook_writes_allowed = if has_saved_path {
                match wait_for_initial_load_before_notebook_writes(
                    &room_for_teardown.initial_load,
                    LAST_PEER_NOTEBOOK_WRITE_SETTLE_TIMEOUT,
                )
                .await
                {
                    Some(RoomInitialLoadState::NotNeeded { .. })
                    | Some(RoomInitialLoadState::Ready { .. }) => true,
                    Some(RoomInitialLoadState::Failed { generation, reason }) => {
                        warn!(
                            "[notebook-sync] Skipping final notebook writes for {} because initial load generation {} failed: {}",
                            notebook_id_for_teardown, generation, reason
                        );
                        false
                    }
                    Some(RoomInitialLoadState::Loading { generation }) => {
                        warn!(
                            "[notebook-sync] Skipping final notebook writes for {} because initial load generation {} is still loading",
                            notebook_id_for_teardown, generation
                        );
                        false
                    }
                    None => {
                        warn!(
                            "[notebook-sync] Skipping final notebook writes for {} after waiting {:?} for initial load to settle",
                            notebook_id_for_teardown,
                            LAST_PEER_NOTEBOOK_WRITE_SETTLE_TIMEOUT
                        );
                        false
                    }
                }
            } else {
                false
            };

            // The source-settle wait can be long enough for a peer to
            // reconnect and launch a replacement kernel. Revalidate before
            // reading launched config or touching notebook/env state from what
            // may now be a new session. A changed generation aborts this stale
            // teardown even if that peer has already disconnected again.
            let still_current_after_load_wait = rooms_for_teardown
                .serialize_with(&teardown_fence_holds)
                .await;
            if !still_current_after_load_wait {
                debug!(
                    "[notebook-sync] Post-kernel cleanup stopped for {} after initial-load wait (peer reconnected)",
                    notebook_id_for_teardown
                );
                return;
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
            let launched_snapshot = if notebook_writes_allowed {
                room_for_teardown
                    .runtime_agent_launched_config
                    .read()
                    .await
                    .clone()
            } else {
                None
            };
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
            //
            // For file-backed rooms we still force one synchronous
            // `.ipynb` save now so the disk record is current at the
            // moment we go inactive. The autosave debouncer may still
            // have unflushed edits in its window, and the daemon could
            // restart (or be killed) before the next debounce tick
            // fires. Skip when we already saved as part of the
            // hot-sync deps flush above. Untitled rooms have no
            // `.ipynb` to save and use the persisted Automerge doc
            // instead, which the synchronous flush at the top of this
            // task already wrote.
            if notebook_writes_allowed && !save_succeeded {
                match save_notebook_to_disk(&room_for_teardown, None).await {
                    Ok(_) => {
                        debug!(
                            "[notebook-sync] Final .ipynb save on kernel teardown for {}",
                            notebook_id_for_teardown
                        );
                    }
                    Err(e) => warn!(
                        "[notebook-sync] Final .ipynb save failed for {}: {} — autosave debouncer still armed for next reconnect",
                        notebook_id_for_teardown, e
                    ),
                }
            }

            // Rename the env dir to match the post-flush unified
            // hash so the next reopen's `captured_env_disk_state`
            // check finds it. Skip the rename when save failed —
            // leaving disk metadata on the old hash while the env moved
            // to the new one would defeat the next reopen. Kernel is
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

            // Revalidate one more time before destructive env cleanup.
            // Between the previous check and this point we ran an
            // env-dir rename and a save; a peer that joined in that
            // window will have triggered auto-launch and written a new
            // env path into `runtime_agent_env_path`. Deleting it now
            // would orphan the resumed kernel. The room stays
            // resident, so aborting is the right move.
            let still_valid = rooms_for_teardown
                .serialize_with(&teardown_fence_holds)
                .await;
            if !still_valid {
                debug!(
                    "[notebook-sync] Skipping env cleanup for {} (peer reconnected and may have relaunched)",
                    notebook_id_for_teardown
                );
                // Do NOT stamp last_kernel_torn_down_at — a peer is
                // back and the room is no longer in the teardown
                // pipeline.
                return;
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
            // Preserve them so the next launch's typed captured-env disk
            // state check hits the cached env instead of rebuilding from
            // the pool. A future age-based GC sweeps envs whose notebook
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn notebook_write_wait_times_out_while_source_is_loading() {
        let initial_load = RoomInitialLoad::default();
        initial_load.mark_required();

        assert_eq!(
            wait_for_initial_load_before_notebook_writes(
                &initial_load,
                std::time::Duration::from_millis(1),
            )
            .await,
            None,
            "teardown must skip notebook writes instead of observing partial source state"
        );
        assert!(initial_load.is_loading());
    }

    #[tokio::test]
    async fn notebook_write_wait_observes_source_ready() {
        let lifecycle = crate::notebook_sync_server::RoomLifecycle::test_default();
        let initial_load = Arc::new(RoomInitialLoad::new(Arc::clone(&lifecycle)));
        initial_load.mark_required();
        let generation = initial_load.state().generation();
        let completer = Arc::clone(&initial_load);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            assert!(lifecycle.publish_recovered_projection_ready(
                generation,
                empty_projection(generation),
                Vec::new(),
            ));
            assert!(completer.complete_ready(generation, 1));
        });

        assert_eq!(
            wait_for_initial_load_before_notebook_writes(
                &initial_load,
                std::time::Duration::from_secs(1),
            )
            .await,
            Some(RoomInitialLoadState::Ready {
                generation,
                cell_count: 1,
            })
        );
    }
}
