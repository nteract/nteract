//! Coordinator-side management of a runtime agent subprocess.
//!
//! `RuntimeAgentHandle` spawns a `runtimed runtime-agent` child process in its
//! own ownership group. The ownership record is persisted as a per-agent
//! manifest for orphan reaping. On Unix, dropping the handle asks the watcher
//! to terminate the agent. Agent death closes the ownership pipes for installed
//! kernels, whose guards terminate their separate groups.

#[cfg(windows)]
use std::os::windows::io::RawHandle;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Result;
use tracing::{info, warn};

use crate::runtime_agent_manifest::RuntimeAgentManifest;
use crate::task_supervisor::spawn_supervised;

/// Handle to a running runtime agent subprocess.
///
/// The runtime agent connects back to the daemon socket as a peer. Managed Unix
/// children share its group; Windows children belong to its job object.
pub struct RuntimeAgentHandle {
    alive: Arc<AtomicBool>,
    /// Runtime agent ID used as the durable manifest key.
    runtime_agent_id: String,
    /// Notebook ID for logging/context.
    notebook_id: String,
    /// Closing this sender asks the watcher, which owns the child, to stop it.
    #[cfg(unix)]
    _shutdown: tokio::sync::oneshot::Sender<()>,
    /// Windows Job Object with KILL_ON_JOB_CLOSE for this runtime agent.
    #[cfg(windows)]
    job: Option<crate::runtime_agent_manifest::WindowsJob>,
}

