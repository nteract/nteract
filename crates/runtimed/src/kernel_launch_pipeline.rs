//! Shared kernel launch pipeline stages used by both manual `LaunchKernel`
//! (`requests/launch_kernel.rs`) and automatic launch (`notebook_sync_server/metadata.rs`).
//!
//! Centralizes environment preparation, `ipykernel` verification, trust-aware
//! error publication, and kernel launch environment variable composition so
//! both triggers share identical behavior and cannot drift.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use tracing::{error, info, warn};

use notebook_doc::metadata::NotebookMetadataSnapshot;
use notebook_protocol::connection::{EnvSource, PackageManager};
use notebook_protocol::protocol::FeatureFlags;
use runtime_doc::{KernelErrorReason, RuntimeLifecycle};

use crate::daemon::Daemon;
use crate::notebook_sync_server::{
    acquire_prewarmed_env_with_capture, get_inline_conda_channels, get_inline_conda_deps,
    get_inline_conda_python, get_inline_uv_deps, get_inline_uv_prerelease,
    get_inline_uv_requires_python, missing_conda_env_yml_decision, prewarmed_acquire_error_details,
    publish_environment_launch_error, reset_and_publish_environment_launch_error,
    reset_starting_state, trust_allows_auto_launch_error_publish, try_conda_pool_for_inline_deps,
    try_uv_pool_for_inline_deps, NotebookRoom,
};
use crate::project_file::ProjectFileKind;
use crate::project_trust::TrustedProjectManifest;
use crate::protocol::NotebookResponse;
use crate::requests::guarded::{self, GuardRejection};
use crate::shell_env_overlay::ShellEnvOverlay;

/// Identifies which entry point drove a kernel launch attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchTrigger {
    /// Explicit user or programmatic `NotebookRequest::LaunchKernel`.
    Manual,
    /// Background auto-launch triggered by room open / metadata sync.
    Auto,
}

/// Inputs for [`prepare_environment`].
pub(crate) struct PrepareEnvContext<'a> {
    pub(crate) trigger: LaunchTrigger,
    pub(crate) daemon: &'a Arc<Daemon>,
    pub(crate) room: &'a NotebookRoom,
    pub(crate) kernel_type: &'a str,
    pub(crate) env_source: &'a EnvSource,
    pub(crate) metadata_snapshot: Option<&'a NotebookMetadataSnapshot>,
    pub(crate) trusted_project: Option<&'a TrustedProjectManifest>,
    pub(crate) notebook_path: Option<&'a Path>,
    /// Pre-extracted PEP 723 dependencies when the caller already scanned cells
    /// (auto-launch). When `None`, `prepare_environment` scans `room.doc` for
    /// `uv:pep723` / `pixi:pep723`.
    pub(crate) precomputed_pep723_deps: Option<&'a [String]>,
}

/// Prepared environment artifacts produced before spawning/restarting a kernel.
pub(crate) struct PreparedEnvironment {
    pub(crate) pooled_env: Option<crate::PooledEnv>,
    pub(crate) inline_deps: Option<Vec<String>>,
    pub(crate) pep723_dependencies: Vec<String>,
    pub(crate) uv_pyproject_offline: bool,
    pub(crate) pixi_toml_frozen: bool,
    pub(crate) feature_flags: FeatureFlags,
}

/// Failure from [`prepare_environment`].
pub(crate) enum PrepareEnvFailure {
    TrustRejected(GuardRejection),
    Error { message: String },
}

impl PrepareEnvFailure {
    pub(crate) fn into_response(self) -> NotebookResponse {
        match self {
            Self::TrustRejected(rejection) => rejection.into_response(),
            Self::Error { message } => NotebookResponse::Error { error: message },
        }
    }
}

/// Build kernel environment variables from the user shell overlay, merging
/// user shell `PATH` with daemon `PATH` so both daemon-managed tools (`uv`)
/// and user shell binaries (`~/.local/bin`, `/opt/homebrew/bin`, etc.) resolve.
pub(crate) fn overlay_env_vars(overlay: &Arc<ShellEnvOverlay>) -> HashMap<String, String> {
    let daemon_path = std::env::var("PATH").unwrap_or_default();
    overlay.build_kernel_env_vars(&daemon_path)
}

/// Merge daemon-required UV/Pixi env vars over a caller-provided base map
/// (such as the inherited shell overlay), giving UV/Pixi precedence.
pub(crate) fn merge_launch_env_vars(
    mut base: HashMap<String, String>,
    uv_pyproject_offline: bool,
    pixi_toml_frozen: bool,
) -> HashMap<String, String> {
    base.extend(crate::uv_project::uv_offline_env_vars(uv_pyproject_offline));
    base.extend(crate::pixi_project::pixi_frozen_env_vars(pixi_toml_frozen));
    base
}

