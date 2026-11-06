//! Subprocess entry point for pool environment warming.
//!
//! The `warm-env` subcommand runs as a short-lived child process spawned by the
//! daemon's warming loops. It creates one environment (UV, Conda, or Pixi),
//! writes structured JSON events to stdout, and exits. All of rattler's
//! in-process memory is reclaimed by the OS when the process exits.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use crate::async_outcome::TimedResult;
use crate::EnvType;

// -- IPC protocol --------------------------------------------------------
//
// stdin:  single JSON object (WarmEnvConfig) - all arguments for the run
// stdout: newline-delimited JSON events (WarmEnvEvent) - progress + result

#[derive(Debug, Serialize, Deserialize)]
pub struct WarmEnvConfig {
    pub env_type: EnvType,
    pub env_dir: PathBuf,
    pub packages: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
}

// -- stdout events -------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum WarmEnvEvent {
    Progress { phase: String, detail: String },
    Result(WarmEnvResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WarmEnvResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venv_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_package: Option<String>,
}

// -- helpers --------------------------------------------------------------

fn emit(event: &WarmEnvEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        let mut stdout = std::io::stdout();
        let _ = std::io::Write::write_all(&mut stdout, json.as_bytes());
        let _ = std::io::Write::write_all(&mut stdout, b"\n");
        let _ = std::io::Write::flush(&mut stdout);
    }
}

fn progress(phase: &str, detail: &str) {
    emit(&WarmEnvEvent::Progress {
        phase: phase.into(),
        detail: detail.into(),
    });
}

fn success_result(python_path: PathBuf, venv_path: PathBuf) -> WarmEnvResult {
    WarmEnvResult {
        success: true,
        python_path: Some(python_path),
        venv_path: Some(venv_path),
        error: None,
        error_kind: None,
        failed_package: None,
    }
}

fn failure_result(
    error: String,
    error_kind: &str,
    failed_package: Option<String>,
) -> WarmEnvResult {
    WarmEnvResult {
        success: false,
        python_path: None,
        venv_path: None,
        error: Some(error),
        error_kind: Some(error_kind.into()),
        failed_package,
    }
}

fn emit_success(python_path: PathBuf, venv_path: PathBuf) {
    emit(&WarmEnvEvent::Result(success_result(
        python_path,
        venv_path,
    )));
}

fn emit_failure(error: String, error_kind: &str, failed_package: Option<String>) {
    emit(&WarmEnvEvent::Result(failure_result(
        error,
        error_kind,
        failed_package,
    )));
}

// -- package hash (shared with daemon's find_existing_environments) -------

const POOL_PACKAGE_HASH_FILE: &str = ".runt-pool-packages.sha256";
const POOL_PACKAGE_HASH_VERSION: &str = "v1";
const POOL_READY_MARKER_FILE: &str = ".runt-pool-ready";

fn expected_pool_package_hash(env_type: EnvType, packages: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut sorted = packages.to_vec();
    sorted.sort();

    let mut hasher = Sha256::new();
    hasher.update(POOL_PACKAGE_HASH_VERSION.as_bytes());
    hasher.update(b"\n");
    hasher.update(env_type.to_string().as_bytes());
    hasher.update(b"\n");
    hasher.update(std::env::consts::OS.as_bytes());
    hasher.update(b"\n");
    hasher.update(std::env::consts::ARCH.as_bytes());
    hasher.update(b"\n");
    for package in sorted {
        hasher.update(package.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

async fn write_pool_package_hash(
    env_root: &Path,
    env_type: EnvType,
    packages: &[String],
) -> std::io::Result<()> {
    tokio::fs::write(
        env_root.join(POOL_PACKAGE_HASH_FILE),
        expected_pool_package_hash(env_type, packages),
    )
    .await
}

async fn write_pool_ready_marker(env_root: &Path) -> std::io::Result<()> {
    tokio::fs::write(env_root.join(POOL_READY_MARKER_FILE), "").await
}

// -- site-packages discovery ----------------------------------------------

fn find_site_packages(env_path: &Path) -> Option<String> {
    let lib_dir = env_path.join("lib");
    std::fs::read_dir(&lib_dir).ok().and_then(|entries| {
        entries.flatten().find_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if name.starts_with("python") {
                let sp = path.join("site-packages");
                sp.is_dir().then(|| sp.to_string_lossy().into_owned())
            } else {
                None
            }
        })
    })
}

// -- UV env creation ------------------------------------------------------

const UV_OFFLINE_INSTALL_TIMEOUT: Duration = Duration::from_secs(30);
const UV_ONLINE_INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const UV_VENV_TIMEOUT: Duration = Duration::from_secs(60);
const PYTHON_RUNTIME_VALIDATION_TIMEOUT: Duration = Duration::from_secs(60);
const PROCESS_TREE_REAP_TIMEOUT: Duration = Duration::from_secs(5);
// Keep optional warming below the daemon's 120s pool-take wait. Long compileall
// runs should not keep a validated environment out of the pool.
const PYTHON_WARMUP_TIMEOUT: Duration = Duration::from_secs(30);

fn uv_pip_install_args(python_path: &Path, packages: &[String], offline: bool) -> Vec<String> {
    let mut args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--link-mode".to_string(),
        "hardlink".to_string(),
        "--python".to_string(),
        python_path.to_string_lossy().to_string(),
    ];
    if offline {
        args.push("--offline".to_string());
    }
    args.extend(packages.iter().cloned());
    args
}

enum UvInstallAttempt {
    Completed(std::process::Output),
    SpawnError(std::io::Error),
    Timeout,
}

