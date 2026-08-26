//! Transactional repair of the installed runtimed service.
//!
//! Service registration and live socket ownership are deliberately inspected
//! separately. An older daemon may still own the stable socket while the
//! current service is registered but not running, or when its current
//! launchd/systemd/Startup artifact is missing.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use runtimed_client::client::PoolClient;
use runtimed_client::protocol::RoomInfo;
use runtimed_client::singleton::{compatibility_error, query_daemon_info, DaemonInfo};
use runtimed_service::ServiceManager;
use uuid::Uuid;

use crate::notebook_sync_server::recovery::{
    migrate_prepared_legacy_overflow_journal, prepare_legacy_overflow_journal,
    verify_prepared_legacy_overflow_fallback, PreparedLegacyOverflowJournal,
};

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
const QUIESCENCE_ATTEMPTS: u32 = 25;
const QUIESCENCE_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone)]
struct LegacyOverflowTakeover {
    affected_rooms: Vec<Uuid>,
    journals: Vec<PreparedLegacyOverflowJournal>,
}

/// Parse the exact shutdown prose emitted by already-shipped 2.7.0-2.7.3
/// daemons. This is intentionally narrow, deny-by-default compatibility debt;
/// new daemons must expose typed upgrade/shutdown state instead of extending
/// this parser. Delete it when those releases leave the supported upgrade path.
fn legacy_overflow_room_ids(error: &str) -> Option<Vec<Uuid>> {
    let retained = regex::Regex::new(r"clean shutdown retained ([0-9]+) room\(s\)").ok()?;
    let expected_count = retained
        .captures(error)?
        .get(1)?
        .as_str()
        .parse::<usize>()
        .ok()?;
    let failures = error.split_once("after durability failure: ")?.1;
    let overflow = regex::Regex::new(
        r"([0-9a-fA-F-]{36}): journal commit failed before peer acknowledgement: room recovery journal failed: recovery manifest is ([0-9]+) bytes; maximum is 262144",
    )
    .ok()?;
    let mut rooms = Vec::new();
    let mut consumed = 0;
    for captures in overflow.captures_iter(failures) {
        let matched = captures.get(0)?;
        let expected_separator = if rooms.is_empty() { "" } else { "; " };
        if failures.get(consumed..matched.start())? != expected_separator {
            return None;
        }
        let actual = captures.get(2)?.as_str().parse::<usize>().ok()?;
        if actual <= 262_144 {
            return None;
        }
        rooms.push(Uuid::parse_str(captures.get(1)?.as_str()).ok()?);
        consumed = matched.end();
    }
    if consumed != failures.len() {
        return None;
    }
    rooms.sort_unstable();
    rooms.dedup();
    (rooms.len() == expected_count).then_some(rooms)
}

fn affected_legacy_daemon_version(version: &str) -> bool {
    ["2.7.0-", "2.7.1-", "2.7.2-", "2.7.3-"]
        .iter()
        .any(|release| {
            version.strip_prefix(release).is_some_and(|suffix| {
                suffix.starts_with("stable.") || suffix.starts_with("nightly.")
            })
        })
}

fn rooms_are_quiescent_for_takeover(
    rooms: &[RoomInfo],
    affected_rooms: &[Uuid],
) -> std::result::Result<(), String> {
    for room in rooms {
        if room.active_peers != 0 || room.has_kernel {
            return Err(format!(
                "room {} is not quiescent (active_peers={}, has_kernel={})",
                room.notebook_id, room.active_peers, room.has_kernel
            ));
        }
    }
    for affected in affected_rooms {
        let Some(room) = rooms
            .iter()
            .find(|room| room.notebook_id == affected.to_string())
        else {
            return Err(format!("affected room {affected} is not resident"));
        };
        if room.ephemeral {
            return Err(format!("affected room {affected} is ephemeral"));
        }
    }
    Ok(())
}

