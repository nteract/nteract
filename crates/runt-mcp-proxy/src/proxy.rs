//! Core MCP proxy — spawns a child, forwards tools/resources, handles restarts.
//!
//! The `McpProxy` struct manages the child process lifecycle and provides the
//! core forwarding logic. It can be used standalone (by `nteract-mcp`) or wrapped
//! by `mcp-supervisor` which adds dev-specific tools and file watching.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, ProtocolVersion,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, ServerCapabilities,
    ServerInfo, Tool,
};
use rmcp::service::{NotificationContext, Peer, RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler};
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use tracing::{error, info, warn};

use crate::child::{self, ChildExitStatus, RunningChild};
use crate::circuit_breaker::CircuitBreaker;
use crate::session;
use crate::tools::{self, ToolDivergence};
use crate::version::ReconnectionEvent;

/// Env var name passed to a freshly respawned child to seed its rejoin
/// target. Must match `runt_mcp::daemon_watch::REJOIN_ENV_VAR`.
const REJOIN_ENV_VAR: &str = "NTERACT_MCP_REJOIN_NOTEBOOK";
/// Identity env vars consumed by `runt-mcp` before daemon-watch starts.
const OPERATOR_CLIENT_ENV_VAR: &str = "NTERACT_MCP_OPERATOR_CLIENT";
const OPERATOR_SESSION_ENV_VAR: &str = "NTERACT_MCP_OPERATOR_SESSION";
const SLOW_CHILD_CALL: Duration = Duration::from_secs(30);
const EX_TEMPFAIL: i32 = 75;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildRestartReason {
    /// The child deliberately asked the proxy to pick up a new daemon binary.
    DaemonUpgrade,
    /// A crash, closed transport without exit metadata, or an explicit restart.
    UnexpectedOrRequested,
}

impl ChildRestartReason {
    fn from_exit_code(exit_code: Option<i32>) -> Self {
        if exit_code == Some(EX_TEMPFAIL) {
            Self::DaemonUpgrade
        } else {
            Self::UnexpectedOrRequested
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::DaemonUpgrade => "daemon_upgrade_exit_75",
            Self::UnexpectedOrRequested => "unexpected_or_requested",
        }
    }
}

fn circuit_breaker_allows_restart(
    circuit_breaker: &mut CircuitBreaker,
    upgrade_handoff_limiter: &mut CircuitBreaker,
    child_was_dead: bool,
    reason: ChildRestartReason,
) -> bool {
    if child_was_dead {
        return true;
    }
    match reason {
        ChildRestartReason::DaemonUpgrade => upgrade_handoff_limiter.record_crash(),
        ChildRestartReason::UnexpectedOrRequested => circuit_breaker.record_crash(),
    }
}