/// Compose final kernel launch environment variables with canonical precedence:
/// shell overlay (if enabled, lowest) -> UV offline vars -> Pixi frozen vars (highest).
pub(crate) fn build_launch_env_vars(
    import_shell_environment: bool,
    overlay: &Arc<ShellEnvOverlay>,
    uv_pyproject_offline: bool,
    pixi_toml_frozen: bool,
) -> HashMap<String, String> {
    let base = if import_shell_environment {
        overlay_env_vars(overlay)
    } else {
        HashMap::new()
    };
    merge_launch_env_vars(base, uv_pyproject_offline, pixi_toml_frozen)
}

/// Resolve the prewarmed package baseline for `LaunchedEnvConfig`, falling back
/// to configured `default_pixi_packages` when Pixi launches on demand without a
/// pooled environment.
pub(crate) async fn resolve_prewarmed_packages(
    daemon: &Daemon,
    env_source: &EnvSource,
    pooled_env: Option<&crate::PooledEnv>,
) -> Option<Vec<String>> {
    if let Some(env) = pooled_env {
        Some(env.prewarmed_packages.clone())
    } else if env_source.package_manager() == Some(PackageManager::Pixi) {
        let pixi_defaults = daemon.default_pixi_packages().await;
        if pixi_defaults.is_empty() {
            None
        } else {
            Some(pixi_defaults)
        }
    } else {
        None
    }
}

/// Publish an environment preparation failure with trigger-appropriate trust
/// handling: manual launches reset and publish `Error`; auto-launches reset
/// starting state to `NotStarted` and suppress publishing `Error` when
/// notebook trust blocks launch so the trust gate is not overwritten.
async fn fail_environment_launch(
    trigger: LaunchTrigger,
    room: &NotebookRoom,
    env_source: &EnvSource,
    reason: Option<KernelErrorReason>,
    details: &str,
) -> PrepareEnvFailure {
    match trigger {
        LaunchTrigger::Manual => {
            reset_starting_state(room, None).await;
            publish_environment_launch_error(room, env_source.as_str(), reason, details);
        }
        LaunchTrigger::Auto => {
            reset_and_publish_environment_launch_error(room, env_source.as_str(), reason, details)
                .await;
        }
    }
    PrepareEnvFailure::Error {
        message: details.to_string(),
    }
}

/// Whether `env_source` acquires a prewarmed pool environment for a Python kernel.
///
/// `EnvSource::Prewarmed(_)` (UV, Conda, and Pixi) and forward-compatible
/// `EnvSource::Unknown(_)` wire strings pull from daemon pools. Self-preparing
/// sources (`Inline`, `Pep723`, `Pyproject`, `PixiToml`, `EnvYml`), borrowed
/// local Conda envs, installed kernelspecs, and Deno never pull from pools.
pub(crate) fn should_acquire_pool_env(kernel_type: &str, env_source: &EnvSource) -> bool {
    if kernel_type == "deno" || env_source.prepares_own_env() {
        return false;
    }
    !matches!(
        env_source,
        EnvSource::ExistingConda | EnvSource::Kernelspec | EnvSource::Deno
    )
}

