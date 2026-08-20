//! Daemon watch loop driven by `DaemonConnection` events.
//!
//! `DaemonConnection` maintains a long-lived supervisor that caches
//! `DaemonInfo` and emits `Connected`/`Upgraded`/`Disconnected`. This module
//! consumes that stream and performs the two actions specific to the MCP server:
//!
//! 1. Exit the process on a version change so the proxy respawns us with
//!    the new binary.
//! 2. Re-join the active notebook session when the daemon comes back
//!    (either after a brief disconnect, or after a same-version restart).
//!
//! Tool dispatch asks the daemon directly instead of gating on a local
//! connection state. Under sustained concurrent load, local gating can stall in
//! `Reconnecting` while the daemon is healthy, short-circuiting every tool call.
//! See #2000.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use runtimed_client::daemon_connection::{DaemonConnection, DaemonEvent};
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

use crate::cloud::{self, NotebookTarget};
use crate::session::{DaemonIncarnation, NotebookSession, SessionDropInfo, SessionDropReason};
use std::collections::HashMap;

/// Exit code when the daemon has been upgraded and the MCP server should
/// restart. EX_TEMPFAIL (sysexits.h) — "temporary failure; try again."
pub const EXIT_DAEMON_UPGRADED: i32 = 75;

/// Env var the proxy sets on the restarted child to hand off the notebook
/// the previous child was attached to. Value is either a UUID or an
/// absolute file path.
pub const REJOIN_ENV_VAR: &str = "NTERACT_MCP_REJOIN_NOTEBOOK";

const REJOIN_RETRY_DELAY: Duration = Duration::from_secs(1);
const REJOIN_MAX_RETRIES: u32 = 3;
const REJOIN_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
struct RecoveryState {
    startup_version: Option<String>,
    initial_target: Option<String>,
    recovery_target: Option<String>,
    observed_intent_epoch: u64,
}

impl RecoveryState {
    fn new(startup_version: Option<String>, observed_intent_epoch: u64) -> Self {
        Self {
            startup_version,
            initial_target: std::env::var(REJOIN_ENV_VAR).ok(),
            recovery_target: None,
            observed_intent_epoch,
        }
    }

    fn observe_explicit_intent(&mut self, epoch: u64) {
        if epoch != self.observed_intent_epoch {
            self.observed_intent_epoch = epoch;
            self.initial_target = None;
            self.recovery_target = None;
        }
    }

    fn live_version_requires_exit(&mut self, version: &str) -> bool {
        match self.startup_version.as_deref() {
            Some(startup) => startup != version,
            None => {
                self.startup_version = Some(version.to_string());
                false
            }
        }
    }

    fn remember_target(&mut self, target: String) {
        // A file path is the durable identity. Never replace one with a UUID
        // from a later, less informative observation of the same loss.
        let should_replace = match self.recovery_target.as_deref() {
            None => true,
            Some(existing) => looks_like_uuid(existing) || !looks_like_uuid(&target),
        };
        if should_replace {
            self.recovery_target = Some(target);
        }
    }

    fn target(&self) -> Option<String> {
        self.initial_target
            .clone()
            .or_else(|| self.recovery_target.clone())
    }

    fn rejoin_succeeded(&mut self) {
        self.initial_target = None;
        self.recovery_target = None;
    }
}

fn event_live_info(event: &DaemonEvent) -> Option<&runtimed_client::singleton::DaemonInfo> {
    match event {
        DaemonEvent::Connected { info } => Some(info),
        DaemonEvent::Upgraded { current, .. } => Some(current),
        DaemonEvent::Disconnected => None,
    }
}

async fn resync_live_info<F, Fut>(
    delivery_was_lagged: bool,
    read: F,
) -> Option<runtimed_client::singleton::DaemonInfo>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<runtimed_client::singleton::DaemonInfo>>,
{
    if delivery_was_lagged {
        info!("Re-reading daemon identity after lagged event delivery");
    }
    read().await
}

fn daemon_binding_matches(
    is_hosted: bool,
    binding: Option<&DaemonIncarnation>,
    live_incarnation: Option<&DaemonIncarnation>,
) -> bool {
    is_hosted || live_incarnation.is_some_and(|live| binding == Some(live))
}

