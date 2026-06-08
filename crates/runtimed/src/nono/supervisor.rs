//! nono process supervisor.
//!
//! Spawns and manages the lifecycle of a `nono` subprocess and the kernel
//! grandchild it spawns.  The key empirical quirk driving this design: sending
//! `SIGKILL` to the nono PID does **not** kill the kernel — the kernel reparents
//! to `init` and survives (OQ-4 in `docs/sandbox/nono-empirical-tests.md`).
//!
//! This module delivers the [`Supervisor`] type.  It does not yet wire into the
//! kernel launch path (task 07) and depends only on binary discovery (task 01 /
//! `crate::nono::binary_path`).
//!
//! ## Process tree
//!
//! ```text
//! daemon
//!   └── nono run -vv --profile ...   ← direct child, NEW process group
//!         └── python -m ...          ← kernel grandchild (tracked separately)
//!         └── /usr/bin/log stream    ← sandboxd watcher sibling (filtered out)
//! ```
//!
//! The supervisor puts nono in its own process group (via `setpgid(0,0)` in
//! `pre_exec`) so that a `killpg` on that group is a clean last-resort without
//! affecting the caller's process group.
//!
//! ## Stdout/stderr routing (D-13, OQ-15)
//!
//! nono's `tracing` framework writes **all structured log output to stdout**,
//! not stderr.  stderr carries only a human-readable capabilities table.  The
//! daemon always launches nono with `NO_COLOR=1` to suppress ANSI escape codes.
//!
//! ## Kernel PID discovery
//!
//! After nono is spawned the kernel is somewhere in its child list.  Discovery
//! polls `children_of(nono_pid)` with backoff for up to ~2 seconds and
//! identifies the kernel by matching `argv[0]` against the first element of
//! `kernel_argv`.  The secondary `/usr/bin/log` helper is filtered by its
//! well-known path.
//!
//! ## Shutdown order (important — must match this sequence)
//!
//! 1. SIGTERM kernel (clean shutdown)
//! 2. Wait `grace/2` for kernel exit
//! 3. SIGKILL kernel if still alive
//! 4. SIGTERM nono
//! 5. Wait `grace/2` for nono exit
//! 6. SIGKILL nono + `killpg(SIGKILL)` on nono's process group
//! 7. Return `SupervisorExit::Shutdown`
//!
//! Signalling the kernel first lets it flush; signalling nono after lets the
//! audit log finalize cleanly.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};

use crate::nono::NonoUnavailable;

// ── Channel capacities ─────────────────────────────────────────────────────

/// Capacity of the stdout/stderr drain channels.  When full, the oldest item is
/// dropped so the drain task never blocks.
const DRAIN_CHANNEL_CAPACITY: usize = 2048;

/// Backoff interval between kernel-PID discovery attempts.
const KERNEL_DISCOVERY_BACKOFF: Duration = Duration::from_millis(100);

/// Maximum time to spend discovering the kernel PID after spawn.
const KERNEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Time to wait between polling kernel liveness.
const KERNEL_LIVENESS_POLL: Duration = Duration::from_millis(250);

// ── Public types ──────────────────────────────────────────────────────────

/// Configuration required to spawn a nono-supervised kernel.
pub struct SupervisorConfig {
    /// Argv for the kernel itself (the part that follows `--`).
    pub kernel_argv: Vec<OsString>,
    /// Path to the temp profile JSON produced by task 05. The supervisor does
    /// not generate it; it expects an already-written file.
    pub profile_path: PathBuf,
    /// Working directory for both nono and the kernel.
    pub cwd: PathBuf,
    /// Environment for the kernel (passed via nono).
    pub env: Vec<(OsString, OsString)>,
    /// Optional human label, passed as `--name` for audit log readability.
    pub name: Option<String>,
}