async fn run_uv_pip_install(
    uv_path: &Path,
    install_args: &[String],
    timeout: Duration,
) -> UvInstallAttempt {
    let mut command = tokio::process::Command::new(uv_path);
    command.args(install_args);

    match run_output_with_timeout(command, timeout).await {
        TimedResult::Completed(output) => UvInstallAttempt::Completed(output),
        TimedResult::Failed(e) => UvInstallAttempt::SpawnError(e),
        TimedResult::TimedOut => UvInstallAttempt::Timeout,
    }
}

async fn read_pipe_to_end<R>(mut reader: R) -> io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut output = Vec::new();
    reader.read_to_end(&mut output).await?;
    Ok(output)
}

/// Owns a spawned subprocess and every process it starts.
///
/// On Unix the child leads its own process group. Until the child has been
/// waited on (`disarm`) or the group killed, dropping this SIGKILLs the whole
/// group, so a cancelled caller does not leave installer grandchildren
/// running. On Windows the kill-on-close job does the same when dropped.
/// A leader that starts process groups of its own needs SIGTERM first; wrap
/// it in [`LeaderChild`] instead.
#[cfg(unix)]
pub(crate) struct ChildProcessTree {
    pgid: i32,
    /// True while the group may still hold live processes that this owner
    /// is responsible for. Cleared after the leader exits normally or the
    /// group is killed, so a reused process-group id is never signalled.
    armed: bool,
}

#[cfg(unix)]
impl Drop for ChildProcessTree {
    fn drop(&mut self) {
        if self.armed {
            terminate_process_tree(self);
        }
    }
}

/// How long a leader that owns child process groups gets to stop them after
/// SIGTERM before its group is killed.
#[cfg(unix)]
const LEADER_STOP_GRACE: Duration = Duration::from_secs(3);

#[cfg(unix)]
fn signal_process_group(pgid: i32, signal: nix::sys::signal::Signal) {
    use nix::sys::signal::killpg;
    use nix::unistd::Pid;

    if let Err(error) = killpg(Pid::from_raw(pgid), signal) {
        if error != nix::errno::Errno::ESRCH {
            warn!("[warm-env] Failed to send {signal} to subprocess group {pgid}: {error}");
        }
    }
}

#[cfg(windows)]
pub(crate) struct ChildProcessTree {
    job: Option<crate::runtime_agent_manifest::WindowsJob>,
}

#[cfg(not(any(unix, windows)))]
pub(crate) struct ChildProcessTree;

impl ChildProcessTree {
    /// The child exited normally and its pipes closed; dropping this no
    /// longer signals the process group.
    pub(crate) fn disarm(&mut self) {
        #[cfg(unix)]
        {
            self.armed = false;
        }
    }
}

pub(crate) fn configure_process_tree(_command: &mut tokio::process::Command) {
    #[cfg(unix)]
    _command.process_group(0);
}

pub(crate) fn own_process_tree(child: &tokio::process::Child) -> io::Result<ChildProcessTree> {
    #[cfg(unix)]
    {
        let pgid = child
            .id()
            .ok_or_else(|| io::Error::other("spawned child has no process id"))?
            as i32;
        Ok(ChildProcessTree { pgid, armed: true })
    }

    #[cfg(windows)]
    {
        use std::os::windows::io::RawHandle;

        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("spawned child has no process id"))?;
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("spawned child has no process handle"))?
            as RawHandle;
        let job_name = format!("nteract-warm-env-command-{pid}");
        let job = crate::runtime_agent_manifest::create_windows_kill_on_close_job_for_process(
            &job_name,
            process_handle,
        )
        .map_err(|error| io::Error::other(error.to_string()))?;
        Ok(ChildProcessTree { job: Some(job) })
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = child;
        Ok(ChildProcessTree)
    }
}

/// Owns a `warm-env` subprocess and its process tree.
///
/// The subprocess starts each installer command in a process group of its
/// own, so killing its group leaves those installers running. It is stopped
/// with SIGTERM first, which makes it kill its installer groups, and gets
/// [`LEADER_STOP_GRACE`] before its group is killed. [`LeaderChild::stop`]
/// does that inline, and dropping this does it in the background.
///
/// This owns the `Child` so the leader is never reaped before a group
/// signal: an unreaped leader keeps its pid, and so its group id, reserved.
pub(crate) struct LeaderChild {
    /// `None` only after Drop has moved it into the background stop.
    child: Option<tokio::process::Child>,
    tree: ChildProcessTree,
}

impl LeaderChild {
    /// Take ownership of a child spawned with [`configure_process_tree`].
    /// If its tree cannot be owned, the child is killed.
    pub(crate) fn new(mut child: tokio::process::Child) -> io::Result<Self> {
        match own_process_tree(&child) {
            Ok(tree) => Ok(Self {
                child: Some(child),
                tree,
            }),
            Err(error) => {
                let _ = child.start_kill();
                Err(error)
            }
        }
    }

    #[allow(clippy::expect_used)] // `child` is only taken in Drop.
    pub(crate) fn child_mut(&mut self) -> &mut tokio::process::Child {
        self.child
            .as_mut()
            .expect("leader child is present until drop")
    }

    /// The leader exited and was reaped; nothing is left to signal.
    pub(crate) fn disarm(&mut self) {
        self.tree.disarm();
    }

    /// Stop the leader and reap it.
    ///
    /// On Unix the group gets SIGTERM and [`LEADER_STOP_GRACE`] to exit. A
    /// leader that is still running after that is killed with its group.
    /// On Windows the kill-on-close job already covers every descendant.
    pub(crate) async fn stop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        #[cfg(unix)]
        if self.tree.armed {
            signal_process_group(self.tree.pgid, nix::sys::signal::Signal::SIGTERM);
            if let Ok(Ok(_)) = tokio::time::timeout(LEADER_STOP_GRACE, child.wait()).await {
                self.tree.disarm();
                return;
            }
            warn!(
                "[warm-env] Subprocess group {} did not exit within {} seconds of SIGTERM",
                self.tree.pgid,
                LEADER_STOP_GRACE.as_secs()
            );
        }
        reap_timed_out_child(child, &mut self.tree).await;
    }
}