/// Pre-flight check that a trusted `pixi.toml` declares `ipykernel`.
///
/// Unlike UV (`uv run --with ipykernel`) and `conda:env_yml` (daemon appends
/// `ipykernel` pre-sync), pixi treats `pixi.toml` as the sole source of truth.
/// Publishes typed `KernelErrorReason::MissingIpykernel` atomically without
/// calling `reset_starting_state` (no runtime agent has spawned yet, and an
/// intermediate `NotStarted` write would race with concurrent retries).
pub(crate) async fn verify_pixi_toml_ipykernel(
    trigger: LaunchTrigger,
    room: &NotebookRoom,
    env_source: &EnvSource,
    trusted_project: Option<&TrustedProjectManifest>,
) -> Result<(), String> {
    if !matches!(env_source, EnvSource::PixiToml) {
        return Ok(());
    }
    let Some(path) = trusted_project
        .filter(|t| *t.kind() == ProjectFileKind::PixiToml)
        .map(|t| t.path())
    else {
        return Ok(());
    };

    let has_ipykernel = match kernel_launch::tools::pixi_info(path).await {
        Ok(info) => info.has_ipykernel(),
        Err(e) => {
            warn!(
                "[notebook-sync] pixi info failed, falling back to line scan: {}",
                e
            );
            crate::project_file::pixi_toml_has_ipykernel(path)
        }
    };
    if has_ipykernel {
        return Ok(());
    }

    warn!(
        "[notebook-sync] pixi.toml at {:?} does not declare ipykernel — cannot launch kernel",
        path
    );
    let details =
        "ipykernel not found in pixi.toml — run `pixi add ipykernel` in your project directory"
            .to_string();
    if room.local_environment_selection.is_preparing() {
        return Err(details);
    }
    if trigger == LaunchTrigger::Auto && !trust_allows_auto_launch_error_publish(room).await {
        reset_starting_state(room, None).await;
        return Err(details);
    }
    let env_source_label = env_source.as_str().to_string();
    if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
        room.state.with_doc(|sd| {
            let _ = sd.clear_env_progress();
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
    Err(details)
}

/// Transition to `PreparingEnv`, acquire or prepare the kernel environment,
/// verify `ipykernel` in inline/PEP 723 caches, and register the env path for
/// GC protection before runtime-agent spawn.
pub(crate) async fn prepare_environment(
    ctx: PrepareEnvContext<'_>,
) -> Result<PreparedEnvironment, PrepareEnvFailure> {
    let PrepareEnvContext {
        trigger,
        daemon,
        room,
        kernel_type,
        env_source,
        metadata_snapshot,
        trusted_project,
        notebook_path,
        precomputed_pep723_deps,
    } = ctx;

    // Transition to `PreparingEnv` before any prewarmed pool build, inline
    // cache build, or project sync begins.
    if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
    }) {
        warn!("[runtime-state] {}", e);
    }

    // Acquire prewarmed pool environment when this source uses daemon pools.
    // All prewarmed sources (UV, Conda, and Pixi) route through
    // `acquire_prewarmed_env_with_capture` so reopen cache-hits reuse claimed
    // envs and `pixi:prewarmed` pulls from the Pixi pool rather than UV.
    let pooled_env = if !should_acquire_pool_env(kernel_type, env_source) {
        if kernel_type == "deno" {
            info!("[notebook-sync] Deno kernel (no pooled env)");
        } else if env_source.prepares_own_env() {
            info!(
                "[notebook-sync] {} prepares its own env, no pool env needed",
                env_source.as_str()
            );
        }
        None
    } else {
        match acquire_prewarmed_env_with_capture(
            env_source.as_str(),
            daemon,
            room,
            metadata_snapshot,
        )
        .await
        {
            Ok(Some(env)) => {
                info!(
                    "[notebook-sync] Acquired {} env: {:?}",
                    env_source.as_str(),
                    env.python_path
                );
                // Protect the acquired env under `runtime_agent_env_path`
                // through the rest of the launch flow (covers reopen cache-hit
                // paths as well as freshly claimed pool envs).
                let mut ep = room.runtime_agent_env_path.write().await;
                *ep = Some(env.venv_path.clone());
                drop(ep);
                Some(env)
            }
            Ok(None) => None,
            Err(acquire_error) => {
                let details = prewarmed_acquire_error_details(env_source.as_str(), &acquire_error);
                error!("[notebook-sync] {}", details);
                fail_environment_launch(
                    trigger,
                    room,
                    env_source,
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    &details,
                )
                .await;
                return Err(PrepareEnvFailure::Error {
                    message: match trigger {
                        LaunchTrigger::Manual => acquire_error.to_string(),
                        LaunchTrigger::Auto => details,
                    },
                });
            }
        }
    };

    let progress_handler: Arc<dyn kernel_env::ProgressHandler> = Arc::new(
        crate::inline_env::RuntimeDocProgressHandler::new_for_launch(
            room.state.clone(),
            room.current_launch_cancellation_receiver(),
        ),
    );

    // Fetch feature flags up front so inline cache hits can refresh vendored
    // launcher files when `bootstrap_dx` is active.
    let feature_flags = daemon.feature_flags().await;
    let bootstrap_dx = feature_flags.bootstrap_dx;

    let mut pep723_dependencies = Vec::new();
    let (pooled_env, inline_deps) = match env_source {
        EnvSource::Pep723(PackageManager::Uv) => {
            prepare_uv_pep723_env(
                trigger,
                room,
                env_source,
                precomputed_pep723_deps,
                progress_handler.clone(),
                &mut pep723_dependencies,
            )
            .await?
        }
        EnvSource::Inline(PackageManager::Uv) => {
            prepare_uv_inline_env_for_launch(
                trigger,
                daemon,
                room,
                env_source,
                metadata_snapshot,
                bootstrap_dx,
                progress_handler.clone(),
                pooled_env,
            )
            .await?
        }
        EnvSource::Inline(PackageManager::Conda) => {
            prepare_conda_inline_env_for_launch(
                trigger,
                daemon,
                room,
                env_source,
                metadata_snapshot,
                progress_handler.clone(),
                pooled_env,
            )
            .await?
        }
        EnvSource::EnvYml => {
            prepare_conda_env_yml_for_launch(
                trigger,
                room,
                env_source,
                metadata_snapshot,
                trusted_project,
                progress_handler.clone(),
            )
            .await?
        }
        EnvSource::Inline(PackageManager::Pixi) => {
            // pixi exec handles its own env caching — extract deps for -w flags.
            let deps = metadata_snapshot
                .and_then(|s| s.runt.pixi.as_ref())
                .map(|p| p.dependencies.clone())
                .unwrap_or_default();
            let deps = crate::inline_env::inline_deps_with_conda_required_packages(&deps);
            if !deps.is_empty() {
                info!("[notebook-sync] pixi:inline deps for pixi exec: {:?}", deps);
                (None, Some(deps))
            } else {
                (pooled_env, None)
            }
        }
        EnvSource::Pep723(PackageManager::Pixi) => {
            let extracted = if let Some(deps) = precomputed_pep723_deps {
                (!deps.is_empty()).then(|| deps.to_vec())
            } else {
                let cells = room.doc.read().await.get_cells();
                match notebook_doc::pep723::find_pep723_in_cells(&cells) {
                    Ok(Some(meta)) if !meta.dependencies.is_empty() => Some(meta.dependencies),
                    _ => None,
                }
            };
            if let Some(raw_deps) = extracted {
                pep723_dependencies = raw_deps.clone();
                let deps = crate::inline_env::inline_deps_with_conda_required_packages(&raw_deps);
                info!("[notebook-sync] pixi:pep723 deps for pixi exec: {:?}", deps);
                (None, Some(deps))
            } else {
                (pooled_env, None)
            }
        }
        _ => (pooled_env, None),
    };

    let mut uv_pyproject_offline = false;
    let mut pixi_toml_frozen = false;
    if let (EnvSource::Pyproject, Some(trusted)) = (env_source, trusted_project) {
        match crate::uv_project::prepare_uv_pyproject_environment(
            trusted,
            notebook_path,
            bootstrap_dx,
            progress_handler.clone(),
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
                return Err(fail_environment_launch(
                    trigger,
                    room,
                    env_source,
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    &details,
                )
                .await);
            }
        }
    } else if let (EnvSource::PixiToml, Some(trusted)) = (env_source, trusted_project) {
        let outcome =
            crate::pixi_project::prepare_pixi_toml_environment(trusted, progress_handler.clone())
                .await;
        // Always clear `ProjectPreparing` progress so a fallback launch does
        // not leave "preparing pixi" pinned in the UI once the kernel is idle.
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
                return Err(fail_environment_launch(
                    trigger,
                    room,
                    env_source,
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    &details,
                )
                .await);
            }
        }
    }

    // Verify `ipykernel` is importable in inline / PEP 723 cached envs before
    // spawning the kernel so stale caches surface typed `MissingIpykernel`.
    verify_prepared_ipykernel(trigger, room, env_source, pooled_env.as_ref()).await?;

    // Protect prepared env directories from GC before any further async work
    // (agent spawn, connect wait).
    if let Some(ref env) = pooled_env {
        let mut ep = room.runtime_agent_env_path.write().await;
        *ep = Some(env.venv_path.clone());
    }

    Ok(PreparedEnvironment {
        pooled_env,
        inline_deps,
        pep723_dependencies,
        uv_pyproject_offline,
        pixi_toml_frozen,
        feature_flags,
    })
}

