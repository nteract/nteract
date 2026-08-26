//! `NotebookRequest::LaunchKernel` handler.
//!
//! Biggest single arm — 1300+ lines. Resolves kernel type + env source,
//! promotes inline deps, claims pool envs or prepares inline caches, spawns
//! the runtime agent, and dispatches LaunchKernel / RestartKernel over RPC.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::sync::oneshot;
use tracing::{error, info, warn};

use notebook_doc::presence;
use notebook_protocol::connection::{EnvSource, LaunchSpec, PackageManager};
use runtime_doc::{KernelActivity, KernelErrorReason, RuntimeLifecycle};

use crate::async_outcome::{recv_oneshot_with_timeout, TimedOneShot};
use crate::daemon::Daemon;
use crate::shell_env_overlay::ShellEnvOverlay;

fn overlay_env_vars(overlay: &Arc<ShellEnvOverlay>) -> std::collections::HashMap<String, String> {
    // Merge the user's shell PATH with the daemon's PATH so the kernel can
    // both find daemon-managed tools (uv) and the user's shell binaries
    // (~/.local/bin, /opt/homebrew/bin, etc.).
    let daemon_path = std::env::var("PATH").unwrap_or_default();
    overlay.build_kernel_env_vars(&daemon_path)
}
use crate::notebook_sync_server::{
    acquire_prewarmed_env_with_capture, build_launched_config, captured_env_disk_state,
    captured_env_for_runtime, captured_env_source_override, check_and_broadcast_sync_state,
    check_inline_deps, extract_pixi_toml_deps, format_conda_env_yml_build_details,
    get_inline_conda_channels, get_inline_conda_deps, get_inline_conda_python, get_inline_uv_deps,
    get_inline_uv_prerelease, get_inline_uv_requires_python, missing_conda_env_yml_decision,
    project_environment_build_approved, promote_inline_deps_to_project,
    publish_environment_launch_error, reset_starting_state, reset_starting_state_with_outcome,
    resolve_metadata_snapshot, send_runtime_agent_request_with_captured_env_repair,
    try_conda_pool_for_inline_deps, try_uv_pool_for_inline_deps, update_kernel_presence_locked,
    CapturedEnvRuntime, KernelLaunchAttempt, KernelLaunchCommitRejection, KernelLaunchCompletion,
    ManualLaunchAdmission, NotebookRoom, ResetOutcome,
};
use crate::protocol::NotebookResponse;
use crate::requests::guarded;