#[cfg(unix)]
impl Drop for LeaderChild {
    fn drop(&mut self) {
        if !self.tree.armed {
            return;
        }
        let Some(mut child) = self.child.take() else {
            return;
        };
        let pgid = self.tree.pgid;
        // The background stop below owns the group from here on.
        self.tree.armed = false;
        signal_process_group(pgid, nix::sys::signal::Signal::SIGTERM);

        // SIGKILL only if the leader is still unreaped after the grace
        // period. If the runtime is shutting down the task is dropped, and
        // the leader's SIGTERM handler is what stops the installers.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if tokio::time::timeout(LEADER_STOP_GRACE, child.wait())
                    .await
                    .is_err()
                {
                    signal_process_group(pgid, nix::sys::signal::Signal::SIGKILL);
                    let _ = child.wait().await;
                }
            });
            return;
        }

        // No runtime to wait on. Poll the leader with WNOHANG, which reaps
        // it if it has exited, and kill the group only while it is unreaped.
        let Some(pid) = child.id() else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("warm-env-stop".into())
            .spawn(move || {
                use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
                use nix::unistd::Pid;

                let pid = Pid::from_raw(pid as i32);
                let deadline = std::time::Instant::now() + LEADER_STOP_GRACE;
                while std::time::Instant::now() < deadline {
                    match waitpid(pid, Some(WaitPidFlag::WNOHANG)) {
                        Ok(WaitStatus::StillAlive) => std::thread::sleep(Duration::from_millis(50)),
                        _ => return,
                    }
                }
                signal_process_group(pgid, nix::sys::signal::Signal::SIGKILL);
                let _ = waitpid(pid, None);
                drop(child);
            });
    }
}

fn terminate_process_tree(process_tree: &mut ChildProcessTree) {
    #[cfg(unix)]
    {
        signal_process_group(process_tree.pgid, nix::sys::signal::Signal::SIGKILL);
        process_tree.armed = false;
    }

    #[cfg(windows)]
    {
        // The job uses JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so dropping the
        // final handle terminates the child and every process it spawned.
        process_tree.job.take();
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = process_tree;
    }
}

pub(crate) async fn reap_timed_out_child(
    child: &mut tokio::process::Child,
    process_tree: &mut ChildProcessTree,
) {
    terminate_process_tree(process_tree);
    let _ = child.start_kill();

    match tokio::time::timeout(PROCESS_TREE_REAP_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => warn!("[warm-env] Failed to reap timed-out subprocess: {error}"),
        Err(_) => warn!(
            "[warm-env] Timed-out subprocess did not exit within {} seconds of tree termination",
            PROCESS_TREE_REAP_TIMEOUT.as_secs()
        ),
    }
}

