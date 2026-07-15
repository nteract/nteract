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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use runtimed_client::daemon_connection::{DaemonConnection, DaemonEvent};
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

use crate::cloud::{self, NotebookTarget};
use crate::session::{NotebookSession, SessionDropInfo, SessionDropReason};
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

/// What the watch loop should do in response to a `DaemonEvent`.
#[derive(Debug, PartialEq, Eq)]
enum WatchDecision {
    /// Exit the process with the given code (daemon upgraded).
    Exit(i32),
    /// Rejoin using the provided initial target (UUID or file path) from
    /// `NTERACT_MCP_REJOIN_NOTEBOOK` — for the restarted-child case.
    RejoinInitial(String),
    /// Rejoin using the current session's state — for reconnect or
    /// same-version restart while we already have a session.
    RejoinContinuation,
    /// Record that the daemon was lost. The watch loop uses this to
    /// gate `RejoinContinuation` — only after a disconnect.
    MarkDisconnected,
    /// Nothing to do.
    NoOp,
}

/// Classify a `DaemonEvent` into the action the watch loop should take.
///
/// `initial_target` is **not consumed** by `classify()`. The watch loop
/// is responsible for clearing it — either after a successful rejoin, or
/// when a tool call establishes a session first (making the handoff
/// stale). This ensures the target survives failed rejoin attempts and
/// can be retried on the next `Connected` event, but never overwrites a
/// session that the user explicitly switched to.
///
/// `was_disconnected` tracks whether the daemon connection was lost since
/// the last successful join. This prevents the 10-second heartbeat
/// `Connected` events from triggering spurious rejoins — only a
/// `Connected` event that follows an actual `Disconnected` triggers a
/// `RejoinContinuation`. Without this, every heartbeat creates a brief
/// 2→1 peer cycle that keeps the room alive indefinitely (#2088).
fn classify(
    event: &DaemonEvent,
    initial_target: &Option<String>,
    has_session: bool,
    was_disconnected: bool,
    disconnect_target: &Option<String>,
) -> WatchDecision {
    match event {
        DaemonEvent::Upgraded { previous, current } => {
            if previous.version != current.version {
                return WatchDecision::Exit(EXIT_DAEMON_UPGRADED);
            }
            // Same-version restart (new pid) always needs a rejoin —
            // the old peer connection is dead regardless of
            // was_disconnected (the daemon process recycled).
            if let Some(t) = initial_target.as_ref() {
                WatchDecision::RejoinInitial(t.clone())
            } else if has_session {
                WatchDecision::RejoinContinuation
            } else if let Some(t) = disconnect_target.as_ref() {
                // Session was cleared on disconnect to prevent tool
                // calls from hanging on a dead DocHandle. Rejoin
                // using the saved target.
                WatchDecision::RejoinInitial(t.clone())
            } else {
                WatchDecision::NoOp
            }
        }
        DaemonEvent::Connected { .. } => {
            // Initial target always takes priority (proxy hand-off).
            if let Some(t) = initial_target.as_ref() {
                return WatchDecision::RejoinInitial(t.clone());
            }
            // Only rejoin after a real disconnect, not on routine
            // heartbeat refreshes. DaemonConnection emits Connected
            // every HEARTBEAT_INTERVAL (10s); without this gate the
            // watch loop would reconnect every 10s, creating a brief
            // 2-peer spike that resets the eviction timer (#2088).
            if has_session && was_disconnected {
                WatchDecision::RejoinContinuation
            } else if !has_session && was_disconnected {
                // Session was cleared on disconnect to prevent tool
                // calls from hanging on a dead DocHandle. Rejoin
                // using the saved target.
                if let Some(t) = disconnect_target.as_ref() {
                    WatchDecision::RejoinInitial(t.clone())
                } else {
                    WatchDecision::NoOp
                }
            } else {
                WatchDecision::NoOp
            }
        }
        DaemonEvent::Disconnected => WatchDecision::MarkDisconnected,
    }
}

/// Clear daemon-disconnect state when a tool-established session made it stale.
///
/// Hosted sessions do not depend on the local daemon, so local daemon disconnects
/// should not stay latched while a hosted session survives. Local sessions still
/// preserve `was_disconnected` when it came from a lagged event with no saved
/// target; that path intentionally triggers a continuity rejoin.
fn clear_stale_disconnect_state_for_active_session(
    has_session: bool,
    has_local_session: bool,
    was_disconnected: &mut bool,
    disconnect_target: &mut Option<String>,
) -> bool {
    if !has_session {
        return false;
    }

    let mut cleared = false;

    if disconnect_target.is_some() {
        *disconnect_target = None;
        cleared = true;
        if *was_disconnected {
            *was_disconnected = false;
        }
    }

    if !has_local_session && *was_disconnected {
        *was_disconnected = false;
        cleared = true;
    }

    cleared
}