impl RuntimeAgentHandle {
    /// Spawn a runtime agent subprocess that will connect back to the daemon socket.
    ///
    /// The runtime agent is given the socket path, notebook ID, runtime agent ID,
    /// and blob root as CLI arguments. It connects to the daemon socket and joins
    /// the notebook room as a `RuntimeAgent` peer.
    pub async fn spawn(
        notebook_id: String,
        runtime_agent_id: String,
        blob_root: PathBuf,
        socket_path: PathBuf,
        runtime_agent_exe: Option<PathBuf>,
    ) -> Result<Self> {
        let exe = match runtime_agent_exe {
            Some(path) => path,
            None => std::env::current_exe()?,
        };
        info!(
            "[runtime-agent-handle] Spawning runtime agent: {} runtime-agent --notebook-id {} (socket: {})",
            exe.display(),
            notebook_id,
            socket_path.display(),
        );

        let mut cmd = tokio::process::Command::new(&exe);
        cmd.arg("runtime-agent")
            .arg("--notebook-id")
            .arg(&notebook_id)
            .arg("--runtime-agent-id")
            .arg(&runtime_agent_id)
            .arg("--blob-root")
            .arg(blob_root.as_os_str())
            .arg("--socket")
            .arg(socket_path.as_os_str())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true);

        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(unix)]
        let mut child_exits =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?;

        let mut child = cmd.spawn()?;

        #[cfg(unix)]
        let pgid = child.id().map(|pid| pid as i32);

        #[cfg(unix)]
        let manifest = match pgid {
            Some(pgid) => {
                RuntimeAgentManifest::unix(runtime_agent_id.clone(), notebook_id.clone(), pgid)
            }
            None => {
                let _ = child.kill().await;
                anyhow::bail!("runtime agent spawned without a process id");
            }
        };

        #[cfg(windows)]
        let (manifest, job) = {
            let pid = match child.id() {
                Some(pid) => pid,
                None => {
                    let _ = child.kill().await;
                    anyhow::bail!("runtime agent spawned without a process id");
                }
            };
            let process_handle = match child.raw_handle() {
                Some(handle) => handle as RawHandle,
                None => {
                    let _ = child.kill().await;
                    anyhow::bail!("runtime agent spawned without a process handle");
                }
            };
            let (job_name, job) = crate::runtime_agent_manifest::create_windows_job_for_process(
                &runtime_agent_id,
                process_handle,
            )
            .inspect_err(|_| {
                let _ = child.start_kill();
            })?;
            (
                RuntimeAgentManifest::windows(
                    runtime_agent_id.clone(),
                    notebook_id.clone(),
                    pid,
                    job_name,
                ),
                job,
            )
        };

        if let Err(e) = crate::runtime_agent_manifest::write_manifest(&manifest) {
            let _ = child.kill().await;
            return Err(e.context("failed to persist runtime-agent ownership manifest"));
        }

        info!(
            "[runtime-agent-handle] Runtime agent spawned (pid={:?}, notebook_id={}, runtime_agent_id={})",
            child.id(),
            notebook_id,
            runtime_agent_id,
        );

        let alive = Arc::new(AtomicBool::new(true));
        #[cfg(unix)]
        let (shutdown, mut cancelled) = tokio::sync::oneshot::channel::<()>();

        // Monitor child process exit
        let alive_clone = alive.clone();
        let panic_alive = alive.clone();
        let runtime_agent_id_clone = runtime_agent_id.clone();
        spawn_supervised(
            "runtime-agent-watcher",
            async move {
                #[cfg(unix)]
                {
                    use nix::{
                        sys::signal::{killpg, Signal},
                        unistd::Pid,
                    };
                    let group = Pid::from_raw(pgid.expect("manifest requires a child PID"));
                    // Observe exit without reaping: even after natural exit, the leader
                    // pins this group's identity until its managed descendants are killed.
                    let exit = async {
                        loop {
                            {
                                let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
                                if unsafe {
                                    libc::waitid(
                                        libc::P_PID,
                                        group.as_raw() as libc::id_t,
                                        &mut info,
                                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                                    )
                                } < 0
                                {
                                    let e = std::io::Error::last_os_error();
                                    if e.kind() == std::io::ErrorKind::Interrupted {
                                        continue;
                                    }
                                    return Err(e);
                                }
                                if unsafe { info.si_pid() } != 0 {
                                    return Ok(());
                                }
                            }
                            child_exits.recv().await;
                        }
                    };
                    tokio::pin!(exit);
                    let observed = tokio::select! {
                        r=&mut exit=>r,
                        _=&mut cancelled=>{
                            // The launch/handshake polls this signal even while RPC processing is busy.
                            let _=nix::sys::signal::kill(group,Signal::SIGTERM);
                            tokio::time::timeout(std::time::Duration::from_secs(8),exit).await.unwrap_or(Ok(()))
                        }
                    };
                    match observed {
                        Ok(()) => {
                            let decision = crate::runtime_agent_manifest::unix_cleanup_decision(
                                &runtime_agent_id_clone,
                                group.as_raw(),
                                killpg(group, Signal::SIGKILL),
                            );
                            if decision
                                != crate::runtime_agent_manifest::CleanupDecision::RetainForRetry
                            {
                                crate::runtime_agent_manifest::remove_manifest(
                                    &runtime_agent_id_clone,
                                );
                            }
                        }
                        Err(e) => warn!(
                            "Cannot establish ownership of agent {runtime_agent_id_clone}: {e}"
                        ),
                    }
                }
                match child.wait().await {
                    Ok(status) => {
                        info!(
                            "[runtime-agent-handle] Runtime agent {} exited with status: {}",
                            runtime_agent_id_clone, status
                        );
                    }
                    Err(e) => {
                        warn!(
                            "[runtime-agent-handle] Runtime agent {} wait error: {}",
                            runtime_agent_id_clone, e
                        );
                    }
                }
                alive_clone.store(false, Ordering::Relaxed);
            },
            move |_| {
                panic_alive.store(false, Ordering::Relaxed);
            },
        );

        Ok(Self {
            alive,
            runtime_agent_id,
            notebook_id,
            #[cfg(unix)]
            _shutdown: shutdown,
            #[cfg(windows)]
            job: Some(job),
        })
    }

    /// Check if the runtime agent process is still running.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

impl Drop for RuntimeAgentHandle {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            self.job.take();
            crate::runtime_agent_manifest::remove_manifest(&self.runtime_agent_id);
        }

        info!(
            "[runtime-agent-handle] RuntimeAgentHandle dropped for notebook {} runtime_agent {}",
            self.notebook_id, self.runtime_agent_id
        );
    }
}
