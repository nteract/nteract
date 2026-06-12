//! runtimed CLI entry point.
//!
//! This runs the runtime daemon as a standalone process that manages
//! prewarmed Python environments for notebook windows.

// Allow `expect()` and `unwrap()` in tests
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use runtimed::client::PoolClient;
use runtimed::daemon::{Daemon, DaemonConfig};
use runtimed::service::ServiceManager;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "runtimed")]
#[command(version = concat!(env!("CARGO_PKG_VERSION"), "+", include_str!(concat!(env!("OUT_DIR"), "/git_hash.txt"))))]
#[command(about = "Runtime daemon for managing Jupyter environments")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Log level (defaults to "info" on nightly, "warn" on stable)
    #[arg(long, global = true)]
    log_level: Option<String>,

    /// Run in development mode (per-worktree isolation)
    ///
    /// When enabled, the daemon stores all state in ~/.cache/runt/worktrees/{hash}/
    /// instead of ~/.cache/runt/, allowing multiple worktrees to run their own
    /// isolated daemon instances.
    #[arg(long, global = true)]
    dev: bool,
}

fn daemon_binary_name() -> &'static str {
    runt_workspace::daemon_binary_basename()
}

fn daemon_service_name() -> &'static str {
    runt_workspace::daemon_service_basename()
}