async fn wait_for_launch_generation(
    room: &NotebookRoom,
    generation: u64,
) -> KernelLaunchCompletion {
    let mut generation = generation;
    loop {
        if let Some(completion) = room.launch_completion(generation) {
            match completion {
                KernelLaunchCompletion::Released => {
                    if let Some(successor) = room.launch_successor_generation(generation) {
                        generation = successor;
                        continue;
                    }
                    return KernelLaunchCompletion::Released;
                }
                terminal => return terminal,
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn wait_for_joined_launch(
    room: &NotebookRoom,
    generation: u64,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<KernelLaunchCompletion, ()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    let completion = wait_for_launch_generation(room, generation);
    tokio::pin!(completion);
    tokio::select! {
        biased;
        result = &mut completion => Ok(result),
        _ = crate::notebook_sync_server::wait_for_kernel_launch_cancellation(cancel_rx) => {
            // The owner remains independently fenced until its cancellation-
            // safe checkpoint, but a joined request must retain its transport
            // budget. Wait only for the remainder of the original deadline.
            tokio::time::timeout_at(deadline, completion)
                .await
                .map_err(|_| ())
        }
        _ = tokio::time::sleep_until(deadline) => Err(()),
    }
}

async fn existing_kernel_response(room: &NotebookRoom) -> Option<NotebookResponse> {
    let active = room.active_kernel_launch()?;
    let lifecycle = room
        .state
        .read(|sd| sd.read_state().kernel.lifecycle)
        .unwrap_or(RuntimeLifecycle::NotStarted);
    if !matches!(
        lifecycle,
        RuntimeLifecycle::Running(_)
            | RuntimeLifecycle::Resolving
            | RuntimeLifecycle::PreparingEnv
            | RuntimeLifecycle::Launching
            | RuntimeLifecycle::Connecting
    ) {
        return None;
    }

    let current_agent_id = room.current_runtime_agent_id.read().await.clone();
    if current_agent_id.as_deref() != Some(&active.runtime_agent_id)
        || room.runtime_agent_request_tx.lock().await.is_none()
    {
        room.clear_active_kernel_launch_if_agent(&active.runtime_agent_id);
        return None;
    }
    let launched_config = room.runtime_agent_launched_config.read().await.clone()?;

    Some(NotebookResponse::KernelAlreadyRunning {
        kernel_type: active.kernel_type,
        env_source: active.env_source,
        launched_config,
    })
}

async fn complete_manual_launch(
    room: &NotebookRoom,
    launch_attempt: &mut Option<KernelLaunchAttempt>,
    runtime_agent_id: &str,
    kernel_type: &str,
    env_source: &EnvSource,
    launched_config: &notebook_protocol::protocol::LaunchedEnvConfig,
) -> Result<(), NotebookResponse> {
    let attempt = launch_attempt
        .take()
        .expect("manual launch attempt must be owned");
    let env_source_label = env_source.as_str().to_string();
    let commit_result = {
        let (mut config, mut presence_state) = tokio::join!(
            room.runtime_agent_launched_config.write(),
            room.broadcasts.presence.write()
        );
        attempt.succeed_with_agent(runtime_agent_id, || {
            *config = Some(launched_config.clone());
            update_kernel_presence_locked(
                &mut presence_state,
                &room.broadcasts.presence_tx,
                presence::KernelStatus::Idle,
                &env_source_label,
            );
            if let Err(e) = room.state.with_doc(|sd| {
                sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
                sd.set_kernel_info(kernel_type, kernel_type, &env_source_label)?;
                sd.set_prewarmed_packages(&launched_config.prewarmed_packages)?;
                sd.set_runtime_agent_id(runtime_agent_id)?;
                Ok(())
            }) {
                warn!("[runtime-state] {}", e);
            }
            room.set_active_kernel_launch(
                runtime_agent_id.to_string(),
                kernel_type.to_string(),
                env_source.clone(),
            );
        })
    };

    match commit_result {
        Ok(()) => {
            check_and_broadcast_sync_state(room).await;
            Ok(())
        }
        Err((cancelled_attempt, KernelLaunchCommitRejection::Cancelled)) => {
            // Shutdown won the gate before success was linearized. Keep the
            // token until cleanup finishes so no successor can launch beside
            // the kernel or agent we are stopping.
            let _ = crate::requests::shutdown_kernel::handle(room).await;
            cancelled_attempt.finish_cancelled();
            Err(NotebookResponse::Error {
                error: "Kernel launch cancelled by ShutdownKernel".to_string(),
            })
        }
        Err((superseded_attempt, KernelLaunchCommitRejection::AgentUnavailable)) => {
            drop(superseded_attempt);
            let details = "Kernel launch was superseded by a newer runtime agent";
            reset_starting_state_with_outcome(
                room,
                Some(runtime_agent_id),
                ResetOutcome::Error {
                    reason: None,
                    details,
                },
            )
            .await;
            Err(NotebookResponse::Error {
                error: details.to_string(),
            })
        }
    }
}

pub(crate) async fn handle(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    kernel_type: String,
    env_source: LaunchSpec,
    notebook_path: Option<String>,
) -> NotebookResponse {
    if let Err(rejection) = guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }

    let mut launch_attempt = Some(loop {
        match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => {
                // The active kernel can finish between admission and this
                // check. Owning the gate makes a progress-phase projection
                // safe here: no different launch can be in flight.
                if let Some(response) = existing_kernel_response(room).await {
                    attempt.release_without_cooldown();
                    return response;
                }
                break attempt;
            }
            ManualLaunchAdmission::InFlight {
                generation,
                cancel_rx,
            } => {
                let completion = wait_for_joined_launch(room, generation, cancel_rx).await;
                match completion {
                    Ok(KernelLaunchCompletion::Succeeded) => {
                        return existing_kernel_response(room).await.unwrap_or_else(|| {
                            NotebookResponse::Error {
                                error: "Kernel launch completed without an active launch identity"
                                    .to_string(),
                            }
                        });
                    }
                    Ok(KernelLaunchCompletion::Released) => continue,
                    Ok(KernelLaunchCompletion::Cancelled) => {
                        return NotebookResponse::Error {
                            error: "Kernel launch was cancelled by shutdown".to_string(),
                        };
                    }
                    Ok(KernelLaunchCompletion::Failed) | Err(_) => {
                        return NotebookResponse::Error {
                            error: "Kernel launch timed out or failed".to_string(),
                        };
                    }
                }
            }
        }
    });

    // Fall back to the room's on-disk path when the caller doesn't
    // supply one. The frontend typically launches with
    // `notebook_path: None` and relies on the room knowing its own
    // path; without this fallback, notebook-relative working dirs
    // and auto-detection of `pyproject.toml` / `environment.yml` /
    // `pixi.toml` silently stop working for saved notebooks.
    let notebook_path = match notebook_path {
        Some(p) => Some(p),
        None => room
            .file_binding
            .path()
            .await
            .map(|p| p.to_string_lossy().into_owned()),
    };
    // The room-local launch gate above owns serialization. RuntimeStateDoc is
    // the client-facing projection, not a lock: concurrent Automerge lifecycle
    // writes can legitimately resolve to an intermediate phase.
    if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
        room.state.with_doc(|sd| {
            sd.clear_env_progress().ok();
            sd.set_trust("trusted", false).ok();
            sd.set_lifecycle(&RuntimeLifecycle::Resolving)
        })
    }) {
        warn!("[runtime-state] {}", e);
    }
    if let Err(e) = room.comms.with_doc(|cd| cd.clear_comms()) {
        warn!("[comms-doc] {}", e);
    }
    if let Err(e) = room.state.with_doc(|sd| sd.clear_comms()) {
        warn!("[runtime-state] {}", e);
    }

    let notebook_path = notebook_path.map(std::path::PathBuf::from);
    // Fall back to room.identity.working_dir for untitled notebooks (mirrors auto-launch path).
    // Enables project file detection (environment.yaml, pyproject.toml, pixi.toml)
    // when MCP callers send notebook_path: None for UUID-based notebooks.
    let notebook_path = match notebook_path {
        some @ Some(_) => some,
        None => {
            let wd = room.identity.working_dir.read().await;
            wd.clone().inspect(|p| {
                info!(
                    "[notebook-sync] LaunchKernel: using room working_dir for project file detection: {}",
                    p.display()
                );
            })
        }
    };

    // Resolve metadata snapshot from Automerge doc (preferred) or disk
    let mut metadata_snapshot = resolve_metadata_snapshot(room, notebook_path.as_deref()).await;

    // Auto-detect kernel type if "auto" or empty
    let resolved_kernel_type = if kernel_type == "auto" || kernel_type.is_empty() {
        metadata_snapshot
            .as_ref()
            .and_then(|s| s.detect_runtime())
            .unwrap_or_else(|| {
                info!("[notebook-sync] LaunchKernel: kernel type unknown, defaulting to python");
                "python".to_string()
            })
    } else {
        kernel_type.clone()
    };
    info!(
        "[notebook-sync] LaunchKernel: resolved kernel_type='{}' (from '{}')",
        resolved_kernel_type, kernel_type
    );

    // Classify the request-time input. Permissive: non-canonical values land in
    // `LaunchSpec::Concrete(EnvSource::Unknown(_))` and pass through unchanged.
    let launch_spec = env_source;

    // Deno kernels don't use Python environments - always use "deno" regardless
    // of what env_source was requested. Log a warning if caller passed a Python env.
    let resolved_env_source = if resolved_kernel_type == "deno" {
        match &launch_spec {
            LaunchSpec::Auto | LaunchSpec::AutoScoped(_) => {
                info!("[notebook-sync] Deno kernel detected, using 'deno' env_source");
            }
            LaunchSpec::Concrete(EnvSource::Deno) => {
                info!("[notebook-sync] Deno kernel detected, using 'deno' env_source");
            }
            LaunchSpec::Concrete(other) => {
                warn!(
                    "[notebook-sync] Deno kernel requested with Python env_source '{}' - \
                     ignoring and using 'deno' instead",
                    other.as_str()
                );
            }
        }
        EnvSource::Deno
    } else if matches!(launch_spec, LaunchSpec::Auto | LaunchSpec::AutoScoped(_)) {
        // Auto-detect Python environment, optionally scoped to a package manager family.
        // "auto:uv" constrains to UV sources, "auto:conda" to conda sources,
        // "auto:pixi" to pixi sources.
        let auto_scope: Option<&'static str> = match launch_spec.auto_scope() {
            Some(PackageManager::Uv) => Some("uv"),
            Some(PackageManager::Conda) => Some("conda"),
            Some(PackageManager::Pixi) => Some("pixi"),
            Some(PackageManager::Unknown(_)) | None => None,
        };

        let environment_mode = *room.identity.environment_mode.read().await;
        let detected_project = if environment_mode.allows_project_files() {
            notebook_path.as_ref().and_then(|path| match auto_scope {
                Some("uv") => crate::project_file::find_nearest_project_file(
                    path,
                    &[crate::project_file::ProjectFileKind::PyprojectToml],
                ),
                Some("conda") => crate::project_file::find_nearest_project_file(
                    path,
                    &[crate::project_file::ProjectFileKind::EnvironmentYml],
                ),
                Some("pixi") => crate::project_file::find_nearest_project_file(
                    path,
                    &[crate::project_file::ProjectFileKind::PixiToml],
                ),
                _ => crate::project_file::detect_project_file(path),
            })
        } else {
            None
        };
        let project_source = detected_project.as_ref().map(|detected| {
            info!(
                "[notebook-sync] Auto-detected project file: {:?} -> {}",
                detected.path,
                detected.to_env_source().as_str()
            );
            detected.to_env_source()
        });

        // Auto keeps the legacy project-first policy. `notebook` is the
        // explicit opt-out and suppresses project_source above.
        if let Some(source) = if matches!(
            environment_mode,
            notebook_protocol::connection::CreateNotebookEnvironmentMode::Auto
                | notebook_protocol::connection::CreateNotebookEnvironmentMode::Project
        ) {
            project_source.clone()
        } else {
            None
        } {
            info!(
                "[notebook-sync] LaunchKernel: using project file -> {}",
                source.as_str()
            );
            source
        }
        // Captured prewarmed env wins over inline deps. Captured deps look
        // structurally identical to user-authored inline deps, so without this
        // override, reopening a captured notebook would route through the
        // inline-deps path and miss the already-claimed env.
        else if let Some(captured_src) = captured_env_source_override(metadata_snapshot.as_ref())
            .filter(|src| match auto_scope {
                Some("uv") => matches!(src, EnvSource::Prewarmed(PackageManager::Uv)),
                Some("conda") => matches!(src, EnvSource::Prewarmed(PackageManager::Conda)),
                Some("pixi") => false,
                _ => true,
            })
        {
            info!(
                "[notebook-sync] LaunchKernel: captured env on disk -> {}",
                captured_src.as_str()
            );
            captured_src
        }
        // Priority 3: Check inline deps in notebook metadata
        else if let Some(inline_source) =
            metadata_snapshot
                .as_ref()
                .and_then(|snap| -> Option<EnvSource> {
                    match auto_scope {
                        Some("uv") => snap
                            .runt
                            .uv
                            .as_ref()
                            .filter(|uv| !uv.dependencies.is_empty())
                            .map(|_| EnvSource::Inline(PackageManager::Uv)),
                        Some("conda") => snap
                            .runt
                            .conda
                            .as_ref()
                            .filter(|c| !c.dependencies.is_empty())
                            .map(|_| EnvSource::Inline(PackageManager::Conda)),
                        Some("pixi") => snap
                            .runt
                            .pixi
                            .as_ref()
                            .filter(|p| !p.dependencies.is_empty())
                            .map(|_| EnvSource::Inline(PackageManager::Pixi)),
                        _ => check_inline_deps(snap).filter(|s| !matches!(s, EnvSource::Deno)),
                    }
                })
        {
            info!(
                "[notebook-sync] Found inline deps in notebook metadata -> {}",
                inline_source.as_str()
            );
            inline_source
        } else {
            // Check PEP 723 script blocks in cell source.
            let has_pep723_deps = if auto_scope == Some("conda") {
                false
            } else {
                let cells = room.doc.read().await.get_cells();
                match notebook_doc::pep723::find_pep723_in_cells(&cells) {
                    Ok(Some(ref m)) if !m.dependencies.is_empty() => true,
                    Ok(_) => false,
                    Err(e) => {
                        warn!(
                            "[notebook-sync] Failed to parse PEP 723 script blocks: {}",
                            e
                        );
                        false
                    }
                }
            };

            if has_pep723_deps {
                let pep723_source = match auto_scope {
                    Some("uv") => EnvSource::Pep723(PackageManager::Uv),
                    Some("pixi") => EnvSource::Pep723(PackageManager::Pixi),
                    Some("conda") => unreachable!("conda scope skips PEP 723"),
                    _ => {
                        let default_env = daemon.default_python_env().await;
                        match default_env {
                            crate::settings_doc::PythonEnvType::Pixi => {
                                EnvSource::Pep723(PackageManager::Pixi)
                            }
                            _ => EnvSource::Pep723(PackageManager::Uv),
                        }
                    }
                };
                info!(
                    "[notebook-sync] Found PEP 723 deps in cell source ({})",
                    pep723_source.as_str()
                );
                pep723_source
            }
            // Fall back to prewarmed (scoped to family)
            else {
                let fallback = match auto_scope {
                    Some("conda") => EnvSource::Prewarmed(PackageManager::Conda),
                    Some("pixi") => EnvSource::Prewarmed(PackageManager::Pixi),
                    _ => {
                        let default_env = daemon.default_python_env().await;
                        match default_env {
                            crate::settings_doc::PythonEnvType::Conda => {
                                EnvSource::Prewarmed(PackageManager::Conda)
                            }
                            crate::settings_doc::PythonEnvType::Pixi => {
                                EnvSource::Prewarmed(PackageManager::Pixi)
                            }
                            _ => EnvSource::Prewarmed(PackageManager::Uv),
                        }
                    }
                };
                info!(
                    "[notebook-sync] No project file detected, using {}",
                    fallback.as_str()
                );
                fallback
            }
        }
    } else {
        // Use explicit env_source (e.g., "uv:inline", "conda:inline")
        match launch_spec {
            LaunchSpec::Concrete(source) => source,
            LaunchSpec::Auto | LaunchSpec::AutoScoped(_) => unreachable!("auto handled above"),
        }
    };

    let parsed_resolved = resolved_env_source.clone();

    // For pixi:toml, verify ipykernel is declared before launching.
    // Unlike uv (`uv run --with ipykernel`) and conda:env_yml (daemon
    // injects ipykernel into deps pre-sync), pixi does not auto-inject.
    //
    // Publish the typed `KernelErrorReason::MissingIpykernel` AFTER
    // `reset_starting_state` so the Error lifecycle survives. The prior
    // code only returned an `Error` response — the toolbar could
    // classify the spawn error generically but never rendered the
    // targeted remediation on the RPC path.
    if matches!(parsed_resolved, EnvSource::PixiToml) {
        let pixi_path = notebook_path.as_ref().and_then(|nb| {
            crate::project_file::detect_project_file(nb)
                .filter(|d| d.kind == crate::project_file::ProjectFileKind::PixiToml)
                .map(|d| d.path)
        });
        if let Some(ref path) = pixi_path {
            let has_ipykernel = match kernel_launch::tools::pixi_info(path).await {
                Ok(info) => info.has_ipykernel(),
                Err(_) => crate::project_file::pixi_toml_has_ipykernel(path),
            };
            if !has_ipykernel {
                warn!(
                    "[notebook-sync] pixi.toml at {:?} does not declare ipykernel",
                    path
                );
                // Publish the typed reason atomically. Don't call
                // reset_starting_state here — no runtime agent has spawned
                // yet on this path, and the auto-launch version in
                // notebook_sync_server/metadata.rs deliberately skips it
                // for the same reason. reset_starting_state writes
                // NotStarted first and releases the doc lock before our
                // Error write lands, giving a concurrent retry a window to
                // claim Resolving that we'd then clobber back to Error.
                let env_source_label = parsed_resolved.as_str().to_string();
                if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
                    room.state.with_doc(|sd| {
                        sd.set_lifecycle_with_error(
                            &RuntimeLifecycle::Error,
                            Some(KernelErrorReason::MissingIpykernel),
                        )?;
                        sd.set_kernel_info("python", "python", &env_source_label)?;
                        Ok(())
                    })
                }) {
                    warn!("[runtime-state] {}", e);
                }
                return NotebookResponse::Error {
                    error: "ipykernel not found in pixi.toml — run `pixi add ipykernel` in your project directory".to_string(),
                };
            }
        }
    }

    // For project-backed envs, promote any inline deps to the project
    // file before launching. This handles the case where add_dependency
    // wrote to CRDT metadata and then triggered a restart.
    if matches!(
        parsed_resolved,
        EnvSource::PixiToml | EnvSource::Pyproject | EnvSource::EnvYml
    ) {
        if let Some(ref snap) = metadata_snapshot {
            let has_inline = match parsed_resolved {
                EnvSource::PixiToml => snap
                    .runt
                    .pixi
                    .as_ref()
                    .is_some_and(|p| !p.dependencies.is_empty()),
                EnvSource::Pyproject => snap
                    .runt
                    .uv
                    .as_ref()
                    .is_some_and(|u| !u.dependencies.is_empty()),
                EnvSource::EnvYml => snap
                    .runt
                    .conda
                    .as_ref()
                    .is_some_and(|c| !c.dependencies.is_empty()),
                _ => false,
            };
            if has_inline {
                // Build a minimal launched config with project paths for promotion
                let mut promo_config = notebook_protocol::protocol::LaunchedEnvConfig::default();
                if matches!(parsed_resolved, EnvSource::PixiToml) {
                    promo_config.pixi_toml_path = notebook_path.as_ref().and_then(|p| {
                        crate::project_file::detect_project_file(p)
                            .filter(|d| d.kind == crate::project_file::ProjectFileKind::PixiToml)
                            .map(|d| d.path)
                    });
                    // Launched baseline = current pixi.toml deps (before promotion)
                    if let Some(ref path) = promo_config.pixi_toml_path {
                        if let Ok(content) = std::fs::read_to_string(path) {
                            promo_config.pixi_toml_deps = Some(extract_pixi_toml_deps(&content));
                        }
                    }
                } else if matches!(parsed_resolved, EnvSource::EnvYml) {
                    promo_config.environment_yml_path = notebook_path.as_ref().and_then(|p| {
                        crate::project_file::find_nearest_project_file(
                            p,
                            &[crate::project_file::ProjectFileKind::EnvironmentYml],
                        )
                        .map(|d| d.path)
                    });
                    // Launched baseline = current env.yml deps (before promotion)
                    if let Some(ref path) = promo_config.environment_yml_path {
                        if let Ok(env_config) = crate::project_file::parse_environment_yml(path) {
                            let mut deps = env_config.dependencies;
                            deps.sort();
                            promo_config.environment_yml_deps = Some(deps);
                        }
                    }
                } else {
                    promo_config.pyproject_path = notebook_path.as_ref().and_then(|p| {
                        crate::project_file::detect_project_file(p)
                            .filter(|d| {
                                d.kind == crate::project_file::ProjectFileKind::PyprojectToml
                            })
                            .map(|d| d.path)
                    });
                }
                match promote_inline_deps_to_project(
                    room,
                    resolved_env_source.as_str(),
                    &promo_config,
                )
                .await
                {
                    Ok(promoted) if !promoted.is_empty() => {
                        info!(
                            "[notebook-sync] Promoted deps to project file: {:?}",
                            promoted
                        );
                        // Re-read metadata snapshot after CRDT was updated
                        metadata_snapshot =
                            resolve_metadata_snapshot(room, notebook_path.as_deref()).await;
                    }
                    Err(e) => {
                        warn!("[notebook-sync] Failed to promote deps: {}", e);
                    }
                    _ => {}
                }
            }
        }
    }

    // Transition to "preparing_env" phase
    if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
    }) {
        warn!("[runtime-state] {}", e);
    }

    // Deno kernels don't need pooled environments
    let pooled_env = if resolved_kernel_type == "deno" {
        info!("[notebook-sync] LaunchKernel: Deno kernel (no pooled env)");
        None
    } else {
        // Python kernels require pooled environment
        match resolved_env_source.as_str() {
            "uv:prewarmed" | "conda:prewarmed" => {
                // Route through the capture-aware acquirer so:
                //  - Reopen path: if metadata has env_id + captured
                //    deps and the unified-hash env exists on disk,
                //    we cache-hit instead of taking from the pool.
                //  - First-launch path: take from pool, strip base,
                //    claim into `{cache}/{unified_hash}/`, write
                //    captured deps + env_id back into metadata.
                //
                // Without this, a manual LaunchKernel after capture
                // would take a fresh pool env instead of reusing
                // the claimed one, leaking envs and bypassing drift
                // detection's "captured baseline" logic.
                match acquire_prewarmed_env_with_capture(
                    resolved_env_source.as_str(),
                    daemon,
                    room,
                    metadata_snapshot.as_ref(),
                )
                .await
                {
                    Ok(Some(env)) => {
                        info!(
                            "[notebook-sync] LaunchKernel: acquired {} env: {:?}",
                            resolved_env_source.as_str(),
                            env.python_path
                        );
                        // Set the active runtime owner now so the env is
                        // protected by `runtime_agent_env_path` through
                        // the rest of the launch flow. (The pool lease
                        // was already released inside
                        // `acquire_prewarmed_env_with_capture`.)
                        let mut ep = room.runtime_agent_env_path.write().await;
                        *ep = Some(env.venv_path.clone());
                        drop(ep);
                        Some(env)
                    }
                    Ok(None) => None,
                    Err(()) => {
                        let error = format!(
                            "{} pool empty - no environment available",
                            if matches!(parsed_resolved, EnvSource::Prewarmed(PackageManager::Uv)) {
                                "UV"
                            } else {
                                "Conda"
                            }
                        );
                        let details = format!(
                            "Failed to acquire prewarmed environment for {}. {error}",
                            parsed_resolved.as_str(),
                        );
                        reset_starting_state(room, None).await;
                        publish_environment_launch_error(
                            room,
                            parsed_resolved.as_str(),
                            Some(KernelErrorReason::EnvironmentPrepareFailed),
                            &details,
                        );
                        return NotebookResponse::Error { error };
                    }
                }
            }
            "uv:pyproject" | "uv:inline" | "uv:pep723" | "conda:inline" | "conda:env_yml"
            | "pixi:toml" | "pixi:inline" | "pixi:pep723" => {
                // These sources prepare their own environments, no pooled env needed
                info!(
                    "[notebook-sync] LaunchKernel: {} prepares its own env, no pool env",
                    resolved_env_source
                );
                None
            }
            other => {
                // For remaining conda sources, route to conda pool. Set
                // runtime_agent_env_path BEFORE releasing the lease so the
                // env is never momentarily unprotected.
                let (env, guard) = if other.starts_with("conda:") {
                    match daemon.take_conda_env().await {
                        Some(taken) => taken,
                        None => {
                            reset_starting_state(room, None).await;
                            return NotebookResponse::Error {
                                error: "Conda pool empty".to_string(),
                            };
                        }
                    }
                } else {
                    // Prewarmed UV
                    match daemon.take_uv_env().await {
                        Some(taken) => taken,
                        None => {
                            reset_starting_state(room, None).await;
                            return NotebookResponse::Error {
                                error: "UV pool empty".to_string(),
                            };
                        }
                    }
                };
                {
                    let mut ep = room.runtime_agent_env_path.write().await;
                    *ep = Some(env.venv_path.clone());
                }
                guard.release().await;
                Some(env)
            }
        }
    };

    // For inline deps, prepare a cached environment with rich progress
    let launch_progress_handler: std::sync::Arc<dyn kernel_env::ProgressHandler> =
        std::sync::Arc::new(
            crate::inline_env::RuntimeDocProgressHandler::new_for_launch(
                room.state.clone(),
                room.current_launch_cancellation_receiver(),
            ),
        );

    // Fetch feature flags up front so inline cache hits can refresh vendored
    // launcher files when bootstrap_dx is active.
    let feature_flags_for_inline = daemon.feature_flags().await;
    let bootstrap_dx = feature_flags_for_inline.bootstrap_dx;

    let (pooled_env, inline_deps) = if matches!(
        parsed_resolved,
        EnvSource::Pep723(PackageManager::Uv)
    ) {
        // Extract PEP 723 deps from cell source
        let cells = room.doc.read().await.get_cells();
        let pep723_deps = match notebook_doc::pep723::find_pep723_in_cells(&cells) {
            Ok(Some(m)) if !m.dependencies.is_empty() => Some(m.dependencies),
            Ok(_) => None,
            Err(e) => {
                error!(
                    "[notebook-sync] Invalid PEP 723 metadata in notebook: {}",
                    e
                );
                let details = format!("Invalid PEP 723 metadata in notebook: {}", e);
                reset_starting_state(room, None).await;
                publish_environment_launch_error(
                    room,
                    parsed_resolved.as_str(),
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    &details,
                );
                return NotebookResponse::Error { error: details };
            }
        };

        if let Some(deps) = pep723_deps {
            info!(
                "[notebook-sync] LaunchKernel: Preparing cached UV env for PEP 723 deps: {:?}",
                deps
            );
            match crate::inline_env::prepare_uv_inline_env(
                &deps,
                None,
                None,
                launch_progress_handler.clone(),
            )
            .await
            {
                Ok(prepared) => {
                    info!(
                        "[notebook-sync] LaunchKernel: Using cached PEP 723 env at {:?}",
                        prepared.python_path
                    );
                    let env = Some(crate::PooledEnv {
                        env_type: crate::EnvType::Uv,
                        venv_path: prepared.env_path,
                        python_path: prepared.python_path,
                        prewarmed_packages: vec![],
                    });
                    (env, Some(deps))
                }
                Err(e) => {
                    error!("[notebook-sync] Failed to prepare PEP 723 env: {}", e);
                    let details = format!("Failed to prepare PEP 723 environment: {}", e);
                    reset_starting_state(room, None).await;
                    publish_environment_launch_error(
                        room,
                        parsed_resolved.as_str(),
                        Some(KernelErrorReason::EnvironmentPrepareFailed),
                        &details,
                    );
                    return NotebookResponse::Error { error: details };
                }
            }
        } else {
            let details =
                "No PEP 723 dependencies found in notebook cells for requested env_source \"uv:pep723\"";
            reset_starting_state(room, None).await;
            publish_environment_launch_error(
                room,
                parsed_resolved.as_str(),
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                details,
            );
            return NotebookResponse::Error {
                error: details.to_string(),
            };
        }
    } else if matches!(parsed_resolved, EnvSource::Inline(PackageManager::Uv)) {
        if let Some(deps) = metadata_snapshot.as_ref().and_then(get_inline_uv_deps) {
            let prerelease = metadata_snapshot
                .as_ref()
                .and_then(get_inline_uv_prerelease);
            let requires_python = metadata_snapshot
                .as_ref()
                .and_then(get_inline_uv_requires_python);

            // Fast path: check inline env cache first (instant on hit).
            // `check_uv_inline_cache` re-vendors the launcher on hit when
            // bootstrap_dx is on, so stale pre-0.2.0 envs are brought up
            // to today's layout before the kernel boots.
            if let Some(cached) = crate::inline_env::check_uv_inline_cache(
                &deps,
                requires_python.as_deref(),
                prerelease.as_deref(),
                bootstrap_dx,
            )
            .await
            {
                info!(
                    "[notebook-sync] LaunchKernel: UV inline cache hit at {:?}",
                    cached.python_path
                );
                let env = Some(crate::PooledEnv {
                    env_type: crate::EnvType::Uv,
                    venv_path: cached.env_path,
                    python_path: cached.python_path,
                    prewarmed_packages: vec![],
                });
                (env, Some(deps))
            } else if prerelease.is_none() {
                // Try pool reuse for bare deps without prerelease
                match try_uv_pool_for_inline_deps(
                    &deps,
                    requires_python.as_deref(),
                    daemon,
                    room,
                    launch_progress_handler.clone(),
                )
                .await
                {
                    Ok((env, pool_pkgs)) => {
                        let mut pooled = env;
                        pooled.prewarmed_packages = pool_pkgs;
                        (Some(pooled), Some(deps))
                    }
                    Err(_) => {
                        // Pool path failed, fall back to full build
                        info!(
                            "[notebook-sync] LaunchKernel: Preparing cached UV env for inline deps: {:?}",
                            deps
                        );
                        match crate::inline_env::prepare_uv_inline_env(
                            &deps,
                            requires_python.as_deref(),
                            prerelease.as_deref(),
                            launch_progress_handler.clone(),
                        )
                        .await
                        {
                            Ok(prepared) => {
                                let env = Some(crate::PooledEnv {
                                    env_type: crate::EnvType::Uv,
                                    venv_path: prepared.env_path,
                                    python_path: prepared.python_path,
                                    prewarmed_packages: vec![],
                                });
                                (env, Some(deps))
                            }
                            Err(e) => {
                                let details =
                                    format!("Failed to prepare inline environment: {}", e);
                                reset_starting_state(room, None).await;
                                publish_environment_launch_error(
                                    room,
                                    parsed_resolved.as_str(),
                                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                                    &details,
                                );
                                return NotebookResponse::Error { error: details };
                            }
                        }
                    }
                }
            } else {
                // Has prerelease — can't use pool, go straight to full build
                info!(
                    "[notebook-sync] LaunchKernel: Preparing cached UV env for inline deps: {:?} (prerelease: {:?})",
                    deps, prerelease
                );
                match crate::inline_env::prepare_uv_inline_env(
                    &deps,
                    requires_python.as_deref(),
                    prerelease.as_deref(),
                    launch_progress_handler.clone(),
                )
                .await
                {
                    Ok(prepared) => {
                        let env = Some(crate::PooledEnv {
                            env_type: crate::EnvType::Uv,
                            venv_path: prepared.env_path,
                            python_path: prepared.python_path,
                            prewarmed_packages: vec![],
                        });
                        (env, Some(deps))
                    }
                    Err(e) => {
                        let details = format!("Failed to prepare inline environment: {}", e);
                        reset_starting_state(room, None).await;
                        publish_environment_launch_error(
                            room,
                            parsed_resolved.as_str(),
                            Some(KernelErrorReason::EnvironmentPrepareFailed),
                            &details,
                        );
                        return NotebookResponse::Error { error: details };
                    }
                }
            }
        } else {
            (pooled_env, None)
        }
    } else if matches!(parsed_resolved, EnvSource::Inline(PackageManager::Conda)) {
        if let Some(deps) = metadata_snapshot.as_ref().and_then(get_inline_conda_deps) {
            let channels = metadata_snapshot
                .as_ref()
                .map(get_inline_conda_channels)
                .unwrap_or_else(|| vec!["conda-forge".to_string()]);
            let python = metadata_snapshot.as_ref().and_then(get_inline_conda_python);
            let python = python.as_deref();

            // Fast path: check inline env cache first (instant on hit)
            if let Some(cached) =
                crate::inline_env::check_conda_inline_cache(&deps, &channels, python)
            {
                info!(
                    "[notebook-sync] LaunchKernel: Conda inline cache hit at {:?}",
                    cached.python_path
                );
                let env = Some(crate::PooledEnv {
                    env_type: crate::EnvType::Conda,
                    venv_path: cached.env_path,
                    python_path: cached.python_path,
                    prewarmed_packages: vec![],
                });
                (env, Some(deps))
            } else {
                // Try pool reuse (only for default conda-forge channel)
                match try_conda_pool_for_inline_deps(
                    &deps,
                    &channels,
                    python,
                    daemon,
                    room,
                    launch_progress_handler.clone(),
                )
                .await
                {
                    Ok((env, pool_pkgs)) => {
                        let mut pooled = env;
                        pooled.prewarmed_packages = pool_pkgs;
                        (Some(pooled), Some(deps))
                    }
                    Err(_) => {
                        // Pool path failed, fall back to full build
                        info!(
                            "[notebook-sync] LaunchKernel: Preparing cached Conda env for inline deps: {:?} (channels: {:?})",
                            deps, channels
                        );
                        match crate::inline_env::prepare_conda_inline_env(
                            &deps,
                            &channels,
                            python,
                            launch_progress_handler.clone(),
                        )
                        .await
                        {
                            Ok(prepared) => {
                                let env = Some(crate::PooledEnv {
                                    env_type: crate::EnvType::Conda,
                                    venv_path: prepared.env_path,
                                    python_path: prepared.python_path,
                                    prewarmed_packages: vec![],
                                });
                                (env, Some(deps))
                            }
                            Err(e) => {
                                let details =
                                    format!("Failed to prepare conda inline environment: {}", e);
                                reset_starting_state(room, None).await;
                                publish_environment_launch_error(
                                    room,
                                    parsed_resolved.as_str(),
                                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                                    &details,
                                );
                                return NotebookResponse::Error { error: details };
                            }
                        }
                    }
                }
            }
        } else {
            (pooled_env, None)
        }
    } else if matches!(parsed_resolved, EnvSource::EnvYml) {
        // conda:env_yml: find or create a named conda env from environment.yml.
        // Uses standard conda env discovery: name: field → search conda env dirs,
        // prefix: field → use that path directly. Falls back to creating via rattler.
        let yml_path = notebook_path.as_ref().and_then(|p| {
            crate::project_file::find_nearest_project_file(
                p,
                &[crate::project_file::ProjectFileKind::EnvironmentYml],
            )
            .map(|d| d.path)
        });

        if let Some(ref yml) = yml_path {
            match crate::project_file::parse_environment_yml(yml) {
                Ok(env_config) => {
                    let detected_yml = crate::project_file::DetectedProjectFile {
                        path: yml.clone(),
                        kind: crate::project_file::ProjectFileKind::EnvironmentYml,
                    };
                    if let Some(decision) = missing_conda_env_yml_decision(&detected_yml) {
                        if project_environment_build_approved(room, &detected_yml) {
                            info!(
                                "[notebook-sync] Approved environment.yml build for {:?}; continuing launch",
                                detected_yml.path
                            );
                        } else {
                            let details = format_conda_env_yml_build_details(&decision);
                            warn!("[notebook-sync] {}", details);
                            if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
                                room.state.with_doc(|sd| {
                                    sd.set_lifecycle_with_error_details(
                                        &RuntimeLifecycle::AwaitingEnvBuild,
                                        Some(KernelErrorReason::CondaEnvYmlMissing),
                                        Some(&details),
                                    )
                                })
                            }) {
                                warn!("[runtime-state] {}", e);
                            }
                            return NotebookResponse::Error { error: details };
                        }
                    }

                    // Resolve the conda prefix: prefix: → direct path,
                    // name: → search standard dirs, create if not found.
                    // Track whether the env is daemon-owned (safe to
                    // auto-rebuild) vs. user-managed (prefix: field or
                    // pre-existing named env).
                    let (conda_prefix, is_daemon_owned_env) = if let Some(ref prefix) =
                        env_config.prefix
                    {
                        // Explicit prefix: path from environment.yml — user-managed
                        (prefix.clone(), false)
                    } else if let Some(ref name) = env_config.name {
                        match crate::project_file::find_named_conda_env(name) {
                            Some(found) => (found, false), // Pre-existing user env
                            None => (
                                crate::project_file::default_conda_envs_dir().join(name),
                                true,
                            ),
                        }
                    } else {
                        // No name or prefix — use a hash-based env in cache
                        let cache_dir = crate::paths::default_cache_dir().join("conda-envs");
                        let conda_deps_tmp = kernel_env::CondaDependencies {
                            dependencies: env_config.dependencies.clone(),
                            channels: env_config.channels.clone(),
                            python: env_config.python.clone(),
                            env_id: None,
                        };
                        (
                            cache_dir.join(kernel_env::conda::compute_env_hash(&conda_deps_tmp)),
                            true,
                        )
                    };

                    // Merge env.yml deps with any CRDT notebook deps (additive)
                    let mut all_deps = env_config.dependencies.clone();
                    if let Some(crdt_deps) =
                        metadata_snapshot.as_ref().and_then(get_inline_conda_deps)
                    {
                        let base_names: std::collections::HashSet<String> = all_deps
                            .iter()
                            .map(|d| notebook_doc::metadata::extract_package_name(d).to_lowercase())
                            .collect();
                        for dep in &crdt_deps {
                            let name =
                                notebook_doc::metadata::extract_package_name(dep).to_lowercase();
                            if !base_names.contains(&name) {
                                all_deps.push(dep.clone());
                            }
                        }
                    }

                    // Always include ipykernel and pip. pip is explicit so
                    // `%pip` installs into this prepared Conda environment.
                    let base_names: std::collections::HashSet<String> = all_deps
                        .iter()
                        .map(|d| notebook_doc::metadata::extract_package_name(d).to_lowercase())
                        .collect();
                    if !base_names.contains("ipykernel") {
                        all_deps.push("ipykernel".to_string());
                    }
                    if !base_names.contains("pip") {
                        all_deps.push("pip".to_string());
                    }

                    let channels = if env_config.channels.is_empty() {
                        vec!["conda-forge".to_string()]
                    } else {
                        env_config.channels.clone()
                    };

                    let env_name_display = env_config.name.as_deref().unwrap_or("<unnamed>");
                    info!(
                        "[notebook-sync] conda:env_yml: env '{}' at {:?} with {} deps",
                        env_name_display,
                        conda_prefix,
                        all_deps.len()
                    );

                    let conda_deps = kernel_env::CondaDependencies {
                        dependencies: all_deps,
                        channels,
                        python: env_config.python.clone(),
                        env_id: None,
                    };

                    let python_path = crate::project_file::conda_python_path(&conda_prefix);

                    // Check for Python version mismatch: if environment.yaml
                    // requests e.g. python=3.12 but the existing env has 3.14,
                    // the env needs rebuilding. Only auto-rebuild daemon-owned
                    // envs (cache/hash paths). For user-managed envs (prefix:
                    // field or pre-existing named env), surface an error.
                    let python_version_ok = if python_path.exists() {
                        if let Some(ref requested) = env_config.python {
                            let matches = kernel_env::conda::installed_python_matches_constraint(
                                &conda_prefix,
                                requested,
                            );
                            if !matches {
                                let installed = kernel_env::conda::detect_installed_python_version(
                                    &conda_prefix,
                                )
                                .unwrap_or_else(|| "unknown".to_string());
                                if is_daemon_owned_env {
                                    warn!(
                                        "[notebook-sync] conda:env_yml Python mismatch: \
                                         environment.yaml requests python={} but env has {}; \
                                         rebuilding daemon-owned env",
                                        requested, installed
                                    );
                                    if let Err(e) = tokio::fs::remove_dir_all(&conda_prefix).await {
                                        warn!(
                                            "[notebook-sync] Failed to remove mismatched env {:?}: {}",
                                            conda_prefix, e
                                        );
                                    }
                                    false
                                } else {
                                    let details = format!(
                                        "Conda env {:?} has Python {} but environment.yml \
                                         requests python={}. This is a user-managed env — \
                                         rebuild it manually with: conda env remove -n {} \
                                         && conda env create -f environment.yml",
                                        conda_prefix,
                                        installed,
                                        requested,
                                        env_config.name.as_deref().unwrap_or("<env>"),
                                    );
                                    reset_starting_state(room, None).await;
                                    publish_environment_launch_error(
                                        room,
                                        parsed_resolved.as_str(),
                                        None,
                                        &details,
                                    );
                                    return NotebookResponse::Error { error: details };
                                }
                            } else {
                                true
                            }
                        } else {
                            true // No python constraint → any version is fine
                        }
                    } else {
                        false // No existing env
                    };

                    let python_path = crate::project_file::conda_python_path(&conda_prefix);

                    if python_path.exists() && python_version_ok {
                        // Existing env with correct Python — sync deps into it
                        let conda_env = kernel_env::CondaEnvironment {
                            env_path: conda_prefix.clone(),
                            python_path: python_path.clone(),
                        };
                        if let Err(e) = kernel_env::conda::sync_dependencies(
                            &conda_env,
                            &conda_deps,
                            launch_progress_handler.clone(),
                        )
                        .await
                        {
                            let details =
                                format!("conda:env_yml sync into existing env failed: {}", e);
                            error!("[notebook-sync] {}", details);
                            reset_starting_state(room, None).await;
                            publish_environment_launch_error(
                                room,
                                parsed_resolved.as_str(),
                                Some(KernelErrorReason::CondaEnvBuildFailed),
                                &details,
                            );
                            return NotebookResponse::Error { error: details };
                        }
                        // Terminal phase so the banner clears. Matches the env_yml path in
                        // notebook_sync_server::metadata::auto_launch_kernel.
                        launch_progress_handler.on_progress(
                            "conda",
                            kernel_env::EnvProgressPhase::Ready {
                                env_path: conda_prefix.to_string_lossy().into_owned(),
                                python_path: python_path.to_string_lossy().into_owned(),
                            },
                        );
                        let env = Some(crate::PooledEnv {
                            env_type: crate::EnvType::Conda,
                            venv_path: conda_prefix,
                            python_path,
                            prewarmed_packages: vec![],
                        });
                        (
                            env,
                            metadata_snapshot.as_ref().and_then(get_inline_conda_deps),
                        )
                    } else {
                        // No existing env — create it via rattler at the target path.
                        // prepare_environment_in creates {cache_dir}/{hash}/, so we
                        // pass the parent and then rename to the target name.
                        let parent = conda_prefix
                            .parent()
                            .unwrap_or_else(|| std::path::Path::new("/tmp"));
                        if let Err(e) = tokio::fs::create_dir_all(parent).await {
                            let details = format!(
                                "Failed to create conda envs directory {:?}: {}",
                                parent, e
                            );
                            reset_starting_state(room, None).await;
                            publish_environment_launch_error(
                                room,
                                parsed_resolved.as_str(),
                                Some(KernelErrorReason::CondaEnvBuildFailed),
                                &details,
                            );
                            return NotebookResponse::Error { error: details };
                        }
                        match kernel_env::conda::prepare_environment_in(
                            &conda_deps,
                            parent,
                            launch_progress_handler.clone(),
                        )
                        .await
                        {
                            Ok(prepared) => {
                                // Rename hash-based dir to the target env name
                                let final_prefix = if prepared.env_path != conda_prefix {
                                    match tokio::fs::rename(&prepared.env_path, &conda_prefix).await
                                    {
                                        Ok(()) => conda_prefix.clone(),
                                        Err(e) => {
                                            warn!(
                                                "[notebook-sync] Failed to rename {:?} -> {:?}: {}, using hash path",
                                                prepared.env_path, conda_prefix, e
                                            );
                                            prepared.env_path
                                        }
                                    }
                                } else {
                                    prepared.env_path
                                };
                                let python = crate::project_file::conda_python_path(&final_prefix);
                                let env = Some(crate::PooledEnv {
                                    env_type: crate::EnvType::Conda,
                                    venv_path: final_prefix,
                                    python_path: python,
                                    prewarmed_packages: vec![],
                                });
                                (
                                    env,
                                    metadata_snapshot.as_ref().and_then(get_inline_conda_deps),
                                )
                            }
                            Err(e) => {
                                let details = format!(
                                    "Failed to create conda env '{}' from environment.yml: {}",
                                    env_name_display, e
                                );
                                reset_starting_state(room, None).await;
                                publish_environment_launch_error(
                                    room,
                                    parsed_resolved.as_str(),
                                    Some(KernelErrorReason::CondaEnvBuildFailed),
                                    &details,
                                );
                                return NotebookResponse::Error { error: details };
                            }
                        }
                    }
                }
                Err(e) => {
                    let details = format!("Failed to parse environment.yml: {}", e);
                    reset_starting_state(room, None).await;
                    publish_environment_launch_error(
                        room,
                        parsed_resolved.as_str(),
                        Some(KernelErrorReason::EnvironmentPrepareFailed),
                        &details,
                    );
                    return NotebookResponse::Error { error: details };
                }
            }
        } else {
            let details = "conda:env_yml requested but no environment.yml was found";
            warn!("[notebook-sync] {}", details);
            reset_starting_state(room, None).await;
            publish_environment_launch_error(
                room,
                parsed_resolved.as_str(),
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                details,
            );
            return NotebookResponse::Error {
                error: details.to_string(),
            };
        }
    } else if matches!(parsed_resolved, EnvSource::Inline(PackageManager::Pixi)) {
        // pixi exec handles its own caching — just extract deps for -w flags
        let deps = metadata_snapshot
            .as_ref()
            .and_then(|s| s.runt.pixi.as_ref())
            .map(|p| p.dependencies.clone())
            .unwrap_or_default();
        let deps = crate::inline_env::inline_deps_with_conda_required_packages(&deps);
        if !deps.is_empty() {
            info!(
                "[notebook-sync] LaunchKernel: pixi:inline deps for pixi exec: {:?}",
                deps
            );
            (None, Some(deps))
        } else {
            (pooled_env, None)
        }
    } else if matches!(parsed_resolved, EnvSource::Pep723(PackageManager::Pixi)) {
        // PEP 723 deps via pixi exec -w
        let cells = room.doc.read().await.get_cells();
        match notebook_doc::pep723::find_pep723_in_cells(&cells) {
            Ok(Some(meta)) if !meta.dependencies.is_empty() => {
                let deps =
                    crate::inline_env::inline_deps_with_conda_required_packages(&meta.dependencies);
                info!("[notebook-sync] LaunchKernel: pixi:pep723 deps: {:?}", deps);
                (None, Some(deps))
            }
            _ => (pooled_env, None),
        }
    } else {
        (pooled_env, None)
    };

    let mut uv_pyproject_offline = false;
    let mut pixi_toml_frozen = false;
    if matches!(parsed_resolved, EnvSource::Pyproject) {
        match crate::uv_project::prepare_uv_pyproject_environment(
            notebook_path.as_deref(),
            bootstrap_dx,
            launch_progress_handler.clone(),
        )
        .await
        {
            Ok(offline) => {
                uv_pyproject_offline = offline;
                if let Err(e) = room.state.with_doc(|sd| sd.clear_env_progress()) {
                    warn!("[runtime-state] {}", e);
                }
            }
            Err(e) => {
                let details = format!("Failed to prepare UV project environment: {e}");
                error!("[notebook-sync] {}", details);
                reset_starting_state(room, None).await;
                publish_environment_launch_error(
                    room,
                    parsed_resolved.as_str(),
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    &details,
                );
                return NotebookResponse::Error { error: details };
            }
        }
    } else if matches!(parsed_resolved, EnvSource::PixiToml) {
        let outcome = crate::pixi_project::prepare_pixi_toml_environment(
            notebook_path.as_deref(),
            launch_progress_handler.clone(),
        )
        .await;
        // Always clear the `ProjectPreparing` env progress the probe may
        // have published; without this a successful fallback launch leaves
        // "preparing pixi" pinned in the UI after the kernel is idle.
        if let Err(e) = room.state.with_doc(|sd| sd.clear_env_progress()) {
            warn!("[runtime-state] {}", e);
        }
        match outcome {
            crate::pixi_project::PixiPrepareOutcome::SkipOrOnline => {}
            crate::pixi_project::PixiPrepareOutcome::Frozen => {
                pixi_toml_frozen = true;
            }
            crate::pixi_project::PixiPrepareOutcome::OfflineUnrecoverable(e) => {
                let details = format!("Failed to prepare pixi:toml environment: {e}");
                error!("[notebook-sync] {}", details);
                reset_starting_state(room, None).await;
                publish_environment_launch_error(
                    room,
                    parsed_resolved.as_str(),
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    &details,
                );
                return NotebookResponse::Error { error: details };
            }
        }
    }

    // Verify ipykernel is present in the prepared env before we launch.
    // Mirrors the auto-launch gate in `notebook_sync_server/metadata.rs`:
    // the LaunchKernel RPC serves the toolbar restart button,
    // restart-and-run-all, post-trust approval, and other retry paths,
    // so a stale cache or hand-edited venv must surface the typed
    // `MissingIpykernel` reason here too — otherwise retries silently
    // regress to a generic kernel spawn failure. Skipped env sources
    // match the auto-launch site (prewarmed pools, pixi:*, uv:pyproject,
    // conda:env_yml, deno); pixi:toml is gated earlier in this function.
    if matches!(
        parsed_resolved,
        EnvSource::Inline(PackageManager::Uv)
            | EnvSource::Inline(PackageManager::Conda)
            | EnvSource::Pep723(PackageManager::Uv)
    ) {
        if let Some(ref env) = pooled_env {
            let diagnostic = kernel_env::diagnose_ipykernel_async(&env.python_path).await;
            if !diagnostic.is_present() {
                warn!(
                    "[launch-kernel] prepared env at {:?} ({}) cannot import ipykernel: {:?}",
                    env.venv_path,
                    parsed_resolved.as_str(),
                    diagnostic
                );
                let (reason, details) = crate::ipykernel_error::classify_ipykernel_diagnostic(
                    &diagnostic,
                    parsed_resolved.as_str(),
                );
                // Don't delete the env dir: for inline/pep723 it's a
                // content-addressed cache shared across notebooks and
                // vulnerable to a racy nuke of a concurrent install.
                //
                // Tear down the existing runtime agent (if any) BEFORE
                // we write the Error lifecycle. This path can be
                // reached from a restart (prior_lifecycle == Running),
                // in which case an agent is still holding request/
                // response channels. Leaving them up while the UI
                // flips to Error leaves the notebook split-brained
                // (old kernel still executes; UI thinks start failed).
                // `reset_starting_state` first writes NotStarted and
                // clears agent handles; we then overwrite lifecycle
                // with Error + MissingIpykernel so the UI sees the
                // correct reason. Minor TOCTOU against a concurrent
                // retry is accepted — a second retry observing Error
                // will simply start a fresh launch.
                reset_starting_state(room, None).await;
                let env_source_label = parsed_resolved.as_str().to_string();
                if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
                    room.state.with_doc(|sd| {
                        sd.set_lifecycle_with_error_details(
                            &RuntimeLifecycle::Error,
                            Some(reason),
                            Some(&details),
                        )?;
                        sd.set_kernel_info("python", "python", &env_source_label)?;
                        Ok(())
                    })
                }) {
                    warn!("[runtime-state] {}", e);
                }
                return NotebookResponse::Error {
                    error: format!(
                        "ipykernel not found in prepared {} environment",
                        parsed_resolved.as_str()
                    ),
                };
            }
        }
    }

    // For prewarmed pool envs the active path was set above (right at
    // `transfer_to_runtime`); for inline / PEP 723 / env_yml flows that
    // built their own env, set it here so the env directory is in
    // `runtime_agent_env_path` before any further async work (agent spawn,
    // connect timeout).
    if let Some(ref env) = pooled_env {
        let mut ep = room.runtime_agent_env_path.write().await;
        *ep = Some(env.venv_path.clone());
    }

    // Build LaunchedEnvConfig to track what config the kernel was launched with.
    //
    // For captured-prewarmed launches, pass the captured deps through
    // `captured_env_for_config` so `build_launched_config` records them
    // as the launch baseline. That way drift detection treats the
    // launch as "tracking" and won't falsely report captured deps as
    // pending additions on every reopen (see P3 in the codex review).
    //
    // `captured_env_for_config` must match the *final* resolved env
    // source — if the user explicitly asked for e.g. `uv:inline` and
    // we routed through inline flow, don't drag captured prewarmed
    // baselines along.
    let venv_path = pooled_env.as_ref().map(|e| e.venv_path.clone());
    let python_path = pooled_env.as_ref().map(|e| e.python_path.clone());
    let prewarmed_pkgs = pooled_env.as_ref().map(|e| e.prewarmed_packages.clone());
    let feature_flags = feature_flags_for_inline;
    let captured_env_for_config = match resolved_env_source.as_str() {
        "uv:prewarmed" => {
            captured_env_for_runtime(metadata_snapshot.as_ref(), CapturedEnvRuntime::Uv)
                .filter(|c| captured_env_disk_state(c).is_captured_route())
        }
        "conda:prewarmed" => {
            captured_env_for_runtime(metadata_snapshot.as_ref(), CapturedEnvRuntime::Conda)
                .filter(|c| captured_env_disk_state(c).is_captured_route())
        }
        _ => None,
    };
    let launched_config = build_launched_config(
        &resolved_kernel_type,
        resolved_env_source.as_str(),
        inline_deps.as_deref(),
        metadata_snapshot.as_ref(),
        venv_path,
        python_path,
        prewarmed_pkgs.as_deref(),
        notebook_path.as_deref(),
        feature_flags,
        captured_env_for_config.as_ref(),
    );

    if launch_attempt
        .as_ref()
        .is_some_and(KernelLaunchAttempt::is_cancelled)
    {
        return NotebookResponse::Error {
            error: "Kernel launch cancelled by ShutdownKernel".to_string(),
        };
    }

    // Transition to "launching" phase before starting the kernel process
    if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
    }) {
        warn!("[runtime-state] {}", e);
    }
    let redact_env_values_in_outputs = daemon.redact_env_values_in_outputs().await;
    let import_shell_environment = daemon.import_shell_environment().await;
    let shell_overlay = daemon.shell_env_overlay();

    // If runtime agent is already connected, restart kernel in-place
    // (handles the shutdown → launch sequence without subprocess respawn).
    // The overlay is re-evaluated per launch so the toggle takes effect on
    // the next restart without respawning the runtime-agent process.
    {
        let existing_runtime_agent_id = room.current_runtime_agent_id.read().await.clone();
        let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
        if has_runtime_agent {
            info!("[notebook-sync] Agent connected — sending RestartKernel");
            // Precedence: overlay (lowest) → uv → pixi (highest), so daemon-required
            // vars always win over imported shell values.
            let mut restart_env_vars: std::collections::HashMap<String, String> =
                if import_shell_environment {
                    overlay_env_vars(&shell_overlay)
                } else {
                    std::collections::HashMap::new()
                };
            restart_env_vars.extend(crate::uv_project::uv_offline_env_vars(uv_pyproject_offline));
            restart_env_vars.extend(crate::pixi_project::pixi_frozen_env_vars(pixi_toml_frozen));
            match send_runtime_agent_request_with_captured_env_repair(
                room,
                captured_env_for_config.as_ref(),
                |kernel_ports| notebook_protocol::protocol::RuntimeAgentRequest::RestartKernel {
                    kernel_type: resolved_kernel_type.clone(),
                    env_source: resolved_env_source.clone(),
                    notebook_path: notebook_path
                        .as_deref()
                        .map(|p| p.to_str().unwrap_or("").to_string()),
                    launched_config: launched_config.clone(),
                    kernel_ports,
                    env_vars: restart_env_vars.clone(),
                    redact_env_values_in_outputs,
                },
            )
            .await
            {
                Ok(notebook_protocol::protocol::RuntimeAgentResponse::KernelRestarted {
                    env_source: es,
                }) => {
                    let Some(runtime_agent_id) = existing_runtime_agent_id else {
                        let details = "Kernel restarted without a current runtime agent";
                        if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
                            room.state.with_doc(|sd| {
                                sd.set_lifecycle_with_error_details(
                                    &RuntimeLifecycle::Error,
                                    None,
                                    Some(details),
                                )
                            })
                        }) {
                            warn!("[runtime-state] {}", e);
                        }
                        return NotebookResponse::Error {
                            error: details.to_string(),
                        };
                    };
                    if !room.is_current_runtime_agent(&runtime_agent_id).await {
                        let details = "Kernel restart was superseded by a newer runtime agent";
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details,
                            },
                        )
                        .await;
                        return NotebookResponse::Error {
                            error: details.to_string(),
                        };
                    }
                    if let Err(response) = complete_manual_launch(
                        room,
                        &mut launch_attempt,
                        &runtime_agent_id,
                        &resolved_kernel_type,
                        &es,
                        &launched_config,
                    )
                    .await
                    {
                        return response;
                    }

                    return NotebookResponse::KernelLaunched {
                        kernel_type: resolved_kernel_type,
                        env_source: es,
                        launched_config,
                    };
                }
                Ok(
                    notebook_protocol::protocol::RuntimeAgentResponse::Error { error }
                    | notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunchFailed {
                        error,
                        ..
                    },
                ) => {
                    reset_starting_state(room, existing_runtime_agent_id.as_deref()).await;
                    return NotebookResponse::Error {
                        error: format!("Agent restart failed: {}", error),
                    };
                }
                Ok(_) => {
                    reset_starting_state(room, existing_runtime_agent_id.as_deref()).await;
                    return NotebookResponse::Error {
                        error: "Unexpected runtime agent response to RestartKernel".to_string(),
                    };
                }
                Err(e) => {
                    warn!(
                        "[notebook-sync] RestartKernel RPC failed: {} — spawning new runtime agent",
                        e
                    );
                    // Fall through to spawn new runtime agent below
                }
            }
        }
    }

    // Spawn runtime agent subprocess for kernel execution
    {
        info!("[notebook-sync] Spawning runtime agent subprocess");

        // Always pass the room UUID so the agent's RuntimeAgent
        // handshake finds the room in the UUID-keyed rooms map.
        let notebook_id = room.id.to_string();
        let runtime_agent_id = format!("runtime-agent:{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let socket_path = daemon.socket_path().clone();

        // Set provenance + bump generation + create oneshot BEFORE spawn
        // (see auto_launch_kernel for ordering rationale).
        let agent_expected = {
            let mut id = room.current_runtime_agent_id.write().await;
            if launch_attempt
                .as_ref()
                .is_some_and(|attempt| attempt.expect_runtime_agent(&runtime_agent_id))
            {
                *id = Some(runtime_agent_id.clone());
                true
            } else {
                false
            }
        };
        if !agent_expected
            || launch_attempt
                .as_ref()
                .is_some_and(KernelLaunchAttempt::is_cancelled)
        {
            reset_starting_state(room, None).await;
            return NotebookResponse::Error {
                error: "Kernel launch cancelled before runtime agent spawn".to_string(),
            };
        }
        room.runtime_agent_generation
            .fetch_add(1, Ordering::Release);
        let runtime_agent_connect_rx = {
            let (tx, rx) = oneshot::channel();
            let mut guard = room.pending_runtime_agent_connect_tx.lock().await;
            *guard = Some(tx);
            rx
        };

        let spawn_result = tokio::select! {
            biased;
            _ = crate::notebook_sync_server::wait_for_kernel_launch_cancellation(
                launch_attempt
                    .as_ref()
                    .expect("manual launch attempt must be owned")
                    .cancellation_receiver(),
            ) => {
                launch_attempt
                    .as_ref()
                    .expect("manual launch attempt must be owned")
                    .discard_cancelled_runtime_agent(&runtime_agent_id)
                    .await;
                return NotebookResponse::Error {
                    error: "Kernel launch cancelled while spawning runtime agent".to_string(),
                };
            }
            result = crate::runtime_agent_handle::RuntimeAgentHandle::spawn(
                notebook_id,
                runtime_agent_id.clone(),
                room.blob_store.root().to_path_buf(),
                socket_path,
                daemon.config.runtime_agent_exe.clone(),
            ) => result,
        };

        match spawn_result {
            Ok(ra) => {
                {
                    let mut ra_guard = room.runtime_agent_handle.lock().await;
                    *ra_guard = Some(ra);
                }
                if launch_attempt
                    .as_ref()
                    .is_some_and(KernelLaunchAttempt::is_cancelled)
                {
                    launch_attempt
                        .as_ref()
                        .expect("manual launch attempt must be owned")
                        .discard_cancelled_runtime_agent(&runtime_agent_id)
                        .await;
                    return NotebookResponse::Error {
                        error: "Kernel launch cancelled after runtime agent spawn".to_string(),
                    };
                }

                // Connecting lifecycle — fills the gap between spawn and connect
                if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
                    room.state
                        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Connecting))
                }) {
                    warn!("[runtime-state] {}", e);
                }

                // Wait for THIS runtime agent to connect back via socket
                let connect_result = tokio::select! {
                    biased;
                    _ = crate::notebook_sync_server::wait_for_kernel_launch_cancellation(
                        launch_attempt
                            .as_ref()
                            .expect("manual launch attempt must be owned")
                            .cancellation_receiver(),
                    ) => {
                        launch_attempt
                            .as_ref()
                            .expect("manual launch attempt must be owned")
                            .discard_cancelled_runtime_agent(&runtime_agent_id)
                            .await;
                        return NotebookResponse::Error {
                            error: "Kernel launch cancelled while waiting for runtime agent connection".to_string(),
                        };
                    }
                    result = recv_oneshot_with_timeout(
                        runtime_agent_connect_rx,
                        std::time::Duration::from_secs(30),
                    ) => result,
                };
                match connect_result {
                    TimedOneShot::Received(()) => {}
                    TimedOneShot::SenderDropped => {
                        reset_starting_state(room, Some(&runtime_agent_id)).await;
                        return NotebookResponse::Error {
                            error: "Runtime agent connect cancelled (superseded or died)"
                                .to_string(),
                        };
                    }
                    TimedOneShot::TimedOut => {
                        reset_starting_state(room, Some(&runtime_agent_id)).await;
                        return NotebookResponse::Error {
                            error: "Agent failed to connect within 30s".to_string(),
                        };
                    }
                }

                if launch_attempt
                    .as_ref()
                    .is_some_and(KernelLaunchAttempt::is_cancelled)
                {
                    launch_attempt
                        .as_ref()
                        .expect("manual launch attempt must be owned")
                        .discard_cancelled_runtime_agent(&runtime_agent_id)
                        .await;
                    return NotebookResponse::Error {
                        error: "Kernel launch cancelled before LaunchKernel RPC".to_string(),
                    };
                }

                // Send LaunchKernel RPC. Same precedence as the restart path
                // above: overlay (lowest) → uv → pixi (highest).
                let mut launch_env_vars: std::collections::HashMap<String, String> =
                    if import_shell_environment {
                        overlay_env_vars(&shell_overlay)
                    } else {
                        std::collections::HashMap::new()
                    };
                launch_env_vars
                    .extend(crate::uv_project::uv_offline_env_vars(uv_pyproject_offline));
                launch_env_vars.extend(crate::pixi_project::pixi_frozen_env_vars(pixi_toml_frozen));
                match send_runtime_agent_request_with_captured_env_repair(
                    room,
                    captured_env_for_config.as_ref(),
                    |kernel_ports| notebook_protocol::protocol::RuntimeAgentRequest::LaunchKernel {
                        kernel_type: resolved_kernel_type.clone(),
                        env_source: resolved_env_source.clone(),
                        notebook_path: notebook_path
                            .as_deref()
                            .map(|p| p.to_str().unwrap_or("").to_string()),
                        launched_config: launched_config.clone(),
                        kernel_ports,
                        env_vars: launch_env_vars.clone(),
                        redact_env_values_in_outputs,
                    },
                )
                .await
                {
                    Ok(notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunched {
                        env_source: es,
                    }) => {
                        if !room.is_current_runtime_agent(&runtime_agent_id).await {
                            let details = "Kernel launch was superseded by a newer runtime agent";
                            reset_starting_state_with_outcome(
                                room,
                                Some(&runtime_agent_id),
                                ResetOutcome::Error {
                                    reason: None,
                                    details,
                                },
                            )
                            .await;
                            return NotebookResponse::Error {
                                error: details.to_string(),
                            };
                        }
                        if let Err(response) = complete_manual_launch(
                            room,
                            &mut launch_attempt,
                            &runtime_agent_id,
                            &resolved_kernel_type,
                            &es,
                            &launched_config,
                        )
                        .await
                        {
                            return response;
                        }

                        NotebookResponse::KernelLaunched {
                            kernel_type: resolved_kernel_type,
                            env_source: es,
                            launched_config,
                        }
                    }
                    Ok(
                        notebook_protocol::protocol::RuntimeAgentResponse::Error { error }
                        | notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunchFailed {
                            error,
                            ..
                        },
                    ) => {
                        // Mirror the response into CRDT so UIs that
                        // watch RuntimeStateDoc (not the RPC reply)
                        // also see the failure.
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details: &error,
                            },
                        )
                        .await;
                        NotebookResponse::Error {
                            error: format!("Agent kernel launch failed: {}", error),
                        }
                    }
                    Ok(_) => {
                        let msg = "Unexpected runtime agent response";
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details: msg,
                            },
                        )
                        .await;
                        NotebookResponse::Error {
                            error: msg.to_string(),
                        }
                    }
                    Err(e) => {
                        let details = format!("Agent communication error: {e}");
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details: &details,
                            },
                        )
                        .await;
                        NotebookResponse::Error { error: details }
                    }
                }
            }
            Err(e) => {
                let details = format!("Failed to spawn runtime agent: {e}");
                reset_starting_state_with_outcome(
                    room,
                    None,
                    ResetOutcome::Error {
                        reason: None,
                        details: &details,
                    },
                )
                .await;
                NotebookResponse::Error { error: details }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::{AutoLaunchAdmission, ManualLaunchAdmission, NotebookRoom};

    fn test_room() -> (tempfile::TempDir, Arc<NotebookRoom>) {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        (tmp, room)
    }

    #[tokio::test(start_paused = true)]
    async fn auto_launch_gate_completion_unblocks_stale_lifecycle_projection() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();

        let waiter = tokio::spawn({
            let room = Arc::clone(&room);
            async move { wait_for_launch_generation(&room, 1).await }
        });
        tokio::task::yield_now().await;

        assert!(attempt.succeed().is_ok());
        let later_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("later auto-launch should be admitted"),
        };
        later_attempt.release_without_cooldown();
        tokio::time::advance(std::time::Duration::from_millis(101)).await;

        assert_eq!(waiter.await.unwrap(), KernelLaunchCompletion::Succeeded);
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Launching,
            "the regression requires completion to be independent of the CRDT projection"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn joined_waiter_follows_successor_after_benign_release() {
        let (_tmp, room) = test_room();
        let first = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("first auto-launch should be admitted"),
        };
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();
        let waiter = tokio::spawn({
            let room = Arc::clone(&room);
            async move { wait_for_launch_generation(&room, 1).await }
        });
        tokio::task::yield_now().await;

        first.release_without_cooldown();
        let successor = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("successor auto-launch should be admitted"),
        };
        assert!(successor.succeed().is_ok());
        tokio::time::advance(std::time::Duration::from_millis(101)).await;

        assert_eq!(waiter.await.unwrap(), KernelLaunchCompletion::Succeeded);
    }

    #[tokio::test]
    async fn existing_kernel_response_reuses_active_launch() {
        let (_tmp, room) = test_room();
        let launched_config = notebook_protocol::protocol::LaunchedEnvConfig {
            launch_id: Some("launch-1".to_string()),
            ..Default::default()
        };
        *room.runtime_agent_launched_config.write().await = Some(launched_config.clone());
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "agent-1".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );

        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
            .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        let response = existing_kernel_response(&room).await.unwrap();
        match response {
            NotebookResponse::KernelAlreadyRunning {
                kernel_type,
                env_source,
                launched_config: actual_config,
            } => {
                assert_eq!(kernel_type, "python");
                assert_eq!(env_source, EnvSource::Prewarmed(PackageManager::Uv));
                assert_eq!(actual_config, launched_config);
            }
            other => panic!("expected existing-kernel response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn terminal_lifecycle_rejects_response_without_projection_driven_clear() {
        let (_tmp, room) = test_room();
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "agent-1".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Error))
            .unwrap();

        assert!(existing_kernel_response(&room).await.is_none());
        assert!(room.active_kernel_launch().is_some());
    }

    #[tokio::test]
    async fn stale_agent_cleanup_preserves_replacement_launch() {
        let (_tmp, room) = test_room();
        *room.current_runtime_agent_id.write().await = Some("replacement-agent".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "replacement-agent".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );

        assert!(
            !room
                .record_active_kernel_launch_if_current(
                    "stale-agent".to_string(),
                    "deno".to_string(),
                    EnvSource::Deno,
                )
                .await
        );

        room.clear_active_kernel_launch_if_agent("stale-agent");

        assert_eq!(
            room.active_kernel_launch()
                .map(|active| active.runtime_agent_id),
            Some("replacement-agent".to_string())
        );
    }

    #[tokio::test]
    async fn manual_launch_joins_exact_auto_launch_generation() {
        let (_tmp, room) = test_room();
        let auto_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };

        assert_eq!(
            match room.try_begin_manual_launch() {
                ManualLaunchAdmission::InFlight { generation, .. } => generation,
                ManualLaunchAdmission::Admitted(_) => {
                    panic!("manual launch must join the auto-launch")
                }
            },
            1
        );
        auto_attempt.release_without_cooldown();
    }

    #[tokio::test]
    async fn concurrent_manual_launches_share_one_generation() {
        let (_tmp, room) = test_room();
        let first = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("first manual launch should be admitted")
            }
        };

        assert_eq!(
            match room.try_begin_manual_launch() {
                ManualLaunchAdmission::InFlight { generation, .. } => generation,
                ManualLaunchAdmission::Admitted(_) => {
                    panic!("second manual launch must join the first")
                }
            },
            1
        );
        first.release_without_cooldown();
    }

    #[tokio::test]
    async fn failed_manual_launch_does_not_arm_auto_launch_cooldown() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("first manual launch should be admitted")
            }
        };
        drop(attempt);
        while room.launch_completion(1).is_none() {
            tokio::task::yield_now().await;
        }

        match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            AutoLaunchAdmission::InFlight { .. } => {
                panic!("manual failure must release the gate")
            }
            AutoLaunchAdmission::CoolingDown { .. } => {
                panic!("manual failure must not throttle reconnect-driven launch")
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn manual_retry_preserves_existing_auto_launch_cooldown() {
        let (_tmp, room) = test_room();
        let auto_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto launch should be admitted"),
        };
        drop(auto_attempt);
        while room.launch_completion(1).is_none() {
            tokio::task::yield_now().await;
        }

        let manual_attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("manual launch must bypass reconnect cooldown")
            }
        };
        drop(manual_attempt);
        while room.launch_completion(2).is_none() {
            tokio::task::yield_now().await;
        }
        assert!(matches!(
            room.try_begin_auto_launch(),
            AutoLaunchAdmission::CoolingDown { .. }
        ));

        tokio::time::advance(crate::notebook_sync_server::AUTO_LAUNCH_FAILURE_COOLDOWN).await;
        match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            _ => panic!("original cooldown should expire normally"),
        }
    }

    #[tokio::test]
    async fn shutdown_cancellation_wins_manual_success_linearization() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("first manual launch should be admitted")
            }
        };
        assert_eq!(room.cancel_in_flight_launch(), Some(1));

        let cancelled_attempt = attempt
            .succeed()
            .expect_err("shutdown must prevent launch success from linearizing");
        assert!(matches!(
            room.try_begin_manual_launch(),
            ManualLaunchAdmission::InFlight { generation: 1, .. }
        ));
        cancelled_attempt.finish_cancelled();

        assert_eq!(
            room.launch_completion(1),
            Some(KernelLaunchCompletion::Cancelled)
        );
        match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("cancelled owner must release after cleanup")
            }
        }
    }

    #[tokio::test]
    async fn cancelled_manual_success_does_not_publish_launched_config() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        room.expect_runtime_agent("agent-1");
        assert!(room.mark_runtime_agent_connected("agent-1"));
        assert_eq!(room.cancel_in_flight_launch(), Some(1));
        let mut launch_attempt = Some(attempt);
        let launched_config = notebook_protocol::protocol::LaunchedEnvConfig {
            launch_id: Some("cancelled-launch".to_string()),
            ..Default::default()
        };

        assert!(complete_manual_launch(
            &room,
            &mut launch_attempt,
            "agent-1",
            "python",
            &EnvSource::Prewarmed(PackageManager::Uv),
            &launched_config,
        )
        .await
        .is_err());
        assert!(room.runtime_agent_launched_config.read().await.is_none());
    }

    #[tokio::test]
    async fn abandoned_manual_launch_cleans_agent_slots_before_releasing_gate() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(attempt.expect_runtime_agent("agent-1"));
        let (request_tx, _request_rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(request_tx);
        let (connect_tx, _connect_rx) = tokio::sync::oneshot::channel();
        *room.pending_runtime_agent_connect_tx.lock().await = Some(connect_tx);
        room.state
            .with_doc(|doc| doc.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();

        drop(attempt);
        for _ in 0..20 {
            if room.launch_completion(1).is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(
            room.launch_completion(1),
            Some(KernelLaunchCompletion::Failed)
        );
        assert!(room.current_runtime_agent_id.read().await.is_none());
        assert!(room.runtime_agent_request_tx.lock().await.is_none());
        assert!(room.pending_runtime_agent_connect_tx.lock().await.is_none());
        assert_eq!(
            room.state
                .read(|doc| doc.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Error
        );
    }

    #[tokio::test]
    async fn cancelled_attempt_drop_preserves_runtime_agent_disconnect_error() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(attempt.expect_runtime_agent("agent-1"));
        assert!(room.mark_runtime_agent_connected("agent-1"));
        assert!(room.disconnect_runtime_agent_and_commit_terminal(
            "agent-1",
            || {},
            |doc| doc.set_lifecycle_with_error_details(
                &RuntimeLifecycle::Error,
                None,
                Some("Runtime agent disconnected"),
            ),
        ));

        drop(attempt);
        for _ in 0..20 {
            if room.launch_completion(1).is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(
            room.launch_completion(1),
            Some(KernelLaunchCompletion::Cancelled)
        );
        let state = room.state.read(|doc| doc.read_state()).unwrap();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(
            state.kernel.error_details.as_deref(),
            Some("Runtime agent disconnected")
        );
    }

    #[tokio::test]
    async fn cancelled_launch_cannot_regress_shutdown_projection() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        assert_eq!(room.cancel_in_flight_launch(), Some(1));
        room.state
            .with_doc(|doc| doc.set_lifecycle(&RuntimeLifecycle::Shutdown))
            .unwrap();

        let committed = room.commit_unless_launch_cancelled(|| {
            room.state
                .with_doc(|doc| doc.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
        });
        assert!(committed.is_none());
        assert_eq!(
            room.state
                .read(|doc| doc.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Shutdown
        );
        attempt.finish_cancelled();
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_join_retains_launch_timeout_while_owner_cleanup_continues() {
        let (_tmp, room) = test_room();
        let owner = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        let (generation, cancel_rx) = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::InFlight {
                generation,
                cancel_rx,
            } => (generation, cancel_rx),
            ManualLaunchAdmission::Admitted(_) => {
                panic!("manual request must join the auto-launch")
            }
        };
        let waiter = tokio::spawn({
            let room = Arc::clone(&room);
            async move { wait_for_joined_launch(&room, generation, cancel_rx).await }
        });

        assert_eq!(room.cancel_in_flight_launch(), Some(generation));
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        assert_eq!(waiter.await.unwrap(), Err(()));
        assert!(
            matches!(
                room.try_begin_manual_launch(),
                ManualLaunchAdmission::InFlight { generation: 1, .. }
            ),
            "timing out a joined request must not release the owner's safety fence"
        );
        owner.finish_cancelled();
    }

    #[tokio::test]
    async fn manual_launch_can_take_over_after_benign_release_without_successor() {
        let (_tmp, room) = test_room();
        let auto_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        auto_attempt.release_without_cooldown();

        match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("manual launch should take ownership after release")
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failed_auto_launch_cannot_reuse_stale_active_response() {
        let (_tmp, room) = test_room();
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "agent-1".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );
        let attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();
        room.clear_active_kernel_launch();
        drop(attempt);

        assert_eq!(
            wait_for_launch_generation(&room, 1).await,
            KernelLaunchCompletion::Failed
        );
        assert!(existing_kernel_response(&room).await.is_none());
    }
}