/// Run the watch loop to completion. Returns the exit code the caller
/// should use; 0 means the event stream closed cleanly.
pub async fn watch(
    daemon_conn: Arc<DaemonConnection>,
    socket_path: PathBuf,
    session: Arc<RwLock<Option<NotebookSession>>>,
    peer_label: Arc<RwLock<String>>,
    last_session_drop: Arc<RwLock<Option<SessionDropInfo>>>,
    parked_sessions: Arc<RwLock<HashMap<String, NotebookSession>>>,
    session_intent_epoch: Arc<AtomicU64>,
) -> i32 {
    let mut rx = daemon_conn.subscribe();
    let mut initial_target: Option<String> = std::env::var(REJOIN_ENV_VAR).ok();
    if initial_target.is_some() {
        info!("Seeded initial rejoin target from {REJOIN_ENV_VAR}");
    }

    // Track whether we've been through a Disconnected state.
    // `initial_target.is_some()` seeds this to true so the first
    // Connected event (which always fires on supervisor startup)
    // triggers the initial rejoin without requiring a prior disconnect.
    let mut was_disconnected = initial_target.is_some();

    // When a disconnect clears the session (to prevent tool calls from
    // hanging on a dead DocHandle), we stash the notebook target here so
    // the next Connected/Upgraded event can rejoin without requiring an
    // initial_target from the proxy.
    let mut disconnect_target: Option<String> = None;
    let mut observed_intent_epoch = session_intent_epoch.load(Ordering::Acquire);

    loop {
        let event = match rx.recv().await {
            Ok(ev) => ev,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!("Daemon event stream lagged, dropped {n} events");
                // Treat a lag as a potential disconnect — we may have
                // missed a Disconnected event in the dropped batch.
                was_disconnected = true;
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => return 0,
        };

        let (has_session, has_local_session) = {
            let guard = session.read().await;
            (
                guard.is_some(),
                guard.as_ref().is_some_and(|session| !session.is_hosted()),
            )
        };

        let current_intent_epoch = session_intent_epoch.load(Ordering::Acquire);
        if current_intent_epoch != observed_intent_epoch {
            info!(
                previous_epoch = observed_intent_epoch,
                current_epoch = current_intent_epoch,
                "Clearing automatic rejoin state after explicit session intent"
            );
            observed_intent_epoch = current_intent_epoch;
            initial_target = None;
            disconnect_target = None;
            was_disconnected = false;
        }

        // Once a tool call (connect_notebook / create_notebook) has
        // established a live session, the proxy's initial handoff target
        // is stale. Without this, a pending initial_target would win over
        // the user's active session on the next Connected/Upgraded event,
        // overwriting or clearing whatever notebook the user switched to.
        if has_session && initial_target.is_some() {
            info!("Clearing stale initial rejoin target (session already active)");
            initial_target = None;
        }

        // If a tool call re-established a session after a disconnect, or
        // a hosted session survived a local daemon disconnect, clear the
        // stale daemon disconnect state so it cannot trigger a later
        // continuity rejoin against a healthy tool-selected session.
        if clear_stale_disconnect_state_for_active_session(
            has_session,
            has_local_session,
            &mut was_disconnected,
            &mut disconnect_target,
        ) {
            info!("Clearing stale daemon disconnect state (session already active)");
        }

        match classify(
            &event,
            &initial_target,
            has_local_session,
            was_disconnected,
            &disconnect_target,
        ) {
            WatchDecision::Exit(code) => {
                if let DaemonEvent::Upgraded { previous, current } = &event {
                    info!(
                        "Daemon upgraded ({} → {}), exiting for proxy respawn",
                        previous.version, current.version
                    );
                }
                return code;
            }
            WatchDecision::RejoinInitial(target) => {
                info!("Performing initial rejoin to {target}");
                let ok = rejoin(
                    &socket_path,
                    &session,
                    &peer_label,
                    &last_session_drop,
                    Some(target),
                    &session_intent_epoch,
                    observed_intent_epoch,
                )
                .await;
                // Only clear the disconnect flag and consume the initial
                // target if rejoin succeeded or the session was explicitly
                // cleared (room evicted). If rejoin exhausted retries,
                // keep both was_disconnected=true and initial_target
                // intact so the next Connected event retries.
                if ok {
                    was_disconnected = false;
                    initial_target = None;
                    disconnect_target = None;
                }
            }
            WatchDecision::RejoinContinuation => {
                info!("Daemon reachable, rejoining notebook session");
                let ok = rejoin(
                    &socket_path,
                    &session,
                    &peer_label,
                    &last_session_drop,
                    None,
                    &session_intent_epoch,
                    observed_intent_epoch,
                )
                .await;
                if ok {
                    was_disconnected = false;
                    disconnect_target = None;
                }
            }
            WatchDecision::MarkDisconnected => {
                was_disconnected = true;
                // Immediately clear the session to prevent tool calls from
                // hanging on a dead DocHandle while we wait for the daemon
                // to come back. Save the notebook target so we can rejoin
                // when the daemon reconnects.
                let old_session = {
                    let mut guard = session.write().await;
                    if guard.as_ref().is_some_and(NotebookSession::is_hosted) {
                        None
                    } else {
                        guard.take().map(|session| {
                            (session.notebook_id.clone(), session.notebook_path.clone())
                        })
                    }
                };
                if let Some((notebook_id, notebook_path)) = old_session {
                    info!(
                        "Clearing session for disconnected daemon (notebook: {notebook_id}); \
                         will rejoin on reconnect"
                    );
                    // Stash the target for rejoin. File-backed notebooks
                    // use the file path; ephemeral notebooks use the UUID.
                    disconnect_target =
                        Some(notebook_path.clone().unwrap_or_else(|| notebook_id.clone()));
                    *last_session_drop.write().await = Some(SessionDropInfo {
                        reason: SessionDropReason::Disconnected,
                        notebook_id,
                        notebook_path: notebook_path.clone(),
                        rejoin_target: disconnect_target.clone(),
                    });
                }
                // Also clear parked local sessions — their DocHandles are dead
                // too. Hosted parked sessions do not depend on this daemon.
                {
                    let mut parked = parked_sessions.write().await;
                    let before = parked.len();
                    parked.retain(|_, session| session.is_hosted());
                    let removed = before.saturating_sub(parked.len());
                    if removed > 0 {
                        info!(
                            "Clearing {} parked local session(s) on daemon disconnect",
                            removed
                        );
                    }
                }
            }
            WatchDecision::NoOp => {}
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
/// Returns `true` if the rejoin succeeded or the session was explicitly
/// cleared (room evicted). Returns `false` if retries were exhausted
/// without success — the caller should keep `was_disconnected` true so
/// the next `Connected` event retries.
async fn rejoin(
    socket_path: &Path,
    session: &Arc<RwLock<Option<NotebookSession>>>,
    peer_label: &Arc<RwLock<String>>,
    last_session_drop: &Arc<RwLock<Option<SessionDropInfo>>>,
    override_target: Option<String>,
    session_intent_epoch: &Arc<AtomicU64>,
    expected_intent_epoch: u64,
) -> bool {
    if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
        return true;
    }
    if let Some(target) = override_target.as_deref() {
        match cloud::parse_connect_target(Some(target), None, None, None) {
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
    }

    let (notebook_id, notebook_path) = match override_target {
        Some(target) if looks_like_uuid(&target) => (target, None),
        Some(target) => {
            // Treat as file path. We'll learn the real notebook_id from
            // connect_open's response.
            (target.clone(), Some(target))
        }
        None => {
            let guard = session.read().await;
            match guard.as_ref() {
                Some(s) => (s.notebook_id.clone(), s.notebook_path.clone()),
                None => return true, // No session to rejoin — not a failure
            }
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

                let new_session =
                    NotebookSession::local(handle, new_notebook_id, notebook_path.clone());
                // Hold the publication lock across the check/install. Any
                // active session is authoritative, even for the same UUID:
                // an explicit tool activation may carry retained projection
                // heads/generation that a background rejoin must not erase.
                let mut guard = session.write().await;
                if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
                    info!("Dropping automatic rejoin superseded by explicit disconnect");
                    return true;
                }
                if let Some(existing) = guard.as_ref() {
                    info!(
                        "Rejoin target {} superseded by active session {}; \
                         dropping rejoined connection",
                        new_session.notebook_id, existing.notebook_id
                    );
                    return true;
                }
                *guard = Some(new_session);
                info!("Rejoined notebook session ({new_cell_count} cells)");
                return true;
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
                let mut guard = session.write().await;
                if session_intent_epoch.load(Ordering::Acquire) != expected_intent_epoch {
                    info!("Dropping hosted rejoin superseded by explicit disconnect");
                    return true;
                }
                if let Some(existing) = guard.as_ref() {
                    info!(
                        "Hosted rejoin target {target} superseded by active session {}; \
                         dropping rejoined connection",
                        existing.session_key()
                    );
                    return true;
                }
                *guard = Some(new_session);
                info!("Rejoined hosted notebook session {target}");
                return true;
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
    use chrono::Utc;
    use runtimed_client::singleton::DaemonInfo;

    fn info_with(version: &str, pid: u32) -> DaemonInfo {
        DaemonInfo {
            endpoint: "/tmp/test.sock".to_string(),
            pid,
            version: version.to_string(),
            started_at: Utc::now(),
            blob_port: None,
            execution_store_dir: None,
            worktree_path: None,
            workspace_description: None,
        }
    }

    #[test]
    fn version_change_triggers_exit() {
        let event = DaemonEvent::Upgraded {
            previous: info_with("1.0.0", 100),
            current: info_with("1.1.0", 200),
        };
        let initial = None;
        let disconnect = None;
        // Version change exits regardless of was_disconnected.
        assert_eq!(
            classify(&event, &initial, false, false, &disconnect),
            WatchDecision::Exit(EXIT_DAEMON_UPGRADED)
        );
    }

    #[test]
    fn same_version_restart_triggers_continuation_rejoin() {
        // Upgraded (same-version) always triggers rejoin — the daemon
        // process recycled so the old peer is dead. was_disconnected
        // is irrelevant for Upgraded events.
        let event = DaemonEvent::Upgraded {
            previous: info_with("1.0.0", 100),
            current: info_with("1.0.0", 200),
        };
        let initial = None;
        let disconnect = None;
        assert_eq!(
            classify(&event, &initial, true, false, &disconnect),
            WatchDecision::RejoinContinuation
        );
    }

    #[test]
    fn same_version_restart_without_session_is_noop() {
        let event = DaemonEvent::Upgraded {
            previous: info_with("1.0.0", 100),
            current: info_with("1.0.0", 200),
        };
        let initial = None;
        let disconnect = None;
        assert_eq!(
            classify(&event, &initial, false, false, &disconnect),
            WatchDecision::NoOp
        );
    }

    #[test]
    fn connected_returns_initial_target_without_consuming() {
        let event = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = Some("abc-uuid".to_string());
        let disconnect = None;
        // Initial target triggers RejoinInitial but classify() does NOT
        // consume it — the watch loop consumes after successful rejoin.
        assert_eq!(
            classify(&event, &initial, false, false, &disconnect),
            WatchDecision::RejoinInitial("abc-uuid".to_string())
        );
        assert!(
            initial.is_some(),
            "classify must not consume initial target"
        );

        // With initial_target still present, next Connected still returns
        // RejoinInitial (retry semantics — will keep trying until the
        // watch loop clears it after a successful rejoin).
        assert_eq!(
            classify(&event, &initial, false, false, &disconnect),
            WatchDecision::RejoinInitial("abc-uuid".to_string())
        );
    }

    #[test]
    fn cleared_initial_target_falls_through() {
        let event = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        // After the watch loop clears initial_target (on successful rejoin),
        // subsequent Connected events without session/disconnect are NoOp.
        let initial: Option<String> = None;
        let disconnect = None;
        assert_eq!(
            classify(&event, &initial, false, false, &disconnect),
            WatchDecision::NoOp
        );
    }

    #[test]
    fn disconnected_marks_disconnected() {
        let initial = Some("abc".to_string());
        let disconnect = None;
        assert_eq!(
            classify(
                &DaemonEvent::Disconnected,
                &initial,
                true,
                false,
                &disconnect
            ),
            WatchDecision::MarkDisconnected
        );
        assert!(
            initial.is_some(),
            "disconnect must not consume initial target"
        );
    }

    #[test]
    fn uuid_target_detected() {
        assert!(looks_like_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!looks_like_uuid("/tmp/notebook.ipynb"));
        assert!(!looks_like_uuid("notebook.ipynb"));
        assert!(!looks_like_uuid("relative/path"));
    }

    /// Connected events that are just heartbeat refreshes (no prior
    /// disconnect) must NOT trigger RejoinContinuation. This is the
    /// primary fix for #2088 — without this gate, every 10s heartbeat
    /// Connected event would create a brief 2→1 peer cycle that resets
    /// the eviction timer, keeping the room alive indefinitely.
    #[test]
    fn heartbeat_connected_does_not_rejoin() {
        let event = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = None;
        let disconnect = None;

        // has_session=true but was_disconnected=false (steady-state
        // heartbeat) → must be NoOp, not RejoinContinuation.
        assert_eq!(
            classify(&event, &initial, true, false, &disconnect),
            WatchDecision::NoOp,
            "heartbeat Connected must not trigger rejoin"
        );
    }

    /// Connected events after a lagged disconnect should trigger
    /// RejoinContinuation because the peer connection was actually lost.
    #[test]
    fn lagged_connected_after_disconnect_triggers_rejoin_continuation() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = None;
        let disconnect = None;

        // After disconnect, Connected should trigger rejoin while the session
        // is still live.
        assert_eq!(
            classify(&connected, &initial, true, true, &disconnect),
            WatchDecision::RejoinContinuation
        );
    }

    /// After an ephemeral notebook is evicted and the session is cleared
    /// WITHOUT a disconnect_target, subsequent Connected/Upgraded events
    /// should produce NoOp (not RejoinContinuation). This regression test
    /// verifies the fix for #2088 — without clearing the session, the
    /// watch loop would reconnect every 10s, briefly creating peers and
    /// preventing proper room eviction.
    #[test]
    fn cleared_session_stops_continuation_rejoins() {
        let event = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = None;
        let disconnect = None;

        // With has_session=true AND was_disconnected=true, we get
        // RejoinContinuation.
        assert_eq!(
            classify(&event, &initial, true, true, &disconnect),
            WatchDecision::RejoinContinuation
        );

        // After the session is cleared (has_session=false) and no
        // disconnect_target, same event is NoOp even with
        // was_disconnected=true. This is the eviction case: the room
        // is gone, so there's nothing to rejoin.
        assert_eq!(
            classify(&event, &initial, false, true, &disconnect),
            WatchDecision::NoOp
        );

        // Same for Upgraded (same-version restart).
        let upgraded = DaemonEvent::Upgraded {
            previous: info_with("1.0.0", 100),
            current: info_with("1.0.0", 200),
        };
        assert_eq!(
            classify(&upgraded, &initial, false, false, &disconnect),
            WatchDecision::NoOp
        );
    }

    /// Once a tool call (connect_notebook / create_notebook) establishes a
    /// session, the proxy's initial handoff target becomes stale. The watch
    /// loop clears initial_target before calling classify() when
    /// has_session=true, so a heartbeat Connected with a stale handoff
    /// yields RejoinContinuation (if was_disconnected) or NoOp — never
    /// RejoinInitial that would overwrite the user's active notebook.
    #[test]
    fn stale_handoff_cleared_when_session_exists() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let disconnect = None;

        // Simulate: proxy set initial_target, but before the first
        // Connected event, a connect_notebook tool call established a
        // session. The watch loop clears initial_target because
        // has_session=true.
        let initial_after_clear: Option<String> = None;

        // With session active and was_disconnected=false (steady state),
        // heartbeat is NoOp — does NOT rejoin to the stale target.
        assert_eq!(
            classify(&connected, &initial_after_clear, true, false, &disconnect),
            WatchDecision::NoOp,
            "stale handoff must not override active session"
        );

        // With session active and was_disconnected=true (daemon bounced),
        // RejoinContinuation uses the current session — not the stale target.
        assert_eq!(
            classify(&connected, &initial_after_clear, true, true, &disconnect),
            WatchDecision::RejoinContinuation,
            "should rejoin current session, not stale target"
        );
    }

    /// When rejoin fails (returns false), initial_target must survive for
    /// retry on the next Connected event. This test simulates the classify
    /// behavior: with initial_target present, classify always returns
    /// RejoinInitial — it never consumes the target. The watch loop only
    /// clears it after successful rejoin.
    #[test]
    fn failed_initial_rejoin_preserves_target_for_retry() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let disconnect = None;

        // Simulate the watch loop's initial_target across multiple events.
        let mut initial_target = Some("target-uuid".to_string());

        // First Connected → RejoinInitial.
        assert_eq!(
            classify(&connected, &initial_target, false, true, &disconnect),
            WatchDecision::RejoinInitial("target-uuid".to_string())
        );

        // Simulate rejoin failure (watch loop does NOT clear initial_target).
        // was_disconnected stays true, initial_target stays Some.

        // Second Connected → still RejoinInitial (retry).
        assert_eq!(
            classify(&connected, &initial_target, false, true, &disconnect),
            WatchDecision::RejoinInitial("target-uuid".to_string())
        );

        // Simulate rejoin success (watch loop clears initial_target).
        initial_target = None;

        // Third Connected without session → NoOp.
        assert_eq!(
            classify(&connected, &initial_target, false, false, &disconnect),
            WatchDecision::NoOp
        );
    }

    /// When the session is cleared on disconnect (to prevent tool calls
    /// from hanging on a dead DocHandle), the saved disconnect_target
    /// enables automatic rejoin when the daemon reconnects.
    #[test]
    fn disconnect_target_triggers_rejoin_on_reconnect() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = None;
        let disconnect_target = Some("/tmp/notebook.ipynb".to_string());

        // Session cleared (has_session=false), was_disconnected=true,
        // disconnect_target present → RejoinInitial with the saved path.
        assert_eq!(
            classify(&connected, &initial, false, true, &disconnect_target),
            WatchDecision::RejoinInitial("/tmp/notebook.ipynb".to_string())
        );
    }

    /// Same-version daemon restart with a disconnect_target (session was
    /// cleared on disconnect) triggers RejoinInitial with the saved target.
    #[test]
    fn disconnect_target_triggers_rejoin_on_upgraded() {
        let upgraded = DaemonEvent::Upgraded {
            previous: info_with("1.0.0", 100),
            current: info_with("1.0.0", 200),
        };
        let initial = None;
        let disconnect_target = Some("some-uuid".to_string());

        // Session cleared, disconnect_target present → RejoinInitial.
        assert_eq!(
            classify(&upgraded, &initial, false, false, &disconnect_target),
            WatchDecision::RejoinInitial("some-uuid".to_string())
        );
    }

    /// When both initial_target and disconnect_target are present,
    /// initial_target takes priority (it's the proxy's handoff).
    #[test]
    fn initial_target_takes_priority_over_disconnect_target() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = Some("proxy-target".to_string());
        let disconnect_target = Some("disconnect-target".to_string());

        assert_eq!(
            classify(&connected, &initial, false, true, &disconnect_target),
            WatchDecision::RejoinInitial("proxy-target".to_string())
        );
    }

    /// After a successful rejoin clears disconnect_target, heartbeats
    /// should not trigger rejoins (prevents the #2088 regression).
    #[test]
    fn cleared_disconnect_target_prevents_spurious_rejoins() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = None;
        let disconnect = None; // cleared after successful rejoin

        // Session re-established (has_session=true), steady-state heartbeat.
        assert_eq!(
            classify(&connected, &initial, true, false, &disconnect),
            WatchDecision::NoOp,
            "cleared disconnect target must not trigger rejoin"
        );
    }

    #[test]
    fn hosted_session_clears_stale_daemon_disconnect_state() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = None;
        let mut was_disconnected = true;
        let mut disconnect_target = Some("550e8400-e29b-41d4-a716-446655440000".to_string());

        assert!(clear_stale_disconnect_state_for_active_session(
            true,
            false,
            &mut was_disconnected,
            &mut disconnect_target,
        ));
        assert!(!was_disconnected);
        assert_eq!(disconnect_target, None);

        // If the user later opens a local notebook, the old daemon
        // disconnect must not force a continuity rejoin that replaces the
        // healthy tool-selected local peer.
        assert_eq!(
            classify(
                &connected,
                &initial,
                true,
                was_disconnected,
                &disconnect_target
            ),
            WatchDecision::NoOp
        );
    }

    #[test]
    fn local_session_with_disconnect_target_clears_rejoin_latch() {
        let connected = DaemonEvent::Connected {
            info: info_with("1.0.0", 100),
        };
        let initial = None;
        let mut was_disconnected = true;
        let mut disconnect_target = Some("/tmp/previous.ipynb".to_string());

        assert!(clear_stale_disconnect_state_for_active_session(
            true,
            true,
            &mut was_disconnected,
            &mut disconnect_target,
        ));
        assert!(!was_disconnected);
        assert_eq!(disconnect_target, None);

        assert_eq!(
            classify(
                &connected,
                &initial,
                true,
                was_disconnected,
                &disconnect_target
            ),
            WatchDecision::NoOp
        );
    }
}