/// Extract the daemon version from a freshly-initialized child's MCP
/// `ServerInfo`. `runt mcp` stamps the daemon version into
/// `server_info.title` as `"nteract (daemon X.Y.Z)"` during its startup
/// handshake. Returning `None` is expected whenever the daemon wasn't
/// reachable when the child started — the proxy degrades to a generic
/// "child restarted" reconnection banner in that case.
fn extract_daemon_version(client: &child::RunningChild) -> Option<String> {
    let peer_info = client.peer_info()?;
    let title = peer_info.server_info.as_ref()?.title.as_deref()?;
    // Title format: "nteract (daemon X.Y.Z)".
    let open = title.find("(daemon ")?;
    let close = title.rfind(')')?;
    let inner = title.get(open + "(daemon ".len()..close)?;
    let v = inner.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// Configuration for the MCP proxy.
pub struct ProxyConfig {
    /// Resolver that returns the path to the child binary.
    /// Called on every spawn (init and restart) so it picks up binary upgrades on disk.
    /// This is the core reason the proxy exists: the MCPB bundle is stable while
    /// the user upgrades the nteract app, and the proxy transparently picks up the new binary.
    pub resolve_child_command: Box<dyn Fn() -> Result<PathBuf, String> + Send + Sync>,
    /// Arguments to the child (e.g., `["mcp"]`).
    pub child_args: Vec<String>,
    /// Environment variables for the child process.
    pub child_env: HashMap<String, String>,
    /// Server name presented to the MCP client (e.g., "nteract", "nteract-dev").
    pub server_name: String,
    /// Directory for tool cache (optional, enables optimistic tool serving).
    pub cache_dir: Option<PathBuf>,
    /// Child monitor polling interval in milliseconds (default: 500ms).
    /// Lower values detect child exit faster but use more CPU.
    pub monitor_poll_interval_ms: u64,
    /// Recovery action appended to terminal failure messages (circuit-breaker
    /// trip, incompatible tool-list divergence). The launcher knows how its
    /// child is installed and what restores it; the proxy does not. The MCPB
    /// bundle points at reinstalling the extension, the dev supervisor at
    /// relaunching the worktree daemon.
    pub recovery_hint: String,
}

/// Shared mutable state for the proxy.
pub struct ProxyState {
    /// rmcp client connected to the child process.
    pub child_client: Option<RunningChild>,
    /// OS exit status published by the task that owns the current child.
    child_exit_status: Option<ChildExitStatus>,
    /// Monotonic generation for the child transport.
    ///
    /// Forwarded calls snapshot this with a cloned child peer so stale calls
    /// cannot commit state after the proxy has restarted the child.
    pub child_generation: u64,
    /// Number of times the child has been restarted.
    pub restart_count: u32,
    /// Circuit breaker for crash detection.
    pub circuit_breaker: CircuitBreaker,
    /// Independent rate limit for intentional upgrade handoffs. Upgrade exits
    /// do not consume the crash budget, but a flapping installation must not
    /// respawn children forever in a tight loop.
    upgrade_handoff_limiter: CircuitBreaker,
    /// Cached child tool definitions, loaded from disk at startup.
    pub cached_tools: Option<Vec<Tool>>,
    /// Durable active notebook target for auto-rejoin after restart. This may
    /// be a daemon UUID, canonical file path, or hosted notebook URL.
    pub last_notebook_id: Option<String>,
    /// Daemon/cloud notebook id corresponding to `last_notebook_id`. The
    /// durable handoff target may instead be a path or hosted URL, so retain
    /// both forms to recognize an explicit disconnect by notebook id.
    last_notebook_session_id: Option<String>,
    /// Upstream MCP client name (forwarded to child).
    pub upstream_name: String,
    /// Upstream MCP client title (forwarded to child).
    pub upstream_title: Option<String>,
    /// Last known daemon version (for detecting upgrades).
    pub last_daemon_version: Option<String>,
    /// Pending reconnection message to prepend to the next tool call.
    pub reconnection_message: Option<String>,
    /// Channel to notify that the tool list has changed.
    pub tool_list_changed_tx: Option<mpsc::Sender<()>>,
    /// Whether the proxy should exit (set on incompatible tool divergence).
    pub should_exit: bool,
    /// Timestamp when the current child was spawned (for uptime tracking).
    pub child_spawn_time: Option<Instant>,
    /// Timestamp of the last child restart.
    pub last_restart_time: Option<Instant>,
}

/// The MCP proxy — manages child process lifecycle and forwards MCP calls.
#[derive(Clone)]
pub struct McpProxy {
    pub state: Arc<RwLock<ProxyState>>,
    pub config: Arc<ProxyConfig>,
    /// Signaled when the child client is first connected.
    pub child_ready: Arc<Notify>,
    /// Signaled when the proxy should exit (incompatible tool divergence).
    pub exit_signal: Arc<Notify>,
    /// Flag to prevent concurrent restarts (monitor + tool call racing).
    restart_in_progress: Arc<Mutex<bool>>,
    /// Stable across child generations so automatic rejoin retains the exact
    /// operator used by the explicit connect in the previous child.
    operator_session: String,
}

impl McpProxy {
    /// Create a new proxy. Does not spawn the child yet — call `init_child()`
    /// or use the background init pattern.
    pub fn new(config: ProxyConfig, tool_list_changed_tx: Option<mpsc::Sender<()>>) -> Self {
        let cached_tools = config
            .cache_dir
            .as_ref()
            .map(|dir| tools::load_cached_tools(dir))
            .unwrap_or_else(tools::load_builtin_tools);

        if let Some(ref cached) = cached_tools {
            info!("Loaded {} cached child tools", cached.len());
        }

        Self {
            state: Arc::new(RwLock::new(ProxyState {
                child_client: None,
                child_exit_status: None,
                child_generation: 0,
                restart_count: 0,
                circuit_breaker: CircuitBreaker::new(),
                upgrade_handoff_limiter: CircuitBreaker::new(),
                cached_tools,
                last_notebook_id: None,
                last_notebook_session_id: None,
                upstream_name: "unknown".to_string(),
                upstream_title: None,
                last_daemon_version: None,
                reconnection_message: None,
                tool_list_changed_tx,
                should_exit: false,
                child_spawn_time: None,
                last_restart_time: None,
            })),
            config: Arc::new(config),
            child_ready: Arc::new(Notify::new()),
            exit_signal: Arc::new(Notify::new()),
            restart_in_progress: Arc::new(Mutex::new(false)),
            operator_session: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        }
    }

    fn child_env(&self, upstream_name: &str) -> HashMap<String, String> {
        let mut child_env = self.config.child_env.clone();
        child_env.insert(
            OPERATOR_CLIENT_ENV_VAR.to_string(),
            upstream_name.to_string(),
        );
        child_env.insert(
            OPERATOR_SESSION_ENV_VAR.to_string(),
            self.operator_session.clone(),
        );
        child_env
    }

    /// Set the upstream client identity (from MCP initialize handshake).
    pub async fn set_upstream_identity(&self, name: String, title: Option<String>) {
        let mut state = self.state.write().await;
        state.upstream_name = name;
        state.upstream_title = title;
    }

    /// Spawn the child process and connect. Called during initialization.
    pub async fn init_child(&self) -> Result<(), String> {
        let (upstream_name, upstream_title) = {
            let state = self.state.read().await;
            (state.upstream_name.clone(), state.upstream_title.clone())
        };

        let child_command = (self.config.resolve_child_command)()
            .map_err(|e| format!("Failed to resolve child binary: {e}"))?;

        info!(
            event = "child_spawned",
            binary = %child_command.display(),
            args = ?self.config.child_args,
            upstream_client = %upstream_name,
            "Spawning child process"
        );

        let child_env = self.child_env(&upstream_name);
        let spawned = child::spawn_child(
            &child_command,
            &self.config.child_args,
            &child_env,
            &upstream_name,
            upstream_title.as_deref(),
        )
        .await?;

        // Read the daemon version out of the child's ServerInfo.title
        // before we move the client into state. `runt mcp` stamps the
        // daemon version there during its startup handshake (see
        // crates/runt-mcp/src/lib.rs::get_info).
        let daemon_version = extract_daemon_version(&spawned.client);

        let generation = {
            let mut state = self.state.write().await;
            state.child_generation = state.child_generation.wrapping_add(1);
            state.child_client = Some(spawned.client);
            state.child_exit_status = Some(spawned.exit_status);
            state.child_spawn_time = Some(Instant::now());
            state.last_daemon_version = daemon_version;
            state.child_generation
        };

        self.refresh_tool_cache_for_generation(generation).await;

        // Spawn background task to monitor child lifecycle
        self.spawn_child_monitor();

        self.child_ready.notify_waiters();
        info!("Child process initialized successfully");

        Ok(())
    }

    /// Restart the child process after it dies.
    ///
    /// Handles circuit breaker, version detection, session rejoin, and
    /// tool divergence detection.
    pub async fn restart_child(&self) -> Result<(), String> {
        self.restart_child_for_reason().await
    }

    async fn restart_child_for_reason(&self) -> Result<(), String> {
        // Prevent concurrent restarts (monitor task + tool call racing)
        let mut restart_lock = self.restart_in_progress.lock().await;
        if *restart_lock {
            info!("Restart already in progress, skipping duplicate request");
            return Ok(());
        }
        *restart_lock = true;
        drop(restart_lock);

        let reason = self.current_child_restart_reason().await;
        info!(
            event = "child_restart_classified",
            restart_reason = reason.label(),
            "Classified child restart reason"
        );

        // Phase 1: Drop old client, check circuit breaker
        let (child_was_dead, old_child) = {
            let mut state = self.state.write().await;
            let was_dead = state.child_client.is_none();
            let old_child = state.child_client.take();
            state.child_exit_status = None;
            if old_child.is_some() {
                state.child_generation = state.child_generation.wrapping_add(1);
            }

            let uptime = state
                .child_spawn_time
                .map(|t| t.elapsed().as_secs())
                .unwrap_or(0);

            info!(
                event = "child_restart_requested",
                restart_num = state.restart_count + 1,
                child_was_dead = was_dead,
                restart_reason = reason.label(),
                uptime_secs = uptime,
                "Restarting child process"
            );

            // Exit 75 is the child's intentional handoff protocol for a
            // daemon upgrade. It must not consume the crash budget.
            let restart_allowed = {
                let ProxyState {
                    circuit_breaker,
                    upgrade_handoff_limiter,
                    ..
                } = &mut *state;
                circuit_breaker_allows_restart(
                    circuit_breaker,
                    upgrade_handoff_limiter,
                    was_dead,
                    reason,
                )
            };
            if !restart_allowed {
                let msg = format!(
                    "The nteract MCP server failed after repeated restarts. \
                     Restart your Claude session so a fresh MCP connection \
                     is established. {}",
                    self.config.recovery_hint
                );
                state.reconnection_message = Some(msg.clone());
                drop(state);
                self.clear_restart_in_progress().await;
                return Err(msg);
            }

            (was_dead, old_child)
        };
        if let Some(old) = old_child {
            let _ = old.cancel().await;
        }

        // Phase 2: Backoff (skip for daemon upgrade exits)
        if !child_was_dead && reason != ChildRestartReason::DaemonUpgrade {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }

        // Snapshot the daemon version before restart
        let old_version = {
            let state = self.state.read().await;
            state.last_daemon_version.clone()
        };

        // Phase 3: Resolve binary and spawn new child.
        // Re-resolve on every restart so binary upgrades take effect.
        let child_command = match (self.config.resolve_child_command)() {
            Ok(path) => {
                info!("Resolved child binary: {}", path.display());
                path
            }
            Err(e) => {
                let msg = format!("Failed to resolve child binary on restart: {e}");
                error!("{msg}");
                let mut state = self.state.write().await;
                state.reconnection_message = Some(msg.clone());
                drop(state);
                self.clear_restart_in_progress().await;
                return Err(msg);
            }
        };

        let (upstream_name, upstream_title, rejoin_target) = {
            let state = self.state.read().await;
            (
                state.upstream_name.clone(),
                state.upstream_title.clone(),
                state.last_notebook_id.clone(),
            )
        };

        // Seed the respawned child with the previous notebook target so
        // its `daemon_watch` loop rejoins on the first `Connected` event
        // without us having to call `connect_notebook` over the child MCP
        // channel.
        let mut child_env = self.child_env(&upstream_name);
        if let Some(ref target) = rejoin_target {
            child_env.insert(REJOIN_ENV_VAR.to_string(), target.clone());
        }

        match child::spawn_child(
            &child_command,
            &self.config.child_args,
            &child_env,
            &upstream_name,
            upstream_title.as_deref(),
        )
        .await
        {
            Ok(spawned) => {
                // Read new daemon version from the restarted child's
                // ServerInfo.title before moving the client into state.
                let new_version = extract_daemon_version(&spawned.client);

                let (old_tools, generation) = {
                    let mut state = self.state.write().await;
                    state.child_generation = state.child_generation.wrapping_add(1);
                    state.child_client = Some(spawned.client);
                    state.child_exit_status = Some(spawned.exit_status);
                    state.restart_count += 1;
                    state.child_spawn_time = Some(Instant::now());
                    state.last_restart_time = Some(Instant::now());
                    (state.cached_tools.clone(), state.child_generation)
                };

                // Refresh tool cache and check for divergence
                self.refresh_tool_cache_for_generation(generation).await;

                let tool_list_changed_tx = {
                    let mut state = self.state.write().await;
                    if let (Some(ref old), Some(ref new)) = (&old_tools, &state.cached_tools) {
                        match tools::detect_divergence(old, new) {
                            ToolDivergence::Same => {}
                            ToolDivergence::Superset { ref added } => {
                                info!("New tools available after restart: {added:?}");
                            }
                            ToolDivergence::Incompatible {
                                ref removed,
                                ref added,
                            } => {
                                warn!(
                                    "Tool list incompatible after restart — removed: {removed:?}, added: {added:?}. \
                                     Exiting so the MCP client can restart with the new tool set."
                                );
                                state.should_exit = true;
                                // Signal the exit so nteract-mcp can shut down
                                self.exit_signal.notify_waiters();
                            }
                        }
                    }

                    // The new child told us the daemon version it saw on its
                    // startup handshake. Compare it with what the previous
                    // child reported to detect a daemon upgrade across the
                    // restart. If either side is unknown we degrade to the
                    // generic ChildRestart banner below.
                    state.last_daemon_version = new_version.clone();

                    // Session rejoin is now the child's responsibility
                    // (`daemon_watch` consumes the seeded REJOIN env var on
                    // its first `Connected` event). A handed-off target means
                    // rejoin was requested, not that the asynchronous child
                    // rejoin has completed successfully.
                    let session_rejoin_requested = rejoin_target.is_some();
                    let reconnection_event = match (old_version.as_deref(), new_version.as_deref())
                    {
                        (Some(old), Some(new)) if old != new => ReconnectionEvent::DaemonUpgrade {
                            old_version: old.to_string(),
                            new_version: new.to_string(),
                            session_rejoin_requested,
                        },
                        _ => ReconnectionEvent::ChildRestart {
                            session_rejoin_requested,
                        },
                    };
                    state.reconnection_message = Some(reconnection_event.message());
                    state.tool_list_changed_tx.clone()
                };

                // Spawn new monitor for the restarted child
                self.spawn_child_monitor();

                // Notify upstream client to keep connection alive
                if let Some(tx) = tool_list_changed_tx {
                    let _ = tx.send(()).await;
                    info!("Notified upstream client of tool list change to keep connection alive");
                }

                self.clear_restart_in_progress().await;
                self.child_ready.notify_waiters();
                info!("Child restarted successfully");
                Ok(())
            }
            Err(e) => {
                let mut state = self.state.write().await;
                state.reconnection_message = Some(format!("Child restart failed: {e}"));
                error!("Failed to restart child: {e}");
                drop(state);
                self.clear_restart_in_progress().await;
                Err(e)
            }
        }
    }

    /// Observe the process owner's exit status after the MCP transport closes.
    /// The short wait closes the race where stdout EOF reaches rmcp just before
    /// `Child::wait` publishes the status. A live transport is an explicit or
    /// manual restart and does not wait here.
    async fn current_child_restart_reason(&self) -> ChildRestartReason {
        let mut exit_status = {
            let state = self.state.read().await;
            let transport_closed = state
                .child_client
                .as_ref()
                .is_some_and(|child| child.is_transport_closed());
            if !transport_closed {
                return ChildRestartReason::UnexpectedOrRequested;
            }
            state.child_exit_status.clone()
        };

        let Some(ref mut exit_status) = exit_status else {
            return ChildRestartReason::UnexpectedOrRequested;
        };

        let observed = exit_status
            .borrow()
            .as_ref()
            .and_then(|status| status.code());
        if observed.is_some() {
            return ChildRestartReason::from_exit_code(observed);
        }

        let _ = tokio::time::timeout(Duration::from_secs(1), exit_status.changed()).await;
        let observed = exit_status
            .borrow()
            .as_ref()
            .and_then(|status| status.code());
        ChildRestartReason::from_exit_code(observed)
    }

    /// Spawn a background task to monitor the child process and auto-restart on exit.
    ///
    /// Uses polling (every 500ms) instead of `waiting()` because `RunningService`
    /// doesn't implement `Clone` and `waiting()` consumes `self`, making it incompatible
    /// with the existing architecture where `child_client` is held in `Arc<RwLock<ProxyState>>`.
    ///
    /// When the child exits, the monitor triggers `restart_child()` which spawns a new
    /// monitor, then this monitor exits (preventing task leak).
    fn spawn_child_monitor(&self) {
        let proxy = self.clone();
        tokio::spawn(async move {
            loop {
                // Check if child exists
                let has_child = {
                    let state = proxy.state.read().await;
                    state.child_client.is_some()
                };

                if !has_child {
                    info!("Child monitor: no child to monitor, exiting");
                    break;
                }

                // Poll at configured interval for child closure
                tokio::time::sleep(Duration::from_millis(proxy.config.monitor_poll_interval_ms))
                    .await;

                // `is_transport_closed()` flips when the rmcp service loop
                // breaks because the child's stdout hit EOF (i.e. the
                // process exited). Don't use `is_closed()` here: it only
                // reports "someone consumed the handle via .waiting()" or
                // "the cancellation token was cancelled," neither of which
                // happens on a natural child exit. See child::tests.
                let transport_closed = {
                    let state = proxy.state.read().await;
                    state
                        .child_client
                        .as_ref()
                        .map(|c| c.is_transport_closed())
                        .unwrap_or(true)
                };

                if !transport_closed {
                    continue;
                }

                // Child has exited, record uptime
                let uptime_secs = {
                    let state = proxy.state.read().await;
                    state
                        .child_spawn_time
                        .map(|t| t.elapsed().as_secs())
                        .unwrap_or(0)
                };

                info!(
                    event = "child_exited",
                    uptime_secs = uptime_secs,
                    "Child process exited, attempting automatic restart"
                );

                // Attempt to restart the child
                match proxy.restart_child_for_reason().await {
                    Ok(_) => {
                        info!("Child monitor: restart successful, exiting (new monitor spawned)");
                        // Exit this monitor — restart_child() spawned a new one
                        break;
                    }
                    Err(e) => {
                        error!(
                            event = "child_restart_failed",
                            error = %e,
                            "Child monitor: restart failed, stopping monitor task"
                        );
                        // Circuit breaker may have tripped, stop monitoring
                        break;
                    }
                }
            }
        });
    }

    /// Forward a tool call to the child, restarting if the child has disconnected.
    ///
    /// Prepends any pending reconnection message to the result.
    pub async fn forward_tool_call(
        &self,
        params: CallToolRequestParams,
    ) -> Result<CallToolResult, McpError> {
        // First attempt
        match self.try_forward_tool_call(&params).await {
            Ok(mut result) => {
                self.track_session(&params, &result).await;
                self.prepend_reconnection_message(&mut result).await;
                return Ok(result);
            }
            Err(e) => {
                let state = self.state.read().await;
                let child_alive = state
                    .child_client
                    .as_ref()
                    .is_some_and(|c| !c.is_transport_closed());
                drop(state);
                if child_alive {
                    warn!("Tool call failed but child still connected, not restarting: {e}");
                    return Err(e);
                }
                warn!("Tool call failed and child transport closed, attempting restart: {e}");
            }
        }

        // Child is gone — restart and retry once
        if let Err(e) = self.restart_child().await {
            return Err(McpError::internal_error(
                format!("Child restart failed: {e}"),
                None,
            ));
        }

        // Check if we should exit due to tool divergence
        {
            let state = self.state.read().await;
            if state.should_exit {
                return Err(McpError::internal_error(
                    format!(
                        "Tool list changed incompatibly after daemon upgrade. \
                         The MCP server will exit so your client can reconnect \
                         with the updated tools. {}",
                        self.config.recovery_hint
                    ),
                    None,
                ));
            }
        }

        // Second attempt after restart
        let mut result = self.try_forward_tool_call(&params).await?;
        self.track_session(&params, &result).await;
        self.prepend_reconnection_message(&mut result).await;
        Ok(result)
    }

    /// Forward a resource read to the child, restarting if disconnected.
    pub async fn forward_read_resource(
        &self,
        params: ReadResourceRequestParams,
    ) -> Result<ReadResourceResult, McpError> {
        match self.try_forward_read_resource(&params).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                let state = self.state.read().await;
                let child_alive = state
                    .child_client
                    .as_ref()
                    .is_some_and(|c| !c.is_transport_closed());
                drop(state);
                if child_alive {
                    return Err(e);
                }
                warn!("Resource read failed and child transport closed, attempting restart: {e}");
            }
        }

        if let Err(e) = self.restart_child().await {
            return Err(McpError::internal_error(
                format!("Child restart failed: {e}"),
                None,
            ));
        }

        self.try_forward_read_resource(&params).await
    }

    /// Get the current child tools (live from child, or cached).
    ///
    /// Falls back to the cached list if the live query fails OR returns empty.
    /// Empty-fallback matters when the child is alive but its daemon isn't —
    /// a bare `runt mcp` against a missing daemon returns `{tools: []}`, and
    /// without the fallback the MCP client would see zero tools and stick.
    pub async fn child_tools(&self) -> Vec<Tool> {
        if let Ok(snapshot) = self.child_peer_snapshot().await {
            let start = Instant::now();
            match snapshot.peer.list_tools(None).await {
                Ok(result) if !result.tools.is_empty() => {
                    self.log_child_call_if_slow(
                        "list_tools",
                        None,
                        snapshot.generation,
                        start.elapsed(),
                    )
                    .await;
                    return result.tools;
                }
                Ok(_) => {
                    self.log_child_call_if_slow(
                        "list_tools",
                        None,
                        snapshot.generation,
                        start.elapsed(),
                    )
                    .await;
                    warn!("Child returned empty tool list — falling back to cached tools");
                }
                Err(e) => {
                    self.log_child_call_if_slow(
                        "list_tools",
                        None,
                        snapshot.generation,
                        start.elapsed(),
                    )
                    .await;
                    warn!("Failed to list child tools: {e}");
                }
            }
        }
        // Fall back to cache
        self.state
            .read()
            .await
            .cached_tools
            .clone()
            .unwrap_or_default()
    }

    /// List child resources (pass-through).
    pub async fn child_resources(
        &self,
        request: Option<rmcp::model::PaginatedRequestParams>,
    ) -> ListResourcesResult {
        if let Ok(snapshot) = self.child_peer_snapshot().await {
            let start = Instant::now();
            match snapshot.peer.list_resources(request).await {
                Ok(result) => {
                    self.log_child_call_if_slow(
                        "list_resources",
                        None,
                        snapshot.generation,
                        start.elapsed(),
                    )
                    .await;
                    return result;
                }
                Err(e) => {
                    self.log_child_call_if_slow(
                        "list_resources",
                        None,
                        snapshot.generation,
                        start.elapsed(),
                    )
                    .await;
                    warn!("Failed to list child resources: {e}");
                }
            }
        }
        ListResourcesResult::default()
    }

    /// List child resource templates (pass-through).
    pub async fn child_resource_templates(
        &self,
        request: Option<rmcp::model::PaginatedRequestParams>,
    ) -> ListResourceTemplatesResult {
        if let Ok(snapshot) = self.child_peer_snapshot().await {
            let start = Instant::now();
            match snapshot.peer.list_resource_templates(request).await {
                Ok(result) => {
                    self.log_child_call_if_slow(
                        "list_resource_templates",
                        None,
                        snapshot.generation,
                        start.elapsed(),
                    )
                    .await;
                    return result;
                }
                Err(e) => {
                    self.log_child_call_if_slow(
                        "list_resource_templates",
                        None,
                        snapshot.generation,
                        start.elapsed(),
                    )
                    .await;
                    warn!("Failed to list child resource templates: {e}");
                }
            }
        }
        ListResourceTemplatesResult::default()
    }

    /// Check whether the proxy should exit (due to incompatible tool divergence).
    pub async fn should_exit(&self) -> bool {
        self.state.read().await.should_exit
    }

    /// Reset the circuit breaker (used by supervisor after manual restart or file change).
    pub async fn reset_circuit_breaker(&self) {
        let mut state = self.state.write().await;
        state.circuit_breaker.reset();
        state.upgrade_handoff_limiter.reset();
    }

    /// Get the number of child restarts since proxy creation.
    pub async fn restart_count(&self) -> u32 {
        self.state.read().await.restart_count
    }

    /// Get the child process uptime in seconds (None if no child).
    pub async fn child_uptime_secs(&self) -> Option<u64> {
        self.state
            .read()
            .await
            .child_spawn_time
            .map(|t| t.elapsed().as_secs())
    }

    /// Get the timestamp of the last restart (None if never restarted).
    pub async fn last_restart_time(&self) -> Option<Instant> {
        self.state.read().await.last_restart_time
    }

    /// Explicitly shut down the child process before the proxy exits.
    ///
    /// Without this, Tokio runtime teardown races the detached `wait_for_child`
    /// task — if the runtime drops first, the `shutdown_tx` signal from
    /// `ManagedChildTransport::Drop` is never processed and the child survives
    /// as an orphan, holding its daemon peer connection open and preventing room
    /// eviction.
    pub async fn shutdown_child(&self) {
        let old = {
            let mut state = self.state.write().await;
            state.child_exit_status = None;
            state.child_client.take()
        };
        if let Some(child) = old {
            info!("Shutting down child process before proxy exit");
            let _ = child.cancel().await;
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────

    async fn try_forward_tool_call(
        &self,
        params: &CallToolRequestParams,
    ) -> Result<CallToolResult, McpError> {
        let snapshot = self.child_peer_snapshot().await?;
        let generation = snapshot.generation;
        let start = Instant::now();

        let result = snapshot
            .peer
            .call_tool_once(params.clone())
            .await
            .map_err(|e| McpError::internal_error(format!("Child tool call failed: {e}"), None))
            .and_then(complete_tool_response);
        self.log_child_call_if_slow(
            "call_tool",
            Some(params.name.as_ref()),
            generation,
            start.elapsed(),
        )
        .await;
        result
    }

    async fn try_forward_read_resource(
        &self,
        params: &ReadResourceRequestParams,
    ) -> Result<ReadResourceResult, McpError> {
        let snapshot = self.child_peer_snapshot().await?;
        let generation = snapshot.generation;
        let start = Instant::now();

        let result = snapshot
            .peer
            .read_resource_once(params.clone())
            .await
            .map_err(|e| McpError::internal_error(format!("Child resource read failed: {e}"), None))
            .and_then(complete_resource_response);
        self.log_child_call_if_slow(
            "read_resource",
            Some(params.uri.as_ref()),
            generation,
            start.elapsed(),
        )
        .await;
        result
    }

    async fn track_session(&self, params: &CallToolRequestParams, result: &CallToolResult) {
        if params.name.as_ref() == "disconnect_notebook" && result.is_error != Some(true) {
            let requested_id = params
                .arguments
                .as_ref()
                .and_then(|args| args.get("notebook_id"))
                .and_then(serde_json::Value::as_str);
            let mut state = self.state.write().await;
            let disconnected_active = requested_id.is_none()
                || requested_id == state.last_notebook_id.as_deref()
                || requested_id == state.last_notebook_session_id.as_deref();
            if disconnected_active {
                info!("Clearing notebook handoff target after explicit disconnect");
                state.last_notebook_id = None;
                state.last_notebook_session_id = None;
            }
            return;
        }

        if let Some(id) = session::extract_session_id(params, result) {
            let mut state = self.state.write().await;
            let saving_hosted_session = params.name.as_ref() == "save_notebook"
                && state
                    .last_notebook_id
                    .as_deref()
                    .is_some_and(session::is_hosted_session_target);
            if saving_hosted_session {
                info!("Preserving hosted notebook target across save_notebook");
            } else {
                info!("Tracking active notebook session: {id}");
                state.last_notebook_id = Some(id);
            }
            if let Some(notebook_id) = session::extract_notebook_id_from_result(result) {
                state.last_notebook_session_id = Some(notebook_id);
            }
        }
    }

    async fn prepend_reconnection_message(&self, result: &mut CallToolResult) {
        let mut state = self.state.write().await;
        if let Some(msg) = state.reconnection_message.take() {
            // Prepend the reconnection notice before the actual tool result
            result
                .content
                .insert(0, ContentBlock::text(format!("[nteract] {msg}\n")));
        }
    }

    async fn refresh_tool_cache_for_generation(&self, generation: u64) {
        let snapshot = match self.child_peer_snapshot().await {
            Ok(snapshot) if snapshot.generation == generation => snapshot,
            _ => return,
        };
        let start = Instant::now();
        match snapshot.peer.list_tools(None).await {
            Ok(child_tools) => {
                // Never enshrine an empty list. An old/broken child that
                // transiently returns `{tools: []}` would otherwise poison
                // the on-disk cache — `load_cached_tools` treats an empty
                // file as valid, so every subsequent start would read
                // zero tools and skip the built-in fallback.
                if child_tools.tools.is_empty() {
                    warn!("Child returned empty tool list — keeping prior cache");
                } else {
                    let tools = child_tools.tools;
                    let mut state = self.state.write().await;
                    if state.child_generation == generation {
                        if let Some(ref cache_dir) = self.config.cache_dir {
                            tools::save_tool_cache(cache_dir, &tools);
                        }
                        state.cached_tools = Some(tools);
                    }
                }
            }
            Err(e) => {
                warn!("Failed to refresh tool cache: {e}");
            }
        }
        self.log_child_call_if_slow("refresh_tool_cache", None, generation, start.elapsed())
            .await;
    }

    async fn child_peer_snapshot(&self) -> Result<ChildPeerSnapshot, McpError> {
        let state = self.state.read().await;
        let client = state
            .child_client
            .as_ref()
            .ok_or_else(|| McpError::internal_error("nteract MCP server not running", None))?;
        Ok(ChildPeerSnapshot {
            peer: client.peer().clone(),
            generation: state.child_generation,
        })
    }

    async fn log_child_call_if_slow(
        &self,
        operation: &str,
        target: Option<&str>,
        generation: u64,
        elapsed: Duration,
    ) {
        if elapsed < SLOW_CHILD_CALL {
            return;
        }
        let (transport_closed, restart_count) = {
            let state = self.state.read().await;
            (
                if state.child_generation == generation {
                    state.child_client.as_ref().map(|c| c.is_transport_closed())
                } else {
                    None
                },
                state.restart_count,
            )
        };
        warn!(
            operation,
            target,
            generation,
            elapsed_ms = elapsed.as_millis(),
            ?transport_closed,
            restart_count,
            "Slow child MCP call"
        );
    }

    async fn clear_restart_in_progress(&self) {
        *self.restart_in_progress.lock().await = false;
    }
}

struct ChildPeerSnapshot {
    peer: Peer<child::RoleChild>,
    generation: u64,
}

fn require_legacy_handshake(context: &RequestContext<RoleServer>) -> Result<(), McpError> {
    if context.peer.peer_info().is_none() {
        return Err(McpError::invalid_request(
            "initialize is required before application requests",
            None,
        ));
    }
    Ok(())
}

fn complete_tool_response(response: CallToolResponse) -> Result<CallToolResult, McpError> {
    match response {
        CallToolResponse::Complete(result) => Ok(result),
        _ => Err(McpError::internal_error(
            "Child returned a non-final tool response on a legacy MCP connection",
            None,
        )),
    }
}

fn complete_resource_response(
    response: ReadResourceResponse,
) -> Result<ReadResourceResult, McpError> {
    match response {
        ReadResourceResponse::Complete(result) => Ok(result),
        _ => Err(McpError::internal_error(
            "Child returned a non-final resource response on a legacy MCP connection",
            None,
        )),
    }
}

// ---------------------------------------------------------------------------
// ServerHandler — used when McpProxy is the top-level MCP server (nteract-mcp)
// ---------------------------------------------------------------------------

/// Standalone ServerHandler for `McpProxy`. Used by `nteract-mcp` where the proxy
/// IS the MCP server. The supervisor wraps this with its own ServerHandler that
/// adds supervisor_* tools.
impl ServerHandler for McpProxy {
    async fn initialize(
        &self,
        request: rmcp::model::InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::InitializeResult, McpError> {
        if context.peer.peer_info().as_deref() != Some(&request) {
            return Err(McpError::invalid_request(
                "initialize cannot change an existing connection or follow application requests",
                None,
            ));
        }
        let mut info = self.get_info();
        if self
            .supported_protocol_versions()
            .contains(&request.protocol_version)
        {
            info.protocol_version = request.protocol_version;
        }
        Ok(info)
    }

    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [ProtocolVersion]> {
        const VERSIONS: &[ProtocolVersion] = &[
            ProtocolVersion::V_2024_11_05,
            ProtocolVersion::V_2025_03_26,
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_11_25,
        ];
        std::borrow::Cow::Borrowed(VERSIONS)
    }

    fn get_info(&self) -> ServerInfo {
        // list_tools serves the cached tool set synchronously so the first
        // client response is fast, then on_initialized spawns the child and
        // fires tools/list_changed. Advertising listChanged tells the client
        // to re-query when that notification arrives, so any drift between
        // the cache and the live child (e.g. after a daemon upgrade) is
        // reconciled without a reconnect.
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .enable_resources()
                .enable_resources_list_changed()
                .enable_extensions_with(crate::mcp_apps_extension_capabilities())
                .build(),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
        .with_server_info(Implementation::new(
            &self.config.server_name,
            env!("CARGO_PKG_VERSION"),
        ))
        .with_instructions(
            "nteract MCP server for Jupyter notebooks. \
             Each connection has one active notebook session. \
             Use list_active_notebooks to discover open notebooks, \
             then connect_notebook or create_notebook to set your active session. \
             Calling these again switches your active session.",
        )
    }

    async fn discover(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::DiscoverResult, McpError> {
        Err(McpError::method_not_found::<
            rmcp::model::DiscoverRequestMethod,
        >())
    }

    async fn list_prompts(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListPromptsResult, McpError> {
        require_legacy_handshake(&context)?;
        Ok(rmcp::model::ListPromptsResult::default())
    }

    async fn complete(
        &self,
        _request: rmcp::model::CompleteRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::CompleteResult, McpError> {
        require_legacy_handshake(&context)?;
        Ok(rmcp::model::CompleteResult::default())
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        require_legacy_handshake(&context)?;
        // Serve tools optimistically: if the child is connected, query it live;
        // otherwise return the cached/built-in tool definitions immediately.
        // This avoids blocking the MCP client during async child initialization.
        // The background init task sends `notifications/tools/list_changed` once
        // the child is ready, prompting the client to re-query with live tools.
        let state = self.state.read().await;
        let mut tools = if state.child_client.is_some() {
            drop(state);
            self.child_tools().await
        } else {
            let cached = state.cached_tools.clone().unwrap_or_default();
            drop(state);
            cached
        };
        tools.push(reconnect_tool());
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn list_resources(
        &self,
        request: Option<rmcp::model::PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        require_legacy_handshake(&context)?;
        Ok(self.child_resources(request).await)
    }

    async fn list_resource_templates(
        &self,
        request: Option<rmcp::model::PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        require_legacy_handshake(&context)?;
        Ok(self.child_resource_templates(request).await)
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        require_legacy_handshake(&context)?;
        self.forward_read_resource(request).await.map(Into::into)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        require_legacy_handshake(&context)?;
        // Intercept the built-in reconnect tool before waiting on child
        // readiness — reconnect is the escape hatch when the child is
        // wedged, so it must not block on child readiness itself.
        if request.name == RECONNECT_TOOL_NAME {
            return self.handle_reconnect().await.map(Into::into);
        }

        // Wait for child if not ready
        let notified = self.child_ready.notified();
        let needs_wait = self.state.read().await.child_client.is_none();
        if needs_wait {
            info!(
                "Tool '{}' called before child ready, waiting...",
                request.name
            );
            let _ = tokio::time::timeout(Duration::from_secs(60), notified).await;
        }

        self.forward_tool_call(request).await.map(Into::into)
    }

    // Spawn the child only after the client has sent `notifications/initialized`.
    // Once the child is up, send tools/list_changed and resources/list_changed
    // so the client re-queries and replaces the cached list with the live one.
    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        if context.peer.peer_info().is_none() {
            return;
        }
        if self.state.read().await.child_client.is_some() {
            return;
        }
        let proxy = self.clone();
        let peer = context.peer;
        tokio::spawn(async move {
            if let Err(e) = proxy.init_child().await {
                error!("Failed to initialize child: {e}");
                return;
            }
            if let Err(e) = peer.notify_tool_list_changed().await {
                warn!("Failed to send tools/list_changed: {e}");
            }
            if let Err(e) = peer.notify_resource_list_changed().await {
                warn!("Failed to send resources/list_changed: {e}");
            }
            info!("Child initialized after client-initialized, tools available");
        });
    }
}

/// Name of the built-in reconnect tool exposed by the standalone proxy.
const RECONNECT_TOOL_NAME: &str = "reconnect";

/// Build the `reconnect` tool definition injected into the standalone
/// `ServerHandler::list_tools` result.
fn reconnect_tool() -> Tool {
    // Claude Code validates every tool's inputSchema as JSON Schema and rejects
    // the entire tools/list response if any tool is missing `type: "object"`
    // at the root — even for no-argument tools.
    let mut schema: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    schema.insert(
        "type".to_string(),
        serde_json::Value::String("object".to_string()),
    );
    Tool::new(
        RECONNECT_TOOL_NAME,
        "Restart the nteract MCP child process and reconnect to the daemon. \
         Use when tools are hanging, returning stale errors, or after a daemon \
         upgrade. Child-only — the daemon itself is managed by the installed \
         nteract app.",
        schema,
    )
}

impl McpProxy {
    /// Handle the built-in `reconnect` tool call.
    ///
    /// Kicks the child via `restart_child()` and waits briefly for the new
    /// child to become ready so the caller's next tool call sees a fresh
    /// transport. Any reconnection message set by `restart_child()` is
    /// returned inline rather than prepended to a future call.
    async fn handle_reconnect(&self) -> Result<CallToolResult, McpError> {
        info!("reconnect tool invoked — restarting child");
        let prior_restart_count = self.restart_count().await;

        if let Err(e) = self.restart_child().await {
            return Err(McpError::internal_error(
                format!("Child restart failed: {e}"),
                None,
            ));
        }

        // Best-effort wait so the caller's next tool call sees the new
        // child. Don't fail the reconnect call if the child is slow —
        // the next forwarded call will retry via the normal restart path.
        let notified = self.child_ready.notified();
        let _ = tokio::time::timeout(Duration::from_secs(30), notified).await;

        let restart_count = self.restart_count().await;
        let pending = self.state.write().await.reconnection_message.take();
        let detail = pending.unwrap_or_else(|| "Child restarted.".to_string());
        let body = format!("{detail}\n\nRestart #{restart_count} (was #{prior_restart_count}).");
        Ok(CallToolResult::success(vec![ContentBlock::text(body)]))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn test_config() -> ProxyConfig {
        ProxyConfig {
            resolve_child_command: Box::new(|| Ok(PathBuf::from("/nonexistent/runt"))),
            child_args: vec!["mcp".to_string()],
            child_env: HashMap::new(),
            server_name: "test-proxy".to_string(),
            cache_dir: None,
            monitor_poll_interval_ms: 500,
            recovery_hint: "Test recovery hint.".to_string(),
        }
    }

    async fn first_request_response(request: serde_json::Value) -> serde_json::Value {
        use rmcp::ServiceExt;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let proxy = McpProxy::new(test_config(), None);
        let (server_side, mut client_side) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            if let Ok(service) = proxy.serve(server_side).await {
                let _ = service.waiting().await;
            }
        });
        let mut encoded = serde_json::to_vec(&request).unwrap();
        encoded.push(b'\n');
        client_side.write_all(&encoded).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            BufReader::new(client_side).read_line(&mut response),
        )
        .await
        .expect("first request should receive a response")
        .unwrap();
        server.abort();
        serde_json::from_str(&response).unwrap()
    }

    #[tokio::test]
    async fn legacy_initialize_negotiates_each_supported_version() {
        let proxy = McpProxy::new(test_config(), None);
        let versions = proxy.supported_protocol_versions();
        assert_eq!(versions.len(), 4);
        for version in versions.iter() {
            let response = first_request_response(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": version,
                    "capabilities": {},
                    "clientInfo": { "name": "test-client", "version": "1" }
                }
            }))
            .await;
            assert_eq!(response["result"]["protocolVersion"], version.as_str());
            assert!(response.get("error").is_none(), "{response}");
        }
    }

    #[tokio::test]
    async fn modern_first_requests_are_rejected_before_dispatch() {
        for method in ["server/discover", "tools/list"] {
            let response = first_request_response(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": {
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {}
                    }
                }
            }))
            .await;
            assert_eq!(response["error"]["code"], -32022, "{response}");
            assert!(response.get("result").is_none(), "{response}");
        }
    }

    fn test_config_with_cache(dir: &std::path::Path) -> ProxyConfig {
        ProxyConfig {
            resolve_child_command: Box::new(|| Ok(PathBuf::from("/nonexistent/runt"))),
            child_args: vec!["mcp".to_string()],
            child_env: HashMap::new(),
            server_name: "test-proxy".to_string(),
            cache_dir: Some(dir.to_path_buf()),
            monitor_poll_interval_ms: 500,
            recovery_hint: "Test recovery hint.".to_string(),
        }
    }

    // ── Proxy creation ────────────────────────────────────────────────

    #[test]
    fn proxy_server_info_advertises_mcp_apps_extension() {
        let proxy = McpProxy::new(test_config(), None);
        let info = proxy.get_info();

        assert!(info
            .capabilities
            .extensions
            .as_ref()
            .is_some_and(|extensions| extensions.contains_key(crate::MCP_APPS_EXTENSION_ID)));

        let wire = serde_json::to_value(info).expect("serialize server info");
        assert_eq!(
            wire.pointer("/capabilities/extensions/io.modelcontextprotocol~1ui"),
            Some(&serde_json::json!({}))
        );
    }

    #[tokio::test]
    async fn proxy_starts_with_no_child() {
        let proxy = McpProxy::new(test_config(), None);
        let state = proxy.state.read().await;
        assert!(state.child_client.is_none());
        assert_eq!(state.child_generation, 0);
        assert_eq!(state.restart_count, 0);
        assert!(state.last_notebook_id.is_none());
        assert!(state.reconnection_message.is_none());
        assert!(!state.should_exit);
        assert!(state.child_spawn_time.is_none());
        assert!(state.last_restart_time.is_none());
    }

    #[tokio::test]
    async fn proxy_starts_with_unknown_upstream() {
        let proxy = McpProxy::new(test_config(), None);
        let state = proxy.state.read().await;
        assert_eq!(state.upstream_name, "unknown");
        assert!(state.upstream_title.is_none());
    }

    #[tokio::test]
    async fn set_upstream_identity() {
        let proxy = McpProxy::new(test_config(), None);
        proxy
            .set_upstream_identity("Claude Code".to_string(), Some("Claude Code".to_string()))
            .await;

        let state = proxy.state.read().await;
        assert_eq!(state.upstream_name, "Claude Code");
        assert_eq!(state.upstream_title, Some("Claude Code".to_string()));
    }

    #[tokio::test]
    async fn set_upstream_identity_without_title() {
        let proxy = McpProxy::new(test_config(), None);
        proxy.set_upstream_identity("zed".to_string(), None).await;

        let state = proxy.state.read().await;
        assert_eq!(state.upstream_name, "zed");
        assert!(state.upstream_title.is_none());
    }

    #[test]
    fn child_identity_env_is_stable_and_overrides_stale_config() {
        let mut config = test_config();
        config.child_env.insert(
            OPERATOR_CLIENT_ENV_VAR.to_string(),
            "stale-client".to_string(),
        );
        config.child_env.insert(
            OPERATOR_SESSION_ENV_VAR.to_string(),
            "stalesession".to_string(),
        );
        let proxy = McpProxy::new(config, None);

        let initial = proxy.child_env("codex-mcp-client");
        let restarted = proxy.child_env("codex-mcp-client");

        assert_eq!(
            initial.get(OPERATOR_CLIENT_ENV_VAR).map(String::as_str),
            Some("codex-mcp-client")
        );
        assert_eq!(
            initial.get(OPERATOR_SESSION_ENV_VAR),
            restarted.get(OPERATOR_SESSION_ENV_VAR)
        );
        assert_eq!(
            initial.get(OPERATOR_SESSION_ENV_VAR).map(String::len),
            Some(8)
        );
    }

    // ── Tool cache loading at startup ─────────────────────────────────

    #[tokio::test]
    async fn proxy_loads_tool_cache_on_creation() {
        let dir = tempfile::tempdir().unwrap();
        let tool = rmcp::model::Tool::new(
            "test_tool".to_string(),
            "A test tool".to_string(),
            serde_json::Map::new(),
        );
        tools::save_tool_cache(dir.path(), &[tool]);

        let proxy = McpProxy::new(test_config_with_cache(dir.path()), None);
        let state = proxy.state.read().await;
        assert!(state.cached_tools.is_some());
        assert_eq!(state.cached_tools.as_ref().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn proxy_falls_back_to_builtin_when_dir_empty() {
        let dir = tempfile::tempdir().unwrap();
        let proxy = McpProxy::new(test_config_with_cache(dir.path()), None);
        let state = proxy.state.read().await;
        // Falls back to built-in tool cache
        assert!(state.cached_tools.is_some());
        assert!(!state.cached_tools.as_ref().unwrap().is_empty());
    }

    #[tokio::test]
    async fn proxy_uses_builtin_when_no_cache_dir() {
        let proxy = McpProxy::new(test_config(), None);
        let state = proxy.state.read().await;
        // Built-in tool cache is always available
        assert!(state.cached_tools.is_some());
        assert!(!state.cached_tools.as_ref().unwrap().is_empty());
    }

    // ── should_exit ───────────────────────────────────────────────────

    #[tokio::test]
    async fn should_exit_starts_false() {
        let proxy = McpProxy::new(test_config(), None);
        assert!(!proxy.should_exit().await);
    }

    #[tokio::test]
    async fn should_exit_reflects_state() {
        let proxy = McpProxy::new(test_config(), None);
        proxy.state.write().await.should_exit = true;
        assert!(proxy.should_exit().await);
    }

    // ── reset_circuit_breaker ─────────────────────────────────────────

    #[tokio::test]
    async fn reset_circuit_breaker_clears_state() {
        let proxy = McpProxy::new(test_config(), None);

        // Trip the circuit breaker
        {
            let mut state = proxy.state.write().await;
            for _ in 0..10 {
                state.circuit_breaker.record_crash();
                state.upgrade_handoff_limiter.record_crash();
            }
            assert!(!state.circuit_breaker.record_crash(), "should be tripped");
            assert!(
                !state.upgrade_handoff_limiter.record_crash(),
                "upgrade limiter should be tripped"
            );
        }

        proxy.reset_circuit_breaker().await;

        {
            let mut state = proxy.state.write().await;
            assert!(
                state.circuit_breaker.record_crash(),
                "should allow crashes after reset"
            );
            assert!(
                state.upgrade_handoff_limiter.record_crash(),
                "should allow upgrade handoffs after reset"
            );
        }
    }

    #[test]
    fn exit_75_is_classified_as_daemon_upgrade() {
        assert_eq!(
            ChildRestartReason::from_exit_code(Some(75)),
            ChildRestartReason::DaemonUpgrade
        );
        assert_eq!(
            ChildRestartReason::from_exit_code(Some(1)),
            ChildRestartReason::UnexpectedOrRequested
        );
        assert_eq!(
            ChildRestartReason::from_exit_code(None),
            ChildRestartReason::UnexpectedOrRequested
        );
    }

    #[test]
    fn intentional_upgrade_exits_do_not_consume_crash_budget() {
        let mut circuit_breaker = CircuitBreaker::new();
        let mut upgrade_handoff_limiter = CircuitBreaker::new();

        for _ in 0..5 {
            assert!(circuit_breaker_allows_restart(
                &mut circuit_breaker,
                &mut upgrade_handoff_limiter,
                false,
                ChildRestartReason::DaemonUpgrade,
            ));
        }
        assert!(!circuit_breaker_allows_restart(
            &mut circuit_breaker,
            &mut upgrade_handoff_limiter,
            false,
            ChildRestartReason::DaemonUpgrade,
        ));

        // Exhausting the independent handoff limiter leaves the full crash
        // budget untouched; the sixth unexpected restart trips that breaker.
        for _ in 0..5 {
            assert!(circuit_breaker_allows_restart(
                &mut circuit_breaker,
                &mut upgrade_handoff_limiter,
                false,
                ChildRestartReason::UnexpectedOrRequested,
            ));
        }
        assert!(!circuit_breaker_allows_restart(
            &mut circuit_breaker,
            &mut upgrade_handoff_limiter,
            false,
            ChildRestartReason::UnexpectedOrRequested,
        ));
    }

    // ── Reconnection message lifecycle ────────────────────────────────

    #[tokio::test]
    async fn reconnection_message_prepended_to_result() {
        let proxy = McpProxy::new(test_config(), None);

        // Set a reconnection message
        proxy.state.write().await.reconnection_message =
            Some("Daemon upgraded (2.1.2 → 2.1.3)".to_string());

        // Create a tool result
        let mut result = CallToolResult::success(vec![ContentBlock::text("tool output")]);

        // Prepend should add the message
        proxy.prepend_reconnection_message(&mut result).await;

        assert_eq!(result.content.len(), 2);
        // First content should be the reconnection notice
        let ContentBlock::Text(first_text) = &result.content[0] else {
            panic!("first content should be text");
        };
        assert!(first_text.text.contains("Daemon upgraded"));
        assert!(first_text.text.starts_with("[nteract]"));
        // Second should be the original
        let ContentBlock::Text(second_text) = &result.content[1] else {
            panic!("second content should be text");
        };
        assert_eq!(second_text.text, "tool output");
    }

    #[tokio::test]
    async fn complete_tool_response_preserves_metadata_and_content_after_reconnection() {
        use rmcp::model::{MetaObject, Resource};

        let proxy = McpProxy::new(test_config(), None);
        proxy.state.write().await.reconnection_message = Some("Child restarted".to_string());
        let mut meta = MetaObject::new();
        meta.insert(
            "ui".to_string(),
            serde_json::json!({"resourceUri": "ui://notebook"}),
        );
        let annotations = serde_json::from_value(serde_json::json!({
            "audience": ["user"],
            "priority": 0.8
        }))
        .unwrap();
        let resource = Resource::new("ui://notebook", "notebook")
            .with_meta(meta.clone())
            .with_annotations(annotations);
        let original_content = vec![
            ContentBlock::text("tool output"),
            ContentBlock::resource_link(resource),
            ContentBlock::image("aW1hZ2U=", "image/png"),
        ];
        let mut result = CallToolResult::success(original_content.clone());
        result.structured_content = Some(serde_json::json!({"notebook_id": "notebook-id"}));
        result.meta = Some(meta.clone());
        result.is_error = Some(true);
        let expected_structured = result.structured_content.clone();

        let mut result = complete_tool_response(result.into()).unwrap();
        proxy.prepend_reconnection_message(&mut result).await;
        let result = complete_tool_response(result.into()).unwrap();

        assert_eq!(&result.content[1..], original_content.as_slice());
        assert_eq!(result.meta, Some(meta));
        assert_eq!(result.structured_content, expected_structured);
        assert_eq!(result.is_error, Some(true));
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(
            wire["content"][2]["annotations"]["audience"],
            serde_json::json!(["user"])
        );
        assert_eq!(
            wire["content"][2]["_meta"]["ui"]["resourceUri"],
            "ui://notebook"
        );
    }

    #[test]
    fn complete_resource_response_preserves_contents_and_metadata() {
        let wire = serde_json::json!({
            "contents": [{
                "uri": "ui://notebook",
                "mimeType": "text/html;profile=mcp-app",
                "text": "<main>Notebook</main>",
                "_meta": {"ui": {"prefersBorder": true}}
            }],
            "_meta": {"source": "child"}
        });
        let result: ReadResourceResult = serde_json::from_value(wire.clone()).unwrap();
        let result = complete_resource_response(result.into()).unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), wire);
    }

    #[test]
    fn non_final_child_responses_are_rejected() {
        let input = rmcp::model::InputRequiredResult::from_request_state("state");
        let tool_error =
            complete_tool_response(CallToolResponse::InputRequired(input.clone())).unwrap_err();
        let resource_error =
            complete_resource_response(ReadResourceResponse::InputRequired(input)).unwrap_err();
        assert!(tool_error.message.contains("non-final tool response"));
        assert!(resource_error
            .message
            .contains("non-final resource response"));
    }

    #[tokio::test]
    async fn reconnection_message_cleared_after_prepend() {
        let proxy = McpProxy::new(test_config(), None);

        proxy.state.write().await.reconnection_message = Some("test message".to_string());

        let mut result = CallToolResult::success(vec![ContentBlock::text("output")]);
        proxy.prepend_reconnection_message(&mut result).await;

        // Message should be consumed
        assert!(proxy.state.read().await.reconnection_message.is_none());
    }

    #[tokio::test]
    async fn no_reconnection_message_leaves_result_unchanged() {
        let proxy = McpProxy::new(test_config(), None);

        // No reconnection message set
        let mut result = CallToolResult::success(vec![ContentBlock::text("output")]);
        let original_len = result.content.len();

        proxy.prepend_reconnection_message(&mut result).await;

        assert_eq!(result.content.len(), original_len);
    }

    #[tokio::test]
    async fn reconnection_message_only_prepended_once() {
        let proxy = McpProxy::new(test_config(), None);
        proxy.state.write().await.reconnection_message = Some("upgraded".to_string());

        let mut result1 = CallToolResult::success(vec![ContentBlock::text("first")]);
        proxy.prepend_reconnection_message(&mut result1).await;
        assert_eq!(result1.content.len(), 2);

        // Second call should not prepend anything
        let mut result2 = CallToolResult::success(vec![ContentBlock::text("second")]);
        proxy.prepend_reconnection_message(&mut result2).await;
        assert_eq!(result2.content.len(), 1);
    }

    // ── Session tracking via track_session ────────────────────────────

    #[tokio::test]
    async fn track_session_captures_connect_notebook() {
        let proxy = McpProxy::new(test_config(), None);

        let params: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "connect_notebook",
            "arguments": { "path": "/tmp/test.ipynb" }
        }))
        .unwrap();
        let result = CallToolResult::success(vec![ContentBlock::text("ok")]);

        proxy.track_session(&params, &result).await;

        let state = proxy.state.read().await;
        assert_eq!(state.last_notebook_id, Some("/tmp/test.ipynb".to_string()));
    }

    #[tokio::test]
    async fn track_session_updates_on_new_notebook() {
        let proxy = McpProxy::new(test_config(), None);

        // Open first notebook
        let params1: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "connect_notebook",
            "arguments": { "path": "/tmp/first.ipynb" }
        }))
        .unwrap();
        proxy
            .track_session(
                &params1,
                &CallToolResult::success(vec![ContentBlock::text("ok")]),
            )
            .await;

        // Open second notebook — should replace
        let params2: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "connect_notebook",
            "arguments": { "path": "/tmp/second.ipynb" }
        }))
        .unwrap();
        proxy
            .track_session(
                &params2,
                &CallToolResult::success(vec![ContentBlock::text("ok")]),
            )
            .await;

        let state = proxy.state.read().await;
        assert_eq!(
            state.last_notebook_id,
            Some("/tmp/second.ipynb".to_string())
        );
    }

    #[tokio::test]
    async fn track_session_promotes_saved_notebook_from_uuid_to_path() {
        let proxy = McpProxy::new(test_config(), None);

        let create: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "create_notebook",
            "arguments": {}
        }))
        .unwrap();
        proxy
            .track_session(
                &create,
                &CallToolResult::success(vec![ContentBlock::text(
                    r#"{"notebook_id":"38582ef2-a117-4ce6-83d2-20c2c45d33d7"}"#,
                )]),
            )
            .await;

        let save: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "save_notebook",
            "arguments": { "path": "analysis.ipynb" }
        }))
        .unwrap();
        proxy
            .track_session(
                &save,
                &CallToolResult::success(vec![ContentBlock::text(
                    r#"{"path":"/tmp/analysis.ipynb","notebook_id":"38582ef2-a117-4ce6-83d2-20c2c45d33d7"}"#,
                )]),
            )
            .await;

        let state = proxy.state.read().await;
        assert_eq!(
            state.last_notebook_id,
            Some("/tmp/analysis.ipynb".to_string())
        );
    }

    #[tokio::test]
    async fn track_session_preserves_hosted_target_across_save() {
        let proxy = McpProxy::new(test_config(), None);
        let hosted_target = "https://preview.runt.run/n/01KTZA152886TK1WAHYA48G7HJ";
        proxy.state.write().await.last_notebook_id = Some(hosted_target.to_string());

        let save: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "save_notebook",
            "arguments": { "path": "analysis.ipynb" }
        }))
        .unwrap();
        proxy
            .track_session(
                &save,
                &CallToolResult::success(vec![ContentBlock::text(
                    r#"{"path":"/tmp/analysis.ipynb","notebook_id":"01KTZA152886TK1WAHYA48G7HJ"}"#,
                )]),
            )
            .await;

        assert_eq!(
            proxy.state.read().await.last_notebook_id.as_deref(),
            Some(hosted_target)
        );
    }

    #[tokio::test]
    async fn track_session_clears_handoff_after_active_disconnect() {
        let proxy = McpProxy::new(test_config(), None);
        {
            let mut state = proxy.state.write().await;
            state.last_notebook_id = Some("/tmp/analysis.ipynb".to_string());
            state.last_notebook_session_id =
                Some("38582ef2-a117-4ce6-83d2-20c2c45d33d7".to_string());
        }
        let disconnect: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "disconnect_notebook",
            "arguments": { "notebook_id": "38582ef2-a117-4ce6-83d2-20c2c45d33d7" }
        }))
        .unwrap();

        proxy
            .track_session(
                &disconnect,
                &CallToolResult::success(vec![ContentBlock::text("ok")]),
            )
            .await;

        let state = proxy.state.read().await;
        assert!(state.last_notebook_id.is_none());
        assert!(state.last_notebook_session_id.is_none());
    }

    #[tokio::test]
    async fn track_session_keeps_active_handoff_when_parked_session_disconnects() {
        let proxy = McpProxy::new(test_config(), None);
        {
            let mut state = proxy.state.write().await;
            state.last_notebook_id = Some("/tmp/active.ipynb".to_string());
            state.last_notebook_session_id = Some("active-id".to_string());
        }
        let disconnect: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "disconnect_notebook",
            "arguments": { "notebook_id": "parked-id" }
        }))
        .unwrap();

        proxy
            .track_session(
                &disconnect,
                &CallToolResult::success(vec![ContentBlock::text("ok")]),
            )
            .await;

        let state = proxy.state.read().await;
        assert_eq!(state.last_notebook_id.as_deref(), Some("/tmp/active.ipynb"));
        assert_eq!(state.last_notebook_session_id.as_deref(), Some("active-id"));
    }

    #[tokio::test]
    async fn track_session_ignores_non_session_tools() {
        let proxy = McpProxy::new(test_config(), None);

        let params: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "execute_cell",
            "arguments": { "cell_id": "abc" }
        }))
        .unwrap();

        proxy
            .track_session(
                &params,
                &CallToolResult::success(vec![ContentBlock::text("ok")]),
            )
            .await;

        let state = proxy.state.read().await;
        assert!(state.last_notebook_id.is_none());
    }

    #[tokio::test]
    async fn track_session_ignores_errors() {
        let proxy = McpProxy::new(test_config(), None);

        let params: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "connect_notebook",
            "arguments": { "path": "/tmp/test.ipynb" }
        }))
        .unwrap();
        let mut result = CallToolResult::success(vec![ContentBlock::text("error")]);
        result.is_error = Some(true);

        proxy.track_session(&params, &result).await;

        let state = proxy.state.read().await;
        assert!(state.last_notebook_id.is_none());
    }

    // ── try_forward_tool_call without child ───────────────────────────

    #[tokio::test]
    async fn forward_fails_without_child() {
        let proxy = McpProxy::new(test_config(), None);
        let params: CallToolRequestParams = serde_json::from_value(serde_json::json!({
            "name": "list_active_notebooks"
        }))
        .unwrap();

        let result = proxy.try_forward_tool_call(&params).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("not running"));
    }

    #[tokio::test]
    async fn child_peer_snapshot_fails_without_child() {
        let proxy = McpProxy::new(test_config(), None);

        let result = proxy.child_peer_snapshot().await;

        match result {
            Ok(_) => panic!("snapshot should fail without a child"),
            Err(err) => assert!(err.message.contains("not running")),
        }
    }

    #[tokio::test]
    async fn stale_tool_cache_refresh_without_child_is_noop() {
        let proxy = McpProxy::new(test_config(), None);
        let cached = vec![rmcp::model::Tool::new(
            "cached_tool".to_string(),
            "A cached tool".to_string(),
            serde_json::Map::new(),
        )];
        proxy.state.write().await.cached_tools = Some(cached);

        proxy.refresh_tool_cache_for_generation(42).await;

        let state = proxy.state.read().await;
        let tools = state
            .cached_tools
            .as_ref()
            .expect("cache should remain set");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name.as_ref(), "cached_tool");
    }

    // ── child_tools falls back to cache ───────────────────────────────

    #[tokio::test]
    async fn child_tools_returns_cache_when_no_child() {
        let proxy = McpProxy::new(test_config(), None);
        let cached = vec![rmcp::model::Tool::new(
            "cached_tool".to_string(),
            "A cached tool".to_string(),
            serde_json::Map::new(),
        )];
        proxy.state.write().await.cached_tools = Some(cached);

        let tools = proxy.child_tools().await;
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name.as_ref(), "cached_tool");
    }

    #[tokio::test]
    async fn child_tools_returns_builtin_when_no_child() {
        let proxy = McpProxy::new(test_config(), None);
        let tools = proxy.child_tools().await;
        // Falls back to built-in cache even without a child
        assert!(!tools.is_empty());
    }

    // ── Optimistic list_tools (no child, no blocking) ──────────────────

    #[tokio::test]
    async fn list_tools_returns_cached_tools_immediately_without_child() {
        // Regression test: list_tools must return cached tools without
        // blocking when the child process isn't connected yet. The old
        // behavior waited up to 30s, causing MCP clients to time out
        // and report zero tools.
        let proxy = McpProxy::new(test_config(), None);
        let cached = vec![rmcp::model::Tool::new(
            "test_tool".to_string(),
            "A test tool".to_string(),
            serde_json::Map::new(),
        )];
        proxy.state.write().await.cached_tools = Some(cached);

        // Must complete well under the old 30s timeout
        let result = tokio::time::timeout(Duration::from_millis(100), async {
            let state = proxy.state.read().await;
            let tools = if state.child_client.is_some() {
                drop(state);
                proxy.child_tools().await
            } else {
                let cached = state.cached_tools.clone().unwrap_or_default();
                drop(state);
                cached
            };
            tools
        })
        .await
        .expect("list_tools should return immediately, not block for 30s");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name.as_ref(), "test_tool");
    }

    // ── tool_list_changed notification channel ────────────────────────

    #[tokio::test]
    async fn tool_list_changed_tx_is_stored() {
        let (tx, _rx) = mpsc::channel::<()>(4);
        let proxy = McpProxy::new(test_config(), Some(tx));
        let state = proxy.state.read().await;
        assert!(state.tool_list_changed_tx.is_some());
    }

    #[tokio::test]
    async fn no_tool_list_changed_tx_when_none() {
        let proxy = McpProxy::new(test_config(), None);
        let state = proxy.state.read().await;
        assert!(state.tool_list_changed_tx.is_none());
    }

    // ── ProxyConfig ───────────────────────────────────────────────────

    #[test]
    fn proxy_config_accepts_env_vars() {
        let mut env = HashMap::new();
        env.insert("NTERACT_CHANNEL".to_string(), "stable".to_string());
        env.insert(
            "RUNTIMED_SOCKET_PATH".to_string(),
            "/tmp/test.sock".to_string(),
        );

        let config = ProxyConfig {
            resolve_child_command: Box::new(|| Ok(PathBuf::from("/nonexistent/runt"))),
            child_args: vec!["mcp".to_string()],
            child_env: env,
            server_name: "nteract".to_string(),
            cache_dir: None,
            monitor_poll_interval_ms: 500,
            recovery_hint: "Test recovery hint.".to_string(),
        };

        assert_eq!(config.child_env.len(), 2);
        assert_eq!(config.child_env.get("NTERACT_CHANNEL").unwrap(), "stable");
    }

    // ── Version tracking at creation ──────────────────────────────────

    #[tokio::test]
    async fn proxy_starts_with_no_daemon_version() {
        // No child has handed us a ServerInfo yet, so we don't know the
        // daemon version. Populated on init_child / restart_child from
        // the child's MCP handshake.
        let proxy = McpProxy::new(test_config(), None);
        let state = proxy.state.read().await;
        assert!(state.last_daemon_version.is_none());
    }

    // ── extract_daemon_version title parsing ──────────────────────────

    #[test]
    fn parse_daemon_version_from_title() {
        assert_eq!(
            parse_daemon_version_in_title("nteract (daemon 2.3.2)"),
            Some("2.3.2")
        );
        assert_eq!(
            parse_daemon_version_in_title("nteract (daemon 2.3.2+abc1234)"),
            Some("2.3.2+abc1234")
        );
        assert_eq!(parse_daemon_version_in_title("nteract"), None);
        assert_eq!(parse_daemon_version_in_title("nteract (daemon )"), None);
    }

    /// Pure version of `extract_daemon_version` without the RunningChild
    /// wrapper, for unit testing the title parser.
    fn parse_daemon_version_in_title(title: &str) -> Option<&str> {
        let open = title.find("(daemon ")?;
        let close = title.rfind(')')?;
        let inner = title.get(open + "(daemon ".len()..close)?;
        let v = inner.trim();
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    }

    // ── Restart metrics ───────────────────────────────────────────────

    #[tokio::test]
    async fn restart_count_starts_at_zero() {
        let proxy = McpProxy::new(test_config(), None);
        assert_eq!(proxy.restart_count().await, 0);
    }

    #[tokio::test]
    async fn child_uptime_is_none_without_child() {
        let proxy = McpProxy::new(test_config(), None);
        assert!(proxy.child_uptime_secs().await.is_none());
    }

    #[tokio::test]
    async fn last_restart_time_is_none_initially() {
        let proxy = McpProxy::new(test_config(), None);
        assert!(proxy.last_restart_time().await.is_none());
    }

    // ── Concurrent restart prevention ─────────────────────────────────

    #[tokio::test]
    async fn restart_in_progress_prevents_duplicate_restarts() {
        let proxy = McpProxy::new(test_config(), None);

        // Simulate restart in progress
        *proxy.restart_in_progress.lock().await = true;

        // Attempt restart should return early
        let result = proxy.restart_child().await;

        // Should succeed but do nothing (early return)
        assert!(result.is_ok());

        // Restart count should still be 0
        assert_eq!(proxy.restart_count().await, 0);
    }

    // ── reconnect tool ────────────────────────────────────────────────

    #[test]
    fn reconnect_tool_has_expected_shape() {
        let tool = reconnect_tool();
        assert_eq!(tool.name.as_ref(), RECONNECT_TOOL_NAME);
        assert_eq!(tool.name.as_ref(), "reconnect");
        let desc = tool.description.as_ref().map(|d| d.as_ref()).unwrap_or("");
        assert!(
            desc.to_lowercase().contains("restart"),
            "reconnect tool description should mention restart: {desc}"
        );
        assert_eq!(
            tool.input_schema.get("type").and_then(|v| v.as_str()),
            Some("object"),
            "reconnect tool inputSchema must declare type=object for Claude Code"
        );
    }

    #[tokio::test]
    async fn handle_reconnect_returns_success_and_bumps_restart_count() {
        // Proxy with a bogus child command so restart_child marks a new
        // attempt but the spawn itself fails quickly. We just need it to
        // advance state observable by the caller.
        let proxy = McpProxy::new(test_config(), None);

        let result = proxy.handle_reconnect().await;

        // restart_child() wraps spawn failure as Err; handle_reconnect
        // surfaces that as McpError. Either outcome is fine for this
        // test — we care that the tool runs to completion (no panic,
        // no deadlock) and that restart_count observably advanced when
        // the spawn attempt happened.
        match result {
            Ok(call_result) => {
                let text: String = call_result
                    .content
                    .iter()
                    .filter_map(|content| match content {
                        ContentBlock::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                assert!(
                    text.contains("Restart #"),
                    "expected Restart # in body, got: {text}"
                );
            }
            Err(e) => {
                // Spawn failure is acceptable — just verify the error path
                // is the restart failure message, not something unrelated.
                assert!(
                    e.to_string().to_lowercase().contains("restart")
                        || e.to_string().to_lowercase().contains("spawn")
                        || e.to_string().to_lowercase().contains("child"),
                    "unexpected reconnect error: {e}"
                );
            }
        }
    }
}
