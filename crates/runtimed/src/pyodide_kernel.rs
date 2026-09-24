//! Pyodide adapter kernel — WASM Python sandbox as a runtime peer (dev harness).
//!
//! Implements `KernelConnection` without ZMQ: a `node` subprocess hosts Pyodide
//! (`apps/notebook-cloud/pyodide-worker/runner/pyodide-runner.mjs`) and speaks a
//! JSON-line protocol over stdio. Cell sources arrive from the synced
//! NotebookDoc by `cell_id` (the agent's queue loop owns discovery); stdout and
//! stderr are streamed back as output manifests; failures surface as structured
//! `error` outputs. Cancellation is terminate-and-restart: the child process is
//! killed, losing in-memory Python state by design.
//!
//! Launch fails honestly when Node.js or the runner script is unavailable —
//! never a silent fallback to Python.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Result};
use notebook_protocol::protocol::{
    BokehSessionPatchReply, BokehSessionPatchRequest, CommRequestMessage, LaunchedEnvConfig,
};
use runtime_doc::{KernelActivity, RuntimeLifecycle, RuntimeStateHandle};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::bokeh_session::BokehKernelPatchResponse;
use crate::kernel_connection::{KernelConnection, KernelLaunchConfig, KernelSharedRefs};
use crate::output_prep::{queue_command_channels, LifecycleSignal, QueueCommandReceivers};
use crate::protocol::{CompletionItem, HistoryEntry};

/// Runner script resolved from `RUNT_PYODIDE_RUNNER`, else the in-repo dev path.
fn resolve_runner() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RUNT_PYODIDE_RUNNER") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let dev_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/notebook-cloud/pyodide-worker/runner/pyodide-runner.mjs");
    if dev_path.is_file() {
        return Some(dev_path);
    }
    None
}

/// How long the interpreter may take to become ready (Pyodide WASM load +
/// micropip; declared packages install in the background afterwards).
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Pyodide distribution resolved from `RUNT_PYODIDE_HOME`, else the in-repo
/// dev assets fetched by `apps/notebook-cloud/scripts/fetch-pyodide-assets.mjs`.
fn resolve_pyodide_home() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RUNT_PYODIDE_HOME") {
        let path = PathBuf::from(path);
        if path.join("pyodide.mjs").is_file() {
            return Some(path);
        }
    }
    let dev_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/notebook-cloud/pyodide-assets");
    if dev_path.join("pyodide.mjs").is_file() {
        return Some(dev_path);
    }
    None
}

/// A live `node pyodide-runner.mjs` child speaking JSON lines on stdio.
struct NodeBridge {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout_lines: tokio::sync::mpsc::UnboundedReceiver<String>,
    stderr_lines: tokio::sync::mpsc::UnboundedReceiver<String>,
    /// Most recent runner output line (truncated) for startup diagnostics.
    last_output: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RunnerEvent {
    Ready,
    Stdout {
        text: String,
    },
    Stderr {
        text: String,
    },
    Installed {
        id: String,
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        /// The requirements the runner was asked to install; present on
        /// failures so the kernel can name the offending package without
        /// parsing the error prose.
        #[serde(default)]
        packages: Vec<String>,
    },
    /// Startup declared-deps install progress (emitted outside the
    /// request/response cycle, before and after `ready`).
    InstallProgress {
        phase: InstallProgressPhase,
        #[serde(default)]
        packages: Vec<String>,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        elapsed_ms: Option<u64>,
    },
    /// Requirements a request successfully installed: the runner records
    /// micropip installs made by cell code too, so the kernel can persist
    /// them for a restart.
    PackagesInstalled {
        #[serde(default)]
        packages: Vec<String>,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(default)]
        ename: Option<String>,
        #[serde(default)]
        evalue: Option<String>,
        #[serde(default)]
        traceback: Vec<String>,
        #[serde(default)]
        repr: Option<String>,
    },
    Fatal {
        #[serde(default)]
        error: Option<String>,
    },
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum InstallProgressPhase {
    InstallingPackages,
    InstallComplete,
    Error,
}

/// Merge newly installed requirements into the kernel's declared-dep list,
/// deduplicating by exact requirement string and preserving first-occurrence
/// order. Keeps an in-process interpreter respawn (cancel/crash) consistent
/// with packages hot-added to a running kernel.
fn merge_declared_deps(existing: &mut Vec<String>, added: &[String]) {
    for dep in added {
        if !existing.iter().any(|current| current == dep) {
            existing.push(dep.clone());
        }
    }
}

/// Map a raw micropip failure to one actionable, traceback-free line naming
/// the offending requirement.
fn summarize_install_error(error: &str, packages: &[String]) -> String {
    fn quoted_after<'a>(haystack: &'a str, marker: &str) -> Option<&'a str> {
        let start = haystack.find(marker)? + marker.len();
        let rest = &haystack[start..];
        let end = rest.find('\'')?;
        Some(rest[..end].trim())
    }

    /// Strip version specifiers from a requirement ("six>=1.16" -> "six").
    fn package_name(requirement: &str) -> &str {
        let end = requirement
            .find(|c: char| ">=<!~;[] ()".contains(c))
            .unwrap_or(requirement.len());
        &requirement[..end]
    }

    if let Some(name) = quoted_after(error, "Can't fetch metadata for '") {
        return format!(
            "Package '{name}' could not be resolved — check the package name and spelling."
        );
    }

    let lowered = error.to_lowercase();
    if lowered.contains("can't find a pure python 3 wheel") || lowered.contains("unsupported wheel")
    {
        let name = packages
            .first()
            .map(|req| package_name(req))
            .or_else(|| quoted_after(error, "pure Python 3 wheel for '"))
            .unwrap_or("the requested package");
        return format!(
            "Package '{name}' has no pyodide-compatible wheel (needs a pure-python or \
             pyemscripten build)."
        );
    }

    // Fallback: the last non-empty line of a Python traceback is the
    // exception itself; for single-line JS errors it is the whole message.
    let last_line = error.lines().rev().map(str::trim).find(|l| !l.is_empty());
    match last_line {
        Some(line) if !line.is_empty() => line.to_string(),
        _ => "Package install failed".to_string(),
    }
}