fn cli_command_name() -> &'static str {
    runt_workspace::cli_command_name()
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the daemon (default if no command specified)
    Run {
        /// Socket path for the unified IPC socket (default: ~/.cache/runt*/runtimed.sock)
        #[arg(long)]
        socket: Option<PathBuf>,

        /// Cache directory for environments (default: ~/.cache/runt/envs)
        #[arg(long)]
        cache_dir: Option<PathBuf>,

        /// Directory for the content-addressed blob store (default: ~/.cache/runt/blobs)
        #[arg(long)]
        blob_store_dir: Option<PathBuf>,

        /// Initial UV pool gate; synced settings choose the effective target
        #[arg(
            long,
            default_value_t = runtimed_client::settings_doc::DEFAULT_UV_POOL_SIZE as usize
        )]
        uv_pool_size: usize,

        /// Initial Conda pool gate; synced settings choose the effective target
        #[arg(
            long,
            default_value_t = runtimed_client::settings_doc::DEFAULT_CONDA_POOL_SIZE as usize
        )]
        conda_pool_size: usize,

        /// Initial Pixi pool gate; synced settings choose the effective target
        #[arg(
            long,
            default_value_t = runtimed_client::settings_doc::DEFAULT_PIXI_POOL_SIZE as usize
        )]
        pixi_pool_size: usize,

        /// Override canonical settings JSON path.
        #[arg(long, hide = true)]
        settings_json: Option<PathBuf>,
    },

    /// Install daemon as a system service
    Install {
        /// Path to the daemon binary to install (default: current binary)
        #[arg(long)]
        binary: Option<PathBuf>,
    },

    // =========================================================================
    // Deprecated commands - use 'runt daemon' instead
    // =========================================================================
    /// [DEPRECATED] Use 'runt daemon uninstall' instead
    #[command(hide = true)]
    Uninstall,

    /// [DEPRECATED] Use 'runt daemon status' instead
    #[command(hide = true)]
    Status {
        #[arg(long)]
        json: bool,
    },

    /// [DEPRECATED] Use 'runt daemon start' instead
    #[command(hide = true)]
    Start,

    /// [DEPRECATED] Use 'runt daemon stop' instead
    #[command(hide = true)]
    Stop,

    /// [DEPRECATED] Use 'runt daemon flush' instead
    #[command(hide = true)]
    FlushPool,

    /// Run as a runtime agent subprocess (internal, used by coordinator)
    #[command(hide = true, name = "runtime-agent")]
    RuntimeAgent {
        /// Daemon socket path to connect to
        #[arg(long)]
        socket: PathBuf,
        /// Notebook ID to attach to
        #[arg(long)]
        notebook_id: String,
        /// Runtime agent ID
        #[arg(long)]
        runtime_agent_id: String,
        /// Blob store root path
        #[arg(long)]
        blob_root: PathBuf,
    },

    /// Run a runtime agent attached to a hosted cloud room over WebSocket
    /// (internal/automation). The daemon-managed kernel is unchanged; only the
    /// sync wire differs from `runtime-agent`. The credential is read from the
    /// environment (RUNT_CLOUD_TOKEN), never argv, so it can't leak into the
    /// process command line.
    #[command(hide = true, name = "cloud-runtime-agent")]
    CloudRuntimeAgent {
        /// Base URL of the notebook cloud (https/http; swapped to wss/ws).
        #[arg(long, default_value = "https://preview.runt.run")]
        cloud_url: String,
        /// Notebook id to attach to (room is `/n/<id>/sync`).
        #[arg(long)]
        notebook_id: String,
        /// Connection scope (a workstation runtime attaches as runtime_peer).
        #[arg(long, default_value = "runtime_peer")]
        scope: String,
        /// Auth kind; the token itself comes from RUNT_CLOUD_TOKEN.
        #[arg(long, value_enum, default_value_t = runtimed::workstation::CloudAuthKind::Oidc)]
        auth_kind: runtimed::workstation::CloudAuthKind,
        /// Operator suffix for the doc actor label (`<principal>/<operator>`).
        #[arg(long, default_value = "agent:runt")]
        operator: String,
        /// Blob store root path. Defaults to the daemon's standard blob store
        /// so a workstation one-liner needs no path flags.
        #[arg(long)]
        blob_root: Option<PathBuf>,
        /// Launch-on-attach: start a kernel in this explicit Python interpreter
        /// right after attaching (the `current_python` environment policy), so
        /// the runtime *starts* without waiting for an inbound LaunchKernel RPC
        /// (req #5, deferred). When omitted, the agent attaches only.
        #[arg(long)]
        python_path: Option<PathBuf>,
        /// Notebook file path on this workstation, for the launch-on-attach
        /// kernel (only used with --python-path).
        #[arg(long)]
        notebook_path: Option<String>,
        /// Working directory for notebook-id-only launch-on-attach kernels.
        /// Defaults to the process current directory.
        #[arg(long, alias = "cwd")]
        working_dir: Option<PathBuf>,
        /// Stable workstation id to present to the hosted room. Non-secret.
        #[arg(long)]
        workstation_id: Option<String>,
        /// Human-readable workstation name to present to the hosted room.
        /// Non-secret.
        #[arg(long)]
        workstation_display_name: Option<String>,
    },

    /// Serve this machine as a workstation for a hosted nteract cloud:
    /// register/heartbeat, poll attach jobs, and spawn one
    /// `cloud-runtime-agent` runtime peer per job. The workstation credential
    /// is read from RUNT_CLOUD_TOKEN (never argv); `runt workstation connect`
    /// stores it and `runt workstation run` launches this subcommand.
    #[command(name = "workstation-agent")]
    WorkstationAgent {
        /// Base URL of the notebook cloud (https/http).
        #[arg(long)]
        cloud_url: String,
        /// Stable workstation id (default: ws-<hostname slug>). Non-secret.
        #[arg(long)]
        workstation_id: Option<String>,
        /// Workstation name shown in the panel (default: hostname).
        #[arg(long)]
        display_name: Option<String>,
        /// Default working directory for runtime peers (default: current
        /// directory). Attach jobs may override it per job.
        #[arg(long)]
        working_dir: Option<PathBuf>,
        /// Python interpreter for launch-on-attach kernels (default: python3,
        /// then python, found on PATH).
        #[arg(long)]
        python_path: Option<PathBuf>,
        /// Attach-job poll interval in milliseconds.
        #[arg(long, default_value_t = runtimed::workstation::DEFAULT_POLL_MS, value_parser = clap::value_parser!(u64).range(1..))]
        poll_ms: u64,
        /// Registration heartbeat interval in milliseconds.
        #[arg(long, default_value_t = runtimed::workstation::DEFAULT_HEARTBEAT_MS, value_parser = clap::value_parser!(u64).range(1..))]
        heartbeat_ms: u64,
    },

    /// Warm a pool environment (internal, spawned by daemon warming loops).
    /// Reads JSON config from stdin, writes JSON events to stdout.
    #[command(hide = true, name = "warm-env")]
    WarmEnv,

    /// Dial a hosted notebook room over WebSocket and sync both documents as a
    /// diagnostic peer (internal/automation; absorbed the standalone
    /// `runt-cloud-peer` spike). Unlike `cloud-runtime-agent`, this peer does
    /// not own a kernel — it can add a cell, request execution, and observe the
    /// room's RuntimeStateDoc, which is what the hosted smoke tests need. The
    /// credential is read from RUNT_CLOUD_TOKEN, never argv.
    #[command(hide = true, name = "cloud-peer")]
    CloudPeer {
        /// Base URL of the notebook cloud (https/http; swapped to wss/ws).
        #[arg(long, default_value = "https://preview.runt.run")]
        cloud_url: String,
        /// Notebook id to attach to (room is `/n/<id>/sync`).
        #[arg(long)]
        notebook_id: String,
        /// Connection scope: viewer | editor | runtime_peer | owner.
        #[arg(long, default_value = "owner")]
        scope: String,
        /// Auth kind; the token itself comes from RUNT_CLOUD_TOKEN.
        #[arg(long, value_enum, default_value_t = runtimed::workstation::CloudAuthKind::Oidc)]
        auth_kind: runtimed::workstation::CloudAuthKind,
        /// Operator suffix for the doc actor label (`<principal>/<operator>`).
        #[arg(long, default_value = "agent:cloud-peer")]
        operator: String,
        /// After sync converges, add a code cell with this source.
        #[arg(long)]
        add_cell: Option<String>,
        /// After the added cell converges, send ExecuteCell for it and log the
        /// executions that appear in RuntimeStateDoc. Requires --add-cell.
        #[arg(long)]
        run_cell: bool,
        /// Auto-close after this many seconds (0 = run until disconnected).
        #[arg(long, default_value_t = 20)]
        seconds: u64,
    },
}

