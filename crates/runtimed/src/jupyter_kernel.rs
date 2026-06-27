// Mutex::lock only fails if another thread panicked while holding the lock.
// In that case the program is already crashing, so unwrap is acceptable here.
// The shell_writer unwrap at execute() is guarded by an early-return check.
#![allow(clippy::unwrap_used)]
//! JupyterKernel — concrete `KernelConnection` implementation.
//!
//! Owns the IO-bound parts of a Jupyter kernel: ZeroMQ connections, spawned
//! task handles, request/response infrastructure, process lifecycle.  Does
//! **not** hold queue, executing cell, or status — those live in `KernelState`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Result;
use bytes::Bytes;
use jupyter_protocol::{
    CompleteRequest, ConnectionInfo, ExecuteRequest, HistoryRequest, InterruptRequest,
    JupyterMessage, JupyterMessageContent, KernelInfoRequest, ShutdownRequest,
};
use runtime_doc::{KernelActivity, RuntimeLifecycle};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::async_outcome::{
    await_result_with_timeout, recv_oneshot_with_timeout, TimedOneShot, TimedResult,
};
use crate::kernel_connection::{KernelConnection, KernelLaunchConfig, KernelSharedRefs};
use crate::output_committer::{OrdinaryOutputCommit, OrdinaryOutputKind};
use crate::output_prep::{
    blob_store_large_state_values, escape_glob_pattern, extract_buffer_paths,
    media_to_display_data, message_content_to_nbformat, queue_command_channels,
    store_widget_buffers, LifecycleSignal, QueueCommandReceivers, WorkCommand,
};
use crate::output_redaction::OutputRedactor;
use crate::output_store::{self, OutputManifest, DEFAULT_INLINE_THRESHOLD};
use crate::protocol::{CompletionItem, HistoryEntry, NotebookBroadcast};
use crate::stream_flush::StreamFlushBuffer;
use crate::stream_terminal::StreamTerminals;
use crate::task_supervisor::{spawn_best_effort, spawn_supervised};
use crate::terminal_size::{TERMINAL_COLUMNS_STR, TERMINAL_LINES_STR};
use crate::EnvType;
use notebook_protocol::protocol::{CommRequestMessage, KernelPorts, LaunchedEnvConfig};

const REDACT_ENV_VALUES_IN_OUTPUTS_ENV: &str = "NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS";
const KERNEL_ENV_SECRET_BLOCKLIST: &[&str] = &[
    "RUNT_CLOUD_TOKEN",
    "NTERACT_API_KEY",
    "NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN",
];

enum CommCoalesceMessage {
    StateDelta {
        comm_id: String,
        delta: serde_json::Value,
    },
    MplCanvasFrame {
        comm_id: String,
        png: Vec<u8>,
        size: Option<(u64, u64)>,
    },
}

struct PendingMplCanvasFrame {
    png: Vec<u8>,
    size: Option<(u64, u64)>,
}

fn mpl_size_from_state(state: &serde_json::Value) -> Option<(u64, u64)> {
    let size = state.get("_size").and_then(|v| v.as_array())?;
    let width = size.first()?.as_u64()?;
    let height = size.get(1)?.as_u64()?;
    Some((width, height))
}

fn content_with_mpl_canvas_image_mode(
    mut content: serde_json::Value,
    mode: &str,
) -> serde_json::Value {
    if let Some(inner) = content
        .get_mut("data")
        .and_then(|data| data.get_mut("content"))
        .and_then(|inner| inner.as_object_mut())
    {
        inner.insert(
            "_nteract_image_mode".to_string(),
            serde_json::Value::String(mode.to_string()),
        );
    }
    content
}

fn is_tolerated_kernel_info_reply_parse_error(error: &jupyter_zmq_client::RuntimeError) -> bool {
    match error {
        jupyter_zmq_client::RuntimeError::ParseError { msg_type, source } => {
            // Deno kernels can report a CodeMirror mode shape that the current
            // upstream jupyter_protocol enum does not model. `shell.read()` has
            // already consumed that kernel_info_reply frame before returning the
            // parse error, so this narrow case is enough to prove liveness.
            msg_type == "kernel_info_reply" && source.to_string().contains("CodeMirrorMode")
        }
        _ => false,
    }
}

#[cfg(unix)]
fn ipc_path_prefix(kernel_id: &str) -> PathBuf {
    crate::ipc_socket_dir().join(format!("kernel-{}-ipc", kernel_id))
}

#[cfg(unix)]
pub(crate) fn cleanup_ipc_sockets(prefix: &Path) {
    for port in 1..=5u16 {
        let _ = std::fs::remove_file(format!("{}-{}", prefix.display(), port));
    }
}

#[cfg(not(unix))]
pub(crate) fn cleanup_ipc_sockets(_prefix: &Path) {}

fn captured_stderr_tail(stderr_buffer: &Arc<StdMutex<VecDeque<String>>>) -> String {
    let captured = {
        let queue = stderr_buffer.lock().unwrap();
        queue.iter().cloned().collect::<Vec<_>>().join("\n")
    };
    if captured.is_empty() {
        "(no stderr captured before exit)".to_string()
    } else {
        format!("stderr tail:\n{}", captured)
    }
}

fn kernel_process_exit_message(
    exit_status: std::process::ExitStatus,
    stderr_buffer: &Arc<StdMutex<VecDeque<String>>>,
) -> String {
    format!(
        "Kernel process exited: {}\n{}",
        exit_status,
        captured_stderr_tail(stderr_buffer)
    )
}

fn kernel_process_exited_error(
    kernel_id: &str,
    exit_status: std::process::ExitStatus,
    stderr_buffer: &Arc<StdMutex<VecDeque<String>>>,
    ipc_prefix: Option<&Path>,
) -> anyhow::Error {
    if let Some(prefix) = ipc_prefix {
        cleanup_ipc_sockets(prefix);
    }
    let message = kernel_process_exit_message(exit_status, stderr_buffer);
    error!(
        "[jupyter-kernel] Kernel process exited before launch completed: kernel_id={}\n{}",
        kernel_id, message
    );
    anyhow::anyhow!(message)
}

fn check_kernel_process_still_running(
    process: &mut tokio::process::Child,
    kernel_id: &str,
    stderr_buffer: &Arc<StdMutex<VecDeque<String>>>,
    ipc_prefix: Option<&Path>,
) -> Result<()> {
    match process.try_wait() {
        Ok(Some(status)) => Err(kernel_process_exited_error(
            kernel_id,
            status,
            stderr_buffer,
            ipc_prefix,
        )),
        Ok(None) => Ok(()),
        Err(e) => {
            warn!(
                "[jupyter-kernel] Could not check kernel process status: {}",
                e
            );
            Ok(())
        }
    }
}

async fn bind_kernel_port_listeners(ip: IpAddr, ports: KernelPorts) -> Result<Vec<TcpListener>> {
    let port_numbers = [
        ports.stdin,
        ports.control,
        ports.hb,
        ports.shell,
        ports.iopub,
    ];
    let mut listeners = Vec::with_capacity(port_numbers.len());
    for port in port_numbers {
        listeners.push(TcpListener::bind(SocketAddr::new(ip, port)).await?);
    }
    Ok(listeners)
}

/// Type alias for pending completion response channels.
type PendingCompletions =
    Arc<StdMutex<HashMap<String, oneshot::Sender<(Vec<CompletionItem>, usize, usize)>>>>;

const HISTORY_CACHE_CAPACITY: usize = 64;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct HistoryCacheKey {
    pattern: Option<String>,
    unique: bool,
}

impl HistoryCacheKey {
    fn new(pattern: Option<&str>, unique: bool) -> Self {
        Self {
            pattern: pattern
                .filter(|pattern| !pattern.is_empty())
                .map(str::to_string),
            unique,
        }
    }
}

#[derive(Clone, Debug)]
struct HistoryCacheValue {
    requested_limit: i32,
    entries: Vec<HistoryEntry>,
}

#[derive(Debug)]
struct HistoryLruCache {
    capacity: usize,
    entries: HashMap<HistoryCacheKey, HistoryCacheValue>,
    lru: VecDeque<HistoryCacheKey>,
}

impl HistoryLruCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            lru: VecDeque::new(),
        }
    }

    fn get(&mut self, key: &HistoryCacheKey, limit: i32) -> Option<Vec<HistoryEntry>> {
        let value = self.entries.get(key)?;
        if !history_cache_value_satisfies_limit(value, limit) {
            return None;
        }

        let mut results = value.entries.clone();
        results.truncate(normalize_history_limit(limit));
        self.touch(key);
        Some(results)
    }

    fn insert(&mut self, key: HistoryCacheKey, requested_limit: i32, entries: Vec<HistoryEntry>) {
        if self.capacity == 0 {
            return;
        }

        self.entries.insert(
            key.clone(),
            HistoryCacheValue {
                requested_limit,
                entries,
            },
        );
        self.touch(&key);

        while self.entries.len() > self.capacity {
            if let Some(oldest) = self.lru.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn touch(&mut self, key: &HistoryCacheKey) {
        self.lru.retain(|candidate| candidate != key);
        self.lru.push_back(key.clone());
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.lru.clear();
    }
}

fn normalize_history_limit(limit: i32) -> usize {
    limit.max(0) as usize
}

fn history_cache_value_satisfies_limit(value: &HistoryCacheValue, limit: i32) -> bool {
    let requested = normalize_history_limit(limit);
    let fetched = normalize_history_limit(value.requested_limit);
    fetched >= requested || value.entries.len() < fetched
}

/// Handle for interrupting a kernel without exclusive access.
///
/// What an IOPub status message translates to on the RuntimeStateDoc.
///
/// Either a lifecycle transition (Starting/Restarting/Terminating/Dead —
/// infrequent, always written) or an activity flip (Idle/Busy — hot path,
/// throttled by `set_activity`). Kept local to this file because it is
/// only a dispatch helper for the IOPub handler.
enum IoPubStateUpdate {
    Activity(KernelActivity),
    Lifecycle(RuntimeLifecycle),
}

fn try_send_comm_update(
    work_tx: &crate::output_prep::NonBlockingSender<WorkCommand>,
    comm_id: String,
    state: serde_json::Value,
) {
    match work_tx.try_send(WorkCommand::SendCommUpdate {
        comm_id,
        state,
        buffer_paths: vec![],
        buffers: vec![],
    }) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(WorkCommand::SendCommUpdate { comm_id, .. })) => {
            debug!(
                "[jupyter-kernel] Dropping comm output replay for comm_id={} because work queue is full",
                comm_id
            );
        }
        Err(mpsc::error::TrySendError::Closed(WorkCommand::SendCommUpdate { comm_id, .. })) => {
            warn!(
                "[jupyter-kernel] Dropping comm output replay for comm_id={} because work queue is closed",
                comm_id
            );
        }
    }
}

async fn resolve_output_widget_replay_state(
    replay_cache: &mut HashMap<String, Vec<serde_json::Value>>,
    comm_id: &str,
    output_manifests: &[serde_json::Value],
    appended_manifest: &OutputManifest,
    cleared_before_append: bool,
    blob_store: &crate::blob_store::BlobStore,
) -> Vec<serde_json::Value> {
    if cleared_before_append {
        replay_cache.remove(comm_id);
    }

    let cached_outputs = replay_cache.entry(comm_id.to_string()).or_default();
    if cached_outputs.len() + 1 == output_manifests.len() {
        match output_store::resolve_manifest(appended_manifest, blob_store).await {
            Ok(resolved) => cached_outputs.push(resolved),
            Err(e) => warn!(
                "[jupyter-kernel] Failed to resolve appended Output widget manifest for comm_id={}: {}",
                comm_id, e
            ),
        }
    } else {
        cached_outputs.clear();
        for output_manifest in output_manifests {
            match serde_json::from_value::<OutputManifest>(output_manifest.clone()) {
                Ok(manifest) => match output_store::resolve_manifest(&manifest, blob_store).await {
                    Ok(resolved) => cached_outputs.push(resolved),
                    Err(e) => warn!(
                        "[jupyter-kernel] Failed to resolve Output widget manifest for comm_id={}: {}",
                        comm_id, e
                    ),
                },
                Err(e) => warn!(
                    "[jupyter-kernel] Failed to parse Output widget manifest for comm_id={}: {}",
                    comm_id, e
                ),
            }
        }
    }

    cached_outputs.clone()
}

/// Created at kernel launch time, captures connection_info and session_id.
/// Can be used concurrently with other kernel operations since interrupt
/// creates its own ZMQ control connection.
#[derive(Clone)]
pub struct InterruptHandle {
    connection_info: ConnectionInfo,
    session_id: String,
}

impl InterruptHandle {
    pub async fn interrupt(&self) -> Result<()> {
        let mut control = jupyter_zmq_client::create_client_control_connection(
            &self.connection_info,
            &self.session_id,
        )
        .await?;

        let request: JupyterMessage = InterruptRequest {}.into();
        control.send(request).await?;

        info!("[jupyter-kernel] Sent interrupt_request (via handle)");

        match await_result_with_timeout(control.read(), std::time::Duration::from_secs(5)).await {
            TimedResult::Completed(_reply) => {
                info!("[jupyter-kernel] Received interrupt_reply");
            }
            TimedResult::Failed(e) => {
                warn!("[jupyter-kernel] Error receiving interrupt_reply: {}", e);
            }
            TimedResult::TimedOut => {
                warn!("[jupyter-kernel] Timed out waiting for interrupt_reply (5s)");
            }
        }

        Ok(())
    }
}

/// A Jupyter kernel connection that implements `KernelConnection`.
///
/// Holds the IO-bound parts of a kernel connection: ZeroMQ sockets, spawned
/// background tasks, and request/response infrastructure.  Queue management
/// and state transitions live in `KernelState`.
///
/// Some fields (e.g., `kernel_actor_id`, `comm_seq`, `stream_terminals`) are
/// cloned into spawned tasks during `launch()` and not read from `&self`
/// methods directly, but must be kept alive for the struct's lifetime.
#[allow(dead_code)]
pub struct JupyterKernel {
    /// Kernel type (e.g., "python", "deno").
    kernel_type: String,
    /// Environment source (e.g., "uv:inline", "conda:prewarmed").
    env_source: String,
    /// Environment configuration used at launch (for sync detection).
    launched_config: LaunchedEnvConfig,
    /// Path to the environment directory backing this kernel (if any).
    pub env_path: Option<PathBuf>,
    /// Session ID for Jupyter protocol.
    session_id: String,
    /// Automerge actor ID for kernel writes.
    kernel_actor_id: String,
    /// Connection info for the kernel.
    connection_info: Option<ConnectionInfo>,
    /// Path to the connection file.
    connection_file: Option<PathBuf>,
    /// Shell writer for sending execute requests.
    shell_writer: Option<jupyter_zmq_client::DealerSendConnection>,
    /// IPC socket path prefix for cleanup (Unix only).
    #[cfg(unix)]
    ipc_prefix: Option<PathBuf>,
    /// Kernel process PID for signal-based cleanup (Unix only).
    #[cfg(unix)]
    kernel_pid: Option<i32>,
    /// Handle to the iopub listener task.
    iopub_task: Option<JoinHandle<()>>,
    /// Handle to the shell reader task.
    shell_reader_task: Option<JoinHandle<()>>,
    /// Handle to the process watcher task (detects process exit).
    process_watcher_task: Option<JoinHandle<()>>,
    /// Handle to the heartbeat monitor task (detects unresponsive kernel).
    heartbeat_task: Option<JoinHandle<()>>,
    /// Channel for coalesced comm state writes (IOPub -> coalesce task).
    comm_coalesce_tx: Option<mpsc::UnboundedSender<CommCoalesceMessage>>,
    /// Handle to the coalescing task for comm state CRDT writes.
    comm_coalesce_task: Option<JoinHandle<()>>,
    /// Execution IDs sent through this kernel.
    /// With msg_id = execution_id, parent_header.msg_id IS the execution_id.
    registered_execution_ids: Arc<StdMutex<HashSet<String>>>,
    /// Work command sender for iopub/shell tasks.
    work_cmd_tx: Option<crate::output_prep::NonBlockingSender<WorkCommand>>,
    /// Lifecycle command sender for iopub/shell tasks.
    lifecycle_cmd_tx: Option<mpsc::UnboundedSender<LifecycleSignal>>,
    /// Monotonic counter for comm insertion order (written to RuntimeStateDoc).
    comm_seq: Arc<AtomicU64>,
    /// Pending history requests: msg_id -> response channel.
    pending_history: Arc<StdMutex<HashMap<String, oneshot::Sender<Vec<HistoryEntry>>>>>,
    /// Pending completion requests: msg_id -> response channel.
    pending_completions: PendingCompletions,
    /// Per-kernel LRU cache for history searches.
    history_cache: HistoryLruCache,
    /// Terminal emulators for stream outputs (stdout/stderr).
    stream_terminals: Arc<tokio::sync::Mutex<StreamTerminals>>,
}