/// Record packages a request installed at runtime on the RuntimeStateDoc
/// `env.runtime_installed` field. A runtime peer cannot author
/// NotebookDoc metadata, so the frontend promotes these entries into
/// `runt.execution.dependencies`.
fn apply_runtime_installed(state: &RuntimeStateHandle, packages: &[String]) {
    if packages.is_empty() {
        return;
    }
    let merged = state
        .with_doc(|sd| {
            let mut all = sd.read_state().env.runtime_installed;
            for pkg in packages {
                if !all.iter().any(|current| current == pkg) {
                    all.push(pkg.clone());
                }
            }
            sd.set_runtime_installed(&all)?;
            Ok(all)
        })
        .unwrap_or_default();
    debug!(
        "[pyodide-kernel] Recorded runtime-installed packages: {:?}",
        merged
    );
}

/// Record an install-progress event from the runner on the env.progress
/// channel so the frontend banner mirrors the uv/conda path.
fn apply_install_progress(
    state: &RuntimeStateHandle,
    phase: InstallProgressPhase,
    packages: &[String],
    message: Option<&str>,
    elapsed_ms: Option<u64>,
) {
    let value = match phase {
        InstallProgressPhase::InstallingPackages => serde_json::json!({
            "phase": "installing_packages",
            "packages": packages,
        }),
        InstallProgressPhase::InstallComplete => serde_json::json!({
            "phase": "install_complete",
            "elapsed_ms": elapsed_ms.unwrap_or(0),
            "packages": packages,
        }),
        InstallProgressPhase::Error => {
            let raw = message.unwrap_or("package install failed");
            debug!("[pyodide-kernel] micropip install failed: {}", raw);
            serde_json::json!({
                "phase": "error",
                "message": summarize_install_error(raw, packages),
            })
        }
    };
    if let Err(e) = state.with_doc(|sd| sd.set_env_progress("pyodide", &value).map(|_| ())) {
        debug!("[pyodide-kernel] Failed to record install progress: {}", e);
    }
}

impl NodeBridge {
    /// Spawn the runner and wait for its `ready` event.
    async fn spawn(runner: &Path, declared_deps: &[String]) -> Result<Self> {
        let node = which_node().ok_or_else(|| {
            anyhow!(
                "Pyodide runtime requires Node.js on PATH (the pyodide.wasm adapter hosts \
                 Pyodide in a Node subprocess for local/dev sessions)."
            )
        })?;
        let mut cmd = Command::new(&node);
        cmd.arg(runner);
        if !declared_deps.is_empty() {
            cmd.env("RUNT_PYODIDE_DEPS", declared_deps.join(","));
        }
        // Point the runner at the Pyodide distribution. The daemon's own
        // environment rarely carries this, so resolve it here (env override,
        // then the in-repo dev assets).
        if let Some(home) = resolve_pyodide_home() {
            debug!("[pyodide-kernel] PYODIDE_HOME={}", home.display());
            cmd.env("PYODIDE_HOME", home);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow!("Failed to spawn Pyodide runner ({}): {}", node.display(), e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Pyodide runner has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Pyodide runner has no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Pyodide runner has no stderr"))?;

        let (stdout_tx, stdout_lines) = mpsc::unbounded_channel();
        let (stderr_tx, stderr_lines) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if stdout_tx.send(line).is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if stderr_tx.send(line).is_err() {
                    break;
                }
            }
        });