trait RecoverySession {
    fn hosted(&self) -> bool;
    fn daemon_incarnation(&self) -> Option<&DaemonIncarnation>;
    fn recovery_notebook_id(&self) -> &str;
    fn recovery_notebook_path(&self) -> Option<&str>;
    fn recovery_target(&self) -> String;
}

impl RecoverySession for NotebookSession {
    fn hosted(&self) -> bool {
        self.is_hosted()
    }

    fn daemon_incarnation(&self) -> Option<&DaemonIncarnation> {
        self.local_daemon_incarnation.as_ref()
    }

    fn recovery_notebook_id(&self) -> &str {
        &self.notebook_id
    }

    fn recovery_notebook_path(&self) -> Option<&str> {
        self.notebook_path.as_deref()
    }

    fn recovery_target(&self) -> String {
        self.rejoin_target()
    }
}

fn local_session_matches<S: RecoverySession>(
    session: &S,
    live_incarnation: Option<&DaemonIncarnation>,
) -> bool {
    daemon_binding_matches(
        session.hosted(),
        session.daemon_incarnation(),
        live_incarnation,
    )
}

/// Reconcile all local handles with the one daemon incarnation currently
/// reported live. This contains no disconnect latch: ownership is the entire
/// stale-session predicate.
async fn reconcile_sessions<S: RecoverySession>(
    live_incarnation: Option<&DaemonIncarnation>,
    session: &Arc<RwLock<Option<S>>>,
    parked_sessions: &Arc<RwLock<HashMap<String, S>>>,
    last_session_drop: &Arc<RwLock<Option<SessionDropInfo>>>,
    recovery: &mut RecoveryState,
) {
    let stale_active = {
        let mut guard = session.write().await;
        if guard
            .as_ref()
            .is_some_and(|active| !local_session_matches(active, live_incarnation))
        {
            guard.take()
        } else {
            None
        }
    };

    if let Some(stale) = stale_active {
        let target = stale.recovery_target();
        recovery.remember_target(target.clone());
        *last_session_drop.write().await = Some(SessionDropInfo {
            reason: SessionDropReason::Disconnected,
            notebook_id: stale.recovery_notebook_id().to_string(),
            notebook_path: stale.recovery_notebook_path().map(str::to_string),
            rejoin_target: Some(target),
        });
        info!(
            notebook_id = %stale.recovery_notebook_id(),
            "Removed local session owned by a stale daemon incarnation"
        );
    }

    let mut parked = parked_sessions.write().await;
    let before = parked.len();
    parked.retain(|_, parked_session| local_session_matches(parked_session, live_incarnation));
    let removed = before.saturating_sub(parked.len());
    if removed > 0 {
        info!(
            removed,
            "Removed parked sessions owned by a stale daemon incarnation"
        );
    }
}

pub struct WatchResources {
    pub daemon_conn: Arc<DaemonConnection>,
    pub socket_path: PathBuf,
    pub session: Arc<RwLock<Option<NotebookSession>>>,
    pub peer_label: Arc<RwLock<String>>,
    pub last_session_drop: Arc<RwLock<Option<SessionDropInfo>>>,
    pub parked_sessions: Arc<RwLock<HashMap<String, NotebookSession>>>,
    pub session_intent_epoch: Arc<AtomicU64>,
    pub startup_version: Option<String>,
}