async fn prepare_uv_pep723_env(
    trigger: LaunchTrigger,
    room: &NotebookRoom,
    env_source: &EnvSource,
    precomputed_pep723_deps: Option<&[String]>,
    progress_handler: Arc<dyn kernel_env::ProgressHandler>,
    pep723_dependencies: &mut Vec<String>,
) -> Result<(Option<crate::PooledEnv>, Option<Vec<String>>), PrepareEnvFailure> {
    let pep723_deps = if let Some(deps) = precomputed_pep723_deps {
        (!deps.is_empty()).then(|| deps.to_vec())
    } else {
        let cells = room.doc.read().await.get_cells();
        match notebook_doc::pep723::find_pep723_in_cells(&cells) {
            Ok(Some(m)) if !m.dependencies.is_empty() => Some(m.dependencies),
            Ok(_) => None,
            Err(e) => {
                error!(
                    "[notebook-sync] Invalid PEP 723 metadata in notebook: {}",
                    e
                );
                let details = format!("Invalid PEP 723 metadata in notebook: {}", e);
                return Err(fail_environment_launch(
                    trigger,
                    room,
                    env_source,
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    &details,
                )
                .await);
            }
        }
    };

    let Some(deps) = pep723_deps else {
        return match trigger {
            LaunchTrigger::Manual => {
                let details = "No PEP 723 dependencies found in notebook cells for requested env_source \"uv:pep723\"";
                Err(fail_environment_launch(
                    trigger,
                    room,
                    env_source,
                    Some(KernelErrorReason::EnvironmentPrepareFailed),
                    details,
                )
                .await)
            }
            LaunchTrigger::Auto => Ok((None, None)),
        };
    };

    *pep723_dependencies = deps.clone();
    if let Err(rejection) = guarded::ensure_trusted_pep723(room, &deps).await {
        reset_starting_state(room, None).await;
        return Err(PrepareEnvFailure::TrustRejected(rejection));
    }

    info!(
        "[notebook-sync] Preparing cached UV env for PEP 723 deps: {:?}",
        deps
    );
    match crate::inline_env::prepare_uv_inline_env(&deps, None, None, progress_handler).await {
        Ok(prepared) => {
            info!(
                "[notebook-sync] Using cached PEP 723 env at {:?}",
                prepared.python_path
            );
            let env = Some(crate::PooledEnv {
                env_type: crate::EnvType::Uv,
                venv_path: prepared.env_path,
                python_path: prepared.python_path,
                prewarmed_packages: vec![],
            });
            Ok((env, Some(deps)))
        }
        Err(e) => {
            let details = format!("Failed to prepare PEP 723 environment: {}", e);
            error!("[notebook-sync] {}", details);
            Err(fail_environment_launch(
                trigger,
                room,
                env_source,
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                &details,
            )
            .await)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn prepare_uv_inline_env_for_launch(
    trigger: LaunchTrigger,
    daemon: &Arc<Daemon>,
    room: &NotebookRoom,
    env_source: &EnvSource,
    metadata_snapshot: Option<&NotebookMetadataSnapshot>,
    bootstrap_dx: bool,
    progress_handler: Arc<dyn kernel_env::ProgressHandler>,
    pooled_env: Option<crate::PooledEnv>,
) -> Result<(Option<crate::PooledEnv>, Option<Vec<String>>), PrepareEnvFailure> {
    let Some(deps) = metadata_snapshot.and_then(get_inline_uv_deps) else {
        return Ok((pooled_env, None));
    };

    let prerelease = metadata_snapshot.and_then(get_inline_uv_prerelease);
    let requires_python = metadata_snapshot.and_then(get_inline_uv_requires_python);

    // Fast path: check inline env cache first (instant on hit).
    // `check_uv_inline_cache` re-vendors the launcher on hit when
    // `bootstrap_dx` is on so stale caches match the current layout.
    if let Some(cached) = crate::inline_env::check_uv_inline_cache(
        &deps,
        requires_python.as_deref(),
        prerelease.as_deref(),
        bootstrap_dx,
    )
    .await
    {
        info!(
            "[notebook-sync] UV inline cache hit at {:?}",
            cached.python_path
        );
        let env = Some(crate::PooledEnv {
            env_type: crate::EnvType::Uv,
            venv_path: cached.env_path,
            python_path: cached.python_path,
            prewarmed_packages: vec![],
        });
        return Ok((env, Some(deps)));
    }

    // Try pool reuse for bare deps without prerelease.
    if prerelease.is_none() {
        if let Ok((mut pooled, pool_pkgs)) = try_uv_pool_for_inline_deps(
            &deps,
            requires_python.as_deref(),
            daemon,
            room,
            progress_handler.clone(),
        )
        .await
        {
            pooled.prewarmed_packages = pool_pkgs;
            return Ok((Some(pooled), Some(deps)));
        }
    }

    // Pool path unavailable/failed or prerelease requested — full cached build.
    info!(
        "[notebook-sync] Preparing cached UV env for inline deps: {:?} (prerelease: {:?})",
        deps, prerelease
    );
    match crate::inline_env::prepare_uv_inline_env(
        &deps,
        requires_python.as_deref(),
        prerelease.as_deref(),
        progress_handler,
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
            Ok((env, Some(deps)))
        }
        Err(e) => {
            let details = format!("Failed to prepare inline environment: {}", e);
            error!("[notebook-sync] {}", details);
            Err(fail_environment_launch(
                trigger,
                room,
                env_source,
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                &details,
            )
            .await)
        }
    }
}

async fn prepare_conda_inline_env_for_launch(
    trigger: LaunchTrigger,
    daemon: &Arc<Daemon>,
    room: &NotebookRoom,
    env_source: &EnvSource,
    metadata_snapshot: Option<&NotebookMetadataSnapshot>,
    progress_handler: Arc<dyn kernel_env::ProgressHandler>,
    pooled_env: Option<crate::PooledEnv>,
) -> Result<(Option<crate::PooledEnv>, Option<Vec<String>>), PrepareEnvFailure> {
    let Some(deps) = metadata_snapshot.and_then(get_inline_conda_deps) else {
        return Ok((pooled_env, None));
    };

    let channels = metadata_snapshot
        .map(get_inline_conda_channels)
        .unwrap_or_else(|| vec!["conda-forge".to_string()]);
    let python = metadata_snapshot.and_then(get_inline_conda_python);
    let python = python.as_deref();

    if let Some(cached) = crate::inline_env::check_conda_inline_cache(&deps, &channels, python) {
        info!(
            "[notebook-sync] Conda inline cache hit at {:?}",
            cached.python_path
        );
        let env = Some(crate::PooledEnv {
            env_type: crate::EnvType::Conda,
            venv_path: cached.env_path,
            python_path: cached.python_path,
            prewarmed_packages: vec![],
        });
        return Ok((env, Some(deps)));
    }

    // Try pool reuse (only for default conda-forge channel).
    if let Ok((mut pooled, pool_pkgs)) = try_conda_pool_for_inline_deps(
        &deps,
        &channels,
        python,
        daemon,
        room,
        progress_handler.clone(),
    )
    .await
    {
        pooled.prewarmed_packages = pool_pkgs;
        return Ok((Some(pooled), Some(deps)));
    }

    info!(
        "[notebook-sync] Preparing cached Conda env for inline deps: {:?} (channels: {:?})",
        deps, channels
    );
    match crate::inline_env::prepare_conda_inline_env(&deps, &channels, python, progress_handler)
        .await
    {
        Ok(prepared) => {
            let env = Some(crate::PooledEnv {
                env_type: crate::EnvType::Conda,
                venv_path: prepared.env_path,
                python_path: prepared.python_path,
                prewarmed_packages: vec![],
            });
            Ok((env, Some(deps)))
        }
        Err(e) => {
            let details = format!("Failed to prepare conda inline environment: {}", e);
            error!("[notebook-sync] {}", details);
            Err(fail_environment_launch(
                trigger,
                room,
                env_source,
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                &details,
            )
            .await)
        }
    }
}

async fn prepare_conda_env_yml_for_launch(
    trigger: LaunchTrigger,
    room: &NotebookRoom,
    env_source: &EnvSource,
    metadata_snapshot: Option<&NotebookMetadataSnapshot>,
    trusted_project: Option<&TrustedProjectManifest>,
    progress_handler: Arc<dyn kernel_env::ProgressHandler>,
) -> Result<(Option<crate::PooledEnv>, Option<Vec<String>>), PrepareEnvFailure> {
    let Some(trusted_yml) =
        trusted_project.filter(|t| *t.kind() == ProjectFileKind::EnvironmentYml)
    else {
        let details = "conda:env_yml requested but no environment.yml was found";
        warn!("[notebook-sync] {}", details);
        return Err(fail_environment_launch(
            trigger,
            room,
            env_source,
            Some(KernelErrorReason::EnvironmentPrepareFailed),
            details,
        )
        .await);
    };

    let env_config = match crate::project_file::parse_environment_yml(trusted_yml.path()) {
        Ok(config) => config,
        Err(e) => {
            let details = format!("Failed to parse environment.yml: {}", e);
            error!("[notebook-sync] {}", details);
            return Err(fail_environment_launch(
                trigger,
                room,
                env_source,
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                &details,
            )
            .await);
        }
    };

    // The directory is trusted, so a missing env is built here like uv and
    // pixi build theirs. Trust is the consent for the build.
    let detected_yml = trusted_yml.detected();
    if let Some(decision) = missing_conda_env_yml_decision(&detected_yml) {
        info!(
            "[notebook-sync] Building conda env '{}' from trusted {:?}",
            decision.label, detected_yml.path
        );
    }

    // Track whether the env is daemon-owned (safe to auto-rebuild) vs.
    // user-managed (prefix: field or pre-existing named env).
    let (conda_prefix, is_daemon_owned_env) = if let Some(ref prefix) = env_config.prefix {
        (prefix.clone(), false)
    } else if let Some(ref name) = env_config.name {
        match crate::project_file::find_named_conda_env(name) {
            Some(found) => (found, false),
            None => (
                crate::project_file::default_conda_envs_dir().join(name),
                true,
            ),
        }
    } else {
        let cache_dir = crate::paths::env_yml_conda_cache_dir();
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

    // Merge env.yml deps with any CRDT notebook deps (additive).
    let mut all_deps = env_config.dependencies.clone();
    if let Some(crdt_deps) = metadata_snapshot.and_then(get_inline_conda_deps) {
        let base_names: HashSet<String> = all_deps
            .iter()
            .map(|d| notebook_doc::metadata::extract_package_name(d).to_lowercase())
            .collect();
        for dep in &crdt_deps {
            let name = notebook_doc::metadata::extract_package_name(dep).to_lowercase();
            if !base_names.contains(&name) {
                all_deps.push(dep.clone());
            }
        }
    }

    // Always include ipykernel and pip so `%pip` installs into this prepared Conda env.
    let base_names: HashSet<String> = all_deps
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
    let python_version_ok = if python_path.exists() {
        if let Some(ref requested) = env_config.python {
            let matches =
                kernel_env::conda::installed_python_matches_constraint(&conda_prefix, requested);
            if !matches {
                let installed = kernel_env::conda::detect_installed_python_version(&conda_prefix)
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
                        "Conda env {:?} has Python {} but environment.yml requests \
                         python={}. This is a user-managed env — rebuild it manually \
                         with: conda env remove -n {} && conda env create -f environment.yml",
                        conda_prefix,
                        installed,
                        requested,
                        env_config.name.as_deref().unwrap_or("<env>"),
                    );
                    warn!("[notebook-sync] {}", details);
                    return Err(
                        fail_environment_launch(trigger, room, env_source, None, &details).await,
                    );
                }
            } else {
                true
            }
        } else {
            true
        }
    } else {
        false
    };

    // Re-check python_path after potential env removal.
    let python_path = crate::project_file::conda_python_path(&conda_prefix);
    if python_path.exists() && python_version_ok {
        if conda_prefix.starts_with(crate::paths::env_yml_conda_cache_dir()) {
            kernel_env::gc::touch_last_used(&conda_prefix).await;
        }
        let conda_env = kernel_env::CondaEnvironment {
            env_path: conda_prefix.clone(),
            python_path: python_path.clone(),
        };
        if let Err(e) = kernel_env::conda::sync_dependencies(
            &conda_env,
            &conda_deps,
            if is_daemon_owned_env {
                kernel_env::EnvOwnership::Daemon
            } else {
                kernel_env::EnvOwnership::User
            },
            progress_handler.clone(),
        )
        .await
        {
            let details = format!("conda:env_yml sync into existing env failed: {}", e);
            error!("[notebook-sync] {}", details);
            return Err(fail_environment_launch(
                trigger,
                room,
                env_source,
                Some(KernelErrorReason::CondaEnvBuildFailed),
                &details,
            )
            .await);
        }
        // Terminal phase so the progress banner clears.
        progress_handler.on_progress(
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
        return Ok((env, metadata_snapshot.and_then(get_inline_conda_deps)));
    }

    let parent = conda_prefix.parent().unwrap_or_else(|| Path::new("/tmp"));
    if let Err(e) = tokio::fs::create_dir_all(parent).await {
        let details = format!("Failed to create conda envs directory {:?}: {}", parent, e);
        error!("[notebook-sync] {}", details);
        return Err(fail_environment_launch(
            trigger,
            room,
            env_source,
            Some(KernelErrorReason::CondaEnvBuildFailed),
            &details,
        )
        .await);
    }

    match kernel_env::conda::prepare_environment_in(&conda_deps, parent, progress_handler).await {
        Ok(prepared) => {
            let final_prefix = if prepared.env_path != conda_prefix {
                match tokio::fs::rename(&prepared.env_path, &conda_prefix).await {
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
            Ok((env, metadata_snapshot.and_then(get_inline_conda_deps)))
        }
        Err(e) => {
            let details = format!(
                "Failed to create conda env '{}' from environment.yml: {}",
                env_name_display, e
            );
            error!("[notebook-sync] {}", details);
            Err(fail_environment_launch(
                trigger,
                room,
                env_source,
                Some(KernelErrorReason::CondaEnvBuildFailed),
                &details,
            )
            .await)
        }
    }
}

/// Verify `ipykernel` is importable in prepared inline / PEP 723 envs before
/// spawning the kernel.
///
/// Skipped for prewarmed pools (invariant base packages), `pixi:*` (`pixi exec`
/// / gated earlier via `verify_pixi_toml_ipykernel`), `uv:pyproject`
/// (`uv run --with ipykernel`), `conda:env_yml` (appends `ipykernel` pre-sync),
/// and `deno`.
async fn verify_prepared_ipykernel(
    trigger: LaunchTrigger,
    room: &NotebookRoom,
    env_source: &EnvSource,
    pooled_env: Option<&crate::PooledEnv>,
) -> Result<(), PrepareEnvFailure> {
    if !matches!(
        env_source,
        EnvSource::Inline(PackageManager::Uv)
            | EnvSource::Inline(PackageManager::Conda)
            | EnvSource::Pep723(PackageManager::Uv)
    ) {
        return Ok(());
    }
    let Some(env) = pooled_env else {
        return Ok(());
    };

    let diagnostic = kernel_env::diagnose_ipykernel_async(&env.python_path).await;
    if diagnostic.is_present() {
        return Ok(());
    }

    warn!(
        "[notebook-sync] prepared env at {:?} ({}) cannot import ipykernel: {:?}",
        env.venv_path,
        env_source.as_str(),
        diagnostic
    );
    let (reason, details) =
        crate::ipykernel_error::classify_ipykernel_diagnostic(&diagnostic, env_source.as_str());

    if room.local_environment_selection.is_preparing() {
        return Err(PrepareEnvFailure::Error { message: details });
    }

    // Manual launches can run on a restart while an older runtime agent is still
    // attached, so tear down the prior agent before writing `Error`. Auto-launch
    // checks trust before publishing so trust-blocked notebooks are not forced
    // into `Error`.
    if trigger == LaunchTrigger::Manual {
        reset_starting_state(room, None).await;
    } else if !trust_allows_auto_launch_error_publish(room).await {
        reset_starting_state(room, None).await;
        return Err(PrepareEnvFailure::Error { message: details });
    }

    let env_source_label = env_source.as_str().to_string();
    if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
        room.state.with_doc(|sd| {
            let _ = sd.clear_env_progress();
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

    Err(PrepareEnvFailure::Error { message: details })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_acquire_pool_env_routes_all_prewarmed_managers_including_pixi() {
        assert!(should_acquire_pool_env(
            "python",
            &EnvSource::Prewarmed(PackageManager::Uv)
        ));
        assert!(should_acquire_pool_env(
            "python",
            &EnvSource::Prewarmed(PackageManager::Conda)
        ));
        assert!(should_acquire_pool_env(
            "python",
            &EnvSource::Prewarmed(PackageManager::Pixi)
        ));
        assert!(should_acquire_pool_env(
            "python",
            &EnvSource::Unknown("conda:future".to_string())
        ));

        // Self-preparing, borrowed, kernelspec, and deno never take pool envs.
        assert!(!should_acquire_pool_env(
            "python",
            &EnvSource::Inline(PackageManager::Uv)
        ));
        assert!(!should_acquire_pool_env(
            "python",
            &EnvSource::Inline(PackageManager::Conda)
        ));
        assert!(!should_acquire_pool_env(
            "python",
            &EnvSource::Inline(PackageManager::Pixi)
        ));
        assert!(!should_acquire_pool_env(
            "python",
            &EnvSource::Pep723(PackageManager::Uv)
        ));
        assert!(!should_acquire_pool_env(
            "python",
            &EnvSource::Pep723(PackageManager::Pixi)
        ));
        assert!(!should_acquire_pool_env("python", &EnvSource::Pyproject));
        assert!(!should_acquire_pool_env("python", &EnvSource::PixiToml));
        assert!(!should_acquire_pool_env("python", &EnvSource::EnvYml));
        assert!(!should_acquire_pool_env(
            "python",
            &EnvSource::ExistingConda
        ));
        assert!(!should_acquire_pool_env("python", &EnvSource::Kernelspec));
        assert!(!should_acquire_pool_env("deno", &EnvSource::Deno));
        assert!(!should_acquire_pool_env(
            "deno",
            &EnvSource::Prewarmed(PackageManager::Uv)
        ));
    }

    #[test]
    fn build_launch_env_vars_precedence_uv_and_pixi_override_shell_overlay() {
        let overlay = Arc::new(ShellEnvOverlay::parse_null_separated(
            b"MY_SHELL_VAR=from-shell\0UV_OFFLINE=0\0",
        ));

        let with_shell = build_launch_env_vars(true, &overlay, true, true);
        assert_eq!(
            with_shell.get("MY_SHELL_VAR").map(String::as_str),
            Some("from-shell")
        );
        assert_eq!(
            with_shell.get("UV_OFFLINE").map(String::as_str),
            Some("1"),
            "daemon UV_OFFLINE must override imported shell value"
        );

        let without_shell = build_launch_env_vars(false, &overlay, true, false);
        assert!(!without_shell.contains_key("MY_SHELL_VAR"));
        assert_eq!(
            without_shell.get("UV_OFFLINE").map(String::as_str),
            Some("1")
        );
    }

    #[tokio::test]
    async fn auto_launch_env_failure_suppresses_error_when_trust_blocks_launch() {
        let dir = tempfile::tempdir().unwrap();
        let nb_path = dir.path().join("untrusted_inline.ipynb");
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            Some(nb_path),
            dir.path(),
            Arc::new(crate::blob_store::BlobStore::new(dir.path().join("blobs"))),
            false,
        );
        {
            let mut doc = room.doc.write().await;
            let mut metadata = doc.get_metadata_snapshot().unwrap_or_default();
            metadata.add_uv_dependency("not-approved-for-auto-launch-test");
            doc.set_metadata_snapshot(&metadata).unwrap();
        }
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
            .unwrap();

        let err = fail_environment_launch(
            LaunchTrigger::Auto,
            &room,
            &EnvSource::Inline(PackageManager::Uv),
            Some(KernelErrorReason::EnvironmentPrepareFailed),
            "Failed to prepare inline environment: synthetic error",
        )
        .await;
        assert!(matches!(err, PrepareEnvFailure::Error { .. }));

        // Untrusted inline deps reset starting state to NotStarted and suppress
        // publishing Error so the trust gate is not overwritten.
        let kernel = room.state.read(|sd| sd.read_state().kernel).unwrap();
        assert_eq!(
            kernel.lifecycle,
            RuntimeLifecycle::NotStarted,
            "auto-launch inline/PEP 723 failure must reset to NotStarted and suppress Error when trust blocks launch"
        );
        let trust = room.trust_state.read().await;
        assert_eq!(trust.status, runt_trust::TrustStatus::Untrusted);
    }

    #[tokio::test]
    async fn manual_launch_env_failure_publishes_error_reason_and_details() {
        let dir = tempfile::tempdir().unwrap();
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            dir.path(),
            Arc::new(crate::blob_store::BlobStore::new(dir.path().join("blobs"))),
            false,
        );
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
            .unwrap();

        let failure = fail_environment_launch(
            LaunchTrigger::Manual,
            &room,
            &EnvSource::Inline(PackageManager::Uv),
            Some(KernelErrorReason::EnvironmentPrepareFailed),
            "Failed to prepare inline environment: boom",
        )
        .await;
        match failure.into_response() {
            NotebookResponse::Error { error } => assert!(error.contains("boom")),
            other => panic!("expected Error response, got {:?}", other),
        }

        let kernel = room.state.read(|sd| sd.read_state().kernel).unwrap();
        assert_eq!(kernel.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(
            kernel.error_reason.as_deref(),
            Some(KernelErrorReason::EnvironmentPrepareFailed.as_str())
        );
        assert_eq!(
            kernel.error_details.as_deref(),
            Some("Failed to prepare inline environment: boom")
        );
    }
}