        let bridge = Self {
            child,
            stdin,
            stdout_lines,
            stderr_lines,
            last_output: String::new(),
        };
        Ok(bridge)
    }

    /// Drain events until `ready` (surfaces runner startup failures honestly).
    ///
    /// Non-protocol lines (interpreter noise on either stream) are logged and
    /// skipped rather than treated as fatal — only `fatal` or process exit
    /// aborts startup. Startup declared-deps install progress is recorded on
    /// the env.progress channel when a state handle is provided.
    async fn wait_ready(&mut self, state: Option<&RuntimeStateHandle>) -> Result<()> {
        loop {
            let line = tokio::time::timeout(READY_TIMEOUT, self.next_line())
                .await
                .map_err(|_| {
                    anyhow!(
                        "Pyodide runner did not become ready within {}s (last output: {:?})",
                        READY_TIMEOUT.as_secs(),
                        self.last_output
                    )
                })?
                .ok_or_else(|| anyhow!("Pyodide runner exited before becoming ready"))?;
            self.note_output(&line);
            match parse_event(&line) {
                Ok(RunnerEvent::Ready) => {
                    info!("[pyodide-kernel] Interpreter ready");
                    return Ok(());
                }
                Ok(RunnerEvent::Fatal { error }) => {
                    let message = error.unwrap_or_else(|| "unknown error".to_string());
                    warn!("[pyodide-kernel] Interpreter failed to start: {}", message);
                    return Err(anyhow!("Pyodide runner failed to start: {}", message));
                }
                Ok(RunnerEvent::InstallProgress {
                    phase,
                    packages,
                    message,
                    elapsed_ms,
                }) => {
                    if let Some(state) = state {
                        apply_install_progress(
                            state,
                            phase,
                            &packages,
                            message.as_deref(),
                            elapsed_ms,
                        );
                    }
                    continue;
                }
                Ok(_) => continue,
                Err(_) => {
                    debug!("[pyodide-kernel] Ignoring non-protocol line: {}", line);
                    continue;
                }
            }
        }
    }

    /// Track the most recent output for diagnostics without unbounded growth.
    fn note_output(&mut self, line: &str) {
        self.last_output = line.chars().take(400).collect();
    }

    async fn next_line(&mut self) -> Option<String> {
        // stdout carries the protocol; stderr lines are drained alongside.
        tokio::select! {
            line = self.stdout_lines.recv() => line,
            line = self.stderr_lines.recv() => line,
        }
    }

    async fn send(&mut self, request: &str) -> Result<()> {
        // The runner reads newline-delimited JSON (node:readline); a request
        // without a trailing newline is never dispatched.
        self.stdin
            .write_all(request.as_bytes())
            .await
            .map_err(|e| anyhow!("Pyodide runner stdin write failed: {}", e))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| anyhow!("Pyodide runner stdin write failed: {}", e))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| anyhow!("Pyodide runner stdin flush failed: {}", e))
    }

    fn kill(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn parse_event(line: &str) -> Result<RunnerEvent> {
    serde_json::from_str(line).map_err(|e| {
        anyhow!(
            "Pyodide runner sent a malformed protocol line: {} ({})",
            e,
            line
        )
    })
}

fn which_node() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RUNT_NODE_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    // `which node` without shelling out: probe PATH manually.
    let path_env = std::env::var("PATH").ok()?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join("node");
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        let candidate = dir.join("node.exe");
        #[cfg(windows)]
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub struct PyodideKernel {
    state: RuntimeStateHandle,
    lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
    kernel_type: String,
    env_source: String,
    launched_config: LaunchedEnvConfig,
    runner: PathBuf,
    bridge: Option<NodeBridge>,
    execution_counter: u64,
    kernel_id: String,
    /// Declared `runt.execution.dependencies`, passed to the runner as
    /// `RUNT_PYODIDE_DEPS` so micropip installs them at interpreter startup.
    declared_deps: Vec<String>,
}

impl PyodideKernel {
    /// Spawn (or re-spawn after cancel) the interpreter process.
    async fn ensure_bridge(&mut self) -> Result<&mut NodeBridge> {
        if self.bridge.is_none() {
            info!(
                "[pyodide-kernel] Starting Pyodide interpreter (runner={}, declared_deps={})",
                self.runner.display(),
                self.declared_deps.len()
            );
            match NodeBridge::spawn(&self.runner, &self.declared_deps).await {
                Ok(mut bridge) => {
                    // Startup declared-deps install progress lands on the
                    // env.progress channel; events emitted before `ready` are
                    // consumed here.
                    bridge
                        .wait_ready(Some(&self.state))
                        .await
                        .inspect_err(|error| {
                            warn!("[pyodide-kernel] Interpreter start failed: {:#}", error);
                        })?;
                    self.bridge = Some(bridge);
                }
                Err(error) => {
                    // Loud: a silent interpreter-start failure previously left
                    // cells queued with no visible reason.
                    warn!("[pyodide-kernel] Interpreter start failed: {:#}", error);
                    return Err(error);
                }
            }
        }
        Ok(self.bridge.as_mut().expect("bridge just set"))
    }
}

impl KernelConnection for PyodideKernel {
    async fn launch(
        config: KernelLaunchConfig,
        shared: KernelSharedRefs,
    ) -> Result<(Self, QueueCommandReceivers)> {
        let runner = resolve_runner().ok_or_else(|| {
            anyhow!(
                "Pyodide runtime runner not found. Set RUNT_PYODIDE_RUNNER to \
                 apps/notebook-cloud/pyodide-worker/runner/pyodide-runner.mjs (or install the \
                 pyodide worker assets)."
            )
        })?;

        let (lifecycle_tx, _visualization_tx, _work_tx, receivers) = queue_command_channels(1);

        if let Err(e) = shared
            .state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
        {
            debug!("[pyodide-kernel] Failed to set initial idle state: {}", e);
        }

        // Declared pyodide deps ride the launch env so the runner installs
        // them via micropip at startup.
        let declared_deps: Vec<String> = config
            .env_vars
            .iter()
            .find(|(key, _)| key == "RUNT_PYODIDE_DEPS")
            .map(|(_, value)| {
                value
                    .split(',')
                    .map(|dep| dep.trim().to_string())
                    .filter(|dep| !dep.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let kernel = Self {
            state: shared.state,
            lifecycle_tx,
            kernel_type: config.kernel_type,
            env_source: config.env_source,
            launched_config: config.launched_config,
            runner,
            bridge: None,
            execution_counter: 0,
            kernel_id: "pyodide".to_string(),
            declared_deps,
        };
        Ok((kernel, receivers))
    }

    async fn execute(
        &mut self,
        execution_id: &str,
        cell_id: Option<&str>,
        source: &str,
    ) -> Result<()> {
        self.execution_counter += 1;
        let _ = cell_id; // provenance is already recorded on the execution entry
        let eid = execution_id.to_string();

        if let Err(e) = self
            .state
            .with_doc(|sd| sd.set_execution_running(&eid).map(|_| ()))
        {
            debug!("[pyodide-kernel] State write failed for {}: {}", eid, e);
        }

        let request_id = format!("exec-{}", self.execution_counter);
        let request = serde_json::json!({
            "type": "execute",
            "id": request_id,
            "source": source,
        });

        let mut stdout = String::new();
        let mut stderr = String::new();
        let result = self
            .run_in_sandbox(&request_id, &request, &mut stdout, &mut stderr)
            .await;

        self.commit_result(&eid, stdout, stderr, result).await;
        Ok(())
    }

    /// Install packages into the live sandbox via micropip.
    /// Additions only — removal needs a restart, so the daemon rejects it.
    async fn install_packages(&mut self, packages: &[String]) -> Result<Vec<String>> {
        if packages.is_empty() {
            return Ok(Vec::new());
        }
        // In-flight phase first: the frontend banner mirrors the uv/conda
        // hot-sync path while micropip resolves and downloads.
        let _ = self.state.with_doc(|sd| {
            sd.set_env_progress(
                "pyodide",
                &serde_json::json!({
                    "phase": "installing_packages",
                    "packages": packages,
                }),
            )
            .map(|_| ())
        });

        let request_id = format!("install-{}", self.execution_counter);
        let request = serde_json::json!({
            "type": "install",
            "id": request_id,
            "packages": packages,
        });

        let started = std::time::Instant::now();
        let (mut stdout, mut stderr) = (String::new(), String::new());
        let outcome = self
            .run_install(&request_id, &request, &mut stdout, &mut stderr)
            .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        // Terminal phase: success renders the completion banner; failure
        // renders an actionable, traceback-free summary. The full micropip
        // output stays in daemon logs at debug level.
        let summary = match &outcome {
            Ok(()) => None,
            Err(error) => {
                debug!("[pyodide-kernel] micropip install failed: {}", error);
                Some(summarize_install_error(&error.to_string(), packages))
            }
        };
        let log_tail = if stderr.is_empty() {
            stdout.clone()
        } else {
            stderr.clone()
        };
        let _ = self.state.with_doc(|sd| {
            let phase = match &summary {
                None => serde_json::json!({
                    "phase": "install_complete",
                    "elapsed_ms": elapsed_ms,
                    "packages": packages,
                }),
                Some(message) => serde_json::json!({
                    "phase": "error",
                    "message": message,
                }),
            };
            sd.set_env_progress("pyodide", &phase)?;
            if !log_tail.is_empty() {
                debug!("[pyodide-kernel] install log: {}", log_tail);
            }
            Ok(())
        });

        match outcome {
            Ok(()) => {
                // A respawn must reinstall what this kernel just installed,
                // not just what the notebook declared at launch.
                merge_declared_deps(&mut self.declared_deps, packages);
                Ok(packages.to_vec())
            }
            // The response carries the same summarized message as the
            // env.progress error phase; the daemon's agent loop adds its
            // "Failed to install packages:" prefix.
            Err(_) => Err(anyhow!("{}", summary.expect("summary set on error"))),
        }
    }

    /// Cancellation is terminate-and-restart: kill the child;
    /// the next execute re-spawns a fresh interpreter.
    async fn interrupt(&mut self) -> Result<()> {
        if let Some(bridge) = self.bridge.as_mut() {
            warn!("[pyodide-kernel] Cancelling execution: terminating interpreter");
            bridge.kill();
        }
        self.bridge = None;
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        if let Some(bridge) = self.bridge.as_mut() {
            bridge.kill();
        }
        self.bridge = None;
        Ok(())
    }

    async fn send_comm_message(&mut self, _: CommRequestMessage) -> Result<()> {
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

    async fn apply_bokeh_session_patch(
        &mut self,
        request: BokehSessionPatchRequest,
    ) -> Result<BokehKernelPatchResponse> {
        Ok(BokehKernelPatchResponse {
            reply: BokehSessionPatchReply::Accepted {
                session_id: request.session_id,
                transaction_id: request.transaction_id,
                revision: request.base_revision + 1,
            },
            stdout: String::new(),
            stderr: String::new(),
            error_output: None,
        })
    }

    fn bokeh_session_checkpoint_request(
        &self,
        session_id: String,
    ) -> Option<crate::bokeh_session::BokehCheckpointFuture> {
        Some(Box::pin(async move {
            Ok(crate::bokeh_session::BokehKernelCheckpoint {
                session_id,
                revision: 0,
                document: crate::bokeh_session::BokehKernelSerialization {
                    content: serde_json::json!({}),
                    buffers: Vec::new(),
                },
            })
        }))
    }

    async fn complete(&mut self, _: &str, _: usize) -> Result<(Vec<CompletionItem>, usize, usize)> {
        Ok((vec![], 0, 0))
    }

    async fn get_history(&mut self, _: Option<&str>, _: i32, _: bool) -> Result<Vec<HistoryEntry>> {
        Ok(vec![])
    }

    fn kernel_type(&self) -> &str {
        &self.kernel_type
    }

    fn kernel_id(&self) -> &str {
        &self.kernel_id
    }

    fn env_source(&self) -> &str {
        &self.env_source
    }

    fn launched_config(&self) -> &LaunchedEnvConfig {
        &self.launched_config
    }

    fn env_path(&self) -> Option<&PathBuf> {
        None
    }

    fn is_connected(&self) -> bool {
        self.bridge
            .as_ref()
            .map(|b| b.child.id().is_some())
            .unwrap_or(false)
    }

    fn update_launched_uv_deps(&mut self, _: Vec<String>) {}
}

struct PyodideError {
    ename: String,
    evalue: String,
    traceback: Vec<String>,
}

impl std::fmt::Display for PyodideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.ename, self.evalue)
    }
}

impl std::fmt::Debug for PyodideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.ename, self.evalue)
    }
}