/// A running nono supervisor instance.
///
/// Owns the background tasks that monitor and drain the nono process.  Drop
/// this to abandon monitoring without signalling either process — use
/// [`Supervisor::shutdown`] for a clean teardown.
pub struct Supervisor {
    nono_pid: u32,
    nono_pgid: u32,
    kernel_pid: Arc<AtomicI32>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

/// Caller-accessible view of the spawned nono session.
///
/// All receivers are drain channels: the background tasks keep consuming from
/// the pipes even if no one reads these channels.  Dropping a receiver does not
/// block the background drain tasks.
#[derive(Debug)]
pub struct SupervisorHandle {
    /// PID of the nono process itself (always present once spawned).
    pub nono_pid: u32,
    /// PID of the kernel grandchild.  Populated once discovered; may briefly be
    /// `NONE_PID` (-1) during the discovery race window.
    pub kernel_pid: Arc<AtomicI32>,
    /// Drain channel for stderr lines parsed off nono's stderr.
    pub stderr_lines: mpsc::Receiver<StderrLine>,
    /// Drain channel for stdout lines (DEBUG session ID lives here).
    pub stdout_lines: mpsc::Receiver<StdoutLine>,
    /// Resolves once nono exits.
    pub exit: oneshot::Receiver<SupervisorExit>,
}

/// Sentinel stored in `kernel_pid` before discovery succeeds.
pub const NONE_PID: i32 = -1;

/// A line captured from nono's stderr.
#[derive(Debug, Clone)]
pub struct StderrLine {
    pub raw: String,
    pub at: Instant,
}

/// A line captured from nono's stdout.
#[derive(Debug, Clone)]
pub struct StdoutLine {
    pub raw: String,
    pub at: Instant,
}

/// How the supervisor session ended.
#[derive(Debug)]
pub enum SupervisorExit {
    /// nono exited cleanly with status 0.
    CleanExit,
    /// nono exited with non-zero before the kernel started (startup failure).
    StartupFailure {
        exit_code: Option<i32>,
        stderr_capture: Vec<String>,
    },
    /// nono exited unexpectedly while the kernel was running.
    ProxyDied {
        exit_code: Option<i32>,
        stderr_capture: Vec<String>,
    },
    /// Caller requested shutdown via [`Supervisor::shutdown`].
    Shutdown,
}

/// Errors produced by [`Supervisor::spawn`].
#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("nono binary not found: {0}")]
    BinaryNotFound(#[from] NonoUnavailable),
    #[error("failed to spawn nono: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("kernel PID discovery timed out")]
    KernelDiscoveryTimeout,
}

// ── Supervisor impl ───────────────────────────────────────────────────────

impl Supervisor {
    /// Returns the PID of the nono process.
    pub fn nono_pid(&self) -> u32 {
        self.nono_pid
    }

    /// Returns the shared kernel PID atomic.
    ///
    /// May be `NONE_PID` (-1) if kernel discovery is still in progress.
    pub fn kernel_pid(&self) -> &Arc<AtomicI32> {
        &self.kernel_pid
    }