async fn run_output_with_timeout(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> TimedResult<Output, io::Error> {
    command
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_tree(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return TimedResult::Failed(error),
    };

    let mut process_tree = match own_process_tree(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let _ = child.kill().await;
            return TimedResult::Failed(error);
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let collect_output = async {
        let status = child.wait();
        let stdout = async {
            match stdout {
                Some(pipe) => read_pipe_to_end(pipe).await,
                None => Ok(Vec::new()),
            }
        };
        let stderr = async {
            match stderr {
                Some(pipe) => read_pipe_to_end(pipe).await,
                None => Ok(Vec::new()),
            }
        };
        let (status, stdout, stderr) = tokio::join!(status, stdout, stderr);

        Ok(Output {
            status: status?,
            stdout: stdout?,
            stderr: stderr?,
        })
    };

    match tokio::time::timeout(timeout, collect_output).await {
        Ok(Ok(output)) => {
            process_tree.disarm();
            TimedResult::Completed(output)
        }
        Ok(Err(error)) => TimedResult::Failed(error),
        Err(_) => {
            // The collection future owns the pipe readers, so timing it out
            // drops both read ends before teardown. This prevents descendants
            // that inherited stdout/stderr from keeping cleanup blocked.
            reap_timed_out_child(&mut child, &mut process_tree).await;
            TimedResult::TimedOut
        }
    }
}

fn stderr_excerpt(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .chars()
        .take(200)
        .collect::<String>()
}

async fn run_python_script(
    python_path: &Path,
    script: &str,
    timeout: Duration,
) -> TimedResult<Output, io::Error> {
    let mut command = tokio::process::Command::new(python_path);
    command.args(["-c", script]);
    run_output_with_timeout(command, timeout).await
}

async fn validate_python_runtime(
    python_path: &Path,
    env_label: &str,
) -> Result<(), (String, &'static str)> {
    let validation_script = kernel_env::warmup::build_warmup_command(&[], false, None);

    match run_python_script(
        python_path,
        &validation_script,
        PYTHON_RUNTIME_VALIDATION_TIMEOUT,
    )
    .await
    {
        TimedResult::Completed(output) if output.status.success() => Ok(()),
        TimedResult::Completed(output) => Err((
            format!(
                "{env_label} runtime validation failed: {}",
                stderr_excerpt(&output)
            ),
            "import_error",
        )),
        TimedResult::Failed(error) => Err((
            format!("{env_label} runtime validation failed: {error}"),
            "import_error",
        )),
        TimedResult::TimedOut => Err((
            format!(
                "{env_label} runtime validation timed out after {} seconds",
                PYTHON_RUNTIME_VALIDATION_TIMEOUT.as_secs()
            ),
            "timeout",
        )),
    }
}

async fn run_best_effort_python_warmup(
    env_dir: &Path,
    python_path: &Path,
    packages: &[String],
    include_conda: bool,
    env_label: &str,
) {
    let site_packages = find_site_packages(env_dir);
    let warmup_script =
        kernel_env::warmup::build_warmup_command(packages, include_conda, site_packages.as_deref());

    match run_python_script(python_path, &warmup_script, PYTHON_WARMUP_TIMEOUT).await {
        TimedResult::Completed(output) if output.status.success() => {
            tokio::fs::write(env_dir.join(".warmed"), "").await.ok();
        }
        TimedResult::Completed(output) => {
            warn!(
                "[warm-env] {env_label} warmup failed; keeping validated environment usable without .warmed marker: {}",
                stderr_excerpt(&output)
            );
        }
        TimedResult::Failed(error) => {
            warn!(
                "[warm-env] {env_label} warmup failed; keeping validated environment usable without .warmed marker: {error}"
            );
        }
        TimedResult::TimedOut => {
            // The pool warmer is already a background optimization. Detaching
            // compileall/import work after this point would race with env
            // claims, eviction, and cleanup, so keep it bounded and admit the
            // validated env without the warmed marker when it runs long.
            warn!(
                "[warm-env] {env_label} warmup timed out after {} seconds; keeping validated environment usable without .warmed marker",
                PYTHON_WARMUP_TIMEOUT.as_secs()
            );
        }
    }
}

fn parse_uv_error(stderr: &str) -> Option<(String, String, Option<String>)> {
    let stderr_lower = stderr.to_lowercase();
    let pkg_patterns = [
        (r"package `([^`]+)`", '`'),
        (r"package '([^']+)'", '\''),
        (r"because ([a-z0-9_-]+) was not found", ' '),
        (r"no matching distribution found for ([a-z0-9_-]+)", ' '),
        (r"failed to download `([^`]+)`", '`'),
        (r"failed to download '([^']+)'", '\''),
    ];

    for (pattern, _) in &pkg_patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(&stderr_lower) {
                if let Some(pkg) = caps.get(1) {
                    let package_name = pkg.as_str().to_string();
                    if package_name != "ipykernel"
                        && package_name != "ipywidgets"
                        && package_name != "anywidget"
                    {
                        return Some((
                            stderr.to_string(),
                            "invalid_package".to_string(),
                            Some(package_name),
                        ));
                    }
                }
            }
        }
    }

    if stderr.contains("error") || stderr.contains("failed") || stderr.contains("not found") {
        return Some((stderr.to_string(), "setup_failed".to_string(), None));
    }

    None
}