impl std::error::Error for PyodideError {}

impl PyodideKernel {
    /// Send one execute request and collect events until its result arrives.
    async fn run_in_sandbox(
        &mut self,
        request_id: &str,
        request: &serde_json::Value,
        stdout: &mut String,
        stderr: &mut String,
    ) -> Result<Option<String>, PyodideError> {
        let bridge = self.ensure_bridge().await.map_err(|e| PyodideError {
            ename: "PyodideRuntimeError".to_string(),
            evalue: e.to_string(),
            traceback: vec![],
        })?;
        if let Err(e) = bridge.send(&request.to_string()).await {
            // A dead pipe means the interpreter died — restart on next execute.
            self.bridge = None;
            return Err(PyodideError {
                ename: "PyodideRuntimeError".to_string(),
                evalue: e.to_string(),
                traceback: vec![],
            });
        }
        loop {
            // Scope the bridge borrow so install-progress events can reach
            // the RuntimeStateDoc inside the loop.
            let line = {
                let Some(bridge) = self.bridge.as_mut() else {
                    return Err(PyodideError {
                        ename: "PyodideRuntimeError".to_string(),
                        evalue: "Pyodide runner exited mid-execution".to_string(),
                        traceback: vec![],
                    });
                };
                bridge.next_line().await
            };
            let Some(line) = line else {
                self.bridge = None;
                return Err(PyodideError {
                    ename: "PyodideRuntimeError".to_string(),
                    evalue: "Pyodide runner exited mid-execution".to_string(),
                    traceback: vec![],
                });
            };
            match parse_event(&line) {
                Ok(RunnerEvent::Stdout { text }) => stdout.push_str(&text),
                Ok(RunnerEvent::Stderr { text }) => stderr.push_str(&text),
                Ok(RunnerEvent::InstallProgress {
                    phase,
                    packages,
                    message,
                    elapsed_ms,
                }) => {
                    apply_install_progress(
                        &self.state,
                        phase,
                        &packages,
                        message.as_deref(),
                        elapsed_ms,
                    );
                }
                Ok(RunnerEvent::PackagesInstalled { packages }) => {
                    apply_runtime_installed(&self.state, &packages);
                }
                Ok(RunnerEvent::Result {
                    id,
                    ok,
                    ename,
                    evalue,
                    traceback,
                    repr,
                }) if id == request_id => {
                    if ok {
                        return Ok(repr);
                    }
                    return Err(PyodideError {
                        ename: ename.unwrap_or_else(|| "Exception".to_string()),
                        evalue: evalue.unwrap_or_default(),
                        traceback,
                    });
                }
                Ok(RunnerEvent::Result { .. }) => continue,
                Ok(other) => {
                    debug!(
                        "[pyodide-kernel] Ignoring event during execute: {:?}",
                        other
                    );
                    continue;
                }
                Err(e) => {
                    // Interpreter noise is not a protocol failure; only a
                    // dead process is (handled by the None branch above).
                    debug!(
                        "[pyodide-kernel] Ignoring non-protocol line: {} ({})",
                        line, e
                    );
                    continue;
                }
            }
        }
    }