/// Run the watch loop to completion. Returns the exit code the caller
/// should use; 0 means the event stream closed cleanly.
pub async fn watch(resources: WatchResources) -> i32 {
    let WatchResources {
        daemon_conn,
        socket_path,
        session,
        peer_label,
        last_session_drop,
        parked_sessions,
        session_intent_epoch,
        startup_version,
    } = resources;
    let mut rx = daemon_conn.subscribe();
    let mut recovery = RecoveryState::new(
        startup_version,
        session_intent_epoch.load(Ordering::Acquire),
    );
    if recovery.initial_target.is_some() {
        info!("Seeded initial rejoin target from {REJOIN_ENV_VAR}");
    }

    loop {
        let event = match rx.recv().await {
            Ok(event) => Some(event),
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!("Daemon event stream lagged, dropped {n} events");
                None
            }
            Err(broadcast::error::RecvError::Closed) => return 0,
        };

        let current_intent_epoch = session_intent_epoch.load(Ordering::Acquire);
        if current_intent_epoch != recovery.observed_intent_epoch {
            info!(
                previous_epoch = recovery.observed_intent_epoch,
                current_epoch = current_intent_epoch,
                "Clearing automatic rejoin state after explicit session intent"
            );
            recovery.observe_explicit_intent(current_intent_epoch);
        }

        if let Some(info) = event.as_ref().and_then(event_live_info) {
            if recovery.live_version_requires_exit(&info.version) {
                info!(version = %info.version, "Daemon version differs from MCP startup version");
                return EXIT_DAEMON_UPGRADED;
            }
        }

        // `info()` is the resynchronization authority for every event, and is
        // mandatory after Lagged. It prevents a delayed event from making a
        // decision about an already-replaced daemon.
        let live_info = resync_live_info(event.is_none(), || daemon_conn.info()).await;
        if let Some(info) = live_info.as_ref() {
            if recovery.live_version_requires_exit(&info.version) {
                info!(version = %info.version, "Live daemon version differs from MCP startup version");
                return EXIT_DAEMON_UPGRADED;
            }
        }
        let live_incarnation = live_info.as_ref().map(DaemonIncarnation::from);

        reconcile_sessions(
            live_incarnation.as_ref(),
            &session,
            &parked_sessions,
            &last_session_drop,
            &mut recovery,
        )
        .await;

        // Any live tool-installed session is authoritative. This also makes a
        // same-incarnation Connected heartbeat a structural no-op.
        if session.read().await.is_some() {
            recovery.rejoin_succeeded();
            continue;
        }

        let Some(target) = recovery.target() else {
            continue;
        };
        let Some(expected_incarnation) = live_incarnation else {
            continue;
        };

        info!(%target, "Rejoining notebook against current daemon incarnation");
        if rejoin(
            RejoinResources {
                daemon_conn: &daemon_conn,
                socket_path: &socket_path,
                session: &session,
                peer_label: &peer_label,
                last_session_drop: &last_session_drop,
                session_intent_epoch: &session_intent_epoch,
            },
            target,
            expected_incarnation,
            recovery.observed_intent_epoch,
        )
        .await
        {
            recovery.rejoin_succeeded();
        }
    }
}

/// Decide whether a target string should be treated as a notebook UUID
/// or a file path.
fn looks_like_uuid(target: &str) -> bool {
    let path = std::path::Path::new(target);
    path.components().count() == 1
        && path.extension().is_none()
        && uuid::Uuid::parse_str(target).is_ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicationResult {
    Installed,
    Superseded,
    Cancelled,
}

async fn publish_rejoined_session<S>(
    session: &Arc<RwLock<Option<S>>>,
    new_session: S,
    session_intent_epoch: &AtomicU64,
    expected_intent_epoch: u64,
) -> PublicationResult {
    let mut guard = session.write().await;
    if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
        return PublicationResult::Cancelled;
    }
    if guard.is_some() {
        return PublicationResult::Superseded;
    }
    *guard = Some(new_session);
    PublicationResult::Installed
}

/// Re-join the active notebook session.
///
/// If `override_target` is provided, use it instead of whatever session is
/// currently stored — this is how the proxy hands off the previous
/// notebook_id to a freshly respawned child via `NTERACT_MCP_REJOIN_NOTEBOOK`.
///
/// For file-backed notebooks, uses `connect_open(path)` so the daemon
/// reloads from disk (the UUID-only path would yield an empty document
/// because file-backed rooms' `.automerge` persist files are deleted).
///
/// For untitled (UUID-only) notebooks, the rejoin is daemon-authoritative: it
/// just attempts the reconnect and trusts the daemon, which attaches a resident
/// or recoverable room (untitled notebooks reload from their persisted doc) and
/// refuses a gone one. A refusal surfaces as `SyncError::NotebookUnavailable`
/// and the session is cleared as `Evicted` without retries; the phantom-room
/// guard (#2088) now lives in the daemon, not a client `list_rooms` heuristic.
///
/// Returns `true` if the rejoin succeeded, was superseded by explicit user
/// intent, or the room was definitively evicted. Returns `false` for transient
/// failure or a daemon-incarnation change so the recovery target survives for
/// the next live observation.
struct RejoinResources<'a> {
    daemon_conn: &'a DaemonConnection,
    socket_path: &'a Path,
    session: &'a Arc<RwLock<Option<NotebookSession>>>,
    peer_label: &'a Arc<RwLock<String>>,
    last_session_drop: &'a Arc<RwLock<Option<SessionDropInfo>>>,
    session_intent_epoch: &'a Arc<AtomicU64>,
}