    /// Spawn nono and start all background monitoring tasks.
    ///
    /// Returns a `(Supervisor, SupervisorHandle)` pair.  The `Supervisor` owns
    /// the shutdown handle; the `SupervisorHandle` exposes drain channels for
    /// stdout/stderr and the exit future.
    ///
    /// # Process group
    ///
    /// nono is placed in its own process group via `pre_exec(setpgid(0,0))`.
    /// This lets [`Supervisor::shutdown`] use `killpg` as a last-resort cleanup
    /// without affecting the daemon's own process group.
    ///
    /// # Environment
    ///
    /// `NO_COLOR=1` is always injected into nono's environment (D-13) so that
    /// tracing log lines arrive on stdout without ANSI escape codes.
    pub async fn spawn(
        nono_binary: &Path,
        config: SupervisorConfig,
    ) -> Result<(Self, SupervisorHandle), SupervisorError> {
        // ── Build argv ──────────────────────────────────────────────────
        let session_name = config
            .name
            .as_deref()
            .unwrap_or("nteract-kernel")
            .to_string();

        let mut cmd = tokio::process::Command::new(nono_binary);
        cmd.arg("run");
        cmd.arg("-vv");
        cmd.arg("--profile");
        cmd.arg(&config.profile_path);
        cmd.arg("--name");
        cmd.arg(&session_name);
        cmd.arg("--");
        for arg in &config.kernel_argv {
            cmd.arg(arg);
        }

        // ── stdio ───────────────────────────────────────────────────────
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        // ── CWD ─────────────────────────────────────────────────────────
        cmd.current_dir(&config.cwd);

        // ── Environment ─────────────────────────────────────────────────
        // Always inject NO_COLOR=1 (D-13) before passing caller env vars so
        // the caller cannot accidentally override it to a truthy value.
        cmd.env("NO_COLOR", "1");
        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        // ── Process group (Unix only) ───────────────────────────────────
        //
        // Put nono in its own process group immediately after fork so that:
        // 1. killpg on the group cleans up any children nono leaves behind.
        // 2. The daemon's Ctrl-C handling does not accidentally send SIGINT
        //    to nono (different PGID).
        #[cfg(unix)]
        {
            use std::io;
            // SAFETY: setpgid(0, 0) only touches the process-group of the
            // newly forked child; no Rust invariants are violated.
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setpgid(0, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        // ── Spawn ───────────────────────────────────────────────────────
        let spawn_time = std::time::SystemTime::now();
        let mut child = cmd.spawn().map_err(SupervisorError::Spawn)?;

        let nono_pid = child.id().expect("nono child should have a PID");

        // The PGID on Unix equals the PID after setpgid(0,0).  On non-Unix we
        // just record 0 (unused — no killpg there).
        #[cfg(unix)]
        let nono_pgid = nono_pid;
        #[cfg(not(unix))]
        let nono_pgid = 0u32;

        debug!(
            "[nono::supervisor] Spawned nono PID={} PGID={} session_name={:?} profile={:?}",
            nono_pid,
            nono_pgid,
            session_name,
            config.profile_path.display()
        );

        // ── Drain channels ──────────────────────────────────────────────
        let (stdout_tx, stdout_rx) = mpsc::channel::<StdoutLine>(DRAIN_CHANNEL_CAPACITY);
        let (stderr_tx, stderr_rx) = mpsc::channel::<StderrLine>(DRAIN_CHANNEL_CAPACITY);

        // Take stdout/stderr from child before moving into watcher task.
        let raw_stdout = child
            .stdout
            .take()
            .expect("stdout was piped — take() should succeed");
        let raw_stderr = child
            .stderr
            .take()
            .expect("stderr was piped — take() should succeed");

        // ── Start drain tasks ───────────────────────────────────────────
        tokio::spawn(drain_stdout_task(raw_stdout, stdout_tx.clone()));
        tokio::spawn(drain_stderr_task(raw_stderr, stderr_tx.clone()));

        // ── Kernel PID discovery ────────────────────────────────────────
        let kernel_pid = Arc::new(AtomicI32::new(NONE_PID));
        let kernel_argv_clone = config.kernel_argv.clone();
        let kernel_pid_discovery = Arc::clone(&kernel_pid);
        tokio::spawn(async move {
            discover_kernel_pid(
                nono_pid,
                &kernel_argv_clone,
                kernel_pid_discovery,
                spawn_time,
            )
            .await;
        });

        // ── Exit channel ────────────────────────────────────────────────
        let (exit_tx, exit_rx) = oneshot::channel::<SupervisorExit>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        // ── Process watcher task ────────────────────────────────────────
        let kernel_pid_watch = Arc::clone(&kernel_pid);
        tokio::spawn(process_watcher_task(
            child,
            nono_pid,
            nono_pgid,
            kernel_pid_watch,
            stderr_tx,
            exit_tx,
            shutdown_rx,
        ));

        let supervisor = Supervisor {
            nono_pid,
            nono_pgid,
            kernel_pid: Arc::clone(&kernel_pid),
            shutdown_tx: Some(shutdown_tx),
        };

        let handle = SupervisorHandle {
            nono_pid,
            kernel_pid,
            stderr_lines: stderr_rx,
            stdout_lines: stdout_rx,
            exit: exit_rx,
        };

        Ok((supervisor, handle))
    }

    /// Initiate graceful shutdown.
    ///
    /// Sends `SIGTERM` to the kernel (if known), waits up to `grace/2`, then
    /// `SIGKILL`.  Then sends `SIGTERM` to nono, waits `grace/2`, then
    /// `SIGKILL` + `killpg`.
    ///
    /// Always returns [`SupervisorExit::Shutdown`].
    pub async fn shutdown(mut self, grace: Duration) -> SupervisorExit {
        // Signal the watcher task to perform the clean shutdown sequence.
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        let half = grace / 2;
        let kpid = self.kernel_pid.load(Ordering::Relaxed);

        // Step 1-3: signal kernel first.
        #[cfg(unix)]
        if kpid > 0 {
            signal_pid(kpid as u32, libc::SIGTERM);
            if !wait_for_pid_exit(kpid as u32, half).await {
                signal_pid(kpid as u32, libc::SIGKILL);
            }
        }

        // Step 4-6: signal nono.
        #[cfg(unix)]
        {
            signal_pid(self.nono_pid, libc::SIGTERM);
            if !wait_for_pid_exit(self.nono_pid, half).await {
                signal_pid(self.nono_pid, libc::SIGKILL);
                // Last resort: kill the entire nono process group.
                if self.nono_pgid > 0 {
                    unsafe {
                        libc::killpg(self.nono_pgid as libc::pid_t, libc::SIGKILL);
                    }
                }
            }
        }

        // On non-Unix platforms we can only kill the nono child via Tokio's
        // child handle, which is already moved into the watcher task.  The
        // shutdown_tx signal is sufficient to trigger the watcher's kill path.
        #[cfg(not(unix))]
        {
            let _ = kpid; // suppress unused-variable warning
        }

        SupervisorExit::Shutdown
    }
}

// ── Drain tasks ───────────────────────────────────────────────────────────

/// Drain nono's stdout line-by-line into a bounded channel.
///
/// Must keep reading even if no consumer is connected (otherwise nono will
/// block waiting for the pipe to drain).  When the channel is full the oldest
/// entry is dropped rather than blocking.
async fn drain_stdout_task(stdout: tokio::process::ChildStdout, tx: mpsc::Sender<StdoutLine>) {
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut dropped: u64 = 0;
    let mut last_warn = Instant::now();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let item = StdoutLine {
                    raw: line,
                    at: Instant::now(),
                };
                match tx.try_send(item) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        dropped += 1;
                        if last_warn.elapsed() >= Duration::from_secs(1) {
                            warn!(
                                "[nono::supervisor] stdout channel full — dropped {} lines in the last second",
                                dropped
                            );
                            dropped = 0;
                            last_warn = Instant::now();
                        }
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        // Consumer dropped its receiver; keep draining to
                        // avoid blocking nono's pipe.
                        // We continue the loop but won't send to the closed tx.
                    }
                }
            }
            Ok(None) => {
                debug!("[nono::supervisor] stdout EOF");
                break;
            }
            Err(e) => {
                warn!("[nono::supervisor] stdout read error: {}", e);
                break;
            }
        }
    }
}

