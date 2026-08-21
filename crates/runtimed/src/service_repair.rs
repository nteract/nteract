//! Transactional repair of the installed runtimed service.
//!
//! Service registration and live socket ownership are deliberately inspected
//! separately. An older daemon may still own the stable socket even when the
//! current launchd/systemd/Startup artifact is missing.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use runtimed_client::client::PoolClient;
use runtimed_client::singleton::{compatibility_error, query_daemon_info, DaemonInfo};
use runtimed_service::ServiceManager;

const DAEMON_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
// Clean shutdown may spend up to 20 seconds per notebook establishing its
// durability barrier. This is an overall patience bound, not permission to
// kill a daemon that is still responsive when the bound expires.
const CLEAN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(120);
const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
const SERVICE_EXIT_TIMEOUT: Duration = Duration::from_secs(120);
const FORCED_EXIT_TIMEOUT: Duration = Duration::from_secs(7);
const READY_ATTEMPTS: u32 = 40;
const READY_INTERVAL: Duration = Duration::from_millis(250);

fn same_incarnation(left: &DaemonInfo, right: &DaemonInfo) -> bool {
    left.pid == right.pid && left.started_at == right.started_at
}

trait ServiceRuntime {
    fn is_installed(&self) -> bool;
    fn stop(&mut self) -> std::result::Result<(), String>;
    fn install_and_start(&mut self, source_binary: &Path) -> std::result::Result<(), String>;
}

#[derive(Default)]
struct SystemServiceRuntime {
    manager: ServiceManager,
}

impl ServiceRuntime for SystemServiceRuntime {
    fn is_installed(&self) -> bool {
        self.manager.is_installed()
    }

    fn stop(&mut self) -> std::result::Result<(), String> {
        self.manager.stop().map_err(|error| error.to_string())
    }

    fn install_and_start(&mut self, source_binary: &Path) -> std::result::Result<(), String> {
        let source_binary = source_binary.to_path_buf();
        if self.manager.is_installed() {
            self.manager
                .upgrade(&source_binary)
                .map_err(|error| error.to_string())
        } else {
            self.manager
                .install(&source_binary)
                .map_err(|error| error.to_string())?;
            self.manager.start().map_err(|error| error.to_string())
        }
    }
}

#[allow(async_fn_in_trait)]
trait DaemonRuntime {
    async fn inspect(&self) -> Option<DaemonInfo>;
    async fn is_responding(&self) -> bool;
    async fn request_shutdown(&self) -> std::result::Result<(), String>;
    async fn wait_for_pid_exit(&self, pid: u32, timeout: Duration) -> bool;
    async fn stop_process(&self, pid: u32) -> std::result::Result<(), String>;
    async fn sleep(&self, duration: Duration);
}

struct SystemDaemonRuntime {
    socket_path: PathBuf,
}

impl Default for SystemDaemonRuntime {
    fn default() -> Self {
        Self {
            socket_path: runt_workspace::default_socket_path(),
        }
    }
}

impl DaemonRuntime for SystemDaemonRuntime {
    async fn inspect(&self) -> Option<DaemonInfo> {
        tokio::time::timeout(
            DAEMON_PROBE_TIMEOUT,
            query_daemon_info(self.socket_path.clone()),
        )
        .await
        .ok()
        .flatten()
    }

    async fn is_responding(&self) -> bool {
        tokio::time::timeout(
            DAEMON_PROBE_TIMEOUT,
            PoolClient::new(self.socket_path.clone()).ping(),
        )
        .await
        .is_ok_and(|result| result.is_ok())
    }