impl KernelConnection for JupyterKernel {
    // ── Launch ────────────────────────────────────────────────────────────

    async fn launch(
        config: KernelLaunchConfig,
        shared: KernelSharedRefs,
    ) -> Result<(Self, QueueCommandReceivers)> {
        let kernel_type = config.kernel_type;
        let env_source = config.env_source;
        let notebook_path = config.notebook_path;
        let env = config.pooled_env;
        let direct_python_path = config.direct_python_path;
        let launched_config = config.launched_config;
        let bootstrap_dx = launched_config.feature_flags.bootstrap_dx;
        let env_path = env.as_ref().map(|e| e.venv_path.clone());
        let launch_started = std::time::Instant::now();
        info!(
            "[jupyter-kernel] Launch start: kernel_type={} env_source={} bootstrap_dx={} env_path={:?}",
            kernel_type, env_source, bootstrap_dx, env_path
        );

        // ── Build process command ────────────────────────────────────────

        // Determine kernel name for connection info
        let kernelspec_name = match kernel_type.as_str() {
            "python" => "python3",
            "deno" => "deno",
            _ => &kernel_type,
        };

        // Per-launch IP and stable connection-file path. Ports are
        // (re-)reserved inside the spawn loop below so the file's contents
        // can be rewritten with fresh port numbers on retry; the path itself
        // is what the kernel command-line points at, so keeping it stable
        // means we don't have to rebuild `cmd` between attempts.
        let ip = std::net::IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
        let conn_dir = crate::connections_dir();
        tokio::fs::create_dir_all(&conn_dir).await?;
        let kernel_id: String =
            petname::petname(2, "-").unwrap_or_else(|| Uuid::new_v4().to_string());
        let connection_file_path = conn_dir.join(format!("{}.json", kernel_id));
        info!(
            "[jupyter-kernel] Connection file path selected: kernel_id={} path={}",
            kernel_id,
            connection_file_path.display()
        );

        // Determine working directory
        let cwd = crate::uv_project::notebook_working_dir(notebook_path.as_deref());

        // Build kernel command based on kernel type
        let mut cmd = match kernel_type.as_str() {
            "python" => {
                match env_source.as_str() {
                    "uv:inline" => {
                        let pooled_env = env.ok_or_else(|| {
                            anyhow::anyhow!(
                                "uv:inline requires a prepared environment (was it created?)"
                            )
                        })?;
                        info!(
                            "[jupyter-kernel] Starting Python kernel with cached inline env at {:?}",
                            pooled_env.python_path
                        );
                        let launcher_module = if bootstrap_dx {
                            "nteract_kernel_launcher"
                        } else {
                            "ipykernel_launcher"
                        };
                        let mut cmd = tokio::process::Command::new(&pooled_env.python_path);
                        cmd.args(["-Xfrozen_modules=off", "-m", launcher_module, "-f"]);
                        cmd.arg(&connection_file_path);
                        cmd.stdout(Stdio::null());
                        cmd.stderr(Stdio::piped());
                        cmd.env("VIRTUAL_ENV", &pooled_env.venv_path);
                        if bootstrap_dx {
                            // Inline envs are daemon-owned and normally have
                            // the launcher vendored into site-packages, but
                            // old cache entries or pool-promoted envs may be
                            // missing it. Inject the daemon-side launcher so
                            // `-m nteract_kernel_launcher` works on cache hits
                            // without requiring users to clear inline-envs.
                            let dir = crate::launcher_cache::launcher_cache_dir().await?;
                            cmd.env("PYTHONPATH", &dir);
                        }
                        let uv_path = kernel_launch::tools::get_uv_path().await?;
                        if let Some(uv_dir) = uv_path.parent() {
                            cmd.env("PATH", prepend_to_path(uv_dir));
                        }
                        cmd
                    }
                    "uv:pyproject" => {
                        let uv_path = kernel_launch::tools::get_uv_path().await?;
                        info!(
                            "[jupyter-kernel] Starting Python kernel with uv run (env_source: {})",
                            env_source
                        );
                        let mut cmd = tokio::process::Command::new(&uv_path);
                        cmd.args(crate::uv_project::uv_pyproject_kernel_args(
                            bootstrap_dx,
                            &connection_file_path,
                        ));
                        cmd.stdout(Stdio::null());
                        cmd.stderr(Stdio::piped());
                        if bootstrap_dx {
                            // Inject the daemon-side launcher via PYTHONPATH
                            // instead of invoking it as a script. Running
                            // `python /path/to/launcher.py` would set
                            // `sys.path[0]` to the launcher's cache dir, which
                            // breaks sibling-module imports from the notebook
                            // cwd. `uv run` preserves env vars, and putting
                            // the launcher dir on PYTHONPATH keeps cwd at
                            // `sys.path[0]`.
                            crate::uv_project::apply_bootstrap_pythonpath(&mut cmd).await?;
                        }
                        cmd
                    }
                    "conda:inline" => {
                        let pooled_env = env.ok_or_else(|| {
                            anyhow::anyhow!(
                                "conda:inline requires a prepared environment (was it created?)"
                            )
                        })?;
                        info!(
                            "[jupyter-kernel] Starting Python kernel with cached conda inline env at {:?}",
                            pooled_env.python_path
                        );
                        let launcher_module = if bootstrap_dx {
                            "nteract_kernel_launcher"
                        } else {
                            "ipykernel_launcher"
                        };
                        let mut cmd = tokio::process::Command::new(&pooled_env.python_path);
                        cmd.args(["-Xfrozen_modules=off", "-m", launcher_module, "-f"]);
                        cmd.arg(&connection_file_path);
                        cmd.stdout(Stdio::null());
                        cmd.stderr(Stdio::piped());
                        if bootstrap_dx {
                            // See the uv:inline branch above. Conda inline
                            // cache hits can predate launcher vendoring or be
                            // claimed from a pool env; PYTHONPATH injection
                            // makes those caches launchable.
                            let dir = crate::launcher_cache::launcher_cache_dir().await?;
                            cmd.env("PYTHONPATH", &dir);
                        }
                        cmd
                    }
                    "conda:env_yml" => {
                        // Use the project's named conda environment from environment.yml.
                        // The env prefix was resolved during launch preparation (named env
                        // lookup or creation via rattler) and passed as the pooled_env.
                        let conda_prefix =
                            env.as_ref().map(|e| e.venv_path.clone()).or_else(|| {
                                // Fallback: look up the named env from environment.yml
                                notebook_path.as_deref().and_then(|p| {
                                    crate::project_file::find_nearest_project_file(
                                        p,
                                        &[crate::project_file::ProjectFileKind::EnvironmentYml],
                                    )
                                    .and_then(|d| {
                                        crate::project_file::resolve_conda_env_prefix(&d.path)
                                    })
                                })
                            });

                        if let Some(ref prefix) = conda_prefix {
                            let python = crate::project_file::conda_python_path(prefix);
                            if python.exists() {
                                info!(
                                    "[jupyter-kernel] Starting Python kernel from conda:env_yml env ({})",
                                    python.display()
                                );
                                let launcher_module = if bootstrap_dx {
                                    "nteract_kernel_launcher"
                                } else {
                                    "ipykernel_launcher"
                                };
                                let mut cmd = tokio::process::Command::new(&python);
                                cmd.env("CONDA_PREFIX", prefix);
                                if let Some(ref nb_path) = notebook_path {
                                    if let Some(parent) = nb_path.parent() {
                                        cmd.current_dir(parent);
                                    }
                                }
                                cmd.args(["-Xfrozen_modules=off", "-m", launcher_module, "-f"]);
                                cmd.arg(&connection_file_path);
                                cmd.stdout(Stdio::null());
                                cmd.stderr(Stdio::piped());
                                if bootstrap_dx {
                                    // The env belongs to the user (created from
                                    // their environment.yml). Writing launcher
                                    // files into a shared conda env is a
                                    // permissions / cleanup hazard, so inject
                                    // the daemon-side launcher via PYTHONPATH —
                                    // same pattern as `uv run` and `pixi exec`.
                                    // Without this, `-m nteract_kernel_launcher`
                                    // fails immediately with ModuleNotFoundError.
                                    let dir = crate::launcher_cache::launcher_cache_dir().await?;
                                    cmd.env("PYTHONPATH", &dir);
                                }
                                cmd
                            } else {
                                return Err(anyhow::anyhow!(
                                    "conda:env_yml env at {:?} has no python binary",
                                    prefix
                                ));
                            }
                        } else {
                            return Err(anyhow::anyhow!(
                                "conda:env_yml could not resolve conda environment prefix"
                            ));
                        }
                    }
                    "pixi:toml" => {
                        let manifest_path = notebook_path.as_deref().and_then(|p| {
                            crate::project_file::detect_project_file(p)
                                .filter(|d| {
                                    d.kind == crate::project_file::ProjectFileKind::PixiToml
                                })
                                .map(|d| d.path)
                        });

                        let launcher_module = if bootstrap_dx {
                            "nteract_kernel_launcher"
                        } else {
                            "ipykernel_launcher"
                        };
                        // Forward launch-config env vars (e.g. PIXI_FROZEN=true
                        // when the daemon-side prepare needed frozen mode)
                        // to the shell-hook subprocess. The bottom of this
                        // function also applies them to the final kernel
                        // command, but shell-hook runs first and would
                        // otherwise hit the network without them.
                        let shell_hook_env: std::collections::HashMap<String, String> =
                            config.env_vars.iter().cloned().collect();
                        if let Some(ref manifest) = manifest_path {
                            match kernel_launch::tools::pixi_shell_hook(
                                manifest,
                                None,
                                &shell_hook_env,
                            )
                            .await
                            {
                                Ok(env_vars) => {
                                    let python = env_vars
                                        .get("CONDA_PREFIX")
                                        .map(|p| {
                                            let prefix = std::path::PathBuf::from(p);
                                            if cfg!(windows) {
                                                prefix.join("python.exe")
                                            } else {
                                                prefix.join("bin").join("python")
                                            }
                                        })
                                        .unwrap_or_else(|| std::path::PathBuf::from("python"));
                                    info!(
                                        "[jupyter-kernel] Starting Python kernel via pixi shell-hook ({})",
                                        python.display()
                                    );
                                    let mut cmd = tokio::process::Command::new(&python);
                                    cmd.envs(&env_vars);
                                    if let Some(parent) = manifest.parent() {
                                        cmd.current_dir(parent);
                                    }
                                    cmd.args(["-Xfrozen_modules=off", "-m", launcher_module, "-f"]);
                                    cmd.arg(&connection_file_path);
                                    cmd.stdout(Stdio::null());
                                    cmd.stderr(Stdio::piped());
                                    if bootstrap_dx {
                                        // pixi.toml envs belong to the user.
                                        // Installing nteract_kernel_launcher
                                        // into their env is a cleanup hazard,
                                        // so inject via PYTHONPATH — same
                                        // pattern as uv:pyproject,
                                        // conda:env_yml, and pixi exec.
                                        let dir =
                                            crate::launcher_cache::launcher_cache_dir().await?;
                                        cmd.env("PYTHONPATH", &dir);
                                    }
                                    cmd
                                }
                                Err(e) => {
                                    warn!(
                                        "[jupyter-kernel] pixi shell-hook failed ({}), falling back to pixi run",
                                        e
                                    );
                                    let pixi_path = kernel_launch::tools::get_pixi_path().await?;
                                    let mut cmd = tokio::process::Command::new(&pixi_path);
                                    cmd.args([
                                        "run",
                                        "python",
                                        "-Xfrozen_modules=off",
                                        "-m",
                                        launcher_module,
                                        "-f",
                                    ]);
                                    cmd.arg(&connection_file_path);
                                    cmd.stdout(Stdio::null());
                                    cmd.stderr(Stdio::piped());
                                    if let Some(parent) = manifest.parent() {
                                        cmd.current_dir(parent);
                                    }
                                    if bootstrap_dx {
                                        let dir =
                                            crate::launcher_cache::launcher_cache_dir().await?;
                                        cmd.env("PYTHONPATH", &dir);
                                    }
                                    cmd
                                }
                            }
                        } else {
                            let pixi_path = kernel_launch::tools::get_pixi_path().await?;
                            let mut cmd = tokio::process::Command::new(&pixi_path);
                            cmd.args([
                                "run",
                                "python",
                                "-Xfrozen_modules=off",
                                "-m",
                                launcher_module,
                                "-f",
                            ]);
                            cmd.arg(&connection_file_path);
                            cmd.stdout(Stdio::null());
                            cmd.stderr(Stdio::piped());
                            if let Some(ref nb_path) = notebook_path {
                                if let Some(parent) = nb_path.parent() {
                                    cmd.current_dir(parent);
                                }
                            }
                            if bootstrap_dx {
                                let dir = crate::launcher_cache::launcher_cache_dir().await?;
                                cmd.env("PYTHONPATH", &dir);
                            }
                            cmd
                        }
                    }
                    "pixi:inline" | "pixi:prewarmed" | "pixi:pep723" => {
                        let pixi_path = kernel_launch::tools::get_pixi_path().await?;
                        info!(
                            "[jupyter-kernel] Starting Python kernel with pixi exec (env_source: {})",
                            env_source
                        );
                        let launcher_module = if bootstrap_dx {
                            "nteract_kernel_launcher"
                        } else {
                            "ipykernel_launcher"
                        };
                        let mut cmd = tokio::process::Command::new(&pixi_path);
                        cmd.arg("exec");
                        for pkg in ["ipykernel", "ipywidgets", "anywidget", "nbformat"] {
                            cmd.args(["-w", pkg]);
                        }
                        if let Some(ref deps) = launched_config.pixi_deps {
                            for dep in deps {
                                cmd.args(["-w", dep]);
                            }
                        }
                        for pkg in &launched_config.prewarmed_packages {
                            cmd.args(["-w", pkg]);
                        }
                        cmd.args([
                            "python",
                            "-Xfrozen_modules=off",
                            "-m",
                            launcher_module,
                            "-f",
                        ]);
                        cmd.arg(&connection_file_path);
                        cmd.stdout(Stdio::null());
                        cmd.stderr(Stdio::piped());
                        if bootstrap_dx {
                            // pixi exec spins up an ephemeral env we don't
                            // vendor into; inject the daemon-side launcher via
                            // PYTHONPATH so `-m nteract_kernel_launcher`
                            // resolves without touching sys.path[0].
                            let dir = crate::launcher_cache::launcher_cache_dir().await?;
                            cmd.env("PYTHONPATH", &dir);
                        }
                        cmd
                    }
                    "uv:current_python" => {
                        // current_python: launch directly against a user-owned
                        // interpreter, no pool take and no VIRTUAL_ENV/PATH
                        // overlay. Reachable only over the cloud launch-on-attach
                        // path; direct_python_path is set when the launched env
                        // carries a python_path but no venv_path.
                        let python_path = direct_python_path.as_ref().ok_or_else(|| {
                            anyhow::anyhow!(
                                "uv:current_python requires a direct python_path (none was plumbed through)"
                            )
                        })?;
                        info!(
                            "[jupyter-kernel] Starting Python kernel with current python at {:?}",
                            python_path
                        );
                        let launcher_module = if bootstrap_dx {
                            "nteract_kernel_launcher"
                        } else {
                            "ipykernel_launcher"
                        };
                        let mut cmd = tokio::process::Command::new(python_path);
                        cmd.args(["-Xfrozen_modules=off", "-m", launcher_module, "-f"]);
                        cmd.arg(&connection_file_path);
                        cmd.stdout(Stdio::null());
                        cmd.stderr(Stdio::piped());
                        if bootstrap_dx {
                            // The user's interpreter may predate the launcher;
                            // inject it via PYTHONPATH (same pattern as the
                            // pyproject and pool arms) so
                            // `-m nteract_kernel_launcher` resolves without
                            // touching sys.path[0].
                            let dir = crate::launcher_cache::launcher_cache_dir().await?;
                            cmd.env("PYTHONPATH", &dir);
                        }
                        cmd
                    }
                    _ => {
                        // Prewarmed - use pooled environment
                        let pooled_env = env.ok_or_else(|| {
                            anyhow::anyhow!(
                                "Python kernel requires a pooled environment for env_source: {}",
                                env_source
                            )
                        })?;
                        info!(
                            "[jupyter-kernel] Starting Python kernel from env at {:?}",
                            pooled_env.python_path
                        );
                        // Every pool env (UV/conda/pixi) is vendored with the
                        // `nteract_kernel_launcher` package at creation + take
                        // time, so `-m nteract_kernel_launcher` resolves
                        // regardless of flavor when bootstrap_dx is on.
                        let launcher_module = if bootstrap_dx {
                            "nteract_kernel_launcher"
                        } else {
                            "ipykernel_launcher"
                        };
                        let mut cmd = tokio::process::Command::new(&pooled_env.python_path);
                        cmd.args(["-Xfrozen_modules=off", "-m", launcher_module, "-f"]);
                        cmd.arg(&connection_file_path);
                        cmd.stdout(Stdio::null());
                        cmd.stderr(Stdio::piped());
                        if bootstrap_dx {
                            // Pool envs are daemon-owned and vendored at
                            // creation/take time, but injecting the cached
                            // launcher keeps stale pools from failing with
                            // ModuleNotFoundError after an upgrade.
                            let dir = crate::launcher_cache::launcher_cache_dir().await?;
                            cmd.env("PYTHONPATH", &dir);
                        }

                        if pooled_env.env_type == EnvType::Uv {
                            cmd.env("VIRTUAL_ENV", &pooled_env.venv_path);
                            let uv_path = kernel_launch::tools::get_uv_path().await?;
                            if let Some(uv_dir) = uv_path.parent() {
                                cmd.env("PATH", prepend_to_path(uv_dir));
                            }
                        }

                        cmd
                    }
                }
            }
            "deno" => {
                let deno_path = kernel_launch::tools::get_deno_path().await?;
                info!("[jupyter-kernel] Starting Deno kernel with {:?}", deno_path);
                let mut cmd = tokio::process::Command::new(&deno_path);
                cmd.args(["jupyter", "--kernel", "--conn"]);
                cmd.arg(&connection_file_path);
                cmd.stdout(Stdio::null());
                cmd.stderr(Stdio::piped());
                cmd
            }
            _ => {
                return Err(anyhow::anyhow!(
                    "Unsupported kernel type: {}. Supported types: python, deno",
                    kernel_type
                ));
            }
        };
        cmd.current_dir(&cwd);

        // Set terminal size for consistent output formatting
        cmd.env("COLUMNS", TERMINAL_COLUMNS_STR);
        cmd.env("LINES", TERMINAL_LINES_STR);

        // Apply extra env vars from launch config. `PATH` is merged with
        // whatever the per-launch branch above set on the command so the
        // kernel keeps the environment-activation entries at the front (pixi
        // shell-hook puts the env's bin dir there for `!python` isolation;
        // uv:inline prepends the uv install dir). The imported shell PATH
        // is appended after so user-shell binaries are still reachable but
        // never shadow the activated environment.
        for (key, value) in &config.env_vars {
            if key == "PATH" {
                let existing = cmd
                    .as_std()
                    .get_envs()
                    .find_map(|(k, v)| {
                        if k == std::ffi::OsStr::new("PATH") {
                            v.and_then(|v| v.to_str()).map(String::from)
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default();
                let merged = if existing.is_empty() {
                    value.clone()
                } else {
                    // existing (activation) first, then user shell PATH.
                    crate::shell_env_overlay::merge_paths(&existing, value)
                };
                cmd.env("PATH", merged);
            } else {
                cmd.env(key, value);
            }
        }
        scrub_secret_kernel_env(&mut cmd);
        cmd.env(
            REDACT_ENV_VALUES_IN_OUTPUTS_ENV,
            if config.redact_env_values_in_outputs {
                "1"
            } else {
                "0"
            },
        );

        let output_redactor = Arc::new(OutputRedactor::from_current_process_and_command(
            config.redact_env_values_in_outputs,
            cmd.as_std(),
        ));

        cmd.kill_on_drop(true);

        // Capture kernel stderr for diagnostics. Per-line logs go at debug
        // (or warn when the line looks error-shaped), but we also ring-buffer
        // the last N lines so the early-exit path can surface them in the
        // error message. Without this, users on stable (default warn) saw
        // only "exit status: 1" with no clue why the kernel died.
        const STDERR_BUFFER_LINES: usize = 50;

        type LaunchedKernel = (
            tokio::process::Child,
            Arc<StdMutex<VecDeque<String>>>,
            ConnectionInfo,
        );

        #[cfg(unix)]
        let use_ipc = kernel_type != "deno";

        #[cfg(unix)]
        let ipc_prefix = if use_ipc {
            crate::ensure_ipc_socket_dir()?;
            Some(ipc_path_prefix(&kernel_id))
        } else {
            None
        };

        #[cfg(not(unix))]
        let ipc_prefix: Option<PathBuf> = None;

        let (mut process, stderr_buffer, connection_info) = {
            if let Some(ref prefix) = ipc_prefix {
                let connection_info = ConnectionInfo {
                    transport: jupyter_protocol::connection_info::Transport::IPC,
                    ip: prefix.display().to_string(),
                    shell_port: 1,
                    iopub_port: 2,
                    stdin_port: 3,
                    control_port: 4,
                    hb_port: 5,
                    signature_scheme: "hmac-sha256".to_string(),
                    key: Uuid::new_v4().to_string(),
                    kernel_name: Some(kernelspec_name.to_string()),
                };
                tokio::fs::write(
                    &connection_file_path,
                    serde_json::to_string_pretty(&connection_info)?,
                )
                .await?;
                info!(
                    "[jupyter-kernel] Wrote connection file: kernel_id={} transport=ipc path={} launch_elapsed_ms={}",
                    kernel_id,
                    connection_file_path.display(),
                    launch_started.elapsed().as_millis()
                );

                let spawn_started = std::time::Instant::now();
                let mut process = cmd.spawn()?;
                let stderr_buffer: Arc<StdMutex<VecDeque<String>>> =
                    Arc::new(StdMutex::new(VecDeque::with_capacity(STDERR_BUFFER_LINES)));
                let stderr_drain: Option<JoinHandle<()>> =
                    if let Some(stderr) = process.stderr.take() {
                        let kid = kernel_id.clone();
                        let buffer = stderr_buffer.clone();
                        Some(spawn_best_effort("kernel-stderr", async move {
                            use tokio::io::{AsyncBufReadExt, BufReader};
                            let mut lines = BufReader::new(stderr).lines();
                            while let Ok(Some(line)) = lines.next_line().await {
                                let lower = line.to_ascii_lowercase();
                                if lower.contains("error") || lower.contains("traceback") {
                                    warn!("[kernel-stderr:{}] {}", kid, line);
                                } else {
                                    debug!("[kernel-stderr:{}] {}", kid, line);
                                }
                                let mut queue = buffer.lock().unwrap();
                                if queue.len() == STDERR_BUFFER_LINES {
                                    queue.pop_front();
                                }
                                queue.push_back(line);
                            }
                        }))
                    } else {
                        None
                    };

                info!(
                    "[jupyter-kernel] Spawned kernel process (pid={:?}, kernel_id={}, transport=ipc, prefix={}, spawn_elapsed_ms={}, launch_elapsed_ms={})",
                    process.id(),
                    kernel_id,
                    prefix.display(),
                    spawn_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis(),
                );

                if let Err(e) = check_kernel_process_still_running(
                    &mut process,
                    &kernel_id,
                    &stderr_buffer,
                    Some(prefix.as_path()),
                ) {
                    if let Some(handle) = stderr_drain {
                        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), handle)
                            .await;
                    }
                    return Err(e);
                }

                (process, stderr_buffer, connection_info) as LaunchedKernel
            } else {
                let kernel_ports = config.kernel_ports;
                let ports = [
                    kernel_ports.stdin,
                    kernel_ports.control,
                    kernel_ports.hb,
                    kernel_ports.shell,
                    kernel_ports.iopub,
                ];
                let connection_info = ConnectionInfo {
                    transport: jupyter_protocol::connection_info::Transport::TCP,
                    ip: ip.to_string(),
                    stdin_port: kernel_ports.stdin,
                    control_port: kernel_ports.control,
                    hb_port: kernel_ports.hb,
                    shell_port: kernel_ports.shell,
                    iopub_port: kernel_ports.iopub,
                    signature_scheme: "hmac-sha256".to_string(),
                    key: Uuid::new_v4().to_string(),
                    kernel_name: Some(kernelspec_name.to_string()),
                };
                tokio::fs::write(
                    &connection_file_path,
                    serde_json::to_string_pretty(&connection_info)?,
                )
                .await?;
                info!(
                    "[jupyter-kernel] Wrote connection file: kernel_id={} transport=tcp path={} ports={:?} launch_elapsed_ms={}",
                    kernel_id,
                    connection_file_path.display(),
                    ports,
                    launch_started.elapsed().as_millis()
                );

                let bind_started = std::time::Instant::now();
                let listeners = bind_kernel_port_listeners(ip, kernel_ports).await?;
                info!(
                    "[jupyter-kernel] Reserved TCP ports: kernel_id={} ports={:?} bind_elapsed_ms={} launch_elapsed_ms={}",
                    kernel_id,
                    ports,
                    bind_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis()
                );
                #[cfg(windows)]
                {
                    drop(listeners);
                    info!(
                        "[jupyter-kernel] Released reserved TCP listeners before Windows kernel spawn: kernel_id={} ports={:?} launch_elapsed_ms={}",
                        kernel_id,
                        ports,
                        launch_started.elapsed().as_millis()
                    );
                }
                let spawn_started = std::time::Instant::now();
                let mut process = cmd.spawn()?;
                #[cfg(not(windows))]
                drop(listeners);

                let stderr_buffer: Arc<StdMutex<VecDeque<String>>> =
                    Arc::new(StdMutex::new(VecDeque::with_capacity(STDERR_BUFFER_LINES)));
                let stderr_drain: Option<JoinHandle<()>> =
                    if let Some(stderr) = process.stderr.take() {
                        let kid = kernel_id.clone();
                        let buffer = stderr_buffer.clone();
                        Some(spawn_best_effort("kernel-stderr", async move {
                            use tokio::io::{AsyncBufReadExt, BufReader};
                            let mut lines = BufReader::new(stderr).lines();
                            while let Ok(Some(line)) = lines.next_line().await {
                                let lower = line.to_ascii_lowercase();
                                if lower.contains("error") || lower.contains("traceback") {
                                    warn!("[kernel-stderr:{}] {}", kid, line);
                                } else {
                                    debug!("[kernel-stderr:{}] {}", kid, line);
                                }
                                let mut queue = buffer.lock().unwrap();
                                if queue.len() == STDERR_BUFFER_LINES {
                                    queue.pop_front();
                                }
                                queue.push_back(line);
                            }
                        }))
                    } else {
                        None
                    };

                info!(
                    "[jupyter-kernel] Spawned kernel process (pid={:?}, kernel_id={}, transport=tcp, ports={:?}, spawn_elapsed_ms={}, launch_elapsed_ms={})",
                    process.id(),
                    kernel_id,
                    ports,
                    spawn_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis()
                );

                if let Err(e) = check_kernel_process_still_running(
                    &mut process,
                    &kernel_id,
                    &stderr_buffer,
                    None,
                ) {
                    if let Some(handle) = stderr_drain {
                        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), handle)
                            .await;
                    }
                    return Err(e);
                }

                (process, stderr_buffer, connection_info) as LaunchedKernel
            }
        };