/// Get a log path that works even when HOME is not set.
/// Falls back to /tmp if the normal cache directory is unavailable.
fn early_log_path() -> PathBuf {
    // Try the standard location first
    if let Some(cache) = dirs::cache_dir() {
        let path = cache
            .join(runt_workspace::cache_namespace())
            .join("runtimed.log");
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_ok() {
                return path;
            }
        }
    }
    // Fallback to /tmp which should always be writable
    PathBuf::from("/tmp/runtimed-startup.log")
}

/// Write an early diagnostic message before logging is initialized.
/// This ensures we capture startup failures even when HOME is not set.
fn early_log(msg: &str) {
    use std::io::Write;
    let path = early_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "{} [STARTUP] {}", timestamp, msg);
    }
}

/// Formats timestamps using local time, matching our existing log format.
/// Uses chrono::Local directly to handle DST transitions correctly
/// (unlike `OffsetTime` which captures the offset once at startup).
#[derive(Clone)]
struct LocalTime;

impl tracing_subscriber::fmt::time::FormatTime for LocalTime {
    fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> std::fmt::Result {
        write!(w, "{}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Install panic hook to ensure panics are logged to the daemon log file.
    // Uses early_log_path() which falls back to /tmp if HOME is not set.
    std::panic::set_hook(Box::new(|panic_info| {
        use std::io::Write;

        let log_path = early_log_path();
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let bt = std::backtrace::Backtrace::force_capture();
        let msg = format!("{} [PANIC] runtimed: {}\n{}", timestamp, panic_info, bt);

        // Write to stderr (visible in terminal)
        eprintln!("{}", msg);

        // Also append to log file so it's captured for debugging.
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "{}", msg);
        }
    }));

    let cli = Cli::parse();

    // Set dev mode environment variable if flag is used
    if cli.dev {
        std::env::set_var("RUNTIMED_DEV", "1");
    }

    // Initialize logging - write to both stderr and log file
    let log_path = runtimed::default_log_path();
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // Rotate the previous session's log so the current file only contains
    // this daemon run. Keeps one old copy (.log.1) for crash diagnosis via
    // `runt diagnostics`. Only runs on the daemon path — subcommands like
    // `status` or `install` must not touch the live log.
    if matches!(cli.command, None | Some(Commands::Run { .. })) {
        let prev = log_path.with_extension("log.1");
        let _ = std::fs::rename(&log_path, &prev);
    }