    async fn request_shutdown(&self) -> std::result::Result<(), String> {
        let client = PoolClient::new(self.socket_path.clone());
        match tokio::time::timeout(CLEAN_SHUTDOWN_TIMEOUT, client.shutdown()).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err(format!(
                "clean shutdown did not finish within {} seconds",
                CLEAN_SHUTDOWN_TIMEOUT.as_secs()
            )),
        }
    }

    async fn wait_for_pid_exit(&self, pid: u32, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if !process_exists(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        !process_exists(pid)
    }

    async fn stop_process(&self, pid: u32) -> std::result::Result<(), String> {
        stop_process_by_pid(pid)
            .await
            .map_err(|error| error.to_string())
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// Repair the stable service using `source_binary` and prove the intended
/// daemon took ownership before returning success.
pub async fn repair_service(source_binary: &Path, expected_version: &str) -> Result<DaemonInfo> {
    if !source_binary.exists() {
        return Err(anyhow!(
            "daemon binary not found at {}",
            source_binary.display()
        ));
    }

    let mut service = SystemServiceRuntime::default();
    let daemon = SystemDaemonRuntime::default();
    repair_service_with(&mut service, &daemon, source_binary, expected_version).await
}

async fn repair_service_with<S, D>(
    service: &mut S,
    daemon: &D,
    source_binary: &Path,
    expected_version: &str,
) -> Result<DaemonInfo>
where
    S: ServiceRuntime,
    D: DaemonRuntime,
{
    let previous = daemon.inspect().await;
    if let Some(info) = previous.as_ref() {
        stop_live_daemon(service, daemon, info).await?;
    } else if daemon.is_responding().await {
        stop_unidentified_daemon(service, daemon).await?;
    }

    let install_mode = if service.is_installed() {
        "upgrade"
    } else {
        "fresh install"
    };
    tracing::info!(
        "[service-repair] Applying {} from {}",
        install_mode,
        source_binary.display()
    );
    service
        .install_and_start(source_binary)
        .map_err(|error| anyhow!("failed to install and start daemon service: {error}"))?;

    wait_for_expected_daemon(daemon, previous.as_ref(), expected_version).await
}

async fn stop_unidentified_daemon<S, D>(service: &mut S, daemon: &D) -> Result<()>
where
    S: ServiceRuntime,
    D: DaemonRuntime,
{
    tracing::warn!(
        "[service-repair] Live daemon predates GetDaemonInfo; stopping without PID metadata"
    );
    if let Err(error) = daemon.request_shutdown().await {
        if daemon.is_responding().await {
            return Err(anyhow!(
                "legacy daemon remained responsive after clean shutdown did not complete: {error}; repair stopped to preserve notebook recovery state"
            ));
        }
        tracing::warn!(
            "[service-repair] Legacy daemon became unresponsive during shutdown: {error}"
        );
    }
    stop_service_with_retry(service, daemon).await;
    for _ in 0..50 {
        if !daemon.is_responding().await {
            return Ok(());
        }
        daemon.sleep(Duration::from_millis(100)).await;
    }
    Err(anyhow!(
        "legacy daemon still owns the socket but does not report PID metadata; restart the app or sign out to complete repair"
    ))
}

async fn stop_live_daemon<S, D>(service: &mut S, daemon: &D, info: &DaemonInfo) -> Result<()>
where
    S: ServiceRuntime,
    D: DaemonRuntime,
{
    tracing::info!(
        "[service-repair] Stopping live daemon pid={} version={} started_at={}",
        info.pid,
        info.version,
        info.started_at
    );

    let graceful_completed = match daemon.request_shutdown().await {
        Ok(()) => true,
        Err(error) => {
            if daemon.is_responding().await {
                return Err(anyhow!(
                    "daemon remained responsive after clean shutdown did not complete: {error}; repair stopped to preserve notebook recovery state"
                ));
            }
            tracing::warn!(
                "[service-repair] Daemon pid {} became unresponsive during shutdown: {}",
                info.pid,
                error
            );
            false
        }
    };

    // Always disable the service before waiting for the process to exit. A
    // KeepAlive launcher can otherwise replace a daemon that honored the
    // graceful request before repair has installed the new definition. Do this
    // even when is_installed() is false: a legacy SMAppService job can exist
    // without the current per-user service artifact.
    stop_service_with_retry(service, daemon).await;
    let exit_timeout = if graceful_completed {
        GRACEFUL_EXIT_TIMEOUT
    } else {
        SERVICE_EXIT_TIMEOUT
    };
    if daemon.wait_for_pid_exit(info.pid, exit_timeout).await {
        tracing::info!("[service-repair] Daemon process exited");
        return ensure_socket_owner_released(daemon, info).await;
    }

    match daemon.inspect().await {
        Some(current) if same_incarnation(&current, info) => {}
        Some(current) => {
            return Err(anyhow!(
                "daemon socket ownership changed during repair: pid {} became pid {}",
                info.pid,
                current.pid
            ));
        }
        None => {
            return Err(anyhow!(
                "daemon pid {} remained but no longer proved ownership of the stable socket; refusing unsafe process termination",
                info.pid
            ));
        }
    }

    tracing::warn!(
        "[service-repair] Daemon pid {} is orphaned; escalating process stop",
        info.pid
    );
    daemon
        .stop_process(info.pid)
        .await
        .map_err(|error| anyhow!("failed to stop orphan daemon pid {}: {error}", info.pid))?;
    if !daemon
        .wait_for_pid_exit(info.pid, FORCED_EXIT_TIMEOUT)
        .await
    {
        return Err(anyhow!(
            "daemon pid {} remained after process-stop escalation",
            info.pid
        ));
    }
    ensure_socket_owner_released(daemon, info).await
}

async fn stop_service_with_retry<S, D>(service: &mut S, daemon: &D)
where
    S: ServiceRuntime,
    D: DaemonRuntime,
{
    match service.stop() {
        Ok(()) => {}
        Err(first_error) => {
            tracing::warn!(
                "[service-repair] Service-manager stop did not complete: {first_error}; retrying"
            );
            daemon.sleep(Duration::from_millis(250)).await;
            match service.stop() {
                Ok(()) => {}
                Err(second_error) => {
                    tracing::warn!(
                        "[service-repair] Service-manager stop retry did not complete: {second_error}"
                    );
                }
            }
        }
    }
}

async fn ensure_socket_owner_released<D>(daemon: &D, previous: &DaemonInfo) -> Result<()>
where
    D: DaemonRuntime,
{
    for _ in 0..20 {
        match daemon.inspect().await {
            None => return Ok(()),
            Some(current) if !same_incarnation(&current, previous) => {
                return Err(anyhow!(
                    "another daemon took the socket during repair: pid {}",
                    current.pid
                ));
            }
            Some(_) => daemon.sleep(Duration::from_millis(100)).await,
        }
    }
    Err(anyhow!(
        "daemon pid {} still owns the socket after shutdown",
        previous.pid
    ))
}

async fn wait_for_expected_daemon<D>(
    daemon: &D,
    previous: Option<&DaemonInfo>,
    expected_version: &str,
) -> Result<DaemonInfo>
where
    D: DaemonRuntime,
{
    let mut last_seen = None;
    for _ in 0..READY_ATTEMPTS {
        if let Some(current) = daemon.inspect().await {
            let is_new = previous
                .map(|old| !same_incarnation(old, &current))
                .unwrap_or(true);
            if is_new
                && current.version == expected_version
                && compatibility_error(&current).is_none()
            {
                tracing::info!(
                    "[service-repair] Verified daemon pid={} version={} api={}",
                    current.pid,
                    current.version,
                    current.daemon_api_version
                );
                return Ok(current);
            }
            last_seen = Some(current);
        }
        daemon.sleep(READY_INTERVAL).await;
    }

    let detail = match last_seen {
        Some(info) => format!(
            "last saw pid={} version={} wire={} api={}",
            info.pid, info.version, info.protocol_version, info.daemon_api_version
        ),
        None => "the stable socket never returned daemon metadata".to_string(),
    };
    Err(anyhow!(
        "installed daemon failed self-verification for version {expected_version}: {detail}"
    ))
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(target_os = "windows")]
fn process_exists(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    std::process::Command::new("tasklist")
        .args(["/FI", &filter, "/NH"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn process_exists(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
async fn stop_process_by_pid(pid: u32) -> Result<()> {
    if !process_exists(pid) {
        return Ok(());
    }
    if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error.into());
        }
    }
    let runtime = SystemDaemonRuntime::default();
    if runtime.wait_for_pid_exit(pid, Duration::from_secs(5)).await {
        return Ok(());
    }
    if unsafe { libc::kill(pid as i32, libc::SIGKILL) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error.into());
        }
    }
    if runtime.wait_for_pid_exit(pid, Duration::from_secs(2)).await {
        Ok(())
    } else {
        Err(anyhow!("process {pid} remained after SIGKILL"))
    }
}

#[cfg(target_os = "windows")]
async fn stop_process_by_pid(pid: u32) -> Result<()> {
    let output = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(anyhow!(
            "taskkill failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
async fn stop_process_by_pid(_pid: u32) -> Result<()> {
    Err(anyhow!("process-stop escalation is unsupported"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use chrono::{TimeZone, Utc};
    use runtimed_client::protocol::DAEMON_API_VERSION;

    use super::*;

    fn daemon_info(pid: u32, version: &str, api: u32) -> DaemonInfo {
        DaemonInfo {
            endpoint: "/tmp/runtimed.sock".to_string(),
            protocol_version: notebook_protocol::connection::PROTOCOL_VERSION.into(),
            daemon_api_version: api,
            pid,
            version: version.to_string(),
            started_at: Utc.timestamp_opt(i64::from(pid), 0).unwrap(),
            blob_port: None,
            execution_store_dir: None,
            worktree_path: None,
            workspace_description: None,
        }
    }

    struct FakeDaemon {
        info: Arc<Mutex<Option<DaemonInfo>>>,
        events: Arc<Mutex<Vec<&'static str>>>,
        shutdown_exits: bool,
        shutdown_error: Option<&'static str>,
        responds_without_info: Arc<AtomicBool>,
    }

    impl DaemonRuntime for FakeDaemon {
        async fn inspect(&self) -> Option<DaemonInfo> {
            self.events.lock().unwrap().push("inspect");
            self.info.lock().unwrap().clone()
        }

        async fn is_responding(&self) -> bool {
            self.info.lock().unwrap().is_some() || self.responds_without_info.load(Ordering::SeqCst)
        }

        async fn request_shutdown(&self) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push("shutdown");
            if let Some(error) = self.shutdown_error {
                return Err(error.to_string());
            }
            if self.shutdown_exits {
                *self.info.lock().unwrap() = None;
                self.responds_without_info.store(false, Ordering::SeqCst);
            }
            Ok(())
        }

        async fn wait_for_pid_exit(&self, pid: u32, _timeout: Duration) -> bool {
            self.events.lock().unwrap().push("wait_pid");
            self.info
                .lock()
                .unwrap()
                .as_ref()
                .map(|info| info.pid != pid)
                .unwrap_or(true)
        }

        async fn stop_process(&self, _pid: u32) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push("stop_process");
            *self.info.lock().unwrap() = None;
            Ok(())
        }

        async fn sleep(&self, _duration: Duration) {}
    }

    struct FakeService {
        installed: bool,
        info: Arc<Mutex<Option<DaemonInfo>>>,
        events: Arc<Mutex<Vec<&'static str>>>,
        replacement: DaemonInfo,
    }

    impl ServiceRuntime for FakeService {
        fn is_installed(&self) -> bool {
            self.events.lock().unwrap().push("is_installed");
            self.installed
        }

        fn stop(&mut self) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push("service_stop");
            Err("service artifact missing".to_string())
        }

        fn install_and_start(&mut self, _source_binary: &Path) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push("install_start");
            self.installed = true;
            *self.info.lock().unwrap() = Some(self.replacement.clone());
            Ok(())
        }
    }

    #[test]
    fn compatibility_uses_protocol_and_api_not_build_identity() {
        let compatible_other_build = daemon_info(7, "9.9.9+different", DAEMON_API_VERSION);
        assert_eq!(compatibility_error(&compatible_other_build), None);

        let legacy = daemon_info(8, "2.4.6+old", 0);
        assert!(compatibility_error(&legacy)
            .unwrap()
            .contains("older than required"));
    }

    #[tokio::test]
    async fn live_orphan_is_stopped_before_fresh_service_install() {
        let info = Arc::new(Mutex::new(Some(daemon_info(41, "2.4.6+old", 0))));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: false,
            shutdown_error: None,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.1+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: false,
            info,
            events: events.clone(),
            replacement: replacement.clone(),
        };

        let result = repair_service_with(
            &mut service,
            &daemon,
            Path::new("/Applications/nteract.app/Contents/MacOS/runtimed"),
            &replacement.version,
        )
        .await
        .unwrap();

        assert_eq!(result.pid, replacement.pid);
        let events = events.lock().unwrap();
        let shutdown = events
            .iter()
            .position(|event| *event == "shutdown")
            .unwrap();
        let service_stop = events
            .iter()
            .position(|event| *event == "service_stop")
            .unwrap();
        let wait_pid = events
            .iter()
            .position(|event| *event == "wait_pid")
            .unwrap();
        let stop_process = events
            .iter()
            .position(|event| *event == "stop_process")
            .unwrap();
        let install_start = events
            .iter()
            .position(|event| *event == "install_start")
            .unwrap();
        assert!(shutdown < service_stop);
        assert!(service_stop < wait_pid);
        assert!(wait_pid < stop_process);
        assert!(stop_process < install_start);
    }

    #[tokio::test]
    async fn live_legacy_orphan_without_metadata_is_repaired() {
        let info = Arc::new(Mutex::new(None));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: true,
            shutdown_error: None,
            responds_without_info: Arc::new(AtomicBool::new(true)),
        };
        let replacement = daemon_info(91, "2.7.1+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: false,
            info,
            events: events.clone(),
            replacement: replacement.clone(),
        };

        let result = repair_service_with(
            &mut service,
            &daemon,
            Path::new("/Applications/nteract.app/Contents/MacOS/runtimed"),
            &replacement.version,
        )
        .await
        .unwrap();

        assert_eq!(result.pid, replacement.pid);
        let events = events.lock().unwrap();
        let shutdown = events
            .iter()
            .position(|event| *event == "shutdown")
            .unwrap();
        let service_stop = events
            .iter()
            .position(|event| *event == "service_stop")
            .unwrap();
        let install_start = events
            .iter()
            .position(|event| *event == "install_start")
            .unwrap();
        assert!(shutdown < service_stop);
        assert!(service_stop < install_start);
    }

    #[tokio::test]
    async fn responsive_daemon_is_not_forced_after_clean_shutdown_failure() {
        let old = daemon_info(41, "2.4.6+old", 0);
        let info = Arc::new(Mutex::new(Some(old)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: false,
            shutdown_error: Some("durability barrier still active"),
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.1+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: true,
            info,
            events: events.clone(),
            replacement,
        };

        let error = repair_service_with(
            &mut service,
            &daemon,
            Path::new("/Applications/nteract.app/Contents/MacOS/runtimed"),
            "2.7.1+new",
        )
        .await
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("preserve notebook recovery state"));
        let events = events.lock().unwrap();
        assert!(events.contains(&"shutdown"));
        assert!(!events.contains(&"service_stop"));
        assert!(!events.contains(&"stop_process"));
        assert!(!events.contains(&"install_start"));
    }
}