        #[cfg(not(unix))]
        let _ = &stderr_buffer;

        #[cfg(unix)]
        let kernel_pid = process.id().map(|pid| pid as i32);

        // Fresh session_id for ZMQ connections
        let session_id = Uuid::new_v4().to_string();
        let kernel_actor_id = match shared.kernel_actor_principal.as_deref() {
            Some(principal) => format!("{principal}/runtime:kernel:{}", &session_id[..8]),
            None => format!("rt:kernel:{}", &session_id[..8]),
        };

        // ── ZMQ connections and background tasks ─────────────────────────

        #[cfg(unix)]
        if connection_info.transport == jupyter_protocol::connection_info::Transport::IPC {
            let socket_paths: Vec<String> = [
                connection_info.shell_port,
                connection_info.iopub_port,
                connection_info.stdin_port,
                connection_info.control_port,
                connection_info.hb_port,
            ]
            .iter()
            .map(|port| format!("{}-{}", connection_info.ip, port))
            .collect();

            let socket_wait_started = std::time::Instant::now();
            let deadline = socket_wait_started + std::time::Duration::from_secs(30);
            loop {
                check_kernel_process_still_running(
                    &mut process,
                    &kernel_id,
                    &stderr_buffer,
                    ipc_prefix.as_deref(),
                )?;

                if socket_paths
                    .iter()
                    .all(|p| std::path::Path::new(p).exists())
                {
                    info!(
                        "[jupyter-kernel] All 5 IPC sockets ready: kernel_id={} prefix={} socket_wait_elapsed_ms={} launch_elapsed_ms={}",
                        kernel_id,
                        connection_info.ip,
                        socket_wait_started.elapsed().as_millis(),
                        launch_started.elapsed().as_millis()
                    );
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    let missing: Vec<_> = socket_paths
                        .iter()
                        .filter(|p| !std::path::Path::new(p.as_str()).exists())
                        .collect();
                    if let Some(ref prefix) = ipc_prefix {
                        cleanup_ipc_sockets(prefix);
                    }
                    return Err(anyhow::anyhow!(
                        "Kernel did not create IPC sockets within 30s. Missing: {:?}",
                        missing
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }

        // Create iopub connection and spawn listener
        let iopub_endpoint = connection_info.iopub_url();
        let iopub_connect_started = std::time::Instant::now();
        info!(
            "[jupyter-kernel] Connecting IOPub: kernel_id={} endpoint={} launch_elapsed_ms={}",
            kernel_id,
            iopub_endpoint,
            launch_started.elapsed().as_millis()
        );
        let mut iopub = match jupyter_zmq_client::create_client_iopub_connection(
            &connection_info,
            "",
            &session_id,
        )
        .await
        {
            Ok(conn) => {
                info!(
                        "[jupyter-kernel] IOPub connected: kernel_id={} endpoint={} connect_elapsed_ms={} launch_elapsed_ms={}",
                        kernel_id,
                        iopub_endpoint,
                        iopub_connect_started.elapsed().as_millis(),
                        launch_started.elapsed().as_millis()
                    );
                conn
            }
            Err(e) => {
                error!(
                        "[jupyter-kernel] IOPub connect failed: kernel_id={} endpoint={} connect_elapsed_ms={} launch_elapsed_ms={} error={}",
                        kernel_id,
                        iopub_endpoint,
                        iopub_connect_started.elapsed().as_millis(),
                        launch_started.elapsed().as_millis(),
                        e
                    );
                return Err(e.into());
            }
        };

        // Create command channels for queue processing. Lifecycle commands are
        // control-plane signals and must not be backpressured by bounded output
        // work such as captured Output widget updates.
        let (lifecycle_cmd_tx, work_cmd_tx, command_receivers) = queue_command_channels(100);

        // Shared state refs for spawned tasks
        let registered_execution_ids: Arc<StdMutex<HashSet<String>>> =
            Arc::new(StdMutex::new(HashSet::new()));
        let comm_seq = Arc::new(AtomicU64::new(0));
        let pending_history: Arc<StdMutex<HashMap<String, oneshot::Sender<Vec<HistoryEntry>>>>> =
            Arc::new(StdMutex::new(HashMap::new()));
        let pending_completions: PendingCompletions = Arc::new(StdMutex::new(HashMap::new()));
        let stream_terminals = Arc::new(tokio::sync::Mutex::new(StreamTerminals::new()));

        // Spawn process watcher — detects process exit and signals via oneshot
        let process_cmd_tx = lifecycle_cmd_tx.clone();
        let panic_cmd_tx = lifecycle_cmd_tx.clone();
        let (died_tx, died_rx) = tokio::sync::oneshot::channel::<String>();
        let process_watcher_task = spawn_supervised(
            "process-watcher",
            async move {
                let status = process.wait().await;
                let msg = match status {
                    Ok(exit_status) => {
                        warn!("[jupyter-kernel] Kernel process exited: {}", exit_status);
                        format!("Kernel process exited: {}", exit_status)
                    }
                    Err(e) => {
                        error!("[jupyter-kernel] Error waiting for kernel process: {}", e);
                        format!("Error waiting for kernel process: {}", e)
                    }
                };
                let _ = died_tx.send(msg);
                let _ = process_cmd_tx.send(LifecycleSignal::KernelDied);
            },
            move |_| {
                let _ = panic_cmd_tx.send(LifecycleSignal::KernelDied);
            },
        );

        // ── IOPub listener task ──────────────────────────────────────────

        let broadcast_tx = shared.broadcast_tx.clone();
        let iopub_registered_execution_ids = registered_execution_ids.clone();
        let iopub_lifecycle_tx = lifecycle_cmd_tx.clone();
        let iopub_work_tx = work_cmd_tx.clone();
        let blob_store = shared.blob_store.clone();
        let iopub_comm_seq = comm_seq.clone();
        let iopub_stream_terminals = stream_terminals.clone();
        let state_for_iopub = shared.state.clone();
        let comms_for_iopub = shared.comms.clone();
        let iopub_output_redactor = output_redactor.clone();
        let iopub_output_blob_publisher = shared.output_blob_publisher.clone();
        // IOPub writes use transactions with the base kernel actor. Async
        // blob/manifest work is completed before the document transaction.
        let iopub_kernel_actor_id = kernel_actor_id.clone();
        let output_commit_context = crate::output_commit_context::OutputCommitContext::new(
            state_for_iopub.clone(),
            blob_store.clone(),
            iopub_output_blob_publisher,
            iopub_kernel_actor_id.clone(),
            iopub_lifecycle_tx.clone(),
            iopub_output_redactor.clone(),
        );
        let stream_committer = crate::stream_committer::start_stream_committer(
            output_commit_context.clone(),
            iopub_stream_terminals.clone(),
        );
        let display_update_committer =
            crate::display_update_committer::start_display_update_committer(
                output_commit_context.clone(),
            );
        let output_committer =
            crate::output_committer::start_output_committer(output_commit_context);

        // Create coalescing channel early so the IOPub task can capture the sender.
        let (coalesce_tx, coalesce_rx) = mpsc::unbounded_channel::<CommCoalesceMessage>();
        let comm_coalesce_tx_for_iopub = Some(coalesce_tx.clone());

        let iopub_panic_cmd_tx = lifecycle_cmd_tx.clone();
        let iopub_task = spawn_supervised(
            "iopub",
            async move {
                // Track Output widgets with pending clear_output(wait=true).
                let mut pending_clear_widgets: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                let mut output_widget_replay_cache: HashMap<String, Vec<serde_json::Value>> =
                    HashMap::new();

                // Capture routing cache: msg_id -> comm_id.
                let mut capture_cache: std::collections::HashMap<String, String> =
                    std::collections::HashMap::new();

                // Local comm_id -> target_name map, populated on comm_open and
                // removed on comm_close. Used by the dx comm filter in CommMsg
                // and CommClose arms so we can route without a CRDT read on the
                // hot path.
                let mut comm_targets: std::collections::HashMap<String, String> =
                    std::collections::HashMap::new();
                let mut comm_models: std::collections::HashMap<String, (String, String)> =
                    std::collections::HashMap::new();
                let mut mpl_canvas_image_modes: std::collections::HashMap<String, String> =
                    std::collections::HashMap::new();
                let mut mpl_canvas_sizes: std::collections::HashMap<String, (u64, u64)> =
                    std::collections::HashMap::new();

                let comm_coalesce_tx = comm_coalesce_tx_for_iopub;
                let mut stream_flushes = StreamFlushBuffer::default();

                loop {
                    match iopub.read().await {
                        Ok(message) => {
                            let iopub_start = std::time::Instant::now();
                            let msg_type = message.header.msg_type.clone();
                            debug!(
                                "[iopub] type={} parent_msg_id={:?}",
                                msg_type,
                                message.parent_header.as_ref().map(|h| &h.msg_id)
                            );

                            // parent_header.msg_id IS the execution_id (set in execute()).
                            let execution_id =
                                message.parent_header.as_ref().map(|h| h.msg_id.clone());
                            let is_registered_execution =
                                execution_id.as_ref().is_some_and(|eid| {
                                    iopub_registered_execution_ids
                                        .lock()
                                        .map(|ids| ids.contains(eid))
                                        .unwrap_or(false)
                                });

                            // Handle different message types
                            match &message.content {
                                JupyterMessageContent::Status(status) => {
                                    // Map the kernel's execution_state to either a typed
                                    // activity flip (Idle/Busy — hot path, throttled) or a
                                    // lifecycle transition (Starting/Restarting/Terminating/Dead).
                                    let update = match status.execution_state {
                                        jupyter_protocol::ExecutionState::Busy => {
                                            Some(IoPubStateUpdate::Activity(KernelActivity::Busy))
                                        }
                                        jupyter_protocol::ExecutionState::Idle => {
                                            Some(IoPubStateUpdate::Activity(KernelActivity::Idle))
                                        }
                                        // Starting and Restarting both land in Connecting —
                                        // the kernel process has just come up and is
                                        // reporting its first status; we treat those as
                                        // "connected but pre-kernel_info" transitions.
                                        jupyter_protocol::ExecutionState::Starting
                                        | jupyter_protocol::ExecutionState::Restarting => {
                                            Some(IoPubStateUpdate::Lifecycle(
                                                RuntimeLifecycle::Connecting,
                                            ))
                                        }
                                        jupyter_protocol::ExecutionState::Terminating
                                        | jupyter_protocol::ExecutionState::Dead => Some(
                                            IoPubStateUpdate::Lifecycle(RuntimeLifecycle::Shutdown),
                                        ),
                                        _ => None,
                                    };

                                    if let Some(update) = update {
                                        // Non-execute messages (kernel_info, completions) have a
                                        // parent_header.msg_id that isn't in our registered
                                        // execution set. Treat activity flips from those as
                                        // transient (they don't reflect user code state).
                                        let is_transient_activity = !is_registered_execution
                                            && matches!(update, IoPubStateUpdate::Activity(_));

                                        if !is_transient_activity {
                                            let result =
                                                state_for_iopub.with_doc(|sd| match update {
                                                    IoPubStateUpdate::Activity(a) => {
                                                        sd.set_activity(a)
                                                    }
                                                    IoPubStateUpdate::Lifecycle(lc) => {
                                                        sd.set_lifecycle(&lc)
                                                    }
                                                });
                                            if let Err(e) = result {
                                                warn!("[runtime-state] {}", e);
                                            }
                                        }
                                    }

                                    if status.execution_state
                                        == jupyter_protocol::ExecutionState::Idle
                                    {
                                        let final_stream_flushes = if let Some(eid) =
                                            execution_id.as_ref()
                                        {
                                            let flushes = stream_flushes
                                                .flush_execution(eid, std::time::Instant::now());
                                            stream_flushes.clear_execution(eid);
                                            flushes
                                        } else {
                                            Vec::new()
                                        };

                                        if let Err(e) =
                                            iopub_lifecycle_tx.send(LifecycleSignal::KernelIdle {
                                                execution_id: execution_id.clone(),
                                            })
                                        {
                                            warn!(
                                                "[jupyter-kernel] KernelIdle signal lost because runtime agent receiver closed: {}",
                                                e
                                            );
                                        }

                                        if let Some(eid) =
                                            execution_id.clone().filter(|_| is_registered_execution)
                                        {
                                            output_committer.flush_for_ordering().await;
                                            display_update_committer.flush_for_ordering().await;
                                            stream_committer.flush_then_signal(
                                                final_stream_flushes,
                                                LifecycleSignal::ExecutionDone {
                                                    execution_id: eid,
                                                },
                                            );
                                        } else {
                                            display_update_committer.flush_for_ordering().await;
                                            stream_committer.request_flushes(final_stream_flushes);
                                        }
                                        if execution_id.is_some() && !is_registered_execution {
                                            // Status=Idle with a parent execution_id but no
                                            // registered execution means this is a non-execute
                                            // request like kernel_info, or the id arrived after
                                            // shutdown cleared our local registry.
                                            debug!(
                                                "[jupyter-kernel] Status=Idle with unregistered execution_id={:?}",
                                                execution_id
                                            );
                                        }
                                    }
                                }

                                JupyterMessageContent::ExecuteInput(input) => {
                                    if is_registered_execution {
                                        let execution_count = input.execution_count.0 as i64;

                                        if let Some(ref eid) = execution_id {
                                            if let Err(e) = state_for_iopub.with_doc(|sd| {
                                                sd.set_execution_count(eid, execution_count)
                                            }) {
                                                warn!("[runtime-state] {}", e);
                                            }
                                        }
                                    }
                                }

                                JupyterMessageContent::StreamContent(stream) => {
                                    // Check if this output should go to an Output widget
                                    let parent_msg_id = message
                                        .parent_header
                                        .as_ref()
                                        .map(|h| h.msg_id.as_str())
                                        .unwrap_or("");
                                    if let Some(widget_comm_id) =
                                        capture_cache.get(parent_msg_id).cloned()
                                    {
                                        let stream_name = match stream.name {
                                            jupyter_protocol::Stdio::Stdout => "stdout",
                                            jupyter_protocol::Stdio::Stderr => "stderr",
                                        };
                                        let output = serde_json::json!({
                                            "output_type": "stream",
                                            "name": stream_name,
                                            "text": stream.text
                                        });

                                        if let Ok(manifest) =
                                            crate::output_store::create_manifest_with_redactor(
                                                &output,
                                                &blob_store,
                                                crate::output_store::DEFAULT_INLINE_THRESHOLD,
                                                &iopub_output_redactor,
                                            )
                                            .await
                                        {
                                            let manifest_json = manifest.to_json();
                                            let need_clear =
                                                pending_clear_widgets.remove(&widget_comm_id);
                                            let output_manifests = state_for_iopub
                                                .with_doc(|sd| {
                                                    if need_clear {
                                                        if let Err(e) =
                                                            sd.clear_comm_outputs(&widget_comm_id)
                                                        {
                                                            warn!("[runtime-state] {}", e);
                                                        }
                                                    }
                                                    if let Err(e) = sd.append_comm_output(
                                                        &widget_comm_id,
                                                        &manifest_json,
                                                    ) {
                                                        warn!("[runtime-state] {}", e);
                                                    }
                                                    Ok(
                                                        if let Some(entry) =
                                                            sd.get_comm(&widget_comm_id)
                                                        {
                                                            let manifests = entry.outputs.clone();
                                                            Some(manifests)
                                                        } else {
                                                            None
                                                        },
                                                    )
                                                })
                                                .ok()
                                                .flatten();
                                            if let Some(output_manifests) = output_manifests {
                                                let manifests_json = serde_json::Value::Array(
                                                    output_manifests.clone(),
                                                );
                                                if let Err(e) = comms_for_iopub.with_doc(|cd| {
                                                    let heads = cd.get_heads();
                                                    cd.transact_at_heads_recovering(
                                                        &heads,
                                                        Some(&iopub_kernel_actor_id),
                                                        "comms-doc-output-widget-stream",
                                                        |cd| {
                                                            cd.set_comm_state_property(
                                                                &widget_comm_id,
                                                                "outputs",
                                                                &manifests_json,
                                                            )
                                                        },
                                                    )
                                                }) {
                                                    warn!("[comms-doc] {}", e);
                                                }
                                                let resolved_outputs =
                                                    resolve_output_widget_replay_state(
                                                        &mut output_widget_replay_cache,
                                                        &widget_comm_id,
                                                        &output_manifests,
                                                        &manifest,
                                                        need_clear,
                                                        &blob_store,
                                                    )
                                                    .await;
                                                try_send_comm_update(
                                                    &iopub_work_tx,
                                                    widget_comm_id.clone(),
                                                    serde_json::json!({
                                                        "outputs": resolved_outputs,
                                                    }),
                                                );
                                            }
                                        }
                                        continue;
                                    }

                                    if is_registered_execution {
                                        let stream_name = match stream.name {
                                            jupyter_protocol::Stdio::Stdout => "stdout",
                                            jupyter_protocol::Stdio::Stderr => "stderr",
                                        };
                                        let eid = execution_id.clone().unwrap_or_default();

                                        {
                                            let mut terminals = iopub_stream_terminals.lock().await;
                                            terminals.feed_chunk(&eid, stream_name, &stream.text);
                                        }

                                        if let Some(flush) = stream_flushes.record_chunk(
                                            &eid,
                                            stream_name,
                                            stream.text.len(),
                                            std::time::Instant::now(),
                                        ) {
                                            stream_committer.request_flush(flush);
                                        }
                                    }
                                }

                                JupyterMessageContent::DisplayData(_)
                                | JupyterMessageContent::ExecuteResult(_) => {
                                    let parent_msg_id = message
                                        .parent_header
                                        .as_ref()
                                        .map(|h| h.msg_id.as_str())
                                        .unwrap_or("");

                                    // Dx blob-ref buffer preflight: if the kernel emitted a
                                    // display_data carrying raw bytes as trailing ZMQ
                                    // buffer frames plus a BLOB_REF_MIME entry, write each
                                    // referenced buffer to the blob store before the
                                    // manifest is built.
                                    let iopub_buffers: Vec<Vec<u8>> =
                                        message.buffers.iter().map(|b| b.to_vec()).collect();

                                    if let Some(widget_comm_id) =
                                        capture_cache.get(parent_msg_id).cloned()
                                    {
                                        if let Some(nbformat_value) =
                                            message_content_to_nbformat(&message.content)
                                        {
                                            crate::output_store::preflight_ref_buffers(
                                                &nbformat_value,
                                                &iopub_buffers,
                                                &blob_store,
                                            )
                                            .await;
                                            if let Ok(manifest) =
                                                crate::output_store::create_manifest_with_redactor(
                                                    &nbformat_value,
                                                    &blob_store,
                                                    crate::output_store::DEFAULT_INLINE_THRESHOLD,
                                                    &iopub_output_redactor,
                                                )
                                                .await
                                            {
                                                let manifest_json = manifest.to_json();
                                                let need_clear =
                                                    pending_clear_widgets.remove(&widget_comm_id);
                                                let output_manifests = state_for_iopub
                                                    .with_doc(|sd| {
                                                        if need_clear {
                                                            if let Err(e) = sd
                                                                .clear_comm_outputs(&widget_comm_id)
                                                            {
                                                                warn!("[runtime-state] {}", e);
                                                            }
                                                        }
                                                        if let Err(e) = sd.append_comm_output(
                                                            &widget_comm_id,
                                                            &manifest_json,
                                                        ) {
                                                            warn!("[runtime-state] {}", e);
                                                        }
                                                        Ok(
                                                            if let Some(entry) =
                                                                sd.get_comm(&widget_comm_id)
                                                            {
                                                                let manifests =
                                                                    entry.outputs.clone();
                                                                Some(manifests)
                                                            } else {
                                                                None
                                                            },
                                                        )
                                                    })
                                                    .ok()
                                                    .flatten();
                                                if let Some(output_manifests) = output_manifests {
                                                    let manifests_json = serde_json::Value::Array(
                                                        output_manifests.clone(),
                                                    );
                                                    if let Err(e) = comms_for_iopub.with_doc(|cd| {
                                                        let heads = cd.get_heads();
                                                        cd.transact_at_heads_recovering(
                                                            &heads,
                                                            Some(&iopub_kernel_actor_id),
                                                            "comms-doc-output-widget-display",
                                                            |cd| {
                                                                cd.set_comm_state_property(
                                                                    &widget_comm_id,
                                                                    "outputs",
                                                                    &manifests_json,
                                                                )
                                                            },
                                                        )
                                                    }) {
                                                        warn!("[comms-doc] {}", e);
                                                    }
                                                    let resolved_outputs =
                                                        resolve_output_widget_replay_state(
                                                            &mut output_widget_replay_cache,
                                                            &widget_comm_id,
                                                            &output_manifests,
                                                            &manifest,
                                                            need_clear,
                                                            &blob_store,
                                                        )
                                                        .await;
                                                    try_send_comm_update(
                                                        &iopub_work_tx,
                                                        widget_comm_id.clone(),
                                                        serde_json::json!({
                                                            "outputs": resolved_outputs
                                                        }),
                                                    );
                                                }
                                            }
                                        }
                                        continue;
                                    }

                                    if is_registered_execution {
                                        let output_kind = match &message.content {
                                            JupyterMessageContent::DisplayData(_) => {
                                                OrdinaryOutputKind::DisplayData
                                            }
                                            JupyterMessageContent::ExecuteResult(_) => {
                                                OrdinaryOutputKind::ExecuteResult
                                            }
                                            _ => unreachable!(),
                                        };
                                        let Some(eid) = execution_id.clone() else {
                                            continue;
                                        };

                                        let boundary_flushes = stream_flushes
                                            .flush_execution(&eid, std::time::Instant::now());
                                        stream_flushes.clear_execution(&eid);
                                        stream_committer.flush_for_ordering(boundary_flushes).await;

                                        {
                                            let mut terminals = iopub_stream_terminals.lock().await;
                                            terminals.clear(&eid);
                                        }

                                        if let Some(nbformat_value) =
                                            message_content_to_nbformat(&message.content)
                                        {
                                            let is_rich_error = matches!(
                                                crate::user_error::UserErrorOutput::from_iopub(
                                                    &message.content
                                                ),
                                                Some(crate::user_error::UserErrorOutput::Rich(_))
                                            );
                                            output_committer
                                                .enqueue_output(OrdinaryOutputCommit {
                                                    execution_id: eid.clone(),
                                                    nbformat_value,
                                                    buffers: iopub_buffers,
                                                    kind: if is_rich_error {
                                                        OrdinaryOutputKind::Error
                                                    } else {
                                                        output_kind
                                                    },
                                                })
                                                .await;

                                            // Rich-traceback detection. A display_data or
                                            // execute_result carrying TRACEBACK_MIME IS an error
                                            // semantically — the launcher short-circuits
                                            // `_showtraceback` and emits rich display_data instead
                                            // of classic ErrorOutput. Without this, the runtime
                                            // never flips `execution_had_error`, and
                                            // `Execution.result().success` comes back true for
                                            // failed cells. Route through the same CellError
                                            // command the classic arm uses, after queued output
                                            // commits are durable.
                                            if is_rich_error {
                                                output_committer.flush_then_signal(
                                                    LifecycleSignal::CellError {
                                                        execution_id: eid.clone(),
                                                    },
                                                );
                                            }
                                        }
                                    }
                                }

                                JupyterMessageContent::UpdateDisplayData(update) => {
                                    if let Some(ref display_id) = update.transient.display_id {
                                        let data_value =
                                            serde_json::to_value(&update.data).unwrap_or_default();
                                        let iopub_buffers: Vec<Vec<u8>> =
                                            message.buffers.iter().map(|b| b.to_vec()).collect();
                                        // An update_display_data can target a display_data that
                                        // arrived immediately before it. Drain ordinary output
                                        // commits first so the coalesced display updater can find
                                        // that durable target instead of dropping the update.
                                        output_committer.flush_for_ordering().await;
                                        display_update_committer.request_update(
                                            display_id.clone(),
                                            data_value,
                                            update.metadata.clone(),
                                            iopub_buffers,
                                        );
                                    }
                                }

                                JupyterMessageContent::ErrorOutput(_) => {
                                    let parent_msg_id = message
                                        .parent_header
                                        .as_ref()
                                        .map(|h| h.msg_id.as_str())
                                        .unwrap_or("");
                                    if let Some(widget_comm_id) =
                                        capture_cache.get(parent_msg_id).cloned()
                                    {
                                        if let Some(nbformat_value) =
                                            message_content_to_nbformat(&message.content)
                                        {
                                            if let Ok(manifest) =
                                                crate::output_store::create_manifest_with_redactor(
                                                    &nbformat_value,
                                                    &blob_store,
                                                    crate::output_store::DEFAULT_INLINE_THRESHOLD,
                                                    &iopub_output_redactor,
                                                )
                                                .await
                                            {
                                                let manifest_json = manifest.to_json();
                                                let need_clear =
                                                    pending_clear_widgets.remove(&widget_comm_id);
                                                let output_manifests = state_for_iopub
                                                    .with_doc(|sd| {
                                                        if need_clear {
                                                            if let Err(e) = sd
                                                                .clear_comm_outputs(&widget_comm_id)
                                                            {
                                                                warn!("[runtime-state] {}", e);
                                                            }
                                                        }
                                                        if let Err(e) = sd.append_comm_output(
                                                            &widget_comm_id,
                                                            &manifest_json,
                                                        ) {
                                                            warn!("[runtime-state] {}", e);
                                                        }
                                                        Ok(
                                                            if let Some(entry) =
                                                                sd.get_comm(&widget_comm_id)
                                                            {
                                                                let manifests =
                                                                    entry.outputs.clone();
                                                                Some(manifests)
                                                            } else {
                                                                None
                                                            },
                                                        )
                                                    })
                                                    .ok()
                                                    .flatten();
                                                if let Some(output_manifests) = output_manifests {
                                                    let manifests_json = serde_json::Value::Array(
                                                        output_manifests.clone(),
                                                    );
                                                    if let Err(e) = comms_for_iopub.with_doc(|cd| {
                                                        let heads = cd.get_heads();
                                                        cd.transact_at_heads_recovering(
                                                            &heads,
                                                            Some(&iopub_kernel_actor_id),
                                                            "comms-doc-output-widget-result",
                                                            |cd| {
                                                                cd.set_comm_state_property(
                                                                    &widget_comm_id,
                                                                    "outputs",
                                                                    &manifests_json,
                                                                )
                                                            },
                                                        )
                                                    }) {
                                                        warn!("[comms-doc] {}", e);
                                                    }
                                                    let resolved_outputs =
                                                        resolve_output_widget_replay_state(
                                                            &mut output_widget_replay_cache,
                                                            &widget_comm_id,
                                                            &output_manifests,
                                                            &manifest,
                                                            need_clear,
                                                            &blob_store,
                                                        )
                                                        .await;
                                                    try_send_comm_update(
                                                        &iopub_work_tx,
                                                        widget_comm_id.clone(),
                                                        serde_json::json!({
                                                            "outputs": resolved_outputs
                                                        }),
                                                    );
                                                }
                                            }
                                        }
                                        continue;
                                    }

                                    if is_registered_execution {
                                        let Some(eid) = execution_id.clone() else {
                                            continue;
                                        };

                                        let boundary_flushes = stream_flushes
                                            .flush_execution(&eid, std::time::Instant::now());
                                        stream_flushes.clear_execution(&eid);
                                        stream_committer.flush_for_ordering(boundary_flushes).await;

                                        {
                                            let mut terminals = iopub_stream_terminals.lock().await;
                                            terminals.clear(&eid);
                                        }

                                        if let Some(nbformat_value) =
                                            message_content_to_nbformat(&message.content)
                                        {
                                            output_committer
                                                .enqueue_output(OrdinaryOutputCommit {
                                                    execution_id: eid.clone(),
                                                    nbformat_value,
                                                    buffers: Vec::new(),
                                                    kind: OrdinaryOutputKind::Error,
                                                })
                                                .await;
                                        }

                                        output_committer.flush_then_signal(
                                            LifecycleSignal::CellError {
                                                execution_id: eid.clone(),
                                            },
                                        );
                                    }
                                }

                                JupyterMessageContent::ClearOutput(clear) => {
                                    let parent_msg_id = message
                                        .parent_header
                                        .as_ref()
                                        .map(|h| h.msg_id.as_str())
                                        .unwrap_or("");
                                    if let Some(widget_comm_id) =
                                        capture_cache.get(parent_msg_id).cloned()
                                    {
                                        if clear.wait {
                                            pending_clear_widgets.insert(widget_comm_id.clone());
                                        } else {
                                            pending_clear_widgets.remove(&widget_comm_id);
                                            output_widget_replay_cache.remove(&widget_comm_id);
                                            if let Err(e) = state_for_iopub.with_doc(|sd| {
                                                sd.clear_comm_outputs(&widget_comm_id)?;
                                                Ok(())
                                            }) {
                                                warn!("[runtime-state] {}", e);
                                            }
                                            if let Err(e) = comms_for_iopub.with_doc(|cd| {
                                                let heads = cd.get_heads();
                                                cd.transact_at_heads_recovering(
                                                    &heads,
                                                    Some(&iopub_kernel_actor_id),
                                                    "comms-doc-output-widget-clear",
                                                    |cd| {
                                                        cd.set_comm_state_property(
                                                            &widget_comm_id,
                                                            "outputs",
                                                            &serde_json::json!([]),
                                                        )
                                                    },
                                                )
                                            }) {
                                                warn!("[comms-doc] {}", e);
                                            }
                                            try_send_comm_update(
                                                &iopub_work_tx,
                                                widget_comm_id.clone(),
                                                serde_json::json!({ "outputs": [] }),
                                            );
                                        }
                                    }
                                }

                                JupyterMessageContent::CommOpen(open) => {
                                    // Record the comm_id -> target_name mapping early so
                                    // subsequent CommMsg / CommClose arms can route without
                                    // reading the CRDT.
                                    comm_targets
                                        .insert(open.comm_id.0.clone(), open.target_name.clone());

                                    // Short-circuit reserved nteract.dx.* comms: they carry
                                    // kernel-side protocol traffic (dx blob uploads, future
                                    // dx.query / dx.stream) that must NOT land in
                                    // RuntimeStateDoc::comms. The payload is handled in the
                                    // CommMsg arm below.
                                    if crate::dx_blob_comm::is_dx_target(&open.target_name) {
                                        debug!(
                                            "[dx] comm_open comm_id={} target={} (not persisted)",
                                            open.comm_id.0, open.target_name
                                        );
                                        continue;
                                    }

                                    let buffers: Vec<Vec<u8>> =
                                        message.buffers.iter().map(|b| b.to_vec()).collect();

                                    let data = serde_json::to_value(&open.data).unwrap_or_default();

                                    let comm_open_start = std::time::Instant::now();
                                    let state_json_size =
                                        serde_json::to_string(&data).map(|s| s.len()).unwrap_or(0);
                                    debug!(
                                        "[comm_open] comm_id={} target={} state_size={} bytes",
                                        open.comm_id.0, open.target_name, state_json_size
                                    );

                                    let empty_obj = serde_json::json!({});
                                    let state = data.get("state").unwrap_or(&empty_obj);
                                    let buffer_paths = extract_buffer_paths(&data);
                                    let (state_with_blobs, _used_paths) = store_widget_buffers(
                                        state,
                                        &buffer_paths,
                                        &buffers,
                                        &blob_store,
                                    )
                                    .await;

                                    let blob_elapsed = comm_open_start.elapsed();
                                    if blob_elapsed > std::time::Duration::from_millis(10) {
                                        warn!(
                                        "[iopub-timing] comm_open blob store took {:?} for comm_id={}",
                                        blob_elapsed, open.comm_id.0
                                    );
                                    }

                                    let state_with_blobs = blob_store_large_state_values(
                                        &state_with_blobs,
                                        &blob_store,
                                    )
                                    .await;

                                    {
                                        let lock_start = std::time::Instant::now();
                                        let model_module = state_with_blobs
                                            .get("_model_module")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let model_name = state_with_blobs
                                            .get("_model_name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        comm_models.insert(
                                            open.comm_id.0.clone(),
                                            (model_module.to_string(), model_name.to_string()),
                                        );
                                        if crate::matplotlib_widget::is_mpl_canvas_model(
                                            model_module,
                                            model_name,
                                        ) {
                                            if let Some(size) =
                                                mpl_size_from_state(&state_with_blobs)
                                            {
                                                mpl_canvas_sizes
                                                    .insert(open.comm_id.0.clone(), size);
                                            }
                                            mpl_canvas_image_modes
                                                .entry(open.comm_id.0.clone())
                                                .or_insert_with(|| "full".to_string());
                                        }
                                        let seq = iopub_comm_seq.fetch_add(1, Ordering::Relaxed);
                                        let lock_wait = lock_start.elapsed();
                                        if lock_wait > std::time::Duration::from_millis(5) {
                                            warn!(
                                            "[iopub-timing] comm_open state handle lock waited {:?} for comm_id={}",
                                            lock_wait, open.comm_id.0
                                        );
                                        }
                                        let crdt_start = std::time::Instant::now();
                                        // Extract capture msg_id before with_doc so we can
                                        // update the local cache outside the lock.
                                        let capture_msg = if model_name == "OutputModel" {
                                            state_with_blobs
                                                .get("msg_id")
                                                .and_then(|v| v.as_str())
                                                .filter(|s| !s.is_empty())
                                                .map(|s| s.to_string())
                                        } else {
                                            None
                                        };
                                        if let Err(e) = state_for_iopub.with_doc(|sd| {
                                            sd.put_comm(
                                                &open.comm_id.0,
                                                &open.target_name,
                                                model_module,
                                                model_name,
                                                &serde_json::json!({}),
                                                seq,
                                            )?;
                                            if let Some(ref msg_id) = capture_msg {
                                                sd.set_comm_capture_msg_id(
                                                    &open.comm_id.0,
                                                    msg_id,
                                                )?;
                                            }
                                            Ok(())
                                        }) {
                                            warn!("[runtime-state] {}", e);
                                        }
                                        if let Err(e) = comms_for_iopub.with_doc(|cd| {
                                            let heads = cd.get_heads();
                                            cd.transact_at_heads_recovering(
                                                &heads,
                                                Some(&iopub_kernel_actor_id),
                                                "comms-doc-comm-open",
                                                |cd| {
                                                    cd.put_comm_state(
                                                        &open.comm_id.0,
                                                        &state_with_blobs,
                                                    )
                                                },
                                            )
                                        }) {
                                            warn!("[comms-doc] {}", e);
                                        }
                                        let crdt_elapsed = crdt_start.elapsed();
                                        if crdt_elapsed > std::time::Duration::from_millis(10) {
                                            warn!(
                                            "[iopub-timing] comm_open put_comm CRDT write took {:?} for comm_id={}, state_size={} bytes",
                                            crdt_elapsed, open.comm_id.0, state_json_size
                                        );
                                        }
                                        if let Some(msg_id) = capture_msg {
                                            capture_cache.insert(msg_id, open.comm_id.0.clone());
                                        }
                                    }

                                    let total = comm_open_start.elapsed();
                                    if total > std::time::Duration::from_millis(50) {
                                        warn!(
                                        "[iopub-timing] comm_open TOTAL {:?} for comm_id={} target={} state_size={} bytes",
                                        total, open.comm_id.0, open.target_name, state_json_size
                                    );
                                    }
                                }

                                JupyterMessageContent::CommMsg(msg) => {
                                    let content =
                                        serde_json::to_value(&message.content).unwrap_or_default();
                                    let buffers: Vec<Vec<u8>> =
                                        message.buffers.iter().map(|b| b.to_vec()).collect();

                                    let data = serde_json::to_value(&msg.data).unwrap_or_default();
                                    let method = data.get("method").and_then(|m| m.as_str());

                                    // dx-namespace comms short-circuit before any widget
                                    // state handling. v1 has no live handler — all reserved
                                    // nteract.dx.* targets drop with a warn log carrying the
                                    // raw target name for observability (future kernels
                                    // opening reserved targets we haven't implemented yet).
                                    if let Some(target) = comm_targets.get(&msg.comm_id.0).cloned()
                                    {
                                        if let Some(crate::dx_blob_comm::DxTarget::Unknown(raw)) =
                                            crate::dx_blob_comm::classify_dx_target(&target)
                                        {
                                            warn!(
                                            "[dx] comm_msg on reserved target {} (dropped; filtered from RuntimeStateDoc)",
                                            raw
                                        );
                                            continue;
                                        }
                                    }

                                    let comm_msg_start = std::time::Instant::now();
                                    debug!(
                                        "[comm_msg] comm_id={} method={:?}",
                                        msg.comm_id.0, method
                                    );
                                    let is_mpl_canvas = comm_models
                                        .get(&msg.comm_id.0)
                                        .is_some_and(|(model_module, model_name)| {
                                            crate::matplotlib_widget::is_mpl_canvas_model(
                                                model_module,
                                                model_name,
                                            )
                                        });
                                    let mut mpl_binary_broadcast_mode: Option<String> = None;
                                    if method == Some("update") {
                                        if let Some(state_delta) = data.get("state") {
                                            if is_mpl_canvas {
                                                if let Some(mode) = state_delta
                                                    .get("_image_mode")
                                                    .and_then(|v| v.as_str())
                                                {
                                                    mpl_canvas_image_modes.insert(
                                                        msg.comm_id.0.clone(),
                                                        mode.to_string(),
                                                    );
                                                }
                                                if let Some(size) = mpl_size_from_state(state_delta)
                                                {
                                                    mpl_canvas_sizes
                                                        .insert(msg.comm_id.0.clone(), size);
                                                }
                                            }
                                            if let Some(new_msg_id) =
                                                state_delta.get("msg_id").and_then(|v| v.as_str())
                                            {
                                                capture_cache
                                                    .retain(|_, cid| cid != &msg.comm_id.0);
                                                if !new_msg_id.is_empty() {
                                                    if let Some(existing) =
                                                        capture_cache.get(new_msg_id)
                                                    {
                                                        warn!(
                                                        "[comm_msg] Nested capture: {} overrides {} for msg_id={}",
                                                        msg.comm_id.0, existing, new_msg_id
                                                    );
                                                    }
                                                    capture_cache.insert(
                                                        new_msg_id.to_string(),
                                                        msg.comm_id.0.clone(),
                                                    );
                                                }

                                                if let Err(e) = state_for_iopub.with_doc(|sd| {
                                                    sd.set_comm_capture_msg_id(
                                                        &msg.comm_id.0,
                                                        new_msg_id,
                                                    )
                                                }) {
                                                    warn!("[runtime-state] {}", e);
                                                }
                                            }

                                            let coalesce_delta = if !buffers.is_empty() {
                                                let buffer_paths = extract_buffer_paths(&data);
                                                let (state_with_blobs, _) = store_widget_buffers(
                                                    state_delta,
                                                    &buffer_paths,
                                                    &buffers,
                                                    &blob_store,
                                                )
                                                .await;
                                                state_with_blobs
                                            } else {
                                                state_delta.clone()
                                            };
                                            if let Some(ref tx) = comm_coalesce_tx {
                                                let _ = tx.send(CommCoalesceMessage::StateDelta {
                                                    comm_id: msg.comm_id.0.clone(),
                                                    delta: coalesce_delta,
                                                });
                                            }
                                        }
                                    }
                                    if method != Some("update") && is_mpl_canvas {
                                        match crate::matplotlib_widget::parse_mpl_canvas_custom_message(&data) {
                                                Some(crate::matplotlib_widget::MplCanvasCustomMessage::ImageMode(mode)) => {
                                                    mpl_canvas_image_modes
                                                        .insert(msg.comm_id.0.clone(), mode);
                                                }
                                                Some(crate::matplotlib_widget::MplCanvasCustomMessage::Resize(size)) => {
                                                    if let Some(size) = size {
                                                        mpl_canvas_sizes.insert(
                                                            msg.comm_id.0.clone(),
                                                            size,
                                                        );
                                                    }
                                                }
                                            Some(crate::matplotlib_widget::MplCanvasCustomMessage::Binary) => {
                                                    let mode = mpl_canvas_image_modes
                                                        .get(&msg.comm_id.0)
                                                        .map(String::as_str)
                                                        .unwrap_or("full");
                                                if mode == "full" {
                                                    if let (Some(first_buffer), Some(tx)) =
                                                            (buffers.first(), comm_coalesce_tx.as_ref())
                                                        {
                                                            let _ = tx.send(
                                                                CommCoalesceMessage::MplCanvasFrame {
                                                                    comm_id: msg.comm_id.0.clone(),
                                                                    png: first_buffer.clone(),
                                                                    size: mpl_canvas_sizes
                                                                        .get(&msg.comm_id.0)
                                                                        .copied(),
                                                                },
                                                            );
                                                        }
                                                    }
                                                mpl_binary_broadcast_mode =
                                                    Some(mode.to_string());
                                            }
                                            Some(crate::matplotlib_widget::MplCanvasCustomMessage::Other)
                                            | None => {}
                                        }
                                    }

                                    let comm_msg_elapsed = comm_msg_start.elapsed();
                                    if comm_msg_elapsed > std::time::Duration::from_millis(10) {
                                        warn!(
                                        "[iopub-timing] comm_msg took {:?} for comm_id={} method={:?}",
                                        comm_msg_elapsed, msg.comm_id.0, method
                                    );
                                    }

                                    if method != Some("update") {
                                        let broadcast_content = if let Some(mode) =
                                            mpl_binary_broadcast_mode.as_ref()
                                        {
                                            content_with_mpl_canvas_image_mode(
                                                content.clone(),
                                                mode,
                                            )
                                        } else {
                                            content.clone()
                                        };
                                        let _ = broadcast_tx.send(NotebookBroadcast::Comm {
                                            msg_type: message.header.msg_type.clone(),
                                            content: broadcast_content,
                                            buffers: buffers.clone(),
                                        });
                                    }
                                }

                                JupyterMessageContent::CommClose(close) => {
                                    debug!(
                                        "[jupyter-kernel] comm_close: comm_id={}",
                                        close.comm_id.0
                                    );

                                    let iopub_elapsed = iopub_start.elapsed();
                                    if iopub_elapsed > std::time::Duration::from_millis(50) {
                                        warn!(
                                            "[iopub-timing] message type={} took {:?} total",
                                            msg_type, iopub_elapsed
                                        );
                                    }

                                    // Drop the comm_id -> target_name mapping. If this was
                                    // a dx-namespace comm, skip the RuntimeStateDoc write.
                                    let was_dx_target = comm_targets
                                        .remove(&close.comm_id.0)
                                        .map(|t| crate::dx_blob_comm::is_dx_target(&t))
                                        .unwrap_or(false);
                                    comm_models.remove(&close.comm_id.0);
                                    mpl_canvas_image_modes.remove(&close.comm_id.0);
                                    mpl_canvas_sizes.remove(&close.comm_id.0);
                                    if was_dx_target {
                                        continue;
                                    }

                                    capture_cache.retain(|_, cid| cid != &close.comm_id.0);
                                    output_widget_replay_cache.remove(&close.comm_id.0);

                                    if let Err(e) = comms_for_iopub.with_doc(|cd| {
                                        let heads = cd.get_heads();
                                        cd.transact_at_heads_recovering(
                                            &heads,
                                            Some(&iopub_kernel_actor_id),
                                            "comms-doc-comm-close",
                                            |cd| cd.remove_comm(&close.comm_id.0),
                                        )
                                    }) {
                                        warn!("[comms-doc] {}", e);
                                    }
                                    if let Err(e) = state_for_iopub
                                        .with_doc(|sd| sd.remove_comm(&close.comm_id.0))
                                    {
                                        warn!("[runtime-state] {}", e);
                                    }
                                }

                                _ => {
                                    debug!(
                                        "[jupyter-kernel] Unhandled iopub message: {}",
                                        message.header.msg_type
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            error!("[jupyter-kernel] iopub read error: {}", e);
                            break;
                        }
                    }
                }
                warn!("[jupyter-kernel] iopub loop exited, signaling KernelDied");
                if let Err(e) = iopub_lifecycle_tx.send(LifecycleSignal::KernelDied) {
                    warn!(
                        "[jupyter-kernel] KernelDied signal lost from iopub exit because runtime agent receiver closed: {}",
                        e
                    );
                }
            },
            move |_| {
                // Best-effort in panic handler — can't log, just try to signal
                let _ = iopub_panic_cmd_tx.send(LifecycleSignal::KernelDied);
            },
        );

        // ── Shell connection ─────────────────────────────────────────────

        let identity = jupyter_zmq_client::peer_identity_for_session(&session_id)?;
        let shell_endpoint = connection_info.shell_url();
        let shell_connect_started = std::time::Instant::now();
        info!(
            "[jupyter-kernel] Connecting shell: kernel_id={} endpoint={} launch_elapsed_ms={}",
            kernel_id,
            shell_endpoint,
            launch_started.elapsed().as_millis()
        );
        let mut shell = match jupyter_zmq_client::create_client_shell_connection_with_identity(
            &connection_info,
            &session_id,
            identity,
        )
        .await
        {
            Ok(conn) => {
                info!(
                    "[jupyter-kernel] Shell connected: kernel_id={} endpoint={} connect_elapsed_ms={} launch_elapsed_ms={}",
                    kernel_id,
                    shell_endpoint,
                    shell_connect_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis()
                );
                conn
            }
            Err(e) => {
                error!(
                    "[jupyter-kernel] Shell connect failed: kernel_id={} endpoint={} connect_elapsed_ms={} launch_elapsed_ms={} error={}",
                    kernel_id,
                    shell_endpoint,
                    shell_connect_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis(),
                    e
                );
                return Err(e.into());
            }
        };

        // Verify kernel is alive — race kernel_info_reply against process death
        let kernel_info_started = std::time::Instant::now();
        let request: JupyterMessage = KernelInfoRequest::default().into();
        info!(
            "[jupyter-kernel] Sending kernel_info_request: kernel_id={} launch_elapsed_ms={}",
            kernel_id,
            launch_started.elapsed().as_millis()
        );
        if let Err(e) = shell.send(request).await {
            error!(
                "[jupyter-kernel] kernel_info_request send failed: kernel_id={} elapsed_ms={} launch_elapsed_ms={} error={}",
                kernel_id,
                kernel_info_started.elapsed().as_millis(),
                launch_started.elapsed().as_millis(),
                e
            );
            return Err(e.into());
        }

        let reply = tokio::select! {
            result = await_result_with_timeout(shell.read(), std::time::Duration::from_secs(30)) => {
                match result {
                    TimedResult::Completed(msg) => Ok(Some(msg.header.msg_type)),
                    TimedResult::Failed(e) => {
                        if is_tolerated_kernel_info_reply_parse_error(&e) {
                            warn!(
                                "[jupyter-kernel] Kernel info reply used tolerated parse fallback: kernel_id={} kernel_info_elapsed_ms={} launch_elapsed_ms={} error={}",
                                kernel_id,
                                kernel_info_started.elapsed().as_millis(),
                                launch_started.elapsed().as_millis(),
                                e
                            );
                            Ok(None)
                        } else {
                            Err(anyhow::anyhow!("Kernel did not respond: {}", e))
                        }
                    },
                    TimedResult::TimedOut => Err(anyhow::anyhow!("Kernel did not respond within 30s")),
                }
            }
            died_msg = died_rx => {
                let msg = died_msg.unwrap_or_else(|_| "unknown".to_string());
                Err(anyhow::anyhow!("Kernel process died before responding: {}", msg))
            }
        };

        match reply {
            Ok(Some(msg_type)) => {
                info!(
                    "[jupyter-kernel] Kernel alive: got {} reply (kernel_id={} kernel_info_elapsed_ms={} launch_elapsed_ms={})",
                    msg_type,
                    kernel_id,
                    kernel_info_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis()
                );
            }
            Ok(None) => {
                info!(
                    "[jupyter-kernel] Kernel alive: accepted kernel_info_reply with tolerated parse fallback (kernel_id={} kernel_info_elapsed_ms={} launch_elapsed_ms={})",
                    kernel_id,
                    kernel_info_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis()
                );
            }
            Err(e) => {
                error!(
                    "[jupyter-kernel] Kernel info failed: kernel_id={} kernel_info_elapsed_ms={} launch_elapsed_ms={} error={}",
                    kernel_id,
                    kernel_info_started.elapsed().as_millis(),
                    launch_started.elapsed().as_millis(),
                    e
                );
                // Abort process watcher to clean up orphaned kernel
                process_watcher_task.abort();
                return Err(e);
            }
        }

        // Split shell into reader/writer
        let (shell_writer, mut shell_reader) = shell.split();

        // ── Shell reader task ────────────────────────────────────────────

        let _shell_broadcast_tx = shared.broadcast_tx.clone();
        let shell_registered_execution_ids = registered_execution_ids.clone();
        let shell_pending_history = pending_history.clone();
        let shell_pending_completions = pending_completions.clone();
        let shell_state = shared.state.clone();
        let shell_blob_store = shared.blob_store.clone();
        let shell_kernel_actor_id = kernel_actor_id.clone();
        let shell_output_redactor = output_redactor.clone();

        let shell_panic_cmd_tx = lifecycle_cmd_tx.clone();
        let shell_reader_task = spawn_supervised(
            "shell-reader",
            async move {
                loop {
                    match shell_reader.read().await {
                        Ok(msg) => {
                            let _parent_msg_id =
                                msg.parent_header.as_ref().map(|h| h.msg_id.clone());

                            match msg.content {
                                JupyterMessageContent::ExecuteReply(ref reply) => {
                                    let execution_id =
                                        msg.parent_header.as_ref().map(|h| h.msg_id.clone());
                                    let is_registered_execution =
                                        execution_id.as_ref().is_some_and(|eid| {
                                            shell_registered_execution_ids
                                                .lock()
                                                .map(|ids| ids.contains(eid))
                                                .unwrap_or(false)
                                        });

                                    // Process page payloads
                                    if is_registered_execution {
                                        for payload in &reply.payload {
                                            if let jupyter_protocol::Payload::Page {
                                                data, ..
                                            } = payload
                                            {
                                                let nbformat_value = media_to_display_data(data);

                                                let manifest_json =
                                                    match output_store::create_manifest_with_redactor(
                                                        &nbformat_value,
                                                        &shell_blob_store,
                                                        DEFAULT_INLINE_THRESHOLD,
                                                        &shell_output_redactor,
                                                    )
                                                    .await
                                                    {
                                                        Ok(manifest) => manifest.to_json(),
                                                        Err(e) => {
                                                            warn!(
                                                            "[jupyter-kernel] Failed to create page manifest: {}",
                                                            e
                                                        );
                                                            let redacted = shell_output_redactor
                                                                .redact_output_value(&nbformat_value);
                                                            crate::notebook_sync_server::fallback_output_with_id(&redacted)
                                                        }
                                                    };

                                                let eid = execution_id.clone().unwrap_or_default();
                                                if let Err(e) = shell_state
                                                    .transact_at_current_heads(
                                                        Some(&shell_kernel_actor_id),
                                                        "runtime-state-shell-page-transaction",
                                                        |sd| {
                                                            // Preserve the old fork+merge behavior:
                                                            // append errors are logged but do not
                                                            // turn the transaction into a recovery
                                                            // failure.
                                                            if let Err(e) = sd.append_output(
                                                                &eid,
                                                                &manifest_json,
                                                            ) {
                                                                warn!(
                                                                    "[jupyter-kernel] Failed to append page output to state doc: {}",
                                                                    e
                                                                );
                                                            }
                                                            Ok(())
                                                        },
                                                    )
                                                {
                                                    warn!("[runtime-state] {}", e);
                                                }
                                            }
                                        }
                                    }
                                }
                                JupyterMessageContent::HistoryReply(ref reply) => {
                                    if let Some(ref parent) = msg.parent_header {
                                        let msg_id = &parent.msg_id;
                                        if let Ok(mut pending) = shell_pending_history.lock() {
                                            if let Some(tx) = pending.remove(msg_id) {
                                                let entries: Vec<HistoryEntry> = reply
                                                    .history
                                                    .iter()
                                                    .map(|item| {
                                                        match item {
                                                    jupyter_protocol::HistoryEntry::Input(
                                                        session,
                                                        line,
                                                        source,
                                                    ) => HistoryEntry {
                                                        session: *session as i32,
                                                        line: *line as i32,
                                                        source: source.clone(),
                                                    },
                                                    jupyter_protocol::HistoryEntry::InputOutput(
                                                        session,
                                                        line,
                                                        (source, _output),
                                                    ) => HistoryEntry {
                                                        session: *session as i32,
                                                        line: *line as i32,
                                                        source: source.clone(),
                                                    },
                                                }
                                                    })
                                                    .collect();

                                                debug!(
                                                "[jupyter-kernel] Resolved history request: {} entries",
                                                entries.len()
                                            );
                                                let _ = tx.send(entries);
                                            }
                                        }
                                    }
                                }
                                JupyterMessageContent::CompleteReply(ref reply) => {
                                    if let Some(ref parent) = msg.parent_header {
                                        let msg_id = &parent.msg_id;
                                        if let Ok(mut pending) = shell_pending_completions.lock() {
                                            if let Some(tx) = pending.remove(msg_id) {
                                                let items: Vec<CompletionItem> = reply
                                                    .matches
                                                    .iter()
                                                    .map(|m| CompletionItem {
                                                        label: m.clone(),
                                                        kind: None,
                                                        detail: None,
                                                        source: Some("kernel".to_string()),
                                                    })
                                                    .collect();

                                                debug!(
                                                "[jupyter-kernel] Resolved completion request: {} items",
                                                items.len()
                                            );
                                                let _ = tx.send((
                                                    items,
                                                    reply.cursor_start,
                                                    reply.cursor_end,
                                                ));
                                            }
                                        }
                                    }
                                }
                                _ => {
                                    debug!(
                                        "[jupyter-kernel] shell reply: type={}",
                                        msg.header.msg_type
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            error!("[jupyter-kernel] shell read error: {}", e);
                            break;
                        }
                    }
                }
            },
            move |_| {
                let _ = shell_panic_cmd_tx.send(LifecycleSignal::KernelDied);
            },
        );

        // ── Heartbeat monitor ────────────────────────────────────────────

        let hb_cmd_tx = lifecycle_cmd_tx.clone();
        let hb_panic_cmd_tx = lifecycle_cmd_tx.clone();
        let hb_conn_info = connection_info.clone();
        let hb_kernel_id = kernel_id.clone();
        let hb_kernel_type = kernel_type.clone();
        let hb_env_source = env_source.clone();
        #[cfg(unix)]
        let hb_kernel_pid = kernel_pid;
        #[cfg(not(unix))]
        let hb_kernel_pid: Option<i32> = None;
        let hb_launch_elapsed = launch_started;
        let heartbeat_task = spawn_supervised(
            "heartbeat",
            async move {
                const HEARTBEAT_INITIAL_DELAY: std::time::Duration =
                    std::time::Duration::from_secs(5);
                const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
                const HEARTBEAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
                const HEARTBEAT_MAX_FAILURES: u8 = 3;

                let mut consecutive_failures = 0u8;

                tokio::time::sleep(HEARTBEAT_INITIAL_DELAY).await;

                loop {
                    tokio::time::sleep(HEARTBEAT_INTERVAL).await;

                    let check = async {
                        let mut hb =
                            jupyter_zmq_client::create_client_heartbeat_connection(&hb_conn_info)
                                .await?;
                        hb.single_heartbeat().await
                    };

                    let failure = match await_result_with_timeout(check, HEARTBEAT_TIMEOUT).await {
                        TimedResult::Completed(()) => {
                            if consecutive_failures > 0 {
                                info!(
                                    "[jupyter-kernel] Heartbeat recovered: kernel_id={} kernel_type={} env_source={} pid={:?} previous_failures={} launch_elapsed_ms={}",
                                    hb_kernel_id,
                                    hb_kernel_type,
                                    hb_env_source,
                                    hb_kernel_pid,
                                    consecutive_failures,
                                    hb_launch_elapsed.elapsed().as_millis()
                                );
                            }
                            consecutive_failures = 0;
                            continue;
                        }
                        TimedResult::Failed(e) => {
                            format!("connection error: {e}")
                        }
                        TimedResult::TimedOut => {
                            format!("timeout after {}ms", HEARTBEAT_TIMEOUT.as_millis())
                        }
                    };

                    consecutive_failures = consecutive_failures.saturating_add(1);

                    #[cfg(unix)]
                    if let Some(pid) = hb_kernel_pid {
                        if wait_for_pid_exit(pid, std::time::Duration::ZERO).await {
                            warn!(
                                "[jupyter-kernel] Heartbeat failed and kernel process is gone: kernel_id={} kernel_type={} env_source={} pid={} failure={} launch_elapsed_ms={}",
                                hb_kernel_id,
                                hb_kernel_type,
                                hb_env_source,
                                pid,
                                failure,
                                hb_launch_elapsed.elapsed().as_millis()
                            );
                            let _ = hb_cmd_tx.send(LifecycleSignal::KernelDied);
                            break;
                        }
                    }

                    if consecutive_failures < HEARTBEAT_MAX_FAILURES {
                        warn!(
                            "[jupyter-kernel] Heartbeat probe failed; retrying before declaring kernel dead: kernel_id={} kernel_type={} env_source={} pid={:?} failure={} consecutive_failures={}/{} launch_elapsed_ms={}",
                            hb_kernel_id,
                            hb_kernel_type,
                            hb_env_source,
                            hb_kernel_pid,
                            failure,
                            consecutive_failures,
                            HEARTBEAT_MAX_FAILURES,
                            hb_launch_elapsed.elapsed().as_millis()
                        );
                        continue;
                    }

                    warn!(
                        "[jupyter-kernel] Heartbeat failed after retries, kernel unresponsive: kernel_id={} kernel_type={} env_source={} pid={:?} last_failure={} consecutive_failures={} launch_elapsed_ms={}",
                        hb_kernel_id,
                        hb_kernel_type,
                        hb_env_source,
                        hb_kernel_pid,
                        failure,
                        consecutive_failures,
                        hb_launch_elapsed.elapsed().as_millis()
                    );
                    let _ = hb_cmd_tx.send(LifecycleSignal::KernelDied);
                    break;
                }
            },
            move |_| {
                let _ = hb_panic_cmd_tx.send(LifecycleSignal::KernelDied);
            },
        );

        // ── Coalesced comm state writer ──────────────────────────────────

        let mut coalesce_rx = coalesce_rx;
        let coalesce_comms = shared.comms.clone();
        let coalesce_blob_store = shared.blob_store.clone();
        // Coalesced comm writes must carry a kernel actor ID so the
        // runtime agent's actor filter in `receive_sync_and_foreign_comms`
        // recognizes them as self-authored echoes. This path writes through a
        // transaction on the live doc, so it can use the base kernel actor
        // instead of minting a coalesce sub-actor.
        let coalesce_kernel_actor_id = kernel_actor_id.clone();
        let coalesce_panic_cmd_tx = lifecycle_cmd_tx.clone();
        let comm_coalesce_task = spawn_supervised(
            "comm-coalesce",
            async move {
                let mut pending: HashMap<String, serde_json::Value> = HashMap::new();
                let mut pending_mpl_frames: HashMap<String, PendingMplCanvasFrame> = HashMap::new();
                let mut mpl_frame_seq: HashMap<String, u64> = HashMap::new();
                let mut timer = tokio::time::interval(std::time::Duration::from_millis(16));
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

                loop {
                    tokio::select! {
                        msg = coalesce_rx.recv() => {
                            match msg {
                                Some(CommCoalesceMessage::StateDelta { comm_id, delta }) => {
                                    let entry = pending.entry(comm_id)
                                        .or_insert_with(|| serde_json::json!({}));
                                    if let (Some(existing), Some(new)) =
                                        (entry.as_object_mut(), delta.as_object())
                                    {
                                        for (k, v) in new {
                                            existing.insert(k.clone(), v.clone());
                                        }
                                    }
                                }
                                Some(CommCoalesceMessage::MplCanvasFrame { comm_id, png, size }) => {
                                    pending_mpl_frames.insert(
                                        comm_id,
                                        PendingMplCanvasFrame { png, size },
                                    );
                                }
                                None => break,
                            }
                        }
                        _ = timer.tick() => {
                            if pending.is_empty() && pending_mpl_frames.is_empty() {
                                continue;
                            }
                            let mut batch = std::mem::take(&mut pending);
                            for delta in batch.values_mut() {
                                *delta = blob_store_large_state_values(delta, &coalesce_blob_store).await;
                            }
                            let frame_batch = std::mem::take(&mut pending_mpl_frames);
                            for (comm_id, frame) in frame_batch {
                                match coalesce_blob_store.put(&frame.png, "image/png").await {
                                    Ok(hash) => {
                                        let seq = mpl_frame_seq
                                            .entry(comm_id.clone())
                                            .and_modify(|seq| *seq = seq.saturating_add(1))
                                            .or_insert(1);
                                        let size = frame
                                            .size
                                            .map(|(width, height)| serde_json::json!([width, height]))
                                            .unwrap_or(serde_json::Value::Null);
                                        let mut checkpoint = serde_json::Map::new();
                                        checkpoint.insert(
                                            crate::matplotlib_widget::MPL_CANVAS_CHECKPOINT_KEY
                                                .to_string(),
                                            serde_json::json!({
                                                "version": 1,
                                                "frame": {
                                                    "blob": hash,
                                                    "size": frame.png.len(),
                                                    "media_type": "image/png",
                                                },
                                                "image_mode": "full",
                                                "size": size,
                                                "frame_seq": *seq,
                                            }),
                                        );
                                        let entry = batch
                                            .entry(comm_id)
                                            .or_insert_with(|| serde_json::json!({}));
                                        if let (Some(existing), Some(new)) =
                                            (entry.as_object_mut(), Some(&checkpoint))
                                        {
                                            for (k, v) in new {
                                                existing.insert(k.clone(), v.clone());
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        warn!(
                                            "[comms-doc] Failed to blob-store matplotlib canvas checkpoint: {}",
                                            e
                                        );
                                    }
                                }
                            }
                            if let Err(e) = coalesce_comms.with_doc(|cd| {
                                let heads = cd.get_heads();
                                cd.transact_at_heads_recovering(
                                    &heads,
                                    Some(&coalesce_kernel_actor_id),
                                    "comms-doc-comm-coalesce-transaction",
                                    |cd| {
                                        for (comm_id, delta) in &batch {
                                            if let Err(e) =
                                                cd.merge_comm_state_delta(comm_id, delta)
                                            {
                                                warn!("[comms-doc] {}", e);
                                            }
                                        }
                                        Ok(())
                                    },
                                )?;
                                Ok(())
                            }) {
                                warn!("[comms-doc] {}", e);
                            }
                        }
                    }
                }
            },
            move |_| {
                let _ = coalesce_panic_cmd_tx.send(LifecycleSignal::KernelDied);
            },
        );

        // ── Construct the kernel struct ──────────────────────────────────
        info!(
            "[jupyter-kernel] Launch complete: kernel_id={} kernel_type={} env_source={} launch_elapsed_ms={}",
            kernel_id,
            kernel_type,
            env_source,
            launch_started.elapsed().as_millis()
        );

        let kernel = Self {
            kernel_type,
            env_source,
            launched_config,
            env_path,
            session_id,
            kernel_actor_id,
            connection_info: Some(connection_info),
            connection_file: Some(connection_file_path),
            shell_writer: Some(shell_writer),
            #[cfg(unix)]
            ipc_prefix,
            #[cfg(unix)]
            kernel_pid,
            iopub_task: Some(iopub_task),
            shell_reader_task: Some(shell_reader_task),
            process_watcher_task: Some(process_watcher_task),
            heartbeat_task: Some(heartbeat_task),
            comm_coalesce_tx: Some(coalesce_tx),
            comm_coalesce_task: Some(comm_coalesce_task),
            registered_execution_ids,
            work_cmd_tx: Some(work_cmd_tx),
            lifecycle_cmd_tx: Some(lifecycle_cmd_tx),
            comm_seq,
            pending_history,
            pending_completions,
            history_cache: HistoryLruCache::new(HISTORY_CACHE_CAPACITY),
            stream_terminals,
        };

        info!("[jupyter-kernel] Kernel started: {}", kernel_id);
        Ok((kernel, command_receivers))
    }

    // ── Execute ──────────────────────────────────────────────────────────

    async fn execute(
        &mut self,
        execution_id: &str,
        cell_id: Option<&str>,
        source: &str,
    ) -> Result<()> {
        let shell = self
            .shell_writer
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("No kernel running"))?;

        // Build execute request with msg_id = execution_id.
        // IOPub replies echo this back as parent_header.msg_id, so we can
        // route outputs directly by execution_id without an indirection map.
        let request = ExecuteRequest::new(source.to_string());
        let mut message: JupyterMessage = request.into();
        message.header.msg_id = execution_id.to_string();
        let mut nteract_metadata = serde_json::json!({
            "execution_id": execution_id,
        });
        if let Some(cell_id) = cell_id {
            nteract_metadata["cell_id"] = serde_json::Value::String(cell_id.to_string());
        }
        message.metadata = serde_json::json!({
            "nteract": nteract_metadata,
        });

        // Register execution_id BEFORE sending so IOPub can identify replies
        // without depending on notebook cell identity.
        {
            let mut ids = self.registered_execution_ids.lock().unwrap();
            ids.insert(execution_id.to_string());
        }

        shell.send(message).await?;
        self.history_cache.clear();
        info!(
            "[jupyter-kernel] Sent execute_request: execution_id={}",
            execution_id
        );

        Ok(())
    }

    // ── Interrupt ────────────────────────────────────────────────────────

    async fn interrupt(&mut self) -> Result<()> {
        let connection_info = self
            .connection_info
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No kernel running"))?;

        let mut control =
            jupyter_zmq_client::create_client_control_connection(connection_info, &self.session_id)
                .await?;

        let request: JupyterMessage = InterruptRequest {}.into();
        control.send(request).await?;

        info!("[jupyter-kernel] Sent interrupt_request");

        // Wait for acknowledgement with timeout
        match await_result_with_timeout(control.read(), std::time::Duration::from_secs(5)).await {
            TimedResult::Completed(_reply) => {
                info!("[jupyter-kernel] Received interrupt_reply");
            }
            TimedResult::Failed(e) => {
                warn!("[jupyter-kernel] Error receiving interrupt_reply: {}", e);
            }
            TimedResult::TimedOut => {
                warn!("[jupyter-kernel] Timed out waiting for interrupt_reply (5s)");
            }
        }

        Ok(())
    }

    // ── Shutdown ─────────────────────────────────────────────────────────

    async fn shutdown(&mut self) -> Result<()> {
        info!("[jupyter-kernel] Shutting down kernel");

        // Abort background tasks first so they stop reading from ZeroMQ
        if let Some(task) = self.iopub_task.take() {
            task.abort();
        }
        if let Some(task) = self.shell_reader_task.take() {
            task.abort();
        }
        if let Some(task) = self.process_watcher_task.take() {
            task.abort();
        }
        if let Some(task) = self.heartbeat_task.take() {
            task.abort();
        }
        self.comm_coalesce_tx.take();
        if let Some(task) = self.comm_coalesce_task.take() {
            task.abort();
        }

        // Graceful shutdown: send shutdown_request, then escalate signals.
        // The kernel should exit on its own after receiving the request.
        if let Some(mut shell) = self.shell_writer.take() {
            let request: JupyterMessage = ShutdownRequest { restart: false }.into();
            let _ = shell.send(request).await;
        }

        #[cfg(unix)]
        if let Some(pid) = self.kernel_pid.take() {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;

            // Wait up to 2s for the kernel to exit after shutdown_request
            if !wait_for_pid_exit(pid, std::time::Duration::from_secs(2)).await {
                info!(
                    "[jupyter-kernel] Kernel didn't exit after shutdown_request, sending SIGTERM to pid {}",
                    pid
                );
                let _ = kill(Pid::from_raw(pid), Signal::SIGTERM);

                // Wait up to 3s for SIGTERM
                if !wait_for_pid_exit(pid, std::time::Duration::from_secs(3)).await {
                    info!(
                        "[jupyter-kernel] Kernel didn't respond to SIGTERM, sending SIGKILL to pid {}",
                        pid
                    );
                    if let Err(e) = kill(Pid::from_raw(pid), Signal::SIGKILL) {
                        match e {
                            nix::errno::Errno::ESRCH => {}
                            other => {
                                debug!(
                                    "[jupyter-kernel] Failed to SIGKILL kernel pid {}: {}",
                                    pid, other
                                );
                            }
                        }
                    }
                }
            }
        }

        #[cfg(not(unix))]
        {
            // On non-Unix platforms, kill the child process directly
            // (process groups aren't available)
        }

        if let Some(ref path) = self.connection_file {
            let _ = std::fs::remove_file(path);
        }

        #[cfg(unix)]
        if let Some(ref prefix) = self.ipc_prefix {
            cleanup_ipc_sockets(prefix);
        }

        self.connection_info = None;
        self.connection_file = None;
        self.registered_execution_ids.lock().unwrap().clear();
        self.work_cmd_tx = None;
        self.lifecycle_cmd_tx = None;

        info!("[jupyter-kernel] Kernel shutdown complete");
        Ok(())
    }

    // ── Comm messages ────────────────────────────────────────────────────

    async fn send_comm_message(&mut self, raw_message: CommRequestMessage) -> Result<()> {
        let shell = self
            .shell_writer
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("No kernel running"))?;

        let header: jupyter_protocol::Header = serde_json::from_value(raw_message.header)?;

        let msg_type = header.msg_type.clone();

        let parent_header: Option<jupyter_protocol::Header> = raw_message
            .parent_header
            .and_then(|value| serde_json::from_value(value).ok());

        let message_content =
            JupyterMessageContent::from_type_and_content(&msg_type, raw_message.content)?;

        let message = JupyterMessage {
            zmq_identities: Vec::new(),
            header,
            parent_header,
            metadata: raw_message.metadata,
            content: message_content,
            buffers: raw_message.buffers.into_iter().map(Bytes::from).collect(),
            channel: Some(jupyter_protocol::Channel::Shell),
        };

        debug!(
            "[jupyter-kernel] Sending comm message: type={} msg_id={}",
            msg_type, message.header.msg_id
        );

        shell.send(message).await?;
        Ok(())
    }

    async fn send_comm_update(
        &mut self,
        comm_id: &str,
        state: serde_json::Value,
        buffer_paths: Vec<Vec<String>>,
        buffers: Vec<Vec<u8>>,
    ) -> Result<()> {
        let shell = self
            .shell_writer
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("shell_writer not available"))?;

        let comm_msg = jupyter_protocol::CommMsg {
            comm_id: jupyter_protocol::CommId(comm_id.to_string()),
            data: {
                let mut map = serde_json::Map::new();
                map.insert("method".to_string(), serde_json::json!("update"));
                map.insert("state".to_string(), state);
                map.insert("buffer_paths".to_string(), serde_json::json!(buffer_paths));
                map
            },
        };
        let mut message: jupyter_protocol::JupyterMessage = comm_msg.into();
        message.buffers = buffers.into_iter().map(Bytes::from).collect();
        shell.send(message).await?;
        debug!(
            "[jupyter-kernel] Sent comm_msg(update) to kernel: comm_id={}",
            comm_id
        );
        Ok(())
    }

    // ── Completions ──────────────────────────────────────────────────────

    async fn complete(
        &mut self,
        code: &str,
        cursor_pos: usize,
    ) -> Result<(Vec<CompletionItem>, usize, usize)> {
        // Clone Arc before taking &mut shell_writer to avoid borrow conflicts.
        let pending = self.pending_completions.clone();

        let shell = self
            .shell_writer
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("No kernel running"))?;

        let request = CompleteRequest {
            code: code.to_string(),
            cursor_pos,
        };
        let message: JupyterMessage = request.into();
        let msg_id = message.header.msg_id.clone();

        // Register pending request
        let (tx, rx) = oneshot::channel();
        pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Lock poisoned"))?
            .insert(msg_id.clone(), tx);

        if let Err(e) = shell.send(message).await {
            if let Ok(mut guard) = pending.lock() {
                guard.remove(&msg_id);
            }
            return Err(e.into());
        }
        debug!("[jupyter-kernel] Sent complete_request: msg_id={}", msg_id);

        // Wait for response with timeout (shell reader task will resolve via pending_completions)
        match recv_oneshot_with_timeout(rx, std::time::Duration::from_secs(5)).await {
            TimedOneShot::Received(result) => Ok(result),
            TimedOneShot::SenderDropped => Err(anyhow::anyhow!("Completion request cancelled")),
            TimedOneShot::TimedOut => {
                if let Ok(mut guard) = pending.lock() {
                    guard.remove(&msg_id);
                }
                Err(anyhow::anyhow!("Completion request timed out"))
            }
        }
    }

    // ── History ──────────────────────────────────────────────────────────

    async fn get_history(
        &mut self,
        pattern: Option<&str>,
        n: i32,
        unique: bool,
    ) -> Result<Vec<HistoryEntry>> {
        if n <= 0 {
            return Ok(Vec::new());
        }

        let cache_key = HistoryCacheKey::new(pattern, unique);
        if let Some(entries) = self.history_cache.get(&cache_key, n) {
            debug!(
                "[jupyter-kernel] History cache hit: pattern={:?} unique={} n={} entries={}",
                pattern,
                unique,
                n,
                entries.len()
            );
            return Ok(entries);
        }

        // Clone Arc before taking &mut shell_writer to avoid borrow conflicts.
        let pending = self.pending_history.clone();

        let shell = self
            .shell_writer
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("No kernel running"))?;

        let glob_pattern = escape_glob_pattern(pattern);
        let request = HistoryRequest::Search {
            pattern: glob_pattern,
            unique,
            output: false,
            raw: true,
            n,
        };

        let message: JupyterMessage = request.into();
        let msg_id = message.header.msg_id.clone();

        let (tx, rx) = oneshot::channel();
        pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Lock poisoned"))?
            .insert(msg_id.clone(), tx);

        shell.send(message).await?;
        debug!("[jupyter-kernel] Sent history_request: msg_id={}", msg_id);

        match recv_oneshot_with_timeout(rx, std::time::Duration::from_secs(5)).await {
            TimedOneShot::Received(entries) => {
                self.history_cache.insert(cache_key, n, entries.clone());
                Ok(entries)
            }
            TimedOneShot::SenderDropped => Err(anyhow::anyhow!("History request cancelled")),
            TimedOneShot::TimedOut => {
                if let Ok(mut guard) = pending.lock() {
                    guard.remove(&msg_id);
                }
                Err(anyhow::anyhow!("History request timed out"))
            }
        }
    }

    // ── Read-only metadata accessors ─────────────────────────────────────

    fn kernel_type(&self) -> &str {
        &self.kernel_type
    }

    fn env_source(&self) -> &str {
        &self.env_source
    }

    fn launched_config(&self) -> &LaunchedEnvConfig {
        &self.launched_config
    }

    fn env_path(&self) -> Option<&PathBuf> {
        self.env_path.as_ref()
    }

    fn is_connected(&self) -> bool {
        self.shell_writer.is_some()
    }

    // ── Mutable metadata update ──────────────────────────────────────────

    fn update_launched_uv_deps(&mut self, deps: Vec<String>) {
        self.launched_config.uv_deps = Some(deps);
    }
}

impl JupyterKernel {
    /// Get an InterruptHandle for concurrent interrupt without &mut self.
    pub fn interrupt_handle(&self) -> Option<InterruptHandle> {
        self.connection_info.as_ref().map(|ci| InterruptHandle {
            connection_info: ci.clone(),
            session_id: self.session_id.clone(),
        })
    }
}

impl Drop for JupyterKernel {
    fn drop(&mut self) {
        // Abort any running tasks
        if let Some(task) = self.iopub_task.take() {
            task.abort();
        }
        if let Some(task) = self.shell_reader_task.take() {
            task.abort();
        }
        if let Some(task) = self.process_watcher_task.take() {
            task.abort();
        }
        if let Some(task) = self.heartbeat_task.take() {
            task.abort();
        }
        self.comm_coalesce_tx.take();
        if let Some(task) = self.comm_coalesce_task.take() {
            task.abort();
        }

        // Kill kernel process on Unix
        #[cfg(unix)]
        if let Some(pid) = self.kernel_pid.take() {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
        }

        // Clean up connection file
        if let Some(ref path) = self.connection_file {
            let _ = std::fs::remove_file(path);
        }

        #[cfg(unix)]
        if let Some(ref prefix) = self.ipc_prefix {
            cleanup_ipc_sockets(prefix);
        }

        info!("[jupyter-kernel] JupyterKernel dropped - resources cleaned up");
    }
}

/// Wait for a process to exit by polling `kill(pid, 0)`.
#[cfg(unix)]
async fn wait_for_pid_exit(pid: i32, timeout: std::time::Duration) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match kill(Pid::from_raw(pid), None) {
            Err(nix::errno::Errno::ESRCH) => return true,
            Err(_) => return true,
            Ok(()) => {
                if tokio::time::Instant::now() >= deadline {
                    return false;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

fn scrub_secret_kernel_env(cmd: &mut tokio::process::Command) {
    for key in KERNEL_ENV_SECRET_BLOCKLIST {
        cmd.env_remove(key);
    }
}

fn prepend_to_path(dir: &std::path::Path) -> String {
    let dir_str = dir.to_string_lossy();
    match std::env::var("PATH") {
        Ok(existing) => format!("{}:{}", dir_str, existing),
        Err(_) => dir_str.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn history_entry(source: &str, line: i32) -> HistoryEntry {
        HistoryEntry {
            session: 1,
            line,
            source: source.to_string(),
        }
    }

    #[test]
    fn scrub_secret_kernel_env_prevents_cloud_credentials_from_inheriting() {
        let mut cmd = tokio::process::Command::new("python");
        cmd.env("RUNT_CLOUD_TOKEN", "cloud-secret");
        cmd.env("NTERACT_API_KEY", "api-secret");
        cmd.env("NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN", "publish-secret");
        cmd.env("VISIBLE_KERNEL_ENV", "ok");

        scrub_secret_kernel_env(&mut cmd);

        let envs: Vec<_> = cmd.as_std().get_envs().collect();
        for key in KERNEL_ENV_SECRET_BLOCKLIST {
            assert!(
                envs.iter()
                    .any(|(name, value)| *name == OsStr::new(key) && value.is_none()),
                "{key} should be explicitly removed from the kernel environment"
            );
        }
        assert!(envs
            .iter()
            .any(|(name, value)| *name == OsStr::new("VISIBLE_KERNEL_ENV")
                && value == &Some(OsStr::new("ok"))));
    }

    fn codemirror_mode_parse_error() -> serde_json::Error {
        serde_json::from_value::<jupyter_protocol::CodeMirrorMode>(serde_json::json!({
            "name": "typescript",
            "version": "5.0"
        }))
        .expect_err("string version should not match the upstream CodeMirrorMode enum")
    }

    fn plain_parse_error() -> serde_json::Error {
        serde_json::from_value::<usize>(serde_json::json!("not-a-number"))
            .expect_err("string should not parse as usize")
    }

    #[test]
    fn tolerates_kernel_info_codemirror_mode_parse_error() {
        let error = jupyter_zmq_client::RuntimeError::ParseError {
            msg_type: "kernel_info_reply".to_string(),
            source: codemirror_mode_parse_error(),
        };

        assert!(is_tolerated_kernel_info_reply_parse_error(&error));
    }

    #[test]
    fn does_not_tolerate_other_kernel_info_parse_errors() {
        let error = jupyter_zmq_client::RuntimeError::ParseError {
            msg_type: "kernel_info_reply".to_string(),
            source: plain_parse_error(),
        };

        assert!(!is_tolerated_kernel_info_reply_parse_error(&error));
    }

    #[test]
    fn does_not_tolerate_codemirror_errors_on_other_messages() {
        let error = jupyter_zmq_client::RuntimeError::ParseError {
            msg_type: "execute_reply".to_string(),
            source: codemirror_mode_parse_error(),
        };

        assert!(!is_tolerated_kernel_info_reply_parse_error(&error));
    }

    #[test]
    fn comm_update_replay_is_best_effort_when_work_queue_is_full() {
        let (_lifecycle_tx, tx, mut receivers) = crate::output_prep::queue_command_channels(1);

        try_send_comm_update(
            &tx,
            "comm-a".to_string(),
            serde_json::json!({ "outputs": ["first"] }),
        );
        try_send_comm_update(
            &tx,
            "comm-b".to_string(),
            serde_json::json!({ "outputs": ["dropped"] }),
        );

        let queued = receivers
            .work_rx
            .try_recv()
            .expect("first comm update should be queued");
        assert!(matches!(
            queued,
            WorkCommand::SendCommUpdate { comm_id, .. } if comm_id == "comm-a"
        ));
        assert!(
            receivers.work_rx.try_recv().is_err(),
            "full work queue should drop comm output replay"
        );
    }

    #[tokio::test]
    async fn output_widget_replay_cache_rebuilds_on_drift_and_clear() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = crate::blob_store::BlobStore::new(tmp.path().to_path_buf());
        let first = serde_json::json!({
            "output_type": "stream",
            "name": "stdout",
            "text": "first\n",
        });
        let second = serde_json::json!({
            "output_type": "stream",
            "name": "stdout",
            "text": "second\n",
        });
        let first_manifest =
            output_store::create_manifest(&first, &blob_store, DEFAULT_INLINE_THRESHOLD)
                .await
                .expect("first manifest");
        let second_manifest =
            output_store::create_manifest(&second, &blob_store, DEFAULT_INLINE_THRESHOLD)
                .await
                .expect("second manifest");

        let mut replay_cache = HashMap::new();
        let rebuilt = resolve_output_widget_replay_state(
            &mut replay_cache,
            "comm-a",
            &[first_manifest.to_json(), second_manifest.to_json()],
            &second_manifest,
            false,
            &blob_store,
        )
        .await;
        assert_eq!(
            rebuilt.len(),
            2,
            "cache drift should rebuild from manifests"
        );
        assert_eq!(rebuilt[0]["text"], "first\n");
        assert_eq!(rebuilt[1]["text"], "second\n");

        let cleared = resolve_output_widget_replay_state(
            &mut replay_cache,
            "comm-a",
            &[second_manifest.to_json()],
            &second_manifest,
            true,
            &blob_store,
        )
        .await;
        assert_eq!(
            cleared.len(),
            1,
            "clear_output(wait=true) should discard stale replay cache"
        );
        assert_eq!(cleared[0]["text"], "second\n");
    }

    #[tokio::test]
    async fn bind_kernel_port_listeners_uses_provided_ports() {
        let ports = KernelPorts {
            stdin: 19100,
            control: 19101,
            hb: 19102,
            shell: 19103,
            iopub: 19104,
        };

        let listeners = bind_kernel_port_listeners(IpAddr::V4(Ipv4Addr::LOCALHOST), ports)
            .await
            .expect("bind provided ports");
        let bound_ports: Vec<_> = listeners
            .iter()
            .map(|listener| listener.local_addr().expect("local addr").port())
            .collect();

        assert_eq!(bound_ports, vec![19100, 19101, 19102, 19103, 19104]);
    }

    #[test]
    fn history_lru_returns_cached_prefix_and_refreshes_recency() {
        let mut cache = HistoryLruCache::new(2);
        let import_key = HistoryCacheKey::new(Some("import p"), true);
        let plot_key = HistoryCacheKey::new(Some("plt"), true);
        let numpy_key = HistoryCacheKey::new(Some("np"), true);

        cache.insert(
            import_key.clone(),
            3,
            vec![
                history_entry("import pandas as pd", 3),
                history_entry("import polars as pl", 2),
                history_entry("import pathlib", 1),
            ],
        );
        cache.insert(plot_key.clone(), 1, vec![history_entry("plt.plot(x)", 4)]);

        let hit = cache.get(&import_key, 2).expect("cache hit");
        assert_eq!(
            hit.iter()
                .map(|entry| entry.source.as_str())
                .collect::<Vec<_>>(),
            vec!["import pandas as pd", "import polars as pl"]
        );

        cache.insert(
            numpy_key.clone(),
            1,
            vec![history_entry("np.arange(10)", 5)],
        );

        assert!(cache.get(&plot_key, 1).is_none());
        assert!(cache.get(&import_key, 1).is_some());
        assert!(cache.get(&numpy_key, 1).is_some());
    }

    #[test]
    fn history_lru_misses_when_cached_result_may_be_too_small() {
        let mut cache = HistoryLruCache::new(2);
        let key = HistoryCacheKey::new(Some("import"), false);
        cache.insert(
            key.clone(),
            2,
            vec![
                history_entry("import pandas", 1),
                history_entry("import numpy", 2),
            ],
        );

        assert!(cache.get(&key, 3).is_none());

        let exhausted_key = HistoryCacheKey::new(Some("rare"), false);
        cache.insert(exhausted_key.clone(), 5, vec![history_entry("rare()", 1)]);

        assert_eq!(
            cache.get(&exhausted_key, 10).expect("exhausted hit").len(),
            1
        );
    }
}