async fn rejoin(
    resources: RejoinResources<'_>,
    target: String,
    expected_incarnation: DaemonIncarnation,
    expected_intent_epoch: u64,
) -> bool {
    let RejoinResources {
        daemon_conn,
        socket_path,
        session,
        peer_label,
        last_session_drop,
        session_intent_epoch,
    } = resources;
    if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
        return true;
    }
    match cloud::parse_connect_target(Some(&target), None, None, None) {
        Ok(NotebookTarget::Hosted {
            domain,
            notebook_id,
            ..
        }) => {
            return rejoin_hosted(
                session,
                peer_label,
                last_session_drop,
                domain,
                notebook_id,
                session_intent_epoch,
                expected_intent_epoch,
            )
            .await;
        }
        Ok(NotebookTarget::LocalPath(_)) | Ok(NotebookTarget::LocalNotebookId(_)) => {}
        Err(e) if target.starts_with("http://") || target.starts_with("https://") => {
            warn!("Hosted rejoin target is invalid: {e}");
            *last_session_drop.write().await = Some(SessionDropInfo {
                reason: SessionDropReason::Disconnected,
                notebook_id: target.to_string(),
                notebook_path: None,
                rejoin_target: Some(target.to_string()),
            });
            return false;
        }
        Err(_) => {}
    }

    let (notebook_id, notebook_path) = match target {
        target if looks_like_uuid(&target) => (target, None),
        target => {
            // Treat as file path. We'll learn the real notebook_id from
            // connect_open's response.
            (target.clone(), Some(target))
        }
    };

    // The daemon is authoritative about whether a notebook still exists.
    // NotebookSync attach reloads a resident-or-recoverable room and refuses a
    // gone one. `list_rooms` cannot distinguish an evicted UUID from a dormant
    // untitled notebook that is recoverable from docs_dir, which is the #2088
    // case. A refusal is handled in the retry loop below as Evicted with no
    // retry.
    let label = peer_label.read().await.clone();

    for attempt in 0..=REJOIN_MAX_RETRIES {
        if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
            info!("Automatic notebook rejoin cancelled by explicit session intent");
            return true;
        }
        if daemon_conn
            .info()
            .await
            .as_ref()
            .map(DaemonIncarnation::from)
            .as_ref()
            != Some(&expected_incarnation)
        {
            info!("Automatic notebook rejoin cancelled because daemon incarnation changed");
            return false;
        }
        let use_path = notebook_path
            .as_ref()
            .filter(|p| std::path::Path::new(p.as_str()).exists());

        let result = if let Some(path) = use_path {
            match notebook_sync::connect::connect_open(
                socket_path.to_path_buf(),
                PathBuf::from(path),
                &label,
            )
            .await
            {
                Ok(r) => {
                    let handle = r.handle;
                    if let Err(e) = handle
                        .await_session_ready_timeout(REJOIN_SESSION_READY_TIMEOUT)
                        .await
                    {
                        Err(e)
                    } else {
                        let cell_count = handle.get_cells().len();
                        Ok((handle, cell_count, r.info.notebook_id))
                    }
                }
                Err(e) => Err(e),
            }
        } else {
            match notebook_sync::connect::connect(
                socket_path.to_path_buf(),
                notebook_id.clone(),
                &label,
            )
            .await
            {
                Ok(r) => {
                    let handle = r.handle;
                    if let Err(e) = handle
                        .await_session_ready_timeout(REJOIN_SESSION_READY_TIMEOUT)
                        .await
                    {
                        Err(e)
                    } else {
                        let cell_count = handle.get_cells().len();
                        Ok((handle, cell_count, notebook_id.clone()))
                    }
                }
                Err(e) => Err(e),
            }
        };

        match result {
            Ok((handle, new_cell_count, new_notebook_id)) => {
                crate::presence::announce(&handle, &label).await;

                // Sample again after the entire connect/readiness operation.
                // A mismatch leaves no local handle eligible for publication.
                if daemon_conn
                    .info()
                    .await
                    .as_ref()
                    .map(DaemonIncarnation::from)
                    .as_ref()
                    != Some(&expected_incarnation)
                {
                    info!("Dropping rejoin completed against a replaced daemon incarnation");
                    return false;
                }

                let new_session = NotebookSession::local(
                    handle,
                    new_notebook_id,
                    notebook_path.clone(),
                    Some(expected_incarnation.clone()),
                );
                // Hold the publication lock across the check/install. Any
                // active session is authoritative, even for the same UUID:
                // an explicit tool activation may carry retained projection
                // heads/generation that a background rejoin must not erase.
                return match publish_rejoined_session(
                    session,
                    new_session,
                    session_intent_epoch,
                    expected_intent_epoch,
                )
                .await
                {
                    PublicationResult::Installed => {
                        info!("Rejoined notebook session ({new_cell_count} cells)");
                        true
                    }
                    PublicationResult::Superseded => {
                        info!("Dropping rejoin superseded by an active tool-installed session");
                        true
                    }
                    PublicationResult::Cancelled => {
                        info!("Dropping automatic rejoin superseded by explicit disconnect");
                        true
                    }
                };
            }
            Err(e) => {
                if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
                    info!("Automatic notebook rejoin cancelled by explicit session intent");
                    return true;
                }
                // A daemon refusal (the notebook is gone) is definitive - the
                // handshake completed and the daemon said no. Don't burn retries
                // on it; clear the session as Evicted with a recovery hint. Only
                // the refusal is treated this way: transient failures (daemon down
                // to Io/DaemonUnavailable, streaming-load failure to Protocol)
                // still retry below.
                if matches!(e, notebook_sync::SyncError::NotebookUnavailable(_)) {
                    info!("Rejoin refused by daemon (notebook gone): {e}");
                    *last_session_drop.write().await = Some(SessionDropInfo {
                        reason: SessionDropReason::Evicted,
                        notebook_id: notebook_id.clone(),
                        notebook_path: notebook_path.clone(),
                        rejoin_target: Some(
                            notebook_path.clone().unwrap_or_else(|| notebook_id.clone()),
                        ),
                    });
                    return true;
                }
                if attempt < REJOIN_MAX_RETRIES {
                    warn!(
                        "Rejoin attempt {} failed (retrying in {}s): {e}",
                        attempt + 1,
                        REJOIN_RETRY_DELAY.as_secs()
                    );
                    tokio::time::sleep(REJOIN_RETRY_DELAY).await;
                } else {
                    warn!("Rejoin exhausted retries: {e}");
                    // Record the drop so no_session_error can surface the
                    // notebook_id and reconnect hint to the agent.
                    *last_session_drop.write().await = Some(SessionDropInfo {
                        reason: SessionDropReason::Disconnected,
                        notebook_id: notebook_id.clone(),
                        notebook_path: notebook_path.clone(),
                        rejoin_target: Some(
                            notebook_path.clone().unwrap_or_else(|| notebook_id.clone()),
                        ),
                    });
                }
            }
        }
    }

    false // All retries exhausted
}