    // Log startup diagnostics after rotation so the breadcrumb lands in the
    // current session's log file, not in .log.1. The panic hook above still
    // catches crashes before this point.
    early_log(&format!(
        "runtimed starting: pid={}, HOME={:?}, USER={:?}",
        std::process::id(),
        std::env::var("HOME").ok(),
        std::env::var("USER").ok()
    ));

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path);

    let effective_log_level =
        cli.log_level
            .unwrap_or_else(|| match runt_workspace::build_channel() {
                runt_workspace::BuildChannel::Nightly => {
                    "info,notebook_sync=debug,runtimed::notebook_sync_server=debug".to_string()
                }
                runt_workspace::BuildChannel::Stable => "warn".to_string(),
            });

    // Build tracing subscriber with stderr + optional file output.
    // EnvFilter respects RUST_LOG env var, falling back to channel defaults.
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&effective_log_level));

    let timer = LocalTime;

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_timer(timer.clone());

    // File layer writes to the log file without ANSI escape codes.
    // If the file can't be opened, we fall back to stderr-only logging.
    let file_layer = log_file.ok().map(|file| {
        tracing_subscriber::fmt::layer()
            .with_writer(std::sync::Mutex::new(file))
            .with_ansi(false)
            .with_timer(timer)
    });

    use tracing_subscriber::prelude::*;
    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .init();

    // Log dev mode status
    if runt_workspace::is_dev_mode() {
        if let Some(worktree) = runt_workspace::get_workspace_path() {
            info!(
                "Development mode enabled for worktree: {}",
                worktree.display()
            );
            info!("Logs: {}", log_path.display());
            if let Some(name) = runt_workspace::get_workspace_name() {
                info!("Workspace description: {}", name);
            }
        } else {
            info!("Development mode enabled (no worktree detected)");
        }
    }

    match cli.command {
        None | Some(Commands::Run { .. }) => {
            // Extract run args from command or use defaults
            let (
                socket,
                cache_dir,
                blob_store_dir,
                uv_pool_size,
                conda_pool_size,
                pixi_pool_size,
                settings_json,
            ) = match cli.command {
                Some(Commands::Run {
                    socket,
                    cache_dir,
                    blob_store_dir,
                    uv_pool_size,
                    conda_pool_size,
                    pixi_pool_size,
                    settings_json,
                }) => (
                    socket,
                    cache_dir,
                    blob_store_dir,
                    uv_pool_size,
                    conda_pool_size,
                    pixi_pool_size,
                    settings_json,
                ),
                _ => (
                    None,
                    None,
                    None,
                    runtimed_client::settings_doc::DEFAULT_UV_POOL_SIZE as usize,
                    runtimed_client::settings_doc::DEFAULT_CONDA_POOL_SIZE as usize,
                    runtimed_client::settings_doc::DEFAULT_PIXI_POOL_SIZE as usize,
                    None,
                ),
            };

            let config = DaemonConfig {
                socket_path: socket.unwrap_or_else(runt_workspace::default_socket_path),
                cache_dir: cache_dir.unwrap_or_else(runtimed::default_cache_dir),
                blob_store_dir: blob_store_dir.unwrap_or_else(runtimed::default_blob_store_dir),
                execution_store_dir: runtimed::default_execution_store_dir(),
                uv_pool_size,
                conda_pool_size,
                pixi_pool_size,
                settings_json_path: settings_json,
                ..Default::default()
            };

            run_daemon(config).await
        }
        Some(Commands::Install { binary }) => install_service(binary),
        // Deprecated commands - still work but print warnings
        Some(Commands::Uninstall) => {
            eprintln!(
                "Warning: '{} uninstall' is deprecated. Use '{} daemon uninstall' instead.",
                daemon_binary_name(),
                cli_command_name()
            );
            uninstall_service()
        }
        Some(Commands::Status { json }) => {
            eprintln!(
                "Warning: '{} status' is deprecated. Use '{} daemon status' instead.",
                daemon_binary_name(),
                cli_command_name()
            );
            status(json).await
        }
        Some(Commands::Start) => {
            eprintln!(
                "Warning: '{} start' is deprecated. Use '{} daemon start' instead.",
                daemon_binary_name(),
                cli_command_name()
            );
            start_service()
        }
        Some(Commands::Stop) => {
            eprintln!(
                "Warning: '{} stop' is deprecated. Use '{} daemon stop' instead.",
                daemon_binary_name(),
                cli_command_name()
            );
            stop_service()
        }
        Some(Commands::FlushPool) => {
            eprintln!(
                "Warning: '{} flush-pool' is deprecated. Use '{} daemon flush' instead.",
                daemon_binary_name(),
                cli_command_name()
            );
            flush_pool().await
        }
        Some(Commands::RuntimeAgent {
            socket,
            notebook_id,
            runtime_agent_id,
            blob_root,
        }) => runtimed::runtime_agent::run_runtime_agent(
            socket,
            notebook_id,
            runtime_agent_id,
            blob_root,
        )
        .await
        .map_err(|e| {
            eprintln!("[runtime-agent] Fatal: {}", e);
            e
        }),
        Some(Commands::CloudRuntimeAgent {
            cloud_url,
            notebook_id,
            scope,
            auth_kind,
            operator,
            blob_root,
            python_path,
            notebook_path,
            working_dir,
            workstation_id,
            workstation_display_name,
        }) => {
            let cli_args = runtimed::workstation::CloudAgentArgs {
                cloud_url,
                notebook_id,
                scope,
                auth_kind,
            };
            let mut config =
                runtimed::workstation::build_cloud_config(&cli_args, |k| std::env::var(k).ok())
                    .map_err(|e| {
                        eprintln!("[cloud-runtime-agent] Config error: {}", e);
                        e
                    })?;
            let blob_root = blob_root.unwrap_or_else(runtimed::default_blob_store_dir);
            let resolved_working_dir = working_dir.or_else(|| std::env::current_dir().ok());
            if python_path.is_none()
                && (workstation_id.is_some()
                    || workstation_display_name.is_some()
                    || resolved_working_dir.is_some())
            {
                config.workstation = Some(notebook_cloud_transport::CloudWorkstationMetadata {
                    workstation_id: workstation_id.clone(),
                    display_name: workstation_display_name.clone(),
                    default_environment_label: None,
                    environment_policy: None,
                    working_directory: resolved_working_dir
                        .as_deref()
                        .map(|path| path.to_string_lossy().into_owned()),
                });
            }
            let result = match python_path {
                // Launch-on-attach: allocate and *start* a current_python runtime.
                Some(python_path) => {
                    let launch_working_dir =
                        runtimed::workstation::current_python_launch_working_dir(
                            notebook_path.as_deref(),
                            resolved_working_dir.as_deref(),
                        );
                    let mut workstation_metadata =
                        runtimed::workstation::current_python_workstation_metadata(
                            launch_working_dir.as_deref(),
                        );
                    workstation_metadata.workstation_id = workstation_id;
                    workstation_metadata.display_name = workstation_display_name;
                    let target = runtimed::workstation::RoomTarget {
                        cloud_url: config.cloud_url.clone(),
                        notebook_id: config.notebook_id.clone(),
                        scope: config.scope.clone(),
                        operator,
                        workstation: Some(workstation_metadata),
                    };
                    runtimed::workstation::allocate_current_python_runtime(
                        target,
                        config.auth,
                        python_path,
                        notebook_path,
                        launch_working_dir,
                        std::collections::HashMap::new(),
                        blob_root,
                    )
                    .await
                }
                // Attach-only: wait for an inbound launch (req #5, deferred).
                None => {
                    runtimed::runtime_agent::run_cloud_runtime_agent(
                        config, operator, blob_root, None,
                    )
                    .await
                }
            };
            result.map_err(|e| {
                eprintln!("[cloud-runtime-agent] Fatal: {}", e);
                e
            })
        }
        Some(Commands::WorkstationAgent {
            cloud_url,
            workstation_id,
            display_name,
            working_dir,
            python_path,
            poll_ms,
            heartbeat_ms,
        }) => {
            let token = std::env::var(runtimed::workstation::CLOUD_TOKEN_ENV)
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .ok_or_else(|| {
                    let msg = format!(
                        "workstation credential not found; set {} (never passed on argv)",
                        runtimed::workstation::CLOUD_TOKEN_ENV
                    );
                    eprintln!("[workstation-agent] {msg}");
                    anyhow::anyhow!(msg)
                })?;
            let hostname = runt_workspace::machine_hostname();
            let workstation_id =
                workstation_id.unwrap_or_else(|| runt_workspace::stable_workstation_id(&hostname));
            let display_name = display_name.unwrap_or(hostname);
            let working_dir = match working_dir {
                Some(dir) => dir,
                None => std::env::current_dir()
                    .map_err(|e| anyhow::anyhow!("resolve current directory: {e}"))?,
            };
            let python_path = match python_path {
                Some(path) => path,
                None => runtimed::workstation::resolve_python_on_path(
                    std::env::var("PATH").ok().as_deref(),
                )
                .ok_or_else(|| {
                    let msg = "no python3 or python found on PATH; pass --python-path";
                    eprintln!("[workstation-agent] {msg}");
                    anyhow::anyhow!(msg)
                })?,
            };
            let options = runtimed::workstation::WorkstationAgentOptions {
                cloud_url,
                workstation_id,
                display_name,
                working_dir,
                python_path,
                poll_interval: std::time::Duration::from_millis(poll_ms),
                heartbeat_interval: std::time::Duration::from_millis(heartbeat_ms),
                agent_root: runt_workspace::daemon_base_dir().join("workstation-agent"),
            };
            runtimed::workstation::run_workstation_agent(options, token)
                .await
                .map_err(|e| {
                    eprintln!("[workstation-agent] Fatal: {}", e);
                    e
                })
        }
        Some(Commands::WarmEnv) => {
            runtimed::warm_env::run().await;
            Ok(())
        }
        Some(Commands::CloudPeer {
            cloud_url,
            notebook_id,
            scope,
            auth_kind,
            operator,
            add_cell,
            run_cell,
            seconds,
        }) => {
            let cli_args = runtimed::workstation::CloudAgentArgs {
                cloud_url,
                notebook_id,
                scope,
                auth_kind,
            };
            let config =
                runtimed::workstation::build_cloud_config(&cli_args, |k| std::env::var(k).ok())
                    .map_err(|e| {
                        eprintln!("[cloud-peer] Config error: {}", e);
                        e
                    })?;
            runtimed::cloud_peer::run_cloud_peer(
                config,
                operator,
                runtimed::cloud_peer::CloudPeerActions {
                    add_cell,
                    run_cell,
                    seconds,
                },
            )
            .await
            .map_err(|e| {
                eprintln!("[cloud-peer] Fatal: {}", e);
                e
            })
        }
    }
}