    /// Send one install request and await its result.
    async fn run_install(
        &mut self,
        request_id: &str,
        request: &serde_json::Value,
        stdout: &mut String,
        stderr: &mut String,
    ) -> Result<()> {
        let bridge = self.ensure_bridge().await?;
        if let Err(e) = bridge.send(&request.to_string()).await {
            self.bridge = None;
            return Err(anyhow!("Pyodide runner stdin write failed: {}", e));
        }
        loop {
            // Scope the bridge borrow so install-progress events can reach
            // the RuntimeStateDoc inside the loop.
            let line = {
                let Some(bridge) = self.bridge.as_mut() else {
                    return Err(anyhow!("Pyodide runner exited mid-install"));
                };
                bridge.next_line().await
            };
            let Some(line) = line else {
                self.bridge = None;
                return Err(anyhow!("Pyodide runner exited mid-install"));
            };
            match parse_event(&line) {
                Ok(RunnerEvent::Stdout { text }) => stdout.push_str(&text),
                Ok(RunnerEvent::Stderr { text }) => stderr.push_str(&text),
                Ok(RunnerEvent::InstallProgress {
                    phase,
                    packages,
                    message,
                    elapsed_ms,
                }) => {
                    apply_install_progress(
                        &self.state,
                        phase,
                        &packages,
                        message.as_deref(),
                        elapsed_ms,
                    );
                }
                Ok(RunnerEvent::PackagesInstalled { packages }) => {
                    apply_runtime_installed(&self.state, &packages);
                }
                Ok(RunnerEvent::Installed {
                    id,
                    ok,
                    error,
                    packages,
                }) if id == request_id => {
                    if ok {
                        info!("[pyodide-kernel] Installed packages");
                        return Ok(());
                    }
                    warn!(
                        "[pyodide-kernel] Package install failed for {:?}: {:?}",
                        packages, error
                    );
                    return Err(anyhow!(
                        "{}",
                        error.unwrap_or_else(|| "package install failed".to_string())
                    ));
                }
                Ok(_) => continue,
                Err(e) => {
                    debug!(
                        "[pyodide-kernel] Ignoring non-protocol line: {} ({})",
                        line, e
                    );
                    continue;
                }
            }
        }
    }