async fn create_uv(env_dir: &Path, packages: &[String]) {
    progress("bootstrap", "getting uv path");
    let uv_path = match kernel_launch::tools::get_uv_path().await {
        Ok(path) => path,
        Err(e) => {
            emit_failure(format!("Failed to get uv path: {e}"), "setup_failed", None);
            return;
        }
    };

    #[cfg(target_os = "windows")]
    let python_path = env_dir.join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python_path = env_dir.join("bin").join("python");

    if let Some(parent) = env_dir.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            emit_failure(
                format!("Failed to create cache dir: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    }

    // Create venv
    progress("venv", "creating virtual environment");
    let mut venv_command = tokio::process::Command::new(&uv_path);
    venv_command
        .arg("venv")
        .arg(env_dir)
        .arg("--python")
        .arg("3.13");
    let venv_result = run_output_with_timeout(venv_command, UV_VENV_TIMEOUT).await;

    match venv_result {
        TimedResult::Completed(output) if output.status.success() => {}
        TimedResult::Completed(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            emit_failure(
                format!("Failed to create venv: {stderr}"),
                "setup_failed",
                None,
            );
            return;
        }
        TimedResult::Failed(e) => {
            emit_failure(format!("Failed to create venv: {e}"), "setup_failed", None);
            return;
        }
        TimedResult::TimedOut => {
            emit_failure(
                "Timeout creating venv after 60 seconds".into(),
                "timeout",
                None,
            );
            return;
        }
    }

    // Install packages (offline-first, fallback to network)
    progress("installing", &format!("{} packages", packages.len()));
    let offline_args = uv_pip_install_args(&python_path, packages, true);
    let install_result =
        match run_uv_pip_install(&uv_path, &offline_args, UV_OFFLINE_INSTALL_TIMEOUT).await {
            UvInstallAttempt::Completed(output) if output.status.success() => {
                info!("[warm-env] UV packages installed from local cache (offline mode)");
                UvInstallAttempt::Completed(output)
            }
            UvInstallAttempt::Completed(_)
            | UvInstallAttempt::SpawnError(_)
            | UvInstallAttempt::Timeout => {
                let args = uv_pip_install_args(&python_path, packages, false);
                run_uv_pip_install(&uv_path, &args, UV_ONLINE_INSTALL_TIMEOUT).await
            }
        };

    match install_result {
        UvInstallAttempt::Completed(output) if output.status.success() => {}
        UvInstallAttempt::Completed(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some((error, kind, pkg)) = parse_uv_error(&stderr) {
                cleanup_and_fail(env_dir, error, &kind, pkg).await;
            } else {
                cleanup_and_fail(env_dir, stderr.to_string(), "setup_failed", None).await;
            }
            return;
        }
        UvInstallAttempt::SpawnError(e) => {
            cleanup_and_fail(env_dir, e.to_string(), "setup_failed", None).await;
            return;
        }
        UvInstallAttempt::Timeout => {
            cleanup_and_fail(env_dir, "Timeout after 180 seconds".into(), "timeout", None).await;
            return;
        }
    }

    // Vendor kernel launcher
    progress("vendor", "vendoring kernel launcher");
    if let Err(e) = kernel_env::launcher::vendor_into_venv(&python_path).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to vendor nteract_kernel_launcher: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Required runtime validation comes before the expensive best-effort
    // warmup. The env should not enter the pool if core kernel imports hang or
    // fail, but compileall/import warming is only a performance optimization.
    progress("validating", "checking kernel imports");
    if let Err((error, kind)) = validate_python_runtime(&python_path, "UV").await {
        cleanup_and_fail(env_dir, error, kind, None).await;
        return;
    }
    if let Err(e) = write_pool_ready_marker(env_dir).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to write pool readiness marker: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Warmup (.pyc compilation)
    progress("warming", "compiling .pyc files");
    run_best_effort_python_warmup(env_dir, &python_path, packages, false, "UV").await;

    // Write package hash marker
    if let Err(e) = write_pool_package_hash(env_dir, EnvType::Uv, packages).await {
        warn!("[warm-env] Failed to write UV pool package marker: {e}");
    }
    emit_success(python_path, env_dir.to_path_buf());
}

// -- Conda env creation ---------------------------------------------------

async fn create_conda(env_dir: &Path, packages: &[String], channels: &[String]) {
    use rattler_conda_types::{ChannelConfig, Platform};
    use rattler_solve::{resolvo, SolverImpl, SolverTask};

    #[cfg(target_os = "windows")]
    let python_path = env_dir.join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python_path = env_dir.join("bin").join("python");

    if let Some(parent) = env_dir.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            emit_failure(
                format!("Failed to create cache dir: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    }

    // Setup channel configuration
    let cache_dir = env_dir.parent().unwrap_or(env_dir).to_path_buf();
    let channel_config = ChannelConfig::default_with_root_dir(cache_dir);

    progress("channels", "parsing channels");
    let install_platform = kernel_env::conda_solve_platform();
    let channels =
        match kernel_env::channels::parse_channels(channels, &channel_config, install_platform) {
            Ok(channels) => channels,
            Err(e) => {
                emit_failure(
                    format!("Failed to parse conda channel: {e}"),
                    "setup_failed",
                    None,
                );
                return;
            }
        };

    // Build specs
    progress("specs", "building dependency specs");
    let (specs, constraints) = match kernel_env::python::solve_specs(packages) {
        Ok(s) => s,
        Err(e) => {
            emit_failure(
                format!("Failed to parse match specs: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    // Rattler cache
    let rattler_cache_dir = match rattler::default_cache_dir() {
        Ok(dir) => dir,
        Err(e) => {
            emit_failure(
                format!("Could not determine rattler cache directory: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };
    if let Err(e) = rattler_cache::ensure_cache_dir(&rattler_cache_dir) {
        emit_failure(
            format!("Could not create rattler cache directory: {e}"),
            "setup_failed",
            None,
        );
        return;
    }

    // HTTP client
    let download_client = match kernel_env::channels::download_client() {
        Ok(c) => c,
        Err(e) => {
            emit_failure(
                format!("Failed to create HTTP client: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    let platforms = vec![install_platform, Platform::NoArch];
    let progress_handler = std::sync::Arc::new(kernel_env::LogHandler);

    // Fetch repodata
    progress(
        "resolving",
        "fetching repodata from cache or configured channels",
    );
    let repo_data = match kernel_env::repodata::query_repodata_offline_first(
        channels,
        platforms,
        specs.clone(),
        &rattler_cache_dir,
        download_client.clone(),
        progress_handler,
        "conda",
    )
    .await
    {
        Ok(data) => data,
        Err(e) => {
            emit_failure(
                format!("Failed to fetch repodata: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    // Virtual packages match the solve platform, not the host.
    let virtual_packages = match kernel_env::detect_solve_virtual_packages() {
        Ok(vps) => vps,
        Err(e) => {
            emit_failure(
                format!("Failed to detect virtual packages: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    // Solve
    progress("resolving", "solving dependencies");
    let solver_task = SolverTask {
        virtual_packages,
        specs,
        constraints,
        ..SolverTask::from_iter(&repo_data)
    };
    let required_packages = match resolvo::Solver.solve(solver_task) {
        Ok(result) => result.records,
        Err(e) => {
            emit_failure(
                format!("Failed to solve dependencies: {e}"),
                "invalid_package",
                None,
            );
            return;
        }
    };

    // Install
    progress(
        "installing",
        &format!("{} packages", required_packages.len()),
    );
    if let Err(e) = kernel_env::rattler_installer()
        .with_download_client(download_client)
        .with_target_platform(install_platform)
        .install(env_dir, required_packages)
        .await
    {
        cleanup_and_fail(
            env_dir,
            format!("Failed to install packages: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Verify python
    if !python_path.exists() {
        cleanup_and_fail(
            env_dir,
            format!("Python not found at {python_path:?} after install"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Vendor kernel launcher
    progress("vendor", "vendoring kernel launcher");
    if let Err(e) = kernel_env::launcher::vendor_into_venv(&python_path).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to vendor nteract_kernel_launcher: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    progress("validating", "checking kernel imports");
    if let Err((error, kind)) = validate_python_runtime(&python_path, "Conda").await {
        cleanup_and_fail(env_dir, error, kind, None).await;
        return;
    }
    if let Err(e) = write_pool_ready_marker(env_dir).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to write pool readiness marker: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Warmup
    progress("warming", "compiling .pyc files");
    run_best_effort_python_warmup(env_dir, &python_path, packages, true, "Conda").await;

    if let Err(e) = write_pool_package_hash(env_dir, EnvType::Conda, packages).await {
        warn!("[warm-env] Failed to write Conda pool package marker: {e}");
    }
    emit_success(python_path, env_dir.to_path_buf());
}

// -- Pixi env creation ----------------------------------------------------

async fn create_pixi(project_dir: &Path, packages: &[String], channels: &[String]) {
    if let Some(parent) = project_dir.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            emit_failure(
                format!("Failed to create cache dir: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    }

    progress("creating", "creating pixi environment");
    let handler = std::sync::Arc::new(kernel_env::LogHandler);
    let channel_list: Vec<String> = if channels.is_empty() {
        vec!["conda-forge".to_string()]
    } else {
        channels.to_vec()
    };

    match kernel_env::pixi::create_pixi_environment(project_dir, packages, &channel_list, handler)
        .await
    {
        Ok(env) => {
            progress("warming", "compiling .pyc files");
            if let Err(e) = kernel_env::pixi::warmup_environment(&env, packages).await {
                warn!("[warm-env] Pixi warmup failed (non-fatal): {e}");
            }

            if let Err(e) = write_pool_package_hash(project_dir, EnvType::Pixi, packages).await {
                warn!("[warm-env] Failed to write Pixi pool package marker: {e}");
            }
            emit_success(env.python_path, env.venv_path);
        }
        Err(e) => {
            cleanup_and_fail(
                project_dir,
                format!("Pixi environment creation failed: {e}"),
                "setup_failed",
                None,
            )
            .await;
        }
    }
}

// -- cleanup helper -------------------------------------------------------

async fn cleanup_and_fail(
    env_dir: &Path,
    error: String,
    error_kind: &str,
    failed_package: Option<String>,
) {
    error!("[warm-env] {error}");
    let _ = tokio::fs::remove_dir_all(env_dir).await;
    emit_failure(error, error_kind, failed_package);
}

// -- entry point ----------------------------------------------------------

pub async fn run() {
    run_until_terminated(run_config_from_stdin()).await;
}

/// Run `work` until it finishes or the daemon sends SIGTERM.
///
/// Installer commands run in process groups of their own, so a group kill
/// from the daemon cannot reach them. On SIGTERM this drops `work`, and the
/// in-flight command's `ChildProcessTree` kills its group before exit.
async fn run_until_terminated(work: impl std::future::Future<Output = ()>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut sigterm) => {
                tokio::select! {
                    () = work => {}
                    _ = sigterm.recv() => {
                        warn!("[warm-env] Received SIGTERM; stopping installer subprocesses");
                    }
                }
                return;
            }
            Err(error) => warn!("[warm-env] Failed to install SIGTERM handler: {error}"),
        }
    }
    work.await;
}

async fn run_config_from_stdin() {
    use tokio::io::AsyncReadExt;

    let mut input = String::new();
    if let Err(e) = tokio::io::stdin().read_to_string(&mut input).await {
        emit_failure(
            format!("Failed to read config from stdin: {e}"),
            "setup_failed",
            None,
        );
        return;
    }

    let config: WarmEnvConfig = match serde_json::from_str(&input) {
        Ok(c) => c,
        Err(e) => {
            emit_failure(
                format!("Invalid config JSON on stdin: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    match config.env_type {
        EnvType::Uv => create_uv(&config.env_dir, &config.packages).await,
        EnvType::Conda => create_conda(&config.env_dir, &config.packages, &config.channels).await,
        EnvType::Pixi => create_pixi(&config.env_dir, &config.packages, &config.channels).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warm_env_result_success_roundtrip() {
        let result = WarmEnvResult {
            success: true,
            python_path: Some(PathBuf::from("/env/bin/python")),
            venv_path: Some(PathBuf::from("/env")),
            error: None,
            error_kind: None,
            failed_package: None,
        };
        let event = WarmEnvEvent::Result(result);
        let json = serde_json::to_string(&event).unwrap();
        let parsed: WarmEnvEvent = serde_json::from_str(&json).unwrap();
        match parsed {
            WarmEnvEvent::Result(r) => {
                assert!(r.success);
                assert_eq!(r.python_path.unwrap(), PathBuf::from("/env/bin/python"));
            }
            _ => panic!("expected Result variant"),
        }
    }

    #[test]
    fn warm_env_result_failure_roundtrip() {
        let result = WarmEnvResult {
            success: false,
            python_path: None,
            venv_path: None,
            error: Some("bad package".into()),
            error_kind: Some("invalid_package".into()),
            failed_package: Some("bogus-pkg".into()),
        };
        let event = WarmEnvEvent::Result(result);
        let json = serde_json::to_string(&event).unwrap();
        let parsed: WarmEnvEvent = serde_json::from_str(&json).unwrap();
        match parsed {
            WarmEnvEvent::Result(r) => {
                assert!(!r.success);
                assert_eq!(r.failed_package.unwrap(), "bogus-pkg");
            }
            _ => panic!("expected Result variant"),
        }
    }

    #[test]
    fn warm_env_config_roundtrip() {
        let config = WarmEnvConfig {
            env_type: EnvType::Conda,
            env_dir: PathBuf::from("/cache/pool-conda-abc"),
            packages: vec!["numpy>=1.20,<2".into(), "pandas".into()],
            channels: vec!["conda-forge".into()],
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: WarmEnvConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.packages, config.packages);
        assert_eq!(parsed.channels, config.channels);
    }

    #[test]
    fn package_hash_deterministic() {
        let h1 = expected_pool_package_hash(EnvType::Uv, &["b".into(), "a".into()]);
        let h2 = expected_pool_package_hash(EnvType::Uv, &["a".into(), "b".into()]);
        assert_eq!(h1, h2, "hash should be order-independent");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_output_with_timeout_captures_stdout_and_stderr() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "printf ok; printf err >&2"]);

        let result = run_output_with_timeout(command, Duration::from_secs(5)).await;

        match result {
            TimedResult::Completed(output) => {
                assert!(output.status.success());
                assert_eq!(output.stdout, b"ok");
                assert_eq!(output.stderr, b"err");
            }
            other => panic!("expected completed output, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_output_with_timeout_kills_slow_child() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);

        let result = run_output_with_timeout(command, Duration::from_millis(25)).await;

        assert!(matches!(result, TimedResult::TimedOut));
    }

    const INHERITED_PIPE_HELPER_MODE: &str = "NTERACT_WARM_ENV_PIPE_HELPER_MODE";
    const INHERITED_PIPE_HELPER_PID_FILE: &str = "NTERACT_WARM_ENV_PIPE_HELPER_PID_FILE";
    const INHERITED_PIPE_HELPER_TEST: &str =
        "warm_env::tests::run_output_with_timeout_inherited_pipe_helper";

    #[test]
    #[ignore = "subprocess helper invoked by the process-tree regression test"]
    #[allow(clippy::zombie_processes)] // Parent must exit while its descendant keeps the pipes open.
    fn run_output_with_timeout_inherited_pipe_helper() {
        match std::env::var(INHERITED_PIPE_HELPER_MODE).as_deref() {
            Ok("parent") => {
                // Give the outer process time to establish its Windows Job
                // Object before this helper creates the inherited descendant.
                std::thread::sleep(Duration::from_millis(250));

                let child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        INHERITED_PIPE_HELPER_TEST,
                        "--exact",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env(INHERITED_PIPE_HELPER_MODE, "descendant")
                    .stdin(Stdio::null())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();

                std::fs::write(
                    std::env::var(INHERITED_PIPE_HELPER_PID_FILE).unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
            }
            Ok("descendant") => std::thread::sleep(Duration::from_secs(30)),
            _ => panic!("process-tree helper invoked without a mode"),
        }
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || io::Error::last_os_error().kind() == io::ErrorKind::PermissionDenied
    }

    #[cfg(windows)]
    fn process_is_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process == 0 {
            return false;
        }

        let mut exit_code = 0;
        let ok = unsafe { GetExitCodeProcess(process, &mut exit_code) };
        unsafe { CloseHandle(process) };
        ok != 0 && exit_code == 259 // STILL_ACTIVE
    }

    #[cfg(any(unix, windows))]
    async fn wait_for_process_exit(pid: u32) -> bool {
        for _ in 0..100 {
            if !process_is_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn run_output_with_timeout_kills_descendant_holding_output_pipes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let pid_file = temp_dir.path().join("descendant.pid");
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                INHERITED_PIPE_HELPER_TEST,
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env(INHERITED_PIPE_HELPER_MODE, "parent")
            .env(INHERITED_PIPE_HELPER_PID_FILE, &pid_file);

        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            run_output_with_timeout(command, Duration::from_secs(1)),
        )
        .await
        .expect("subprocess cleanup must return within its bounded reap window");

        assert!(matches!(result, TimedResult::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(8));

        let descendant_pid: u32 = std::fs::read_to_string(&pid_file)
            .expect("helper must record its descendant pid before the timeout")
            .parse()
            .unwrap();
        assert!(
            wait_for_process_exit(descendant_pid).await,
            "descendant {descendant_pid} survived process-tree cleanup"
        );
    }

    #[test]
    fn parse_uv_error_package_not_found() {
        let stderr = r#"error: No solution found when resolving dependencies:
  Because Because scitkit-learn was not found in the package registry and you require scitkit-learn, we can conclude that your requirements are unsatisfiable."#;

        let result = parse_uv_error(stderr).expect("expected package parse error");
        assert_eq!(result.1, "invalid_package");
        assert_eq!(result.2, Some("scitkit-learn".to_string()));
    }

    #[test]
    fn parse_uv_error_backtick_format() {
        let result = parse_uv_error("error: Package `nonexistent-pkg` not found in registry")
            .expect("expected package parse error");
        assert_eq!(result.1, "invalid_package");
        assert_eq!(result.2, Some("nonexistent-pkg".to_string()));
    }

    #[test]
    fn parse_uv_error_no_matching_distribution() {
        let result = parse_uv_error("error: No matching distribution found for bad-package-name")
            .expect("expected package parse error");
        assert_eq!(result.1, "invalid_package");
        assert_eq!(result.2, Some("bad-package-name".to_string()));
    }

    #[test]
    fn parse_uv_error_generic_error() {
        let result = parse_uv_error("error: Failed to resolve dependencies")
            .expect("expected generic error");
        assert_eq!(result.1, "setup_failed");
        assert_eq!(result.2, None);
        assert!(result.0.contains("error"));
    }

    #[test]
    fn parse_uv_error_no_error() {
        assert!(parse_uv_error("Successfully installed packages").is_none());
    }

    #[test]
    fn uv_pip_install_args_offline_first_shape() {
        let args = uv_pip_install_args(
            Path::new("/tmp/env/bin/python"),
            &["ipykernel".into(), "numpy>=2".into()],
            true,
        );

        assert_eq!(args[0], "pip");
        assert_eq!(args[1], "install");
        assert!(args.contains(&"--link-mode".to_string()));
        assert!(args.contains(&"hardlink".to_string()));
        assert!(args.contains(&"--python".to_string()));
        assert!(args.contains(&"/tmp/env/bin/python".to_string()));
        assert!(args.contains(&"--offline".to_string()));
        assert!(args.ends_with(&["ipykernel".to_string(), "numpy>=2".to_string()]));
    }

    #[test]
    fn uv_pip_install_args_online_fallback_shape() {
        let args = uv_pip_install_args(Path::new("/tmp/env/bin/python"), &["pandas".into()], false);

        assert!(!args.contains(&"--offline".to_string()));
        assert!(args.contains(&"--link-mode".to_string()));
        assert!(args.contains(&"hardlink".to_string()));
        assert!(args.ends_with(&["pandas".to_string()]));
    }

    #[test]
    fn uv_offline_probe_has_shorter_timeout_than_online_fallback() {
        assert!(UV_OFFLINE_INSTALL_TIMEOUT < UV_ONLINE_INSTALL_TIMEOUT);
    }

    /// Spawn `sh` as a process-group leader that starts a background
    /// `sleep` grandchild, and return the child, its tree, and the
    /// grandchild pid.
    #[cfg(unix)]
    async fn spawn_group_with_grandchild() -> (tokio::process::Child, ChildProcessTree, i32) {
        use tokio::io::AsyncBufReadExt;

        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        configure_process_tree(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = own_process_tree(&child).unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let grandchild: i32 = lines
            .next_line()
            .await
            .unwrap()
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        (child, tree, grandchild)
    }

    #[cfg(unix)]
    fn process_alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    #[cfg(unix)]
    async fn wait_until_gone(pid: i32) -> bool {
        for _ in 0..200 {
            if !process_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_armed_process_tree_kills_grandchildren() {
        let (child, tree, grandchild) = spawn_group_with_grandchild().await;
        assert!(process_alive(grandchild));

        // A cancelled caller drops both; the tree drops first.
        drop(tree);
        drop(child);

        assert!(
            wait_until_gone(grandchild).await,
            "grandchild {grandchild} outlived its dropped process tree"
        );
    }

    #[cfg(unix)]
    const LEADER_HELPER_PID_FILE: &str = "NTERACT_WARM_ENV_LEADER_HELPER_PID_FILE";
    #[cfg(unix)]
    const LEADER_HELPER_TEST: &str = "warm_env::tests::leader_with_installer_group_helper";

    /// Stand-in for the `warm-env` subcommand: runs a long "installer" in a
    /// process group of its own, the way `run_output_with_timeout` does.
    #[cfg(unix)]
    #[test]
    #[ignore = "subprocess helper invoked by the leader process-tree tests"]
    fn leader_with_installer_group_helper() {
        let pid_file = std::env::var(LEADER_HELPER_PID_FILE).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(run_until_terminated(async move {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", &format!("echo $$ > '{pid_file}'; exec sleep 30")]);
            let _ = run_output_with_timeout(command, Duration::from_secs(60)).await;
        }));
    }

    /// Spawn the leader helper the way the daemon spawns `warm-env` and
    /// return it, its tree, and the pid of the installer it started.
    #[cfg(unix)]
    async fn spawn_leader_with_installer(pid_file: &Path) -> (LeaderChild, i32) {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([LEADER_HELPER_TEST, "--exact", "--ignored", "--nocapture"])
            .env(LEADER_HELPER_PID_FILE, pid_file)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_tree(&mut command);
        let mut leader = LeaderChild::new(command.spawn().unwrap()).unwrap();

        let mut installer = None;
        for _ in 0..200 {
            if let Some(pid) = std::fs::read_to_string(pid_file)
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
            {
                installer = Some(pid);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let installer = installer.expect("leader helper must start its installer");
        let installer_pgid = nix::unistd::getpgid(Some(nix::unistd::Pid::from_raw(installer)))
            .unwrap()
            .as_raw();
        assert_ne!(
            installer_pgid,
            leader.child_mut().id().unwrap() as i32,
            "the installer must run outside the leader's process group"
        );
        (leader, installer)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_leader_kills_installer_in_its_own_group() {
        let temp_dir = tempfile::tempdir().unwrap();
        let (mut leader, installer) =
            spawn_leader_with_installer(&temp_dir.path().join("installer.pid")).await;

        let started = std::time::Instant::now();
        leader.stop().await;

        assert!(
            started.elapsed() < LEADER_STOP_GRACE,
            "the leader should exit on SIGTERM, not wait out the grace period"
        );
        assert!(
            wait_until_gone(installer).await,
            "installer {installer} outlived its stopped leader"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_leader_kills_installer_in_its_own_group() {
        let temp_dir = tempfile::tempdir().unwrap();
        let (leader, installer) =
            spawn_leader_with_installer(&temp_dir.path().join("installer.pid")).await;

        drop(leader);

        assert!(
            wait_until_gone(installer).await,
            "installer {installer} outlived its dropped leader"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_leader_that_ignores_sigterm_kills_it_after_grace() {
        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
            .stdout(Stdio::null());
        configure_process_tree(&mut command);
        let mut leader = LeaderChild::new(command.spawn().unwrap()).unwrap();
        let pid = leader.child_mut().id().unwrap() as i32;
        // Let the shell install its trap before the SIGTERM.
        tokio::time::sleep(Duration::from_millis(200)).await;

        drop(leader);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            process_alive(pid),
            "SIGTERM alone must not stop this leader"
        );

        let mut gone = false;
        for _ in 0..200 {
            if !process_alive(pid) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(gone, "leader {pid} survived the post-grace SIGKILL");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_disarmed_process_tree_leaves_group_alone() {
        let (mut child, mut tree, grandchild) = spawn_group_with_grandchild().await;
        tree.disarm();
        drop(tree);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(process_alive(grandchild), "disarmed drop must not signal");

        let mut tree = own_process_tree(&child).unwrap();
        reap_timed_out_child(&mut child, &mut tree).await;
        assert!(wait_until_gone(grandchild).await);
    }
}