async fn run_daemon(config: DaemonConfig) -> anyhow::Result<()> {
    info!("runtimed starting...");

    info!("Configuration:");
    info!("  Socket: {:?}", config.socket_path);
    info!("  Cache dir: {:?}", config.cache_dir);
    info!("  Blob store: {:?}", config.blob_store_dir);
    info!("  Execution store: {:?}", config.execution_store_dir);
    info!("  UV pool size: {}", config.uv_pool_size);
    info!("  Conda pool size: {}", config.conda_pool_size);
    info!("  Pixi pool size: {}", config.pixi_pool_size);
    let daemon = match Daemon::new(config) {
        Ok(d) => d,
        Err(e) => {
            // Another daemon is already running — this is expected during
            // launchd double-start races, NOT a crash. Exit 0 so launchd's
            // KeepAlive.Crashed does not restart us.
            let msg = format!(
                "Another daemon already running (pid={}, endpoint={}), exiting cleanly",
                e.info.pid, e.info.endpoint
            );
            early_log(&msg);
            eprintln!("{msg}");
            std::process::exit(0);
        }
    };

    runtimed::daemon_telemetry::spawn_daemon_heartbeat(daemon.clone());

    // Set up signal handlers for graceful shutdown with logging
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let shutdown_daemon = daemon.clone();

        runtimed::task_supervisor::spawn_best_effort("signal-handler", async move {
            #[allow(clippy::expect_used)]
            // Signal registration failure is a fundamental OS issue with no recovery
            let mut sigterm = signal(SignalKind::terminate()).expect("failed to register SIGTERM");
            #[allow(clippy::expect_used)]
            // Signal registration failure is a fundamental OS issue with no recovery
            let mut sigint = signal(SignalKind::interrupt()).expect("failed to register SIGINT");

            tokio::select! {
                _ = sigterm.recv() => {
                    early_log("Received SIGTERM, initiating shutdown");
                }
                _ = sigint.recv() => {
                    early_log("Received SIGINT, initiating shutdown");
                }
            }
            shutdown_daemon.trigger_shutdown().await;
        });
    }

    let result = daemon.run().await;
    match &result {
        Ok(()) => early_log("Daemon exited: Ok (graceful shutdown)"),
        Err(e) => early_log(&format!("Daemon exited: Err: {}", e)),
    }
    result
}