async fn wait_for_rooms_to_quiesce(
    socket_path: &Path,
    affected_rooms: &[Uuid],
) -> std::result::Result<(), String> {
    let mut last_error = None;
    for attempt in 0..QUIESCENCE_ATTEMPTS {
        let rooms = PoolClient::new(socket_path.to_path_buf())
            .list_rooms()
            .await
            .map_err(|error| format!("could not inspect rooms before legacy takeover: {error}"))?;
        match rooms_are_quiescent_for_takeover(&rooms, affected_rooms) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < QUIESCENCE_ATTEMPTS {
            tokio::time::sleep(QUIESCENCE_INTERVAL).await;
        }
    }
    Err(last_error.unwrap_or_else(|| "room quiescence could not be established".to_string()))
}

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
    async fn prepare_legacy_overflow_takeover(
        &self,
        _info: &DaemonInfo,
        _shutdown_error: &str,
    ) -> std::result::Result<Option<LegacyOverflowTakeover>, String> {
        Ok(None)
    }
    async fn validate_legacy_overflow_takeover(
        &self,
        _takeover: &LegacyOverflowTakeover,
    ) -> std::result::Result<(), String> {
        Err("legacy recovery takeover is unavailable".to_string())
    }
    fn migrate_legacy_overflow_takeover(
        &self,
        _takeover: &LegacyOverflowTakeover,
    ) -> std::result::Result<(), String> {
        Err("legacy recovery migration is unavailable".to_string())
    }
    fn verify_legacy_overflow_fallback(
        &self,
        _takeover: &LegacyOverflowTakeover,
    ) -> std::result::Result<(), String> {
        Err("legacy recovery fallback verification is unavailable".to_string())
    }
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

    async fn prepare_legacy_overflow_takeover(
        &self,
        info: &DaemonInfo,
        shutdown_error: &str,
    ) -> std::result::Result<Option<LegacyOverflowTakeover>, String> {
        if !affected_legacy_daemon_version(&info.version) {
            return Ok(None);
        }
        let Some(affected_rooms) = legacy_overflow_room_ids(shutdown_error) else {
            return Ok(None);
        };
        wait_for_rooms_to_quiesce(&self.socket_path, &affected_rooms).await?;

        let docs_dir = runtimed_client::default_notebook_docs_dir();
        let journals = affected_rooms
            .iter()
            .map(|notebook_id| {
                prepare_legacy_overflow_journal(&docs_dir, *notebook_id).map_err(|error| {
                    format!("could not preserve legacy recovery for {notebook_id}: {error}")
                })
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Some(LegacyOverflowTakeover {
            affected_rooms,
            journals,
        }))
    }

    async fn validate_legacy_overflow_takeover(
        &self,
        takeover: &LegacyOverflowTakeover,
    ) -> std::result::Result<(), String> {
        let rooms = PoolClient::new(self.socket_path.clone())
            .list_rooms()
            .await
            .map_err(|error| format!("could not recheck rooms before legacy takeover: {error}"))?;
        rooms_are_quiescent_for_takeover(&rooms, &takeover.affected_rooms)
    }

    fn migrate_legacy_overflow_takeover(
        &self,
        takeover: &LegacyOverflowTakeover,
    ) -> std::result::Result<(), String> {
        for prepared in &takeover.journals {
            migrate_prepared_legacy_overflow_journal(prepared).map_err(|error| {
                format!(
                    "could not migrate archived recovery for {}: {error}",
                    prepared.notebook_id
                )
            })?;
        }
        Ok(())
    }

    fn verify_legacy_overflow_fallback(
        &self,
        takeover: &LegacyOverflowTakeover,
    ) -> std::result::Result<(), String> {
        for prepared in &takeover.journals {
            verify_prepared_legacy_overflow_fallback(prepared).map_err(|error| {
                format!(
                    "active recovery for {} is not safe for deferred migration: {error}",
                    prepared.notebook_id
                )
            })?;
        }
        Ok(())
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
    if let Err(error) = stop_service_with_retry(service, daemon).await {
        tracing::warn!(
            "[service-repair] Could not disable unidentified legacy daemon service: {error}"
        );
    }
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

    let mut legacy_takeover = None;
    let graceful_completed = match daemon.request_shutdown().await {
        Ok(()) => true,
        Err(error) => {
            if daemon.is_responding().await {
                legacy_takeover = daemon
                    .prepare_legacy_overflow_takeover(info, &error)
                    .await
                    .map_err(|takeover_error| {
                        anyhow!(
                            "daemon remained responsive after clean shutdown failed: {error}; legacy recovery takeover was refused: {takeover_error}"
                        )
                    })?;
                if legacy_takeover.is_none() {
                    return Err(anyhow!(
                        "daemon remained responsive after clean shutdown did not complete: {error}; repair stopped to preserve notebook recovery state"
                    ));
                }
                tracing::warn!(
                    "[service-repair] Verified legacy recovery-manifest overflow; archived recovery and preparing exact-incarnation takeover"
                );
                false
            } else {
                tracing::warn!(
                    "[service-repair] Daemon pid {} became unresponsive during shutdown: {}",
                    info.pid,
                    error
                );
                false
            }
        }
    };

    // Always disable the service before waiting for the process to exit. A
    // KeepAlive launcher can otherwise replace a daemon that honored the
    // graceful request before repair has installed the new definition. Do this
    // even when is_installed() is false: a legacy SMAppService job can exist
    // without the current per-user service artifact.
    if let Err(error) = stop_service_with_retry(service, daemon).await {
        if legacy_takeover.is_some() {
            return Err(anyhow!(
                "legacy recovery takeover requires disabling the daemon service first: {error}"
            ));
        }
        tracing::warn!("[service-repair] Could not disable daemon service: {error}");
    }
    let exit_timeout = if graceful_completed || legacy_takeover.is_some() {
        GRACEFUL_EXIT_TIMEOUT
    } else {
        SERVICE_EXIT_TIMEOUT
    };
    if daemon.wait_for_pid_exit(info.pid, exit_timeout).await {
        tracing::info!("[service-repair] Daemon process exited");
        ensure_socket_owner_released(daemon, info).await?;
        if let Some(takeover) = &legacy_takeover {
            if let Err(error) = daemon.migrate_legacy_overflow_takeover(takeover) {
                daemon
                    .verify_legacy_overflow_fallback(takeover)
                    .map_err(|verify_error| {
                        anyhow!(
                            "offline legacy journal rewrite failed: {error}; replacement journal verification also failed: {verify_error}"
                        )
                    })?;
                tracing::warn!(
                    "[service-repair] Offline legacy journal rewrite did not complete; continuing after re-verifying the active v1/v2 journal: {error}"
                );
            }
        }
        return Ok(());
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

    if let Some(takeover) = &legacy_takeover {
        daemon
            .validate_legacy_overflow_takeover(takeover)
            .await
            .map_err(|error| {
                anyhow!("legacy recovery takeover became unsafe before process stop: {error}")
            })?;
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
    ensure_socket_owner_released(daemon, info).await?;
    if let Some(takeover) = &legacy_takeover {
        if let Err(error) = daemon.migrate_legacy_overflow_takeover(takeover) {
            daemon
                .verify_legacy_overflow_fallback(takeover)
                .map_err(|verify_error| {
                    anyhow!(
                        "offline legacy journal rewrite failed: {error}; replacement journal verification also failed: {verify_error}"
                    )
                })?;
            tracing::warn!(
                "[service-repair] Offline legacy journal rewrite did not complete; continuing after re-verifying the active v1/v2 journal: {error}"
            );
        }
    }
    Ok(())
}

async fn stop_service_with_retry<S, D>(
    service: &mut S,
    daemon: &D,
) -> std::result::Result<(), String>
where
    S: ServiceRuntime,
    D: DaemonRuntime,
{
    match service.stop() {
        Ok(()) => Ok(()),
        Err(first_error) => {
            tracing::warn!(
                "[service-repair] Service-manager stop did not complete: {first_error}; retrying"
            );
            daemon.sleep(Duration::from_millis(250)).await;
            match service.stop() {
                Ok(()) => Ok(()),
                Err(second_error) => {
                    tracing::warn!(
                        "[service-repair] Service-manager stop retry did not complete: {second_error}"
                    );
                    Err(format!(
                        "service-manager stop failed twice: {first_error}; {second_error}"
                    ))
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

    fn room_info(notebook_id: Uuid, active_peers: usize, has_kernel: bool) -> RoomInfo {
        RoomInfo {
            notebook_id: notebook_id.to_string(),
            active_peers,
            had_peers: active_peers > 0,
            has_kernel,
            kernel_type: None,
            env_source: None,
            kernel_status: None,
            ephemeral: false,
            notebook_path: None,
            state: if active_peers > 0 {
                runtimed_client::protocol::RoomState::Active
            } else if has_kernel {
                runtimed_client::protocol::RoomState::Idle
            } else {
                runtimed_client::protocol::RoomState::Inactive
            },
        }
    }

    struct FakeDaemon {
        info: Arc<Mutex<Option<DaemonInfo>>>,
        events: Arc<Mutex<Vec<&'static str>>>,
        shutdown_exits: bool,
        shutdown_error: Option<&'static str>,
        legacy_takeover: bool,
        migration_error: Option<&'static str>,
        fallback_valid: bool,
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

        async fn prepare_legacy_overflow_takeover(
            &self,
            _info: &DaemonInfo,
            _shutdown_error: &str,
        ) -> std::result::Result<Option<LegacyOverflowTakeover>, String> {
            self.events.lock().unwrap().push("prepare_takeover");
            Ok(self.legacy_takeover.then_some(LegacyOverflowTakeover {
                affected_rooms: Vec::new(),
                journals: Vec::new(),
            }))
        }

        async fn validate_legacy_overflow_takeover(
            &self,
            _takeover: &LegacyOverflowTakeover,
        ) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push("validate_takeover");
            self.legacy_takeover
                .then_some(())
                .ok_or_else(|| "legacy takeover disabled".to_string())
        }

        fn migrate_legacy_overflow_takeover(
            &self,
            _takeover: &LegacyOverflowTakeover,
        ) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push("migrate_takeover");
            if let Some(error) = self.migration_error {
                return Err(error.to_string());
            }
            self.legacy_takeover
                .then_some(())
                .ok_or_else(|| "legacy takeover disabled".to_string())
        }

        fn verify_legacy_overflow_fallback(
            &self,
            _takeover: &LegacyOverflowTakeover,
        ) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push("verify_fallback");
            self.fallback_valid
                .then_some(())
                .ok_or_else(|| "active journal did not pass offline verification".to_string())
        }

        async fn sleep(&self, _duration: Duration) {}
    }

    struct FakeService {
        installed: bool,
        stop_succeeds: bool,
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
            self.stop_succeeds
                .then_some(())
                .ok_or_else(|| "service artifact missing".to_string())
        }

        fn install_and_start(&mut self, _source_binary: &Path) -> std::result::Result<(), String> {
            self.events.lock().unwrap().push(if self.installed {
                "upgrade_start"
            } else {
                "install_start"
            });
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

    #[test]
    fn recognizes_only_the_exact_legacy_manifest_overflow_shape() {
        let room = Uuid::new_v4();
        let error = format!(
            "Daemon returned error: clean shutdown blocked: clean shutdown retained 1 room(s) after durability failure: {room}: journal commit failed before peer acknowledgement: room recovery journal failed: recovery manifest is 262178 bytes; maximum is 262144"
        );
        assert_eq!(legacy_overflow_room_ids(&error), Some(vec![room]));

        let second_room = Uuid::new_v4();
        let two_rooms = format!(
            "clean shutdown blocked: clean shutdown retained 2 room(s) after durability failure: {room}: journal commit failed before peer acknowledgement: room recovery journal failed: recovery manifest is 262178 bytes; maximum is 262144; {second_room}: journal commit failed before peer acknowledgement: room recovery journal failed: recovery manifest is 300000 bytes; maximum is 262144"
        );
        let mut expected = vec![room, second_room];
        expected.sort_unstable();
        assert_eq!(legacy_overflow_room_ids(&two_rooms), Some(expected));

        assert_eq!(
            legacy_overflow_room_ids(
                "clean shutdown retained 1 room(s): durability barrier still active"
            ),
            None
        );
        assert_eq!(
            legacy_overflow_room_ids(&two_rooms.replace(
                &format!(
                    "{second_room}: journal commit failed before peer acknowledgement: room recovery journal failed: recovery manifest is 300000 bytes; maximum is 262144"
                ),
                &format!("{second_room}: source publication is still active")
            )),
            None,
            "a mixed durability failure must never authorize takeover"
        );
        assert_eq!(
            legacy_overflow_room_ids(&error.replace("262178", "262144")),
            None
        );
        assert_eq!(
            legacy_overflow_room_ids(&error.replace("retained 1", "retained 2")),
            None
        );
    }

    #[test]
    fn limits_takeover_to_the_affected_release_family() {
        assert!(affected_legacy_daemon_version(
            "2.7.0-stable.202608172336+f28fa66"
        ));
        assert!(affected_legacy_daemon_version(
            "2.7.1-nightly.202608220012+360d265"
        ));
        assert!(affected_legacy_daemon_version(
            "2.7.2-nightly.202608221655+af1351d"
        ));
        assert!(affected_legacy_daemon_version(
            "2.7.3-stable.202608230344+0b711d4"
        ));
        assert!(affected_legacy_daemon_version(
            "2.7.3-nightly.202608230344+0b711d4"
        ));
        assert!(!affected_legacy_daemon_version(
            "2.7.4-stable.202608261821+1d39250"
        ));
        assert!(!affected_legacy_daemon_version(
            "2.6.9-stable.202608120000+old"
        ));
        assert!(!affected_legacy_daemon_version("2.7.3+local"));
    }

    #[test]
    fn takeover_requires_every_room_to_be_quiescent_and_affected_room_resident() {
        let affected = Uuid::new_v4();
        let unrelated = Uuid::new_v4();
        assert!(
            rooms_are_quiescent_for_takeover(&[room_info(affected, 0, false)], &[affected]).is_ok()
        );
        assert!(rooms_are_quiescent_for_takeover(
            &[
                room_info(affected, 0, false),
                room_info(unrelated, 1, false)
            ],
            &[affected]
        )
        .unwrap_err()
        .contains("not quiescent"));
        assert!(
            rooms_are_quiescent_for_takeover(&[room_info(affected, 0, true)], &[affected])
                .unwrap_err()
                .contains("not quiescent")
        );
        assert!(rooms_are_quiescent_for_takeover(&[], &[affected])
            .unwrap_err()
            .contains("not resident"));

        let mut ephemeral = room_info(affected, 0, false);
        ephemeral.ephemeral = true;
        assert!(rooms_are_quiescent_for_takeover(&[ephemeral], &[affected])
            .unwrap_err()
            .contains("ephemeral"));
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
            legacy_takeover: false,
            migration_error: None,
            fallback_valid: false,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.1+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: false,
            stop_succeeds: false,
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
    async fn installed_service_stop_failure_repairs_orphaned_socket_owner() {
        let info = Arc::new(Mutex::new(Some(daemon_info(41, "2.4.6+old", 0))));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: false,
            shutdown_error: None,
            legacy_takeover: false,
            migration_error: None,
            fallback_valid: false,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.2+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: true,
            stop_succeeds: false,
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
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == "service_stop")
                .count(),
            2,
            "a failed service stop should be retried before process escalation"
        );
        let shutdown = events
            .iter()
            .position(|event| *event == "shutdown")
            .unwrap();
        let first_service_stop = events
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
        let upgrade_start = events
            .iter()
            .position(|event| *event == "upgrade_start")
            .unwrap();
        assert!(shutdown < first_service_stop);
        assert!(first_service_stop < wait_pid);
        assert!(wait_pid < stop_process);
        assert!(stop_process < upgrade_start);
        assert!(!events.contains(&"install_start"));
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
            legacy_takeover: false,
            migration_error: None,
            fallback_valid: false,
            responds_without_info: Arc::new(AtomicBool::new(true)),
        };
        let replacement = daemon_info(91, "2.7.1+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: false,
            stop_succeeds: false,
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
            legacy_takeover: false,
            migration_error: None,
            fallback_valid: false,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.1+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: true,
            stop_succeeds: false,
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

    #[tokio::test]
    async fn verified_legacy_overflow_is_migrated_only_after_exact_process_stops() {
        let old = daemon_info(41, "2.7.3-stable.202608230344+0b711d4", DAEMON_API_VERSION);
        let info = Arc::new(Mutex::new(Some(old)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: false,
            shutdown_error: Some("known legacy overflow"),
            legacy_takeover: true,
            migration_error: None,
            fallback_valid: false,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.4+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: true,
            stop_succeeds: true,
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
        let prepare = events
            .iter()
            .position(|event| *event == "prepare_takeover")
            .unwrap();
        let validate = events
            .iter()
            .position(|event| *event == "validate_takeover")
            .unwrap();
        let stop_process = events
            .iter()
            .position(|event| *event == "stop_process")
            .unwrap();
        let migrate = events
            .iter()
            .position(|event| *event == "migrate_takeover")
            .unwrap();
        let upgrade_start = events
            .iter()
            .position(|event| *event == "upgrade_start")
            .unwrap();
        assert!(prepare < validate);
        assert!(validate < stop_process);
        assert!(stop_process < migrate);
        assert!(migrate < upgrade_start);
    }

    #[tokio::test]
    async fn failed_offline_rewrite_still_installs_daemon_that_can_read_v1() {
        let old = daemon_info(41, "2.7.3-stable.202608230344+0b711d4", DAEMON_API_VERSION);
        let info = Arc::new(Mutex::new(Some(old)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: false,
            shutdown_error: Some("known legacy overflow"),
            legacy_takeover: true,
            migration_error: Some("active journal changed after archive"),
            fallback_valid: true,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.4+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: true,
            stop_succeeds: true,
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
        let migrate = events
            .iter()
            .position(|event| *event == "migrate_takeover")
            .unwrap();
        let verify_fallback = events
            .iter()
            .position(|event| *event == "verify_fallback")
            .unwrap();
        let upgrade_start = events
            .iter()
            .position(|event| *event == "upgrade_start")
            .unwrap();
        assert!(migrate < verify_fallback);
        assert!(verify_fallback < upgrade_start);
    }

    #[tokio::test]
    async fn legacy_takeover_refuses_when_service_launcher_cannot_be_disabled() {
        let old = daemon_info(41, "2.7.3-stable.202608230344+0b711d4", DAEMON_API_VERSION);
        let info = Arc::new(Mutex::new(Some(old)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: false,
            shutdown_error: Some("known legacy overflow"),
            legacy_takeover: true,
            migration_error: None,
            fallback_valid: false,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.4+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: true,
            stop_succeeds: false,
            info,
            events: events.clone(),
            replacement,
        };

        let error = repair_service_with(
            &mut service,
            &daemon,
            Path::new("/Applications/nteract.app/Contents/MacOS/runtimed"),
            "2.7.4+new",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("requires disabling"));
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == "service_stop")
                .count(),
            2
        );
        assert!(!events.contains(&"stop_process"));
        assert!(!events.contains(&"migrate_takeover"));
        assert!(!events.contains(&"upgrade_start"));
    }

    #[tokio::test]
    async fn rewrite_failure_refuses_install_when_active_fallback_is_not_verified() {
        let old = daemon_info(41, "2.7.3-stable.202608230344+0b711d4", DAEMON_API_VERSION);
        let info = Arc::new(Mutex::new(Some(old)));
        let events = Arc::new(Mutex::new(Vec::new()));
        let daemon = FakeDaemon {
            info: info.clone(),
            events: events.clone(),
            shutdown_exits: false,
            shutdown_error: Some("known legacy overflow"),
            legacy_takeover: true,
            migration_error: Some("active journal changed after archive"),
            fallback_valid: false,
            responds_without_info: Arc::new(AtomicBool::new(false)),
        };
        let replacement = daemon_info(84, "2.7.4+new", DAEMON_API_VERSION);
        let mut service = FakeService {
            installed: true,
            stop_succeeds: true,
            info,
            events: events.clone(),
            replacement,
        };

        let error = repair_service_with(
            &mut service,
            &daemon,
            Path::new("/Applications/nteract.app/Contents/MacOS/runtimed"),
            "2.7.4+new",
        )
        .await
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("replacement journal verification also failed"));
        let events = events.lock().unwrap();
        assert!(events.contains(&"stop_process"));
        assert!(events.contains(&"migrate_takeover"));
        assert!(events.contains(&"verify_fallback"));
        assert!(!events.contains(&"upgrade_start"));
    }
}