    /// Write outputs and terminal lifecycle for a finished execution.
    async fn commit_result(
        &self,
        execution_id: &str,
        stdout: String,
        stderr: String,
        result: Result<Option<String>, PyodideError>,
    ) {
        let mut manifests = Vec::new();
        if !stdout.is_empty() {
            manifests.push(serde_json::json!({
                "output_type": "stream",
                "output_id": format!("pyodide-out-{}-stdout", execution_id),
                "name": "stdout",
                "text": { "inline": stdout },
            }));
        }
        if !stderr.is_empty() {
            manifests.push(serde_json::json!({
                "output_type": "stream",
                "output_id": format!("pyodide-out-{}-stderr", execution_id),
                "name": "stderr",
                "text": { "inline": stderr },
            }));
        }
        let success = result.is_ok();
        match result {
            Ok(Some(repr)) if !repr.is_empty() => {
                manifests.push(serde_json::json!({
                    "output_type": "execute_result",
                    "output_id": format!("pyodide-out-{}-result", execution_id),
                    "data": { "text/plain": repr },
                    "metadata": {},
                    "execution_count": self.execution_counter,
                }));
            }
            Ok(_) => {}
            Err(e) => {
                manifests.push(serde_json::json!({
                    "output_type": "error",
                    "output_id": format!("pyodide-out-{}-error", execution_id),
                    "ename": e.ename,
                    "evalue": e.evalue,
                    "traceback": e.traceback,
                }));
            }
        }

        if let Err(e) = self.state.with_doc(|sd| {
            sd.set_execution_count(execution_id, self.execution_counter as i64)?;
            for manifest in &manifests {
                sd.append_output(execution_id, manifest)?;
            }
            Ok(())
        }) {
            debug!(
                "[pyodide-kernel] State write failed for {}: {}",
                execution_id, e
            );
        }

        let _ = self.lifecycle_tx.send(LifecycleSignal::ExecutionDone {
            execution_id: execution_id.to_string(),
        });
        let _ = success;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_declared_deps_deduplicates_and_preserves_order() {
        let mut existing = vec!["six".to_string(), "attrs".to_string()];
        merge_declared_deps(
            &mut existing,
            &["attrs".to_string(), "numpy".to_string(), "six".to_string()],
        );
        assert_eq!(
            existing,
            vec!["six".to_string(), "attrs".to_string(), "numpy".to_string()]
        );
        // Merging an already-declared list is a no-op.
        merge_declared_deps(&mut existing, &["numpy".to_string()]);
        assert_eq!(existing.len(), 3);
    }

    #[test]
    fn summarize_unknown_package_metadata_error() {
        // The exact live failure from a typo'd package name (user report):
        // micropip wraps the Python traceback around the ValueError.
        let error = "Traceback (most recent call last):\n  File \
\"/lib/python3.13/site-packages/micropip/package_index.py\", line 337, in \
query_package\nValueError: Can't fetch metadata for 'request'. Please make \
sure you have entered a correct package name and correctly specified \
index_urls (if you changed them).";
        assert_eq!(
            summarize_install_error(error, &["request".to_string()]),
            "Package 'request' could not be resolved — check the package name and spelling."
        );
    }

    #[test]
    fn summarize_uninstallable_wheel_error_prefers_requirement_list() {
        let error = "Can't find a pure Python 3 wheel for 'numpy>=1.0' (from: numpy)";
        assert_eq!(
            summarize_install_error(error, &["numpy>=1.0".to_string()]),
            "Package 'numpy' has no pyodide-compatible wheel (needs a pure-python or \
             pyemscripten build)."
        );
    }

    #[test]
    fn summarize_uninstallable_wheel_error_extracts_name_from_message() {
        let error = "Can't find a pure Python 3 wheel for 'scipy' (from: scipy)";
        assert_eq!(
            summarize_install_error(error, &[]),
            "Package 'scipy' has no pyodide-compatible wheel (needs a pure-python or \
             pyemscripten build)."
        );
    }

    #[test]
    fn summarize_falls_back_to_exception_line_of_traceback() {
        let error = "Traceback (most recent call last):\n  File \"x\", line 1\n\
NetworkError: some transport failure";
        assert_eq!(
            summarize_install_error(error, &[]),
            "NetworkError: some transport failure"
        );
    }

    #[test]
    fn summarize_empty_error_has_default_message() {
        assert_eq!(summarize_install_error("", &[]), "Package install failed");
    }

    #[test]
    fn install_progress_phase_names_parse_from_runner_payload() {
        for (payload, expected) in [
            (
                r#"{"type":"install_progress","phase":"installing_packages","packages":["six"]}"#,
                InstallProgressPhase::InstallingPackages,
            ),
            (
                r#"{"type":"install_progress","phase":"install_complete","packages":["six"],"elapsed_ms":1200}"#,
                InstallProgressPhase::InstallComplete,
            ),
            (
                r#"{"type":"install_progress","phase":"error","packages":["request"],"message":"boom"}"#,
                InstallProgressPhase::Error,
            ),
        ] {
            match parse_event(payload).expect("parse install_progress") {
                RunnerEvent::InstallProgress { phase, .. } => assert_eq!(phase, expected),
                other => panic!("unexpected event: {other:?}"),
            }
        }
    }

    #[test]
    fn packages_installed_event_parses() {
        match parse_event(r#"{"type":"packages_installed","packages":["six","attrs"]}"#)
            .expect("parse packages_installed")
        {
            RunnerEvent::PackagesInstalled { packages } => {
                assert_eq!(packages, vec!["six".to_string(), "attrs".to_string()])
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    /// End-to-end framing check against the real runner: a request must be
    /// newline-terminated (node:readline never dispatches an unterminated
    /// line), and the runner answers with stdout + a result for that id.
    ///
    /// Skips silently when Node.js or the Pyodide dev assets are unavailable
    /// so the suite stays green on machines without them.
    #[tokio::test]
    async fn bridge_executes_cell_over_newline_framed_protocol() {
        let Some(runner) = resolve_runner() else {
            eprintln!("skipping: pyodide runner not found");
            return;
        };
        if which_node().is_none() {
            eprintln!("skipping: node not found");
            return;
        }
        let mut bridge = match NodeBridge::spawn(&runner, &[]).await {
            Ok(bridge) => bridge,
            Err(error) => {
                eprintln!("skipping: interpreter unavailable ({error})");
                return;
            }
        };

        let request = serde_json::json!({
            "type": "execute",
            "id": "test-1",
            "source": "print('pong')",
        });
        bridge.send(&request.to_string()).await.expect("send");

        let collected = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            let mut stdout = String::new();
            let mut saw_result = false;
            loop {
                let Some(line) = bridge.next_line().await else {
                    break;
                };
                match parse_event(&line) {
                    Ok(RunnerEvent::Stdout { text }) => stdout.push_str(&text),
                    Ok(RunnerEvent::Result { id, ok, .. }) if id == "test-1" => {
                        assert!(ok, "execution reported failure");
                        saw_result = true;
                        break;
                    }
                    _ => continue,
                }
            }
            (stdout, saw_result)
        })
        .await
        .expect("runner never returned a result within 120s (framing bug?)");

        assert!(collected.1, "runner never returned a result (framing bug?)");
        assert!(
            collected.0.contains("pong"),
            "expected captured stdout, got {:?}",
            collected.0
        );

        // Install channel (pyodide hot-sync): micropip installs a real wheel
        // and the runner answers with `installed`.
        let install = serde_json::json!({
            "type": "install",
            "id": "install-1",
            "packages": ["six"],
        });
        bridge
            .send(&install.to_string())
            .await
            .expect("send install");
        let installed = tokio::time::timeout(std::time::Duration::from_secs(180), async {
            loop {
                let Some(line) = bridge.next_line().await else {
                    return None;
                };
                match parse_event(&line) {
                    Ok(RunnerEvent::Installed { id, ok, error, .. }) if id == "install-1" => {
                        return Some((ok, error));
                    }
                    _ => continue,
                }
            }
        })
        .await
        .expect("install response timed out");
        let (ok, error) = installed.expect("runner exited during install");
        assert!(ok, "install failed: {error:?}");

        // The installed package is importable in a subsequent cell.
        let check = serde_json::json!({
            "type": "execute",
            "id": "check-1",
            "source": "import six; print(six.__version__)",
        });
        bridge.send(&check.to_string()).await.expect("send check");
        let version = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            let mut stdout = String::new();
            loop {
                let Some(line) = bridge.next_line().await else {
                    return None;
                };
                match parse_event(&line) {
                    Ok(RunnerEvent::Stdout { text }) => stdout.push_str(&text),
                    Ok(RunnerEvent::Result { id, ok, .. }) if id == "check-1" => {
                        return if ok { Some(stdout) } else { None };
                    }
                    _ => continue,
                }
            }
        })
        .await
        .expect("import check timed out");
        let version = version.expect("import of installed package failed");
        assert!(
            version.contains("1."),
            "expected six version output, got {version:?}"
        );

        // Cell-code install capture: a cell that calls `micropip.install`
        // produces a `packages_installed` event naming the requirement, so the
        // kernel can persist it for a restart.
        let cell_install = serde_json::json!({
            "type": "execute",
            "id": "capture-1",
            "source": "import micropip\nawait micropip.install('attrs')\nprint('captured')",
        });
        bridge
            .send(&cell_install.to_string())
            .await
            .expect("send cell install");
        let captured = tokio::time::timeout(std::time::Duration::from_secs(180), async {
            let mut saw_result = false;
            let mut captured_packages: Vec<String> = Vec::new();
            loop {
                let Some(line) = bridge.next_line().await else {
                    return None;
                };
                match parse_event(&line) {
                    Ok(RunnerEvent::PackagesInstalled { packages }) => {
                        captured_packages.extend(packages);
                    }
                    Ok(RunnerEvent::Result { id, ok, .. }) if id == "capture-1" => {
                        saw_result = true;
                        if !ok {
                            return None;
                        }
                    }
                    _ => continue,
                }
                if saw_result && !captured_packages.is_empty() {
                    return Some(captured_packages);
                }
            }
        })
        .await
        .expect("cell install capture timed out");
        let captured = captured.expect("cell install did not report packages_installed");
        assert!(
            captured.iter().any(|pkg| pkg == "attrs"),
            "expected captured attrs requirement, got {captured:?}"
        );
        bridge.kill();
    }
}