fn install_service(binary: Option<PathBuf>) -> anyhow::Result<()> {
    let source_binary = match binary {
        Some(path) => path,
        None => std::env::current_exe()?,
    };

    println!("Installing {} service...", daemon_service_name());
    println!("Source binary: {}", source_binary.display());
    println!(
        "Binary version: {}+{}",
        env!("CARGO_PKG_VERSION"),
        include_str!(concat!(env!("OUT_DIR"), "/git_hash.txt"))
    );

    let mut manager = ServiceManager::default();

    if manager.is_installed() {
        // Already installed - upgrade the binary instead of failing
        // upgrade() handles: stop old -> copy binary -> start new
        println!("Service already installed, upgrading...");
        manager.upgrade(&source_binary)?;
    } else {
        // Fresh install
        manager.install(&source_binary)?;
        println!("Starting daemon...");
        manager.start()?;
    }

    println!();
    println!("Service installed and running!");
    println!("The daemon will start automatically at login.");
    println!();
    println!("To check status: {} daemon status", cli_command_name());
    println!("To uninstall:    {} daemon uninstall", cli_command_name());

    Ok(())
}

fn uninstall_service() -> anyhow::Result<()> {
    println!("Uninstalling {} service...", daemon_service_name());

    let manager = ServiceManager::default();

    if !manager.is_installed() {
        println!("Service not installed.");
        return Ok(());
    }

    manager.uninstall()?;

    println!("Service uninstalled successfully.");

    Ok(())
}