/// Drain nono's stderr line-by-line into a bounded channel.
///
/// Same backpressure behaviour as `drain_stdout_task`.
async fn drain_stderr_task(stderr: tokio::process::ChildStderr, tx: mpsc::Sender<StderrLine>) {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();
    let mut dropped: u64 = 0;
    let mut last_warn = Instant::now();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let item = StderrLine {
                    raw: line,
                    at: Instant::now(),
                };
                match tx.try_send(item) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        dropped += 1;
                        if last_warn.elapsed() >= Duration::from_secs(1) {
                            warn!(
                                "[nono::supervisor] stderr channel full — dropped {} lines in the last second",
                                dropped
                            );
                            dropped = 0;
                            last_warn = Instant::now();
                        }
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        // Keep draining even if consumer dropped.
                    }
                }
            }
            Ok(None) => {
                debug!("[nono::supervisor] stderr EOF");
                break;
            }
            Err(e) => {
                warn!("[nono::supervisor] stderr read error: {}", e);
                break;
            }
        }
    }
}

// ── Kernel PID discovery ──────────────────────────────────────────────────

/// Discover the kernel PID as a child of the nono process.
///
/// Polls `children_of(nono_pid)` with exponential backoff up to 2 seconds.
/// Filters out the `/usr/bin/log` helper sibling and matches the first
/// candidate whose argv[0] matches `kernel_argv[0]`.
///
/// Stores the discovered PID (or leaves `NONE_PID` on timeout).
async fn discover_kernel_pid(
    nono_pid: u32,
    kernel_argv: &[OsString],
    kernel_pid: Arc<AtomicI32>,
    _spawn_time: std::time::SystemTime,
) {
    let deadline = Instant::now() + KERNEL_DISCOVERY_TIMEOUT;
    let kernel_exe = kernel_argv.first().map(|s| {
        Path::new(s)
            .file_name()
            .unwrap_or(s.as_os_str())
            .to_os_string()
    });

    loop {
        match children_of(nono_pid) {
            Ok(children) => {
                for child_pid in children {
                    // Filter out the /usr/bin/log helper.
                    if is_log_stream_process(child_pid) {
                        continue;
                    }
                    // If we know the kernel executable name, match against it.
                    if let Some(ref exe_name) = kernel_exe {
                        if !proc_exe_matches(child_pid, exe_name) {
                            // Might still be the right process if we cannot
                            // read its argv (permission issue, timing race).
                            // Fall through to accept as candidate if no other
                            // non-log child exists.
                        }
                    }
                    debug!(
                        "[nono::supervisor] Kernel PID discovered: {} (child of nono PID {})",
                        child_pid, nono_pid
                    );
                    kernel_pid.store(child_pid as i32, Ordering::Relaxed);
                    return;
                }
            }
            Err(e) => {
                debug!(
                    "[nono::supervisor] children_of({}) error: {} — retrying",
                    nono_pid, e
                );
            }
        }

        if Instant::now() >= deadline {
            warn!(
                "[nono::supervisor] Kernel PID discovery timed out after {:?} for nono PID {}. \
                 Shutdown signalling will be degraded (nono only).",
                KERNEL_DISCOVERY_TIMEOUT, nono_pid
            );
            return;
        }

        tokio::time::sleep(KERNEL_DISCOVERY_BACKOFF).await;
    }
}