async fn rejoin_hosted(
    session: &Arc<RwLock<Option<NotebookSession>>>,
    peer_label: &Arc<RwLock<String>>,
    last_session_drop: &Arc<RwLock<Option<SessionDropInfo>>>,
    domain: String,
    notebook_id: String,
    session_intent_epoch: &Arc<AtomicU64>,
    expected_intent_epoch: u64,
) -> bool {
    let target = cloud::hosted_notebook_url(&domain, &notebook_id);
    let registry = match cloud::CloudRegistry::load_default() {
        Ok(Some(registry)) => registry,
        Ok(None) => {
            warn!(
                "Cannot rejoin hosted notebook: no cloud registry at {}",
                cloud::registry_path().display()
            );
            return false;
        }
        Err(e) => {
            warn!("Cannot rejoin hosted notebook: {e}");
            return false;
        }
    };
    let domain_config = match registry.domain(&domain) {
        Ok(Some(domain_config)) => domain_config,
        Ok(None) => {
            warn!("Cannot rejoin hosted notebook: domain {domain} is not configured");
            return false;
        }
        Err(e) => {
            warn!("Cannot rejoin hosted notebook: {e}");
            return false;
        }
    };

    for attempt in 0..=REJOIN_MAX_RETRIES {
        if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
            info!("Automatic hosted rejoin cancelled by explicit session intent");
            return true;
        }
        match cloud::connect_hosted_notebook(&domain_config, &notebook_id).await {
            Ok(result) => {
                let label = peer_label.read().await.clone();
                crate::presence::announce(&result.handle, &label).await;

                let new_session = NotebookSession::hosted(
                    result.handle,
                    notebook_id.clone(),
                    domain_config.base_url.clone(),
                );
                return match publish_rejoined_session(
                    session,
                    new_session,
                    session_intent_epoch,
                    expected_intent_epoch,
                )
                .await
                {
                    PublicationResult::Installed => {
                        info!("Rejoined hosted notebook session {target}");
                        true
                    }
                    PublicationResult::Superseded => {
                        info!("Dropping hosted rejoin superseded by an active session");
                        true
                    }
                    PublicationResult::Cancelled => {
                        info!("Dropping hosted rejoin superseded by explicit disconnect");
                        true
                    }
                };
            }
            Err(e) => {
                if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
                    info!("Automatic hosted rejoin cancelled by explicit session intent");
                    return true;
                }
                if attempt < REJOIN_MAX_RETRIES {
                    warn!(
                        "Hosted rejoin attempt {} failed (retrying in {}s): {e}",
                        attempt + 1,
                        REJOIN_RETRY_DELAY.as_secs()
                    );
                    tokio::time::sleep(REJOIN_RETRY_DELAY).await;
                } else {
                    warn!("Hosted rejoin exhausted retries: {e}");
                    *last_session_drop.write().await = Some(SessionDropInfo {
                        reason: SessionDropReason::Disconnected,
                        notebook_id: notebook_id.clone(),
                        notebook_path: None,
                        rejoin_target: Some(target.clone()),
                    });
                }
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use proptest::prelude::*;
    use std::sync::atomic::AtomicUsize;

    fn incarnation(pid: u32) -> DaemonIncarnation {
        DaemonIncarnation {
            pid,
            started_at: Utc.timestamp_opt(pid.into(), 0).single().unwrap(),
        }
    }

    #[derive(Clone, Debug)]
    struct FakeSession {
        id: String,
        path: Option<String>,
        hosted: bool,
        incarnation: Option<DaemonIncarnation>,
    }

    impl FakeSession {
        fn local(id: &str, path: Option<&str>, pid: u32) -> Self {
            Self {
                id: id.to_string(),
                path: path.map(str::to_string),
                hosted: false,
                incarnation: Some(incarnation(pid)),
            }
        }

        fn hosted(id: &str) -> Self {
            Self {
                id: id.to_string(),
                path: None,
                hosted: true,
                incarnation: None,
            }
        }
    }

    impl RecoverySession for FakeSession {
        fn hosted(&self) -> bool {
            self.hosted
        }

        fn daemon_incarnation(&self) -> Option<&DaemonIncarnation> {
            self.incarnation.as_ref()
        }

        fn recovery_notebook_id(&self) -> &str {
            &self.id
        }

        fn recovery_notebook_path(&self) -> Option<&str> {
            self.path.as_deref()
        }

        fn recovery_target(&self) -> String {
            self.path.clone().unwrap_or_else(|| self.id.clone())
        }
    }

    fn daemon_info(version: &str, pid: u32) -> runtimed_client::singleton::DaemonInfo {
        runtimed_client::singleton::DaemonInfo {
            endpoint: "/tmp/test.sock".to_string(),
            pid,
            version: version.to_string(),
            started_at: incarnation(pid).started_at,
            blob_port: None,
            execution_store_dir: None,
            worktree_path: None,
            workspace_description: None,
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum ModelSession {
        Hosted,
        Local(Option<u8>),
    }

    #[derive(Clone, Debug)]
    struct LoopModel {
        active: Option<ModelSession>,
        parked: Vec<ModelSession>,
        recovery_target: Option<String>,
        startup_version: u8,
        exited: bool,
    }

    impl LoopModel {
        fn reconcile(&mut self, live: Option<u8>, version: u8) {
            if version != self.startup_version {
                self.exited = true;
                return;
            }
            let active_matches = self.active.as_ref().is_none_or(|session| match session {
                ModelSession::Hosted => true,
                ModelSession::Local(binding) => live.is_some() && *binding == live,
            });
            if !active_matches {
                self.active = None;
                if self.recovery_target.is_none() {
                    self.recovery_target = Some("saved.ipynb".to_string());
                }
            }
            self.parked.retain(|session| match session {
                ModelSession::Hosted => true,
                ModelSession::Local(binding) => live.is_some() && *binding == live,
            });
        }

        fn remember(&mut self, target: &str) {
            let mut state = RecoveryState {
                startup_version: Some(self.startup_version.to_string()),
                initial_target: None,
                recovery_target: self.recovery_target.take(),
                observed_intent_epoch: 0,
            };
            state.remember_target(target.to_string());
            self.recovery_target = state.recovery_target;
        }
    }

    #[test]
    fn same_incarnation_heartbeat_is_structural_noop() {
        let binding = incarnation(10);
        assert!(daemon_binding_matches(
            false,
            Some(&binding),
            Some(&binding)
        ));
        assert!(!daemon_binding_matches(
            false,
            Some(&binding),
            Some(&incarnation(11))
        ));
        assert!(!daemon_binding_matches(false, None, Some(&binding)));
    }

    #[test]
    fn hosted_binding_survives_local_daemon_loss() {
        assert!(daemon_binding_matches(true, None, None));
        assert!(daemon_binding_matches(true, None, Some(&incarnation(4))));
    }

    #[test]
    fn saved_path_is_not_replaced_by_later_uuid_observation() {
        let mut state = RecoveryState {
            startup_version: Some("2.7.1".to_string()),
            initial_target: None,
            recovery_target: Some("/tmp/saved.ipynb".to_string()),
            observed_intent_epoch: 0,
        };
        state.remember_target("550e8400-e29b-41d4-a716-446655440000".to_string());
        assert_eq!(state.recovery_target.as_deref(), Some("/tmp/saved.ipynb"));
    }

    #[test]
    fn recovery_target_prefers_handoff_and_survives_until_success_or_intent() {
        let mut state = RecoveryState {
            startup_version: Some("2.7.1".to_string()),
            initial_target: Some("proxy-target".to_string()),
            recovery_target: Some("/tmp/recovery.ipynb".to_string()),
            observed_intent_epoch: 3,
        };
        assert_eq!(state.target().as_deref(), Some("proxy-target"));
        // A failed rejoin makes no state transition.
        assert_eq!(state.target().as_deref(), Some("proxy-target"));
        state.rejoin_succeeded();
        assert!(state.target().is_none());

        state.initial_target = Some("stale".to_string());
        state.recovery_target = Some("stale-recovery".to_string());
        state.observe_explicit_intent(4);
        assert!(state.target().is_none());
    }

    #[test]
    fn uuid_and_path_recovery_targets_are_distinct() {
        assert!(looks_like_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!looks_like_uuid("/tmp/notebook.ipynb"));
        assert!(!looks_like_uuid("relative/notebook.ipynb"));
    }

    #[test]
    fn lagged_live_version_mismatch_exits() {
        let mut state = RecoveryState::new(Some("2.7.0".to_string()), 0);
        assert!(state.live_version_requires_exit("2.7.1"));
    }

    #[test]
    fn new_incarnation_tool_install_survives_next_heartbeat() {
        let mut model = LoopModel {
            active: Some(ModelSession::Local(Some(1))),
            parked: vec![],
            recovery_target: None,
            startup_version: 1,
            exited: false,
        };
        model.reconcile(Some(2), 1);
        assert!(model.active.is_none());
        model.active = Some(ModelSession::Local(Some(2)));
        let before = model.clone();
        model.reconcile(Some(2), 1);
        assert_eq!(model.active, before.active);
        assert!(!model.exited);
    }

    #[tokio::test]
    async fn async_reconciliation_clears_stale_handles_and_retains_new_tool_install() {
        let session = Arc::new(RwLock::new(Some(FakeSession::local(
            "old",
            Some("/tmp/saved.ipynb"),
            1,
        ))));
        let parked = Arc::new(RwLock::new(HashMap::from([
            (
                "old-parked".to_string(),
                FakeSession::local("old-parked", None, 1),
            ),
            ("hosted".to_string(), FakeSession::hosted("hosted")),
        ])));
        let last_drop = Arc::new(RwLock::new(None));
        let mut recovery = RecoveryState {
            startup_version: Some("2.7.1".to_string()),
            initial_target: None,
            recovery_target: None,
            observed_intent_epoch: 0,
        };

        reconcile_sessions(
            Some(&incarnation(2)),
            &session,
            &parked,
            &last_drop,
            &mut recovery,
        )
        .await;
        assert!(session.read().await.is_none());
        assert_eq!(
            recovery.recovery_target.as_deref(),
            Some("/tmp/saved.ipynb")
        );
        assert_eq!(parked.read().await.len(), 1);
        assert!(parked.read().await.contains_key("hosted"));

        // A user activation published for the new incarnation is the slot
        // authority and survives the next same-incarnation heartbeat.
        *session.write().await = Some(FakeSession::local("new", None, 2));
        reconcile_sessions(
            Some(&incarnation(2)),
            &session,
            &parked,
            &last_drop,
            &mut recovery,
        )
        .await;
        assert_eq!(
            session.read().await.as_ref().map(|s| s.id.as_str()),
            Some("new")
        );
    }

    #[tokio::test]
    async fn async_publication_never_overwrites_tool_installed_session() {
        let session = Arc::new(RwLock::new(Some(FakeSession::local("tool", None, 2))));
        let epoch = AtomicU64::new(4);
        let result = publish_rejoined_session(
            &session,
            FakeSession::local("background", None, 2),
            &epoch,
            4,
        )
        .await;
        assert_eq!(result, PublicationResult::Superseded);
        assert_eq!(
            session.read().await.as_ref().map(|s| s.id.as_str()),
            Some("tool")
        );

        *session.write().await = None;
        epoch.store(5, Ordering::Release);
        let result = publish_rejoined_session(
            &session,
            FakeSession::local("background", None, 2),
            &epoch,
            4,
        )
        .await;
        assert_eq!(result, PublicationResult::Cancelled);
        assert!(session.read().await.is_none());
    }

    #[tokio::test]
    async fn lagged_delivery_rereads_live_info_and_detects_version_exit() {
        let reads = Arc::new(AtomicUsize::new(0));
        let reads_in_provider = Arc::clone(&reads);
        let info = resync_live_info(true, move || async move {
            reads_in_provider.fetch_add(1, Ordering::AcqRel);
            Some(daemon_info("2.7.2", 22))
        })
        .await
        .expect("lag recovery must return the provider's current info");

        assert_eq!(reads.load(Ordering::Acquire), 1);
        let mut state = RecoveryState::new(Some("2.7.1".to_string()), 0);
        assert!(state.live_version_requires_exit(&info.version));
    }

    proptest! {
        /// Exercise transition sequences instead of independent classifier
        /// inputs. Each byte selects a daemon reconciliation, explicit tool
        /// install, hosted switch, target observation, or version replacement.
        #[test]
        fn transition_sequences_preserve_incarnation_invariants(ops in prop::collection::vec(any::<u8>(), 1..200)) {
            let mut model = LoopModel {
                active: Some(ModelSession::Local(Some(1))),
                parked: vec![ModelSession::Local(Some(1)), ModelSession::Hosted],
                recovery_target: Some("/tmp/original.ipynb".to_string()),
                startup_version: 7,
                exited: false,
            };
            let mut live = Some(1u8);

            for op in ops {
                if model.exited {
                    break;
                }
                match op % 6 {
                    0 => model.reconcile(live, 7),
                    1 => {
                        live = Some(op.wrapping_add(1));
                        model.reconcile(live, 7);
                    }
                    2 => {
                        model.active = Some(ModelSession::Local(live));
                    }
                    3 => model.active = Some(ModelSession::Hosted),
                    4 => model.remember("550e8400-e29b-41d4-a716-446655440000"),
                    _ => model.reconcile(live, 8),
                }

                if !model.exited {
                    if let Some(ModelSession::Local(binding)) = &model.active {
                        // A tool install may precede reconciliation, but it is
                        // always stamped with the live incarnation.
                        prop_assert_eq!(*binding, live);
                    }
                    prop_assert!(model.parked.iter().any(|s| matches!(s, ModelSession::Hosted)));
                    prop_assert_ne!(model.recovery_target.as_deref(), Some("550e8400-e29b-41d4-a716-446655440000"));
                }
            }
        }
    }
}