async fn status(json: bool) -> anyhow::Result<()> {
    let manager = ServiceManager::default();
    let installed = manager.is_installed();

    // Check if daemon is running — socket-first with `daemon.json`
    // fallback so custom `--socket` daemons stay discoverable.
    let daemon_info =
        runtimed_client::singleton::query_daemon_info(runt_workspace::default_socket_path()).await;
    let running = if daemon_info.is_some() {
        // Try to ping to confirm it's actually responding
        let client = PoolClient::default();
        client.ping().await.is_ok()
    } else {
        false
    };

    // Get pool stats if running
    let stats = if running {
        let client = PoolClient::default();
        client.status().await.ok()
    } else {
        None
    };

    if json {
        let output = serde_json::json!({
            "installed": installed,
            "running": running,
            "daemon_info": daemon_info,
            "pool_stats": stats,
        });
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        println!("{} Status", daemon_service_name());
        println!("===============");
        println!(
            "Service installed: {}",
            if installed { "yes" } else { "no" }
        );
        println!("Daemon running:    {}", if running { "yes" } else { "no" });

        if let Some(info) = daemon_info {
            println!();
            println!("Daemon Info:");
            println!("  PID:      {}", info.pid);
            println!("  Endpoint: {}", info.endpoint);
            println!("  Version:  {}", info.version);
            println!("  Started:  {}", info.started_at);
        }

        if let Some(state) = stats {
            println!();
            println!("Pool Statistics:");
            println!(
                "  UV:    {}/{} available",
                state.uv.available,
                state.uv.available + state.uv.warming
            );
            println!(
                "  Conda: {}/{} available",
                state.conda.available,
                state.conda.available + state.conda.warming
            );
        }
    }

    Ok(())
}

fn start_service() -> anyhow::Result<()> {
    let manager = ServiceManager::default();

    if !manager.is_installed() {
        eprintln!(
            "Service not installed. Run '{} install' first.",
            daemon_binary_name()
        );
        std::process::exit(1);
    }

    println!("Starting {} service...", daemon_service_name());
    manager.start()?;
    println!("Service started.");

    Ok(())
}

fn stop_service() -> anyhow::Result<()> {
    let manager = ServiceManager::default();

    if !manager.is_installed() {
        eprintln!("Service not installed.");
        std::process::exit(1);
    }

    println!("Stopping {} service...", daemon_service_name());
    manager.stop()?;
    println!("Service stopped.");

    Ok(())
}

async fn flush_pool() -> anyhow::Result<()> {
    let client = PoolClient::default();

    if !client.is_daemon_running().await {
        eprintln!("Daemon is not running.");
        std::process::exit(1);
    }

    println!("Flushing pool environments...");
    client
        .flush_pool()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to flush pool: {}", e))?;
    println!("Pool flushed. Environments will be rebuilt with current settings.");

    Ok(())
}