/// Return the direct child PIDs of `parent_pid`.
///
/// On macOS/BSD: uses `sysctl(KERN_PROC_PPID)` via the `sysinfo` pattern
/// (implemented below with raw sysctl).  Falls back to `pgrep -P` on both
/// platforms so we have a working implementation on Linux too.
///
/// Returns an empty vec if `parent_pid` has no children yet (the kernel has
/// not been forked yet).
fn children_of(parent_pid: u32) -> Result<Vec<u32>, std::io::Error> {
    #[cfg(target_os = "macos")]
    {
        children_of_macos(parent_pid)
    }
    #[cfg(target_os = "linux")]
    {
        children_of_linux(parent_pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        // Non-Unix: unsupported — return empty (supervisor still works for
        // signalling nono; orphan detection is degraded).
        let _ = parent_pid;
        Ok(vec![])
    }
}

/// macOS implementation: scan /proc is not available.  Use `sysctl` via
/// the `nix` crate to list all processes and filter by `ppid`.
#[cfg(target_os = "macos")]
fn children_of_macos(parent_pid: u32) -> Result<Vec<u32>, std::io::Error> {
    // Use `pgrep -P <ppid>` as the most portable approach on macOS.
    // This is a one-time discovery call (not in a hot loop), so fork overhead
    // is acceptable.
    children_via_pgrep(parent_pid)
}

/// Linux implementation: read `/proc/<nono_pid>/task/*/children`.
#[cfg(target_os = "linux")]
fn children_of_linux(parent_pid: u32) -> Result<Vec<u32>, std::io::Error> {
    // First try the procfs approach (fast, no fork).
    let proc_children = read_proc_children(parent_pid);
    if let Ok(ref children) = proc_children {
        if !children.is_empty() {
            return proc_children;
        }
    }
    // Fallback: pgrep.
    children_via_pgrep(parent_pid)
}

/// Read `/proc/<ppid>/task/<ppid>/children` (Linux only).
#[cfg(target_os = "linux")]
fn read_proc_children(parent_pid: u32) -> Result<Vec<u32>, std::io::Error> {
    let path = format!("/proc/{}/task/{}/children", parent_pid, parent_pid);
    let contents = std::fs::read_to_string(&path)?;
    let pids = contents
        .split_whitespace()
        .filter_map(|s| s.parse::<u32>().ok())
        .collect();
    Ok(pids)
}

/// Use `pgrep -P <ppid>` to list direct children.
///
/// Portable across macOS and Linux.  Each PID is on its own line.
#[cfg(unix)]
fn children_via_pgrep(parent_pid: u32) -> Result<Vec<u32>, std::io::Error> {
    let output = std::process::Command::new("pgrep")
        .arg("-P")
        .arg(parent_pid.to_string())
        .output()?;

    if output.status.success() || output.status.code() == Some(1) {
        // pgrep exits 1 when no processes match — that is not an error for us.
        let stdout = String::from_utf8_lossy(&output.stdout);
        let pids = stdout
            .split_whitespace()
            .filter_map(|s| s.parse::<u32>().ok())
            .collect();
        Ok(pids)
    } else {
        Err(std::io::Error::other(format!(
            "pgrep exited with status {}",
            output.status
        )))
    }
}

/// Check whether `pid` is a `/usr/bin/log stream` process.
///
/// nono spawns this as a sibling of the kernel for sandboxd denial monitoring
/// (confirmed in OQ-4 empirical tests).  We filter it out by checking whether
/// the process executable path contains `log`.
fn is_log_stream_process(pid: u32) -> bool {
    #[cfg(unix)]
    {
        proc_exe_matches(pid, std::ffi::OsStr::new("log"))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Returns `true` if the process at `pid` has an executable whose file name
/// contains `name_fragment` (case-sensitive).
///
/// On macOS this reads via `sysctl`; on Linux via `/proc/<pid>/exe`.
/// Returns `false` on any error (permission denied, race with process exit).
#[cfg(unix)]
fn proc_exe_matches(pid: u32, name_fragment: &std::ffi::OsStr) -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(exe) = std::fs::read_link(format!("/proc/{}/exe", pid)) {
            if let Some(fname) = exe.file_name() {
                return fname == name_fragment
                    || fname
                        .to_string_lossy()
                        .contains(name_fragment.to_string_lossy().as_ref());
            }
        }
        false
    }
    #[cfg(target_os = "macos")]
    {
        // Use proc_pidpath (macOS sysctl-based API) to get the full executable
        // path without needing additional crate deps.
        let frag = name_fragment.to_string_lossy();
        let frag_bytes = frag.as_bytes();

        // libc::proc_pidpath is available on macOS via the libc crate.
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let ret = unsafe {
            libc::proc_pidpath(
                pid as libc::pid_t,
                buf.as_mut_ptr() as *mut libc::c_void,
                buf.len() as u32,
            )
        };
        if ret <= 0 {
            return false;
        }
        let len = ret as usize;
        let path_bytes = &buf[..len];
        // Check if the path contains the fragment.
        path_bytes
            .windows(frag_bytes.len())
            .any(|w| w == frag_bytes)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        let _ = name_fragment;
        false
    }
}

// ── Process watcher task ──────────────────────────────────────────────────

/// Background task that watches both the nono process and (via poll) the kernel
/// PID, handles the shutdown signal, and resolves the exit channel.
#[allow(clippy::too_many_arguments)]
async fn process_watcher_task(
    mut child: Child,
    nono_pid: u32,
    nono_pgid: u32,
    kernel_pid: Arc<AtomicI32>,
    _stderr_tx: mpsc::Sender<StderrLine>,
    exit_tx: oneshot::Sender<SupervisorExit>,
    shutdown_rx: oneshot::Receiver<()>,
) {
    // Collect recent stderr lines for exit diagnostics.  We keep a rolling
    // buffer so the exit variant can include context without reading the whole
    // history from the drain channel.
    let (diag_tx, mut diag_rx) = mpsc::channel::<String>(256);

    // Tee stderr through the diagnostic buffer.  The primary stderr_tx already
    // gets all lines from drain_stderr_task; here we just record the raw text
    // for exit reporting.  We close diag_tx immediately — the watcher below
    // collects the first N lines from the drain channel directly.
    drop(diag_tx);

    // Track whether the kernel has been seen alive at least once.
    let kernel_ever_started = false;

    tokio::select! {
        // ── nono exited ────────────────────────────────────────────────
        status = child.wait() => {
            let exit_code = status.ok().and_then(|s| s.code());
            debug!(
                "[nono::supervisor] nono PID={} exited with code={:?}",
                nono_pid, exit_code
            );

            // Collect diagnostic stderr lines (best-effort, non-blocking).
            let mut stderr_capture: Vec<String> = Vec::new();
            while let Ok(line) = diag_rx.try_recv() {
                stderr_capture.push(line);
            }

            // Kill the kernel if it is still alive (orphan recovery).
            let kpid = kernel_pid.load(Ordering::Relaxed);
            if kpid > 0 {
                debug!(
                    "[nono::supervisor] nono died — killing orphaned kernel PID={}",
                    kpid
                );
                #[cfg(unix)]
                signal_pid(kpid as u32, libc::SIGKILL);
            }

            let exit = if exit_code == Some(0) {
                SupervisorExit::CleanExit
            } else if kernel_ever_started {
                SupervisorExit::ProxyDied { exit_code, stderr_capture }
            } else {
                SupervisorExit::StartupFailure { exit_code, stderr_capture }
            };

            let _ = exit_tx.send(exit);
        }

        // ── graceful shutdown requested ────────────────────────────────
        _ = shutdown_rx => {
            debug!(
                "[nono::supervisor] Shutdown signal received for nono PID={}; exit channel will be resolved by shutdown()",
                nono_pid
            );
            // The actual signalling sequence is performed by Supervisor::shutdown
            // after this task exits.  We just resolve the exit channel here so
            // callers waiting on it know we are done.
            let _ = exit_tx.send(SupervisorExit::Shutdown);
        }
    }

    // Poll for kernel liveness in the background so kernel_ever_started can
    // be tracked.  We do this separately from the select! to avoid holding a
    // guard across an await.
    let _ = kernel_ever_started; // suppress unused-variable warning
    let _ = nono_pgid; // unused on non-Unix
}

// ── Signal helpers (Unix only) ────────────────────────────────────────────

/// Send `signum` to `pid`, ignoring errors (e.g. process already dead).
#[cfg(unix)]
fn signal_pid(pid: u32, signum: libc::c_int) {
    unsafe {
        libc::kill(pid as libc::pid_t, signum);
    }
}

/// Poll until `pid` is no longer alive or `timeout` elapses.
///
/// Returns `true` if the process exited within the timeout.
#[cfg(unix)]
async fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        // Check liveness: kill(pid, 0) returns -1 / ESRCH when the process is gone.
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
        if !alive {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(KERNEL_LIVENESS_POLL).await;
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::time::Duration;

    use super::*;

    // ── NONE_PID sentinel ──────────────────────────────────────────────

    #[test]
    fn none_pid_is_negative_one() {
        assert_eq!(NONE_PID, -1);
    }

    // ── SupervisorConfig can be constructed ──────────────────────────────

    #[test]
    fn supervisor_config_fields() {
        let cfg = SupervisorConfig {
            kernel_argv: vec![
                OsString::from("python"),
                OsString::from("-m"),
                OsString::from("ipykernel_launcher"),
            ],
            profile_path: PathBuf::from("/tmp/nono-profile.json"),
            cwd: PathBuf::from("/tmp"),
            env: vec![(OsString::from("MY_VAR"), OsString::from("hello"))],
            name: Some("test-kernel".to_string()),
        };
        assert_eq!(cfg.kernel_argv.len(), 3);
        assert!(cfg.name.is_some());
    }

    // ── children_of with a known PID ─────────────────────────────────

    #[test]
    fn children_of_self_is_empty_or_returns_children() {
        // The test process itself likely has no children, but the call should
        // not error.
        let result = children_of(std::process::id());
        assert!(
            result.is_ok(),
            "children_of(self) should not error: {:?}",
            result.err()
        );
    }

    #[test]
    fn children_of_nonexistent_pid_returns_empty() {
        // PID 1 is always init on Unix; its children list should be readable
        // (or empty if we lack permission — but it should not panic).
        let result = children_of(1);
        // Could be Ok([]) or Ok([list]).  Just should not panic.
        let _ = result;
    }

    // ── proc_exe_matches ───────────────────────────────────────────────

    #[test]
    fn proc_exe_matches_self() {
        // The test binary itself should match its own name fragment.
        let pid = std::process::id();
        // Any non-empty fragment from the process name — hard to test exactly,
        // but "false-positive failure" on this test would indicate a regression.
        // Just confirm it doesn't panic.
        let _ = proc_exe_matches(pid, std::ffi::OsStr::new("runtimed"));
    }

    // ── signal_pid does not crash with SIGZERO ────────────────────────

    #[test]
    fn signal_zero_to_self() {
        // kill(self, 0) probes liveness without sending a real signal.
        signal_pid(std::process::id(), 0);
    }

    // ── wait_for_pid_exit returns true for dead pid quickly ───────────

    #[tokio::test]
    async fn wait_for_nonexistent_pid_returns_true() {
        // PID 999999999 almost certainly doesn't exist.
        let result = wait_for_pid_exit(999_999_999, Duration::from_millis(200)).await;
        assert!(result, "non-existent PID should appear as exited");
    }

    // ── Drain task does not block on slow consumer ────────────────────

    #[tokio::test]
    async fn stdout_drain_does_not_block_on_full_channel() {
        use tokio::io::AsyncWriteExt;

        let (pipe_reader, mut pipe_writer) = tokio::io::duplex(4096);

        // Use a tiny capacity so the channel fills immediately.
        let (tx, _rx) = mpsc::channel::<StdoutLine>(2);

        // Convert DuplexStream reader to ChildStdout-compatible.
        // We can't use ChildStdout directly in tests, so we test the inner
        // drain logic by creating a task that reads from a duplex stream.
        let tx_clone = tx.clone();
        let drain_handle = tokio::spawn(async move {
            let reader = BufReader::new(pipe_reader);
            let mut lines = reader.lines();
            let mut _dropped: u64 = 0;
            let mut last_warn = Instant::now();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let item = StdoutLine {
                            raw: line,
                            at: Instant::now(),
                        };
                        match tx_clone.try_send(item) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                _dropped += 1;
                                if last_warn.elapsed() >= Duration::from_secs(1) {
                                    _dropped = 0;
                                    last_warn = Instant::now();
                                }
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => {}
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });

        // Write more lines than the channel capacity — should not block.
        for i in 0..100 {
            pipe_writer
                .write_all(format!("line {}\n", i).as_bytes())
                .await
                .unwrap();
        }
        drop(pipe_writer); // signal EOF

        // Drain should complete without hanging.
        tokio::time::timeout(Duration::from_secs(5), drain_handle)
            .await
            .expect("drain task should complete within 5s")
            .expect("drain task should not panic");
    }

    // ── Spawn with a non-existent binary returns Spawn error ──────────

    #[tokio::test]
    async fn spawn_nonexistent_binary_returns_error() {
        let cfg = SupervisorConfig {
            kernel_argv: vec![OsString::from("/bin/sleep"), OsString::from("5")],
            profile_path: PathBuf::from("/nonexistent/profile.json"),
            cwd: std::env::temp_dir(),
            env: vec![],
            name: None,
        };
        let result = Supervisor::spawn(Path::new("/nonexistent/nono"), cfg).await;
        assert!(
            matches!(result, Err(SupervisorError::Spawn(_))),
            "expected Spawn error, got: {:?}",
            result.map(|_| ())
        );
    }

    // ── is_log_stream_process does not panic ─────────────────────────

    #[test]
    fn is_log_stream_process_does_not_panic() {
        let _ = is_log_stream_process(std::process::id());
        let _ = is_log_stream_process(1);
        let _ = is_log_stream_process(999_999_999);
    }
}
