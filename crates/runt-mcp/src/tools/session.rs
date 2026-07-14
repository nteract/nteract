//! Session management tools: list, join, open notebooks.

use std::path::PathBuf;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, Content};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use runtimed_client::client::{ClientError, PoolClient};
use runtimed_client::protocol::{NotebookCellProjection, NotebookProjection};

use crate::cloud::{self, CloudRegistry, NotebookTarget};
use crate::formatting;
use crate::session::{NotebookSession, SessionDropInfo, SessionDropReason};
use crate::session_activation::{
    activation_error, ActivationLease, ActivationTicket, CanonicalNotebookTarget,
};
use crate::NteractMcp;

// The daemon's bounded projection wait is 120 seconds. The transport deadline
// must be longer so the daemon can return its typed current state instead of
// the client racing it with an unclassified timeout.
const MCP_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(125);

/// Read the current session's notebook_id (if any) before replacing it.
async fn previous_notebook_id(server: &NteractMcp) -> Option<String> {
    server
        .session
        .read()
        .await
        .as_ref()
        .map(|s| s.notebook_id.clone())
}

/// Resolve a room's canonical on-disk path from the daemon (authoritative).
///
/// A session established by `notebook_id` (UUID) does not otherwise learn its
/// file path. Without it, `daemon_watch`'s auto-rejoin falls back to
/// `connect(uuid)` after a daemon restart/upgrade, which lands on an empty room
/// because the UUID is daemon-instance scoped and the reaped room's `.automerge`
/// is gone. Carrying the path lets rejoin use `connect_open(path)` and reload
/// from disk. See `docs/adr/mcp-session-lifecycle.md`, Decision 8.
///
/// Returns `None` for ephemeral notebooks (no file) or on lookup failure.
async fn resolve_room_notebook_path(server: &NteractMcp, notebook_id: &str) -> Option<String> {
    let client = PoolClient::new(server.socket_path.clone());
    let rooms = client.list_rooms().await.ok()?;
    rooms
        .into_iter()
        .find(|room| room.notebook_id == notebook_id)
        .and_then(|room| room.notebook_path)
}

/// Maximum number of parked sessions. When this limit is reached, the
/// parked session chosen by HashMap iteration order is evicted to make room. This
/// bounds the resource footprint of a long-lived MCP process that touches
/// many notebooks - without a cap, every notebook ever opened keeps its
/// peer connection and kernel alive indefinitely.
const MAX_PARKED_SESSIONS: usize = 8;

/// Park a replaced active session after an atomic activation publication.
///
/// Instead of dropping the old session (which would decrement the daemon's
/// peer count and start the eviction timer), we move it into a parked
/// sessions map. The daemon peer connection stays alive, so the room and
/// kernel survive. When the agent switches back, the parked session is
/// resumed without a new connection.
///
/// If parking would exceed [`MAX_PARKED_SESSIONS`], one existing parked
/// session is evicted to keep the cache bounded.
async fn park_session(server: &NteractMcp, old: NotebookSession) {
    tracing::info!(
        "[mcp] Parking session {} before notebook switch",
        old.notebook_id
    );
    let session_key = old.session_key();
    // Record the switch so "no session" errors can point agents back
    // if the parked session is later evicted.
    *server.last_session_drop.write().await = Some(SessionDropInfo {
        reason: SessionDropReason::Switched,
        notebook_id: old.notebook_id.clone(),
        notebook_path: old.notebook_path.clone(),
        rejoin_target: Some(old.rejoin_target()),
    });
    // Park the session: peer connection stays alive, no eviction.
    let mut parked = server.parked_sessions.write().await;

    // Arbitrary-order eviction: if at capacity, drop an existing parked session.
    if parked.len() >= MAX_PARKED_SESSIONS {
        if let Some(oldest_key) = parked.keys().next().cloned() {
            tracing::info!(
                "[mcp] Parked sessions at capacity ({}), evicting {} by arbitrary HashMap order",
                MAX_PARKED_SESSIONS,
                oldest_key
            );
            parked.remove(&oldest_key);
        }
    }

    parked.insert(session_key, old);
}

/// Try to resume a parked session for the given notebook_id.
///
/// Returns `Some(session)` if a parked session was found and removed from
/// the parked map. The caller should install it as the active session.
async fn take_parked_session(server: &NteractMcp, notebook_id: &str) -> Option<NotebookSession> {
    server.parked_sessions.write().await.remove(notebook_id)
}

/// Resolve a user-provided path: expand ~ to home dir and resolve relative paths
/// against the current working directory. The MCP server runs in the expected cwd,
/// so relative paths are meaningful here (unlike the daemon, which may run as launchd).
fn resolve_path(path: &str) -> String {
    // Expand ~ using dirs::home_dir() (handles HOME on Unix, USERPROFILE on Windows)
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(rest).to_string_lossy().to_string()
        } else {
            path.to_string()
        }
    } else if let Some(rest) = path.strip_prefix("~\\") {
        // Windows-style: ~\Documents\notebook.ipynb
        if let Some(home) = dirs::home_dir() {
            home.join(rest).to_string_lossy().to_string()
        } else {
            path.to_string()
        }
    } else if path == "~" {
        dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };

    let p = PathBuf::from(&expanded);
    if p.is_relative() {
        std::env::current_dir()
            .map(|cwd| cwd.join(&p).to_string_lossy().to_string())
            .unwrap_or(expanded)
    } else {
        expanded
    }
}

fn canonicalize_local_path(path: &str) -> String {
    let resolved = PathBuf::from(resolve_path(path));
    std::fs::canonicalize(&resolved)
        .unwrap_or(resolved)
        .to_string_lossy()
        .into_owned()
}

fn canonical_local_path_target(path: &str) -> CanonicalNotebookTarget {
    let canonical_path = canonicalize_local_path(path);
    CanonicalNotebookTarget::new(format!("local:path:{canonical_path}"))
}

fn canonical_local_id_target(notebook_id: &str) -> Result<CanonicalNotebookTarget, McpError> {
    let notebook_id = uuid::Uuid::parse_str(notebook_id).map_err(|_| {
        McpError::invalid_params(
            format!(
                "Invalid notebook_id '{}': must be a UUID (e.g. from list_active_notebooks). \
                 To open a file, use the 'path' parameter instead.",
                notebook_id
            ),
            None,
        )
    })?;
    Ok(CanonicalNotebookTarget::new(format!(
        "local:id:{}",
        notebook_id.hyphenated()
    )))
}

async fn canonical_local_id_target_for_server(
    server: &NteractMcp,
    notebook_id: &str,
) -> Result<CanonicalNotebookTarget, McpError> {
    let id_target = canonical_local_id_target(notebook_id)?;
    let normalized_id = id_target
        .as_str()
        .strip_prefix("local:id:")
        .unwrap_or(notebook_id);

    // A path-owned activation learns its UUID only after the daemon publishes
    // the room. While that narrow window is open, wait for publication (or
    // for the leader to register the UUID alias) instead of treating the UUID
    // as a competing target generation.
    let mut attempts = if server.session_activation.has_current_local_path_flight() {
        40
    } else {
        1
    };
    loop {
        let rooms = PoolClient::new(server.socket_path.clone())
            .list_rooms()
            .await
            .map_err(|error| {
                McpError::internal_error(
                    format!("sync_failed: could not canonicalize notebook target: {error}"),
                    None,
                )
            })?;
        if let Some(room) = rooms
            .into_iter()
            .find(|room| room.notebook_id == normalized_id)
        {
            if let Some(path) = room.notebook_path {
                return Ok(canonical_local_path_target(&path));
            }
            return Ok(id_target);
        }
        attempts -= 1;
        if attempts == 0 || !server.session_activation.has_current_local_path_flight() {
            return Ok(id_target);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

use notebook_protocol::protocol::{
    NotebookRequest, NotebookResponse, SaveBlockedReason, SaveErrorKind,
};

use super::{arg_bool, arg_str, arg_string_array, tool_error, tool_success};

fn has_display() -> bool {
    if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
        return true;
    }
    std::env::var("DISPLAY").is_ok() || std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// Collect runtime info from RuntimeStateDoc, polling briefly for it to sync.
/// Matches Python's `_collect_runtime_info()`.
async fn collect_runtime_info(handle: &notebook_sync::handle::DocHandle) -> serde_json::Value {
    // Poll up to ~500ms for RuntimeStateDoc to sync after join
    let mut info = read_runtime_info(handle);
    if info
        .get("kernel_status")
        .and_then(|v| v.as_str())
        .unwrap_or("not_started")
        == "not_started"
    {
        for _ in 0..5 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            info = read_runtime_info(handle);
            let status = info
                .get("kernel_status")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if status != "not_started" && status != "unknown" && !status.is_empty() {
                break;
            }
        }
    }

    // When the kernel is "starting", poll briefly to catch fast error
    // transitions. The daemon's auto-launch sets Resolving synchronously,
    // then runs checks (e.g. missing_conda_env_yml_name) that may flip
    // to Error within milliseconds. Without this, create_notebook returns
    // kernel_status "starting" and the agent never learns about the error
    // unless it polls again. 10 × 50ms = 500ms ceiling — long enough for
    // filesystem-only checks, short enough to not delay legitimate builds.
    let status = info
        .get("kernel_status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if status == "starting" {
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let updated = read_runtime_info(handle);
            let new_status = updated
                .get("kernel_status")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if new_status != "starting" {
                info = updated;
                break;
            }
        }
    }

    info
}

/// Read runtime info snapshot from the handle's RuntimeStateDoc.
fn read_runtime_info(handle: &notebook_sync::handle::DocHandle) -> serde_json::Value {
    let mut info = serde_json::Map::new();
    match handle.get_runtime_state() {
        Ok(state) => {
            // Project the typed lifecycle through to_legacy() so the MCP wire
            // shape stays stable with its string `kernel_status`. A typed MCP
            // lifecycle field belongs with the RuntimeLifecycle wire contract
            // work tracked in #2096.
            let (legacy_status, _legacy_phase) = state.kernel.lifecycle.to_legacy();
            info.insert("kernel_status".into(), serde_json::json!(legacy_status));
            if !state.kernel.language.is_empty() {
                info.insert("language".into(), serde_json::json!(state.kernel.language));
            }
            if !state.kernel.name.is_empty() {
                info.insert("kernel_name".into(), serde_json::json!(state.kernel.name));
            }
            if !state.kernel.env_source.is_empty() {
                info.insert(
                    "env_source".into(),
                    serde_json::json!(state.kernel.env_source),
                );
                use notebook_protocol::connection::EnvSource;
                let parsed = EnvSource::parse(&state.kernel.env_source);
                if let Some(pm) = parsed.package_manager() {
                    info.insert("package_manager".into(), serde_json::json!(pm.as_str()));
                } else if matches!(parsed, EnvSource::Deno) {
                    info.insert("package_manager".into(), serde_json::json!("deno"));
                }
            }
            if !state.env.in_sync {
                info.insert("env_in_sync".into(), serde_json::json!(false));
            }
            if !state.env.prewarmed_packages.is_empty() {
                info.insert(
                    "prewarmed_packages".into(),
                    serde_json::json!(state.env.prewarmed_packages),
                );
            }
            // Error surface (#2157): when the kernel is in an error or
            // decision-pending state, MCP clients get both the typed
            // reason (stable for programmatic handling) and the
            // human-readable details (for surfacing to the user).
            // AwaitingEnvBuild carries CondaEnvYmlMissing + details
            // about which env to create — without this, MCP clients
            // only see kernel_status "awaiting_env_build" with no
            // explanation of what's wrong or what action to take.
            if matches!(
                state.kernel.lifecycle,
                runtime_doc::RuntimeLifecycle::Error
                    | runtime_doc::RuntimeLifecycle::AwaitingEnvBuild
            ) {
                if let Some(reason) = state
                    .kernel
                    .error_reason
                    .as_deref()
                    .filter(|s| !s.is_empty())
                {
                    info.insert("error_reason".into(), serde_json::json!(reason));
                }
                if let Some(details) = state
                    .kernel
                    .error_details
                    .as_deref()
                    .filter(|s| !s.is_empty())
                {
                    info.insert("error_details".into(), serde_json::json!(details));
                }
            }

            // Surface the trust block so callers can see why a kernel hasn't
            // launched yet. The `status` and `needs_approval` fields are
            // already in `RuntimeState.trust`; we project them through and
            // add a remediation hint when the kernel is parked in
            // `AwaitingTrust` so an MCP client knows the exact follow-up
            // call to make. Notebooks loaded from disk hit this when their
            // dep set isn't in the local allowlist — review `dependencies`
            // (e.g. via `get_dependencies` / `manage_dependencies`) before
            // approving so a sketchy package name like `canhazpassword`
            // doesn't sail through silently.
            if !state.trust.status.is_empty() {
                let mut trust_obj = serde_json::Map::new();
                trust_obj.insert("status".into(), serde_json::json!(state.trust.status));
                trust_obj.insert(
                    "needs_approval".into(),
                    serde_json::json!(state.trust.needs_approval),
                );
                if !state.trust.approved_uv_dependencies.is_empty() {
                    trust_obj.insert(
                        "approved_uv_dependencies".into(),
                        serde_json::json!(state.trust.approved_uv_dependencies),
                    );
                }
                if !state.trust.approved_conda_dependencies.is_empty() {
                    trust_obj.insert(
                        "approved_conda_dependencies".into(),
                        serde_json::json!(state.trust.approved_conda_dependencies),
                    );
                }
                if !state.trust.approved_conda_channels.is_empty() {
                    trust_obj.insert(
                        "approved_conda_channels".into(),
                        serde_json::json!(state.trust.approved_conda_channels),
                    );
                }
                if !state.trust.approved_pixi_dependencies.is_empty() {
                    trust_obj.insert(
                        "approved_pixi_dependencies".into(),
                        serde_json::json!(state.trust.approved_pixi_dependencies),
                    );
                }
                if !state.trust.approved_pixi_pypi_dependencies.is_empty() {
                    trust_obj.insert(
                        "approved_pixi_pypi_dependencies".into(),
                        serde_json::json!(state.trust.approved_pixi_pypi_dependencies),
                    );
                }
                if !state.trust.approved_pixi_channels.is_empty() {
                    trust_obj.insert(
                        "approved_pixi_channels".into(),
                        serde_json::json!(state.trust.approved_pixi_channels),
                    );
                }
                info.insert("trust".into(), serde_json::Value::Object(trust_obj));
            }
            if matches!(
                state.kernel.lifecycle,
                runtime_doc::RuntimeLifecycle::AwaitingTrust
            ) {
                info.insert(
                    "next_action".into(),
                    serde_json::json!({
                        "tool": "manage_dependencies",
                        "args": { "trust": true },
                        "reason": "Kernel launch is parked at awaiting_trust because the notebook's declared dependencies are not in the local trusted-package allowlist. Inspect the dependency list (e.g. with get_dependencies) before approving; call manage_dependencies with trust=true to grant approval and unblock launch.",
                    }),
                );
            }
        }
        Err(_) => {
            info.insert("kernel_status".into(), serde_json::json!("unknown"));
        }
    }
    serde_json::Value::Object(info)
}

fn projected_runtime_info(projection: &NotebookProjection) -> serde_json::Value {
    let runtime = &projection.runtime;
    let (kernel_status, _phase) = runtime.kernel.lifecycle.to_legacy();
    let mut info = serde_json::Map::new();
    info.insert("kernel_status".into(), serde_json::json!(kernel_status));
    if !runtime.kernel.language.is_empty() {
        info.insert(
            "language".into(),
            serde_json::json!(runtime.kernel.language),
        );
    }
    if !runtime.kernel.name.is_empty() {
        info.insert("kernel_name".into(), serde_json::json!(runtime.kernel.name));
    }
    if !runtime.kernel.env_source.is_empty() {
        info.insert(
            "env_source".into(),
            serde_json::json!(runtime.kernel.env_source),
        );
    }
    if !runtime.env.in_sync {
        info.insert("env_in_sync".into(), serde_json::json!(false));
    }
    if !runtime.env.prewarmed_packages.is_empty() {
        info.insert(
            "prewarmed_packages".into(),
            serde_json::json!(runtime.env.prewarmed_packages),
        );
    }
    if !runtime.trust.status.is_empty() {
        info.insert(
            "trust".into(),
            serde_json::json!({
                "status": runtime.trust.status,
                "needs_approval": runtime.trust.needs_approval,
            }),
        );
    }
    serde_json::Value::Object(info)
}

/// Snapshot `RuntimeState.project_context` for MCP responses.
///
/// Returns the tagged-union shape verbatim so agents (and developers
/// iterating on the sync path) can see exactly what the daemon wrote.
/// `Pending` surfaces as `{"state": "Pending"}` for symmetry; we don't
/// omit the field because "no project context yet" is a real observation.
fn read_project_context(handle: &notebook_sync::handle::DocHandle) -> serde_json::Value {
    match handle.get_runtime_state() {
        Ok(state) => {
            serde_json::to_value(&state.project_context).unwrap_or(serde_json::Value::Null)
        }
        Err(_) => serde_json::Value::Null,
    }
}

/// Get dependencies from notebook metadata.
fn get_dependencies(handle: &notebook_sync::handle::DocHandle) -> Vec<String> {
    handle
        .get_notebook_metadata()
        .and_then(|m| m.runt.uv)
        .map(|uv| uv.dependencies)
        .unwrap_or_default()
}

/// Format cell summaries for join/open response.
fn format_cell_summaries(handle: &notebook_sync::handle::DocHandle) -> String {
    let cells = handle.get_cells();
    let cell_status_map = crate::tools::cell_read::build_cell_status_map(handle);
    let cell_ec_map = crate::tools::cell_read::build_cell_execution_count_map(handle);
    cells
        .iter()
        .map(|cell| {
            let status = cell_status_map.get(&cell.id).map(String::as_str);
            let ec = cell_ec_map.get(&cell.id).map(String::as_str);
            let execution_id = handle.get_cell_execution_id(&cell.id);
            let display_status = status.or_else(|| {
                if cell.cell_type == "code" && execution_id.is_none() {
                    Some("never_run")
                } else {
                    None
                }
            });
            formatting::format_cell_summary(
                &cell.id,
                &cell.cell_type,
                &cell.source,
                formatting::CellSummaryContext {
                    execution_count: ec,
                    status: display_status,
                    execution_id: execution_id.as_deref(),
                },
                60,
                &[],
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn format_projected_cell_summaries(cells: &[NotebookCellProjection]) -> String {
    cells
        .iter()
        .map(|cell| {
            let display_status = cell.execution_status.as_deref().or_else(|| {
                if cell.cell_type == "code" && cell.execution_id.is_none() {
                    Some("never_run")
                } else {
                    None
                }
            });
            let execution_count = cell.execution_count.map(|count| count.to_string());
            formatting::format_cell_summary(
                &cell.id,
                &cell.cell_type,
                &cell.source_preview,
                formatting::CellSummaryContext {
                    execution_count: execution_count.as_deref(),
                    status: display_status,
                    execution_id: cell.execution_id.as_deref(),
                },
                60,
                &[],
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn add_progressive_session_fields(response: &mut serde_json::Value, session: &NotebookSession) {
    let readiness = session.readiness();
    response["session_generation"] = serde_json::json!(readiness.session_generation);
    response["source_state"] = readiness.source_state.clone();
    response["readiness"] = serde_json::json!({
        "projection": readiness.projection_ready,
        "document": readiness.document_ready,
        "runtime": readiness.runtime_ready,
        "interactive": readiness.interactive,
    });
    response["projection"] = serde_json::json!({
        "heads": readiness.projection_heads,
        "runtime_state_heads": readiness.runtime_state_heads,
        "completeness": readiness.projection_completeness,
    });
    response["capabilities"] = serde_json::json!(readiness.capabilities);
}

fn projection_failure_result(error: &ClientError, lease: &ActivationLease) -> CallToolResult {
    let code = match error {
        ClientError::NotebookProjectionUnavailable {
            failure: runtimed_client::protocol::NotebookProjectionFailure::InitialLoadFailed { .. },
            ..
        } => "source_degraded",
        ClientError::DaemonError(message) if message.starts_with("notebook_not_ready:") => {
            "notebook_not_ready"
        }
        _ => "sync_failed",
    };
    activation_error(
        code,
        &format!("Failed to prepare notebook projection: {error}"),
        lease.generation(),
        lease.target(),
    )
}

async fn get_room_projection(
    server: &NteractMcp,
    notebook_id: &str,
    lease: &ActivationLease,
) -> Result<NotebookProjection, CallToolResult> {
    let result = PoolClient::new(server.socket_path.clone())
        .get_notebook_projection(notebook_id, MCP_SESSION_READY_TIMEOUT)
        .await;
    if !lease.is_current() {
        return Err(superseded_result(lease));
    }
    result.map_err(|error| projection_failure_result(&error, lease))
}

fn superseded_result(lease: &ActivationLease) -> CallToolResult {
    lease.superseded_result()
}

async fn install_activated_session(
    server: &NteractMcp,
    lease: &ActivationLease,
    session: NotebookSession,
) -> Result<(), CallToolResult> {
    let session_key = session.session_key();
    let previous = lease.install_in_slot(&server.session, session).await?;

    // A different target may begin immediately after publication. This
    // session remains the installed, usable identity until that newer attempt
    // actually publishes; failed attempts never poison the active slot.
    if !lease.is_current() {
        if let Some(old) = previous {
            park_session(server, old).await;
        }
        return Err(superseded_result(lease));
    }

    if let Some(old) = previous {
        if old.session_key() != session_key {
            park_session(server, old).await;
        }
    }
    // A fresh activated connection supersedes any parked peer for the same
    // room. Remove it only after successful generation publication.
    server.parked_sessions.write().await.remove(&session_key);
    Ok(())
}

fn notebook_session_response(mut response: serde_json::Value, notebook_id: &str) -> CallToolResult {
    response["resources"] = crate::resources::notebook_resources_json(notebook_id);
    CallToolResult::success(vec![
        Content::text(serde_json::to_string_pretty(&response).unwrap_or_default()),
        Content::resource_link(crate::resources::notebook_cells_resource_link(notebook_id)),
    ])
}

fn notebook_json_response(response: serde_json::Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(
        serde_json::to_string_pretty(&response).unwrap_or_default(),
    )])
}

async fn session_resource_is_readable(server: &NteractMcp, notebook_id: &str) -> bool {
    if let Some(session) = server.session.read().await.as_ref() {
        if session.notebook_id == notebook_id {
            return session
                .access(crate::session::SessionRequirement::DocumentRead)
                .is_ok();
        }
    }

    server
        .parked_sessions
        .read()
        .await
        .get(notebook_id)
        .is_some_and(|session| {
            session
                .access(crate::session::SessionRequirement::DocumentRead)
                .is_ok()
        })
}

async fn readable_notebook_session_response(
    server: &NteractMcp,
    response: serde_json::Value,
    notebook_id: &str,
) -> CallToolResult {
    if session_resource_is_readable(server, notebook_id).await {
        notebook_session_response(response, notebook_id)
    } else {
        notebook_json_response(response)
    }
}

#[allow(dead_code)] // Fields used by schemars for tool input schema generation
#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenNotebookParams {
    /// Hidden target locator for configured local/cloud connection modes.
    #[serde(default)]
    #[schemars(skip)]
    pub target: Option<String>,
    /// Canonical file path to open (e.g. "~/analysis.ipynb").
    /// Either this OR notebook_id must be provided, not both.
    #[serde(default)]
    pub path: Option<String>,
    /// UUID of a running notebook session from list_active_notebooks.
    /// Either this OR path must be provided, not both.
    #[serde(default)]
    pub notebook_id: Option<String>,
    /// Hidden domain selector for configured local/cloud connection modes.
    #[serde(default)]
    #[schemars(skip)]
    pub domain: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListNotebooksParams {
    /// Hidden domain selector for configured local/cloud connection modes.
    #[serde(default)]
    #[schemars(skip)]
    pub domain: Option<String>,
    /// Hidden listing limit for configured non-default notebook sources.
    #[serde(default)]
    #[schemars(skip)]
    pub limit: Option<u16>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateNotebookParams {
    /// Runtime type: "python" or "deno".
    #[serde(default)]
    pub runtime: Option<String>,
    /// Alias for runtime (deprecated but supported for convenience).
    #[serde(default)]
    pub kernel: Option<String>,
    /// Working directory for the kernel.
    #[serde(default)]
    pub working_dir: Option<String>,
    /// Packages to pre-install.
    #[serde(default)]
    pub dependencies: Option<Vec<String>>,
    /// Package manager for dependencies: "uv", "conda", or "pixi".
    /// Defaults to the user's default_python_env setting.
    #[serde(default)]
    pub package_manager: Option<String>,
    /// Environment source mode: "auto", "project", or "notebook".
    /// Defaults to "auto".
    #[serde(default)]
    pub environment_mode: Option<String>,
    /// When true (default for MCP), notebook exists only in memory.
    /// Use save_notebook(path=...) to persist to disk.
    #[serde(default)]
    pub ephemeral: Option<bool>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShowNotebookParams {
    /// Notebook ID to show. Defaults to current session's notebook.
    #[serde(default)]
    pub notebook_id: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveNotebookParams {
    /// Path to save the notebook to (e.g., "~/analysis.ipynb").
    /// Required for ephemeral notebooks created with create_notebook().
    /// Omit to save to the notebook's existing file path.
    #[serde(default)]
    pub path: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct DisconnectNotebookParams {
    /// Notebook ID to disconnect and release. If omitted, disconnects the
    /// active session. Pass a notebook_id to release a specific parked session
    /// without switching away from the current one.
    #[serde(default)]
    pub notebook_id: Option<String>,
}

/// Disconnect a notebook session, releasing its peer connection and allowing
/// the daemon to evict the room normally. Works on both the active session
/// and parked sessions.
pub async fn disconnect_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let target_id = arg_str(request, "notebook_id");

    match target_id {
        Some(id) => {
            // Try parked sessions first.
            let removed = server.parked_sessions.write().await.remove(id);
            if let Some(session) = removed {
                tracing::info!("[mcp] Disconnecting parked session {}", id);
                drop(session);
                return tool_success(&format!(
                    "Disconnected parked session {}. Peer connection released; \
                     daemon eviction timer will start.",
                    id
                ));
            }

            let matches_pending_rejoin = server
                .last_session_drop
                .read()
                .await
                .as_ref()
                .is_some_and(|drop| {
                    drop.notebook_id == id && matches!(drop.reason, SessionDropReason::Disconnected)
                });
            let (old, cancelled_pending_rejoin) = {
                let mut guard = server.session.write().await;
                let is_active = guard
                    .as_ref()
                    .is_some_and(|session| session.notebook_id == id);
                if is_active {
                    server.advance_session_intent_epoch();
                    (guard.take(), false)
                } else if guard.is_none() && matches_pending_rejoin {
                    server.advance_session_intent_epoch();
                    (None, true)
                } else {
                    (None, false)
                }
            };

            if let Some(session) = old {
                *server.last_session_drop.write().await = Some(SessionDropInfo {
                    reason: SessionDropReason::Disconnected,
                    notebook_id: session.notebook_id.clone(),
                    notebook_path: session.notebook_path.clone(),
                    rejoin_target: Some(session.rejoin_target()),
                });
                tracing::info!("[mcp] Disconnecting active session {}", id);
                drop(session);
                return tool_success(&format!(
                    "Disconnected active session {}. No active session now; \
                     use connect_notebook or create_notebook to start a new one.",
                    id
                ));
            }
            if cancelled_pending_rejoin {
                tracing::info!("[mcp] Cancelled automatic rejoin for session {}", id);
                return tool_success(&format!(
                    "Cancelled automatic reconnect for session {}. No active session now; \
                     use connect_notebook or create_notebook to start a new one.",
                    id
                ));
            }

            tool_error(&format!(
                "No active or parked session with notebook_id '{}'. \
                 Use list_active_notebooks to see available sessions.",
                id
            ))
        }
        None => {
            // No ID specified — disconnect the active session.
            let old = {
                let mut guard = server.session.write().await;
                server.advance_session_intent_epoch();
                guard.take()
            };
            match old {
                Some(session) => {
                    let notebook_id = session.notebook_id.clone();
                    *server.last_session_drop.write().await = Some(SessionDropInfo {
                        reason: SessionDropReason::Disconnected,
                        notebook_id: session.notebook_id.clone(),
                        notebook_path: session.notebook_path.clone(),
                        rejoin_target: Some(session.rejoin_target()),
                    });
                    tracing::info!("[mcp] Disconnecting active session {}", notebook_id);
                    drop(session);
                    tool_success(&format!(
                        "Disconnected active session {}. No active session now; \
                         use connect_notebook or create_notebook to start a new one.",
                        notebook_id
                    ))
                }
                None => {
                    let pending_rejoin = server
                        .last_session_drop
                        .read()
                        .await
                        .as_ref()
                        .is_some_and(|drop| matches!(drop.reason, SessionDropReason::Disconnected));
                    if pending_rejoin {
                        tool_success(
                            "Cancelled automatic reconnect. No active session now; \
                             use connect_notebook or create_notebook to start a new one.",
                        )
                    } else {
                        tool_error(
                            "No active session to disconnect. \
                             Pass notebook_id to disconnect a specific parked session.",
                        )
                    }
                }
            }
        }
    }
}

/// List all active notebook sessions.
///
/// "Active" here means peers are connected or the kernel is still alive in
/// the disconnect grace period. Inactive (resumable) rooms — those the daemon
/// is holding in memory after a kernel teardown so a peer can come back — are
/// hidden from this listing. `runt ps` surfaces all states.
pub async fn list_active_notebooks(server: &NteractMcp) -> Result<CallToolResult, McpError> {
    let client = PoolClient::new(server.socket_path.clone());
    match client.list_rooms().await {
        Ok(rooms) => {
            let visible: Vec<_> = rooms
                .into_iter()
                .filter(|r| !matches!(r.state, runtimed_client::protocol::RoomState::Inactive))
                .collect();
            let json = serde_json::to_string_pretty(&visible).unwrap_or_else(|_| "[]".to_string());
            tool_success(&json)
        }
        Err(e) => tool_error(&format!(
            "Failed to list notebooks. Is the daemon running? Error: {}",
            e
        )),
    }
}

fn list_limit_arg(request: &CallToolRequestParams) -> Result<Option<u16>, McpError> {
    let Some(value) = request
        .arguments
        .as_ref()
        .and_then(|args| args.get("limit"))
    else {
        return Ok(None);
    };
    let Some(number) = value.as_u64() else {
        return Err(McpError::invalid_params(
            "limit must be an integer between 1 and 500",
            None,
        ));
    };
    if !(1..=500).contains(&number) {
        return Err(McpError::invalid_params(
            "limit must be an integer between 1 and 500",
            None,
        ));
    }
    Ok(Some(number as u16))
}

fn resolve_registry_domain(
    registry: &CloudRegistry,
    requested_domain: Option<&str>,
) -> Result<cloud::ResolvedCloudDomain, String> {
    let domain = match requested_domain {
        Some(domain) => cloud::normalize_domain(domain)?,
        None => match (registry.default_domain()?, registry.domains.as_slice()) {
            (Some(domain), _) => domain,
            (None, [domain]) => cloud::normalize_domain(&domain.base_url)?,
            (None, _) => {
                return Err(
                    "No cloud domain specified and cloud registry has no default_domain"
                        .to_string(),
                );
            }
        },
    };
    registry
        .domain(&domain)?
        .ok_or_else(|| format!("Cloud domain {domain} is not configured in the local registry"))
}

fn load_cloud_registry_for_tools() -> Result<CloudRegistry, String> {
    CloudRegistry::load_default()?.ok_or_else(|| {
        format!(
            "No cloud domain registry found at {}",
            cloud::registry_path().display()
        )
    })
}

pub async fn list_notebooks(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let requested_domain = arg_str(request, "domain");
    if requested_domain.is_none_or(cloud::is_local_domain_alias) {
        return list_active_notebooks(server).await;
    }

    let registry = match load_cloud_registry_for_tools() {
        Ok(registry) => registry,
        Err(e) => return tool_error(&e),
    };
    let domain = match resolve_registry_domain(&registry, requested_domain) {
        Ok(domain) => domain,
        Err(e) => return tool_error(&e),
    };
    let limit = list_limit_arg(request)?;

    match cloud::list_hosted_notebooks(&domain, limit).await {
        Ok(mut body) => {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("domain".to_string(), serde_json::json!(domain.base_url));
                obj.insert("source".to_string(), serde_json::json!("hosted"));
            }
            Ok(notebook_json_response(body))
        }
        Err(e) => tool_error(&e),
    }
}

async fn connect_hosted_notebook(
    server: &NteractMcp,
    domain: String,
    notebook_id: String,
    prev: Option<String>,
    lease: &ActivationLease,
) -> Result<CallToolResult, McpError> {
    let registry = match load_cloud_registry_for_tools() {
        Ok(registry) => registry,
        Err(e) => return tool_error(&e),
    };
    let domain_config = match resolve_registry_domain(&registry, Some(&domain)) {
        Ok(domain_config) => domain_config,
        Err(e) => return tool_error(&e),
    };
    let session_key = cloud::hosted_notebook_url(&domain_config.base_url, &notebook_id);

    if !lease.is_current() {
        return Ok(superseded_result(lease));
    }
    if let Some(mut parked) = take_parked_session(server, &session_key).await {
        if !lease.is_current() {
            // Put the peer back instead of dropping a healthy parked session
            // merely because another target won during the map lookup.
            server
                .parked_sessions
                .write()
                .await
                .insert(session_key.clone(), parked);
            return Ok(superseded_result(lease));
        }
        tracing::info!("[mcp] Resuming parked hosted session {}", session_key);
        parked.reactivate(lease.generation(), lease.target());
        let handle = &parked.handle;
        let runtime_info = read_runtime_info(handle);
        let deps = get_dependencies(handle);
        let cells_summary = format_cell_summaries(handle);
        let project_context = read_project_context(handle);

        let mut response = serde_json::json!({
            "notebook_id": handle.notebook_id(),
            "connected": true,
            "resumed": true,
            "source": "hosted",
            "domain": domain_config.base_url,
            "target": session_key,
            "runtime": runtime_info,
            "dependencies": deps,
            "project_context": project_context,
            "cells": cells_summary,
        });

        if let Some(ref prev_id) = prev {
            if *prev_id != notebook_id {
                response["switched_from"] = serde_json::json!(prev_id);
            }
        }

        add_progressive_session_fields(&mut response, &parked);
        if let Err(result) = install_activated_session(server, lease, parked).await {
            return Ok(result);
        }
        return Ok(notebook_session_response(response, &notebook_id));
    }

    match cloud::connect_hosted_notebook(&domain_config, &notebook_id).await {
        Ok(result) => {
            let handle = &result.handle;
            let peer_label = server.get_peer_label().await;
            crate::presence::announce(handle, &peer_label).await;

            // Hosted rooms do not currently emit the daemon's sync_status
            // control frame. Give the first sync exchange a short opportunity
            // to populate snapshots before formatting the connect response.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if !lease.is_current() {
                return Ok(superseded_result(lease));
            }

            let runtime_info = read_runtime_info(handle);
            let deps = get_dependencies(handle);
            let cells_summary = format_cell_summaries(handle);
            let project_context = read_project_context(handle);

            let mut response = serde_json::json!({
                "notebook_id": handle.notebook_id(),
                "connected": true,
                "source": "hosted",
                "domain": domain_config.base_url.clone(),
                "target": session_key,
                "runtime": runtime_info,
                "dependencies": deps,
                "project_context": project_context,
                "cells": cells_summary,
            });

            if let Some(ref prev_id) = prev {
                if *prev_id != notebook_id {
                    response["switched_from"] = serde_json::json!(prev_id);
                }
            }

            let session = NotebookSession::hosted_activated(
                result.handle,
                result.broadcast_rx,
                notebook_id.clone(),
                domain_config.base_url,
                lease.generation(),
                lease.target().clone(),
            );
            add_progressive_session_fields(&mut response, &session);
            let call_result = notebook_session_response(response, &notebook_id);
            if let Err(result) = install_activated_session(server, lease, session).await {
                return Ok(result);
            }

            Ok(call_result)
        }
        Err(e) => {
            if !lease.is_current() {
                Ok(superseded_result(lease))
            } else {
                tool_error(&e)
            }
        }
    }
}

async fn connect_local_path_progressive(
    server: &NteractMcp,
    path: String,
    prev: Option<String>,
    lease: &ActivationLease,
) -> Result<CallToolResult, McpError> {
    let abs_path = PathBuf::from(canonicalize_local_path(&path));
    let result = match notebook_sync::connect::connect_open(
        server.socket_path.clone(),
        abs_path.clone(),
        &server.get_peer_label().await,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            if !lease.is_current() {
                return Ok(superseded_result(lease));
            }
            return tool_error(&format!("Failed to open notebook '{path}': {error}"));
        }
    };
    let notebook_id = result.handle.notebook_id().to_string();
    let uuid_alias = canonical_local_id_target(&notebook_id)?;
    if !lease.add_alias(uuid_alias) {
        return Ok(superseded_result(lease));
    }
    let projection = match get_room_projection(server, &notebook_id, lease).await {
        Ok(projection) => projection,
        Err(result) => return Ok(result),
    };
    if !lease.is_current() {
        return Ok(superseded_result(lease));
    }

    let mut session = NotebookSession::local_with_projection(
        result.handle,
        result.broadcast_rx,
        notebook_id.clone(),
        Some(abs_path.to_string_lossy().into_owned()),
        lease.generation(),
        lease.target().clone(),
        projection.clone(),
    );

    if session.notebook_path.is_none() {
        session.notebook_path = Some(abs_path.to_string_lossy().into_owned());
    }
    let peer_label = server.get_peer_label().await;
    crate::presence::announce(&session.handle, &peer_label).await;

    let mut response = serde_json::json!({
        "notebook_id": notebook_id,
        "path": abs_path.to_string_lossy(),
        "notebook_path": abs_path.to_string_lossy(),
        "runtime": projected_runtime_info(&projection),
        "dependencies": projection.dependencies.clone(),
        "project_context": projection.runtime.project_context.clone(),
        "cells": format_projected_cell_summaries(&projection.cells),
    });
    if let Some(ref prev_id) = prev {
        if *prev_id != notebook_id {
            response["switched_from"] = serde_json::json!(prev_id);
        }
    }
    add_progressive_session_fields(&mut response, &session);
    if let Err(result) = install_activated_session(server, lease, session).await {
        return Ok(result);
    }
    Ok(notebook_session_response(response, &notebook_id))
}

async fn connect_local_id_progressive(
    server: &NteractMcp,
    notebook_id: String,
    prev: Option<String>,
    lease: &ActivationLease,
) -> Result<CallToolResult, McpError> {
    let result = match notebook_sync::connect::connect(
        server.socket_path.clone(),
        notebook_id.clone(),
        &server.get_peer_label().await,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            if !lease.is_current() {
                return Ok(superseded_result(lease));
            }
            return tool_error(&format!("Failed to join notebook: {error}"));
        }
    };
    let projection = match get_room_projection(server, &notebook_id, lease).await {
        Ok(projection) => projection,
        Err(result) => return Ok(result),
    };
    if !lease.is_current() {
        return Ok(superseded_result(lease));
    }

    let notebook_path = projection
        .notebook_path
        .clone()
        .or(resolve_room_notebook_path(server, &notebook_id).await);
    if !lease.is_current() {
        return Ok(superseded_result(lease));
    }
    let mut session = NotebookSession::local_with_projection(
        result.handle,
        result.broadcast_rx,
        notebook_id.clone(),
        notebook_path.clone(),
        lease.generation(),
        lease.target().clone(),
        projection.clone(),
    );
    if session.notebook_path.is_none() {
        session.notebook_path = notebook_path.clone();
    }

    let peer_label = server.get_peer_label().await;
    crate::presence::announce(&session.handle, &peer_label).await;
    let mut response = serde_json::json!({
        "notebook_id": notebook_id,
        "connected": true,
        "runtime": projected_runtime_info(&projection),
        "dependencies": projection.dependencies.clone(),
        "project_context": projection.runtime.project_context.clone(),
        "cells": format_projected_cell_summaries(&projection.cells),
    });
    if let Some(ref path) = notebook_path {
        response["notebook_path"] = serde_json::json!(path);
    }
    if let Some(ref prev_id) = prev {
        if *prev_id != notebook_id {
            response["switched_from"] = serde_json::json!(prev_id);
        }
    }
    add_progressive_session_fields(&mut response, &session);
    if let Err(result) = install_activated_session(server, lease, session).await {
        return Ok(result);
    }
    Ok(notebook_session_response(response, &notebook_id))
}

/// Open a notebook through a monotonic, same-target-coalescing activation.
pub async fn open_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let path_arg = arg_str(request, "path").map(str::to_string);
    let id_arg = arg_str(request, "notebook_id").map(str::to_string);
    let target_arg = arg_str(request, "target").map(str::to_string);
    let domain_arg = arg_str(request, "domain").map(str::to_string);

    let target = if target_arg.is_some() || domain_arg.is_some() {
        cloud::parse_connect_target(
            target_arg.as_deref(),
            path_arg.as_deref(),
            id_arg.as_deref(),
            domain_arg.as_deref(),
        )
        .map_err(|message| McpError::invalid_params(message, None))?
    } else {
        match (path_arg, id_arg) {
            (Some(path), None) => NotebookTarget::LocalPath(path),
            (None, Some(notebook_id)) => NotebookTarget::LocalNotebookId(notebook_id),
            (None, None) => {
                return Err(McpError::invalid_params(
                    "Missing required parameter: provide one of 'target', 'path', or 'notebook_id'.",
                    None,
                ));
            }
            (Some(_), Some(_)) => {
                return Err(McpError::invalid_params(
                    "Ambiguous parameters: provide only one of 'target', 'path', or 'notebook_id'.",
                    None,
                ));
            }
        }
    };

    let (target, canonical_target) = match target {
        NotebookTarget::LocalPath(path) => {
            let canonical = canonical_local_path_target(&path);
            (NotebookTarget::LocalPath(path), canonical)
        }
        NotebookTarget::LocalNotebookId(notebook_id) => {
            let canonical = canonical_local_id_target_for_server(server, &notebook_id).await?;
            let normalized = uuid::Uuid::parse_str(&notebook_id)
                .map_err(|_| McpError::invalid_params("Invalid notebook_id", None))?
                .hyphenated()
                .to_string();
            (NotebookTarget::LocalNotebookId(normalized), canonical)
        }
        NotebookTarget::Hosted {
            domain,
            notebook_id,
            source,
        } => {
            let notebook_url = cloud::hosted_notebook_url(&domain, &notebook_id);
            let canonical = CanonicalNotebookTarget::new(format!("hosted:{notebook_url}"));
            (
                NotebookTarget::Hosted {
                    domain,
                    notebook_id,
                    source,
                },
                canonical,
            )
        }
    };

    let mut lease = match server.session_activation.begin(canonical_target) {
        ActivationTicket::Follower(follower) => return Ok(follower.wait().await),
        ActivationTicket::Leader(lease) => lease,
    };
    let prev = previous_notebook_id(server).await;
    let outcome = match target {
        NotebookTarget::LocalPath(path) => {
            connect_local_path_progressive(server, path, prev, &lease).await
        }
        NotebookTarget::LocalNotebookId(notebook_id) => {
            connect_local_id_progressive(server, notebook_id, prev, &lease).await
        }
        NotebookTarget::Hosted {
            domain,
            notebook_id,
            ..
        } => connect_hosted_notebook(server, domain, notebook_id, prev, &lease).await,
    };
    match &outcome {
        Ok(result) => lease.complete(result),
        Err(error) => {
            let result = activation_error(
                "sync_failed",
                &format!("Notebook activation failed: {error:?}"),
                lease.generation(),
                lease.target(),
            );
            lease.complete(&result);
        }
    }
    outcome
}

/// Create a new notebook with optional dependencies.
pub async fn create_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    // Support both 'runtime' and 'kernel' params (kernel is an alias for convenience)
    let kernel_alias = arg_str(request, "kernel");
    let runtime_arg = arg_str(request, "runtime");
    let used_kernel_alias = kernel_alias.is_some() && runtime_arg.is_none();
    let runtime = runtime_arg.or(kernel_alias).unwrap_or("python");

    let working_dir = arg_str(request, "working_dir")
        .map(|s| PathBuf::from(resolve_path(s)))
        .or_else(|| std::env::current_dir().ok());
    let ephemeral = arg_bool(request, "ephemeral").unwrap_or(true);

    let deps: Vec<String> = arg_string_array(request, "dependencies").unwrap_or_default();
    let explicit_pkg_manager = match arg_str(request, "package_manager") {
        Some(pm) => {
            let parsed = notebook_protocol::connection::PackageManager::parse(pm)
                .map_err(|msg| McpError::invalid_params(msg, None))?;
            Some(parsed)
        }
        None => None,
    };
    let environment_mode = match arg_str(request, "environment_mode") {
        Some(mode) => {
            let parsed = notebook_protocol::connection::CreateNotebookEnvironmentMode::parse(mode)
                .map_err(|msg| McpError::invalid_params(msg, None))?;
            Some(parsed)
        }
        None => None,
    };

    let create_target = CanonicalNotebookTarget::new(format!(
        "local:create:{}",
        uuid::Uuid::new_v4().hyphenated()
    ));
    let mut activation_lease = match server.session_activation.begin(create_target) {
        ActivationTicket::Follower(follower) => return Ok(follower.wait().await),
        ActivationTicket::Leader(lease) => lease,
    };
    let prev = previous_notebook_id(server).await;

    let outcome = async {
        match notebook_sync::connect::connect_create_with_environment_mode(
            server.socket_path.clone(),
            runtime,
            working_dir,
            &server.get_peer_label().await,
            ephemeral,
            explicit_pkg_manager.clone(),
            deps.clone(),
            environment_mode,
        )
        .await
        {
            Ok(result) => {
                if let Err(e) = result
                    .handle
                    .await_session_ready_timeout(MCP_SESSION_READY_TIMEOUT)
                    .await
                {
                    return tool_error(&format!(
                        "Notebook created but did not become ready: {}",
                        e
                    ));
                }

                let notebook_id = result.handle.notebook_id().to_string();

                if !activation_lease.is_current() {
                    return Ok(superseded_result(&activation_lease));
                }

                let peer_label = server.get_peer_label().await;
                crate::presence::announce(&result.handle, &peer_label).await;

                // For Deno notebooks, there's no Python package manager — deps use
                // Deno-native imports (npm: specifiers, URL imports). We skip
                // detect_package_manager() which would fall back to "uv" since the
                // Deno env_source hasn't propagated to the CRDT yet at this point.
                let is_deno = runtime.eq_ignore_ascii_case("deno");
                let pkg_manager: Option<notebook_protocol::connection::PackageManager> = if is_deno
                {
                    None
                } else {
                    Some(
                        explicit_pkg_manager
                            .unwrap_or_else(|| super::deps::detect_package_manager(&result.handle)),
                    )
                };

                let mut session = NotebookSession::local(
                    result.handle,
                    result.broadcast_rx,
                    notebook_id.clone(),
                    None,
                );
                session.reactivate(activation_lease.generation(), activation_lease.target());

                let runtime_info = collect_runtime_info(&session.handle).await;
                let all_deps = if let Some(ref pm) = pkg_manager {
                    super::deps::get_deps_for_manager_pub(&session.handle, pm)
                } else {
                    Vec::new() // Deno: no Python deps
                };
                let project_context = read_project_context(&session.handle);

                let mut info = serde_json::json!({
                    "notebook_id": notebook_id,
                    "runtime": runtime_info,
                    "dependencies": all_deps,
                    "added_dependencies": deps,
                    "package_manager": match pkg_manager {
                        Some(ref pm) => pm.as_str(),
                        None => "deno",
                    },
                    "ephemeral": ephemeral,
                    "environment_mode": environment_mode.unwrap_or_default().as_str(),
                    "project_context": project_context,
                });

                if let Some(ref prev_id) = prev {
                    if *prev_id != notebook_id {
                        info["switched_from"] = serde_json::json!(prev_id);
                    }
                }

                if used_kernel_alias {
                    info["info"] =
                        serde_json::json!("Used 'kernel' parameter (alias for 'runtime')");
                }

                add_progressive_session_fields(&mut info, &session);
                if let Err(result) =
                    install_activated_session(server, &activation_lease, session).await
                {
                    return Ok(result);
                }

                Ok(notebook_session_response(info, &notebook_id))
            }
            Err(e) => tool_error(&format!("Failed to create notebook: {}", e)),
        }
    }
    .await;
    match &outcome {
        Ok(result) => activation_lease.complete(result),
        Err(error) => {
            let result = activation_error(
                "sync_failed",
                &format!("Notebook creation failed: {error:?}"),
                activation_lease.generation(),
                activation_lease.target(),
            );
            activation_lease.complete(&result);
        }
    }
    outcome
}

/// Save notebook to disk.
pub async fn save_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let path = arg_str(request, "path").map(resolve_path);

    let access = require_session_access!(server, DocumentMutation);
    let handle = access.handle.clone();
    let notebook_id = access.notebook_id.clone();

    // The daemon decides whether a path is required. Untitled rooms without an
    // existing path return SaveError with a clear message; MCP room ids are
    // always UUIDs and do not identify whether a room is file-backed.

    // Ensure daemon has latest
    if let Err(e) = handle.confirm_sync().await {
        tracing::warn!("confirm_sync failed before save: {e}");
    }

    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }

    let response = handle
        .send_request(NotebookRequest::SaveNotebook {
            format_cells: false,
            path: path.clone(),
        })
        .await;

    // The daemon may have committed the old room's file while this request
    // was in flight, but a later activation must never let that completion
    // rewrite the new active session's rejoin path or masquerade as its save.
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }

    match response {
        Ok(response @ (NotebookResponse::NotebookSaved { .. }
        | NotebookResponse::NotebookAlreadyCurrent { .. })) => {
            let (saved_path, outcome, exported_heads, save_sequence) = match response {
                NotebookResponse::NotebookSaved {
                    path,
                    exported_heads,
                    save_sequence,
                } => (path, "saved", exported_heads, save_sequence),
                NotebookResponse::NotebookAlreadyCurrent {
                    path,
                    exported_heads,
                    save_sequence,
                } => (path, "already_current", exported_heads, save_sequence),
                _ => unreachable!(),
            };
            // Update the rejoin path only if this exact session still owns the
            // active slot. Validation and mutation share one write lock so a
            // newer activation cannot slip between them.
            if let Err(error) = server
                .update_session_path_if_current(&access, saved_path.clone())
                .await
            {
                return super::session_access_error(error);
            }

            let result = serde_json::json!({
                "path": saved_path,
                "notebook_id": notebook_id,
                "outcome": outcome,
                "exported_heads": exported_heads,
                "save_sequence": save_sequence,
            });

            Ok(notebook_session_response(result, &notebook_id))
        }
        Ok(NotebookResponse::NotebookSaveBlocked {
            save_sequence,
            reason,
            ..
        }) => match reason {
            SaveBlockedReason::PathAlreadyOpen {
                uuid,
                path: conflict,
            } => tool_error(&format!(
                "Cannot save: {conflict} is already open in session {uuid}. Close that session first, then retry."
            )),
            SaveBlockedReason::SequenceExhausted => {
                tool_error("Cannot save because the file checkpoint sequence is exhausted")
            }
            SaveBlockedReason::Superseded { latest_sequence } => tool_error(&format!(
                "Save sequence {} was superseded by newer sequence {latest_sequence}",
                save_sequence
                    .map(|sequence| sequence.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )),
            SaveBlockedReason::SourceConflict { message } => tool_error(&format!(
                "Source conflict requires explicit reconciliation: {message}"
            )),
            SaveBlockedReason::SourceDegraded { message } => {
                tool_error(&format!("Notebook source is degraded: {message}"))
            }
            SaveBlockedReason::Io { message } => {
                if path.is_none() && message.contains("untitled") {
                    tool_error(
                        "No path specified. For notebooks created with create_notebook(), you must provide a path (e.g., save_notebook(path='/path/to/file.ipynb'))",
                    )
                } else {
                    tool_error(&format!("Failed to save notebook: {message}"))
                }
            }
        },
        Ok(NotebookResponse::SaveError { error }) => match error {
            SaveErrorKind::PathAlreadyOpen {
                uuid,
                path: conflict,
            } => tool_error(&format!(
                "Cannot save: {conflict} is already open in session {uuid}. \
                 Close that session first, then retry.",
            )),
            SaveErrorKind::Io { message } => {
                if path.is_none() && message.contains("untitled") {
                    tool_error(
                        "No path specified. For notebooks created with create_notebook(), \
                         you must provide a path (e.g., save_notebook(path='/path/to/file.ipynb'))",
                    )
                } else {
                    tool_error(&format!("Failed to save notebook: {message}"))
                }
            }
        },
        Ok(NotebookResponse::Error { error }) => {
            tool_error(&format!("Failed to save notebook: {error}"))
        }
        Ok(resp) => tool_error(&format!("Unexpected response: {resp:?}")),
        Err(e) => tool_error(&format!("Failed to save notebook: {e}")),
    }
}

/// Open the notebook in the nteract desktop app.
pub async fn show_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    // Resolve notebook_id (and optional path) from param or current session
    let (target, session_path) = match arg_str(request, "notebook_id") {
        Some(id) => (id.to_string(), None),
        None => {
            let session = server.session.read().await;
            match session.as_ref() {
                Some(s) => (s.notebook_id.clone(), s.notebook_path.clone()),
                None => {
                    drop(session);
                    return super::no_session_error(server).await;
                }
            }
        }
    };

    // Validate notebook is active in daemon
    let client = PoolClient::new(server.socket_path.clone());
    let rooms = client
        .list_rooms()
        .await
        .map_err(|e| McpError::internal_error(format!("Failed to list notebooks: {e}"), None))?;
    let Some(room) = rooms.iter().find(|r| r.notebook_id == target) else {
        return tool_error(&format!(
            "Notebook '{}' is not currently running. \
             Use list_active_notebooks() to see active notebooks.",
            target
        ));
    };
    let is_ephemeral = room.ephemeral;

    // Resolve the on-disk path: prefer room path (authoritative), then session
    // path, then fall back to the target string if it looks like a file path.
    let resolved_path = room
        .notebook_path
        .as_deref()
        .or(session_path.as_deref())
        .filter(|p| std::path::Path::new(p).is_absolute());

    if !has_display() {
        let mut result = serde_json::json!({
            "notebook_id": target,
            "opened": false,
            "reason": "No display available (headless environment). The notebook is running in the daemon and accessible via MCP tools."
        });
        if let Some(path) = resolved_path {
            result["path"] = serde_json::json!(path);
        }
        if is_ephemeral {
            result["note"] = serde_json::json!(
                "This notebook is ephemeral. Use save_notebook(path) to persist."
            );
        }
        return Ok(readable_notebook_session_response(server, result, &target).await);
    }

    if let Some(path) = resolved_path {
        runt_workspace::open_notebook_app(Some(std::path::Path::new(path)), &[])
            .map_err(|e| McpError::internal_error(format!("Failed to open app: {e}"), None))?;
    } else if std::path::Path::new(&target).is_absolute() {
        runt_workspace::open_notebook_app(Some(std::path::Path::new(&target)), &[])
            .map_err(|e| McpError::internal_error(format!("Failed to open app: {e}"), None))?;
    } else {
        runt_workspace::open_notebook_app(None, &["--notebook-id", &target])
            .map_err(|e| McpError::internal_error(format!("Failed to open app: {e}"), None))?;
    }

    let mut result = serde_json::json!({ "notebook_id": target, "opened": true });
    // Include path in the response so callers can see where the notebook lives.
    if let Some(path) = room.notebook_path.as_deref() {
        result["path"] = serde_json::json!(path);
    } else if let Some(path) = session_path.as_deref() {
        result["path"] = serde_json::json!(path);
    }
    if is_ephemeral {
        result["warning"] =
            serde_json::json!("This notebook is ephemeral. Save it from the app to keep it.");
    }
    Ok(readable_notebook_session_response(server, result, &target).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_request(name: &str, arguments: serde_json::Value) -> CallToolRequestParams {
        serde_json::from_value(serde_json::json!({
            "name": name,
            "arguments": arguments
        }))
        .unwrap()
    }

    fn first_text(result: &CallToolResult) -> &str {
        result.content[0]
            .as_text()
            .expect("tool response text")
            .text
            .as_str()
    }

    /// When package_manager is explicitly provided, it takes precedence
    /// over whatever the daemon detected.
    #[test]
    fn explicit_pkg_manager_takes_precedence() {
        let explicit: Option<&str> = Some("conda");
        let detected = "uv".to_string();
        let result: String = explicit.map(String::from).unwrap_or(detected);
        assert_eq!(result, "conda");
    }

    /// When package_manager is omitted, the detected (daemon) value is used.
    #[test]
    fn omitted_pkg_manager_uses_detected() {
        let explicit: Option<&str> = None;
        let detected = "pixi".to_string();
        let result: String = explicit.map(String::from).unwrap_or(detected);
        assert_eq!(result, "pixi");
    }

    /// save_notebook response must include notebook_id (unchanged UUID) and path.
    /// Verify no previous_notebook_id or new_notebook_id fields exist in the
    /// response schema (structural test via serde_json shape).
    #[test]
    fn save_notebook_response_shape() {
        // Simulate the response JSON that save_notebook produces on success.
        let notebook_id = uuid::Uuid::new_v4().to_string();
        let saved_path = "/tmp/test.ipynb";
        let result = serde_json::json!({
            "path": saved_path,
            "notebook_id": notebook_id,
        });

        // Must have path and notebook_id.
        assert_eq!(result["path"].as_str().unwrap(), saved_path);
        assert_eq!(result["notebook_id"].as_str().unwrap(), notebook_id);

        // Must NOT have legacy identity-mutation fields.
        assert!(
            result.get("previous_notebook_id").is_none(),
            "previous_notebook_id must not appear in save response"
        );
        assert!(
            result.get("new_notebook_id").is_none(),
            "new_notebook_id must not appear in save response"
        );

        // The notebook_id in the response is a valid UUID.
        assert!(
            uuid::Uuid::parse_str(&notebook_id).is_ok(),
            "notebook_id in save response must be a valid UUID"
        );
    }

    #[test]
    fn notebook_session_response_returns_text_json_and_cells_resource_link() {
        let result = notebook_session_response(serde_json::json!({"notebook_id": "nb 1"}), "nb 1");

        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.content.len(), 2);

        let text = result.content[0]
            .as_text()
            .expect("response JSON text")
            .text
            .as_str();
        let response: serde_json::Value =
            serde_json::from_str(text).expect("session response should be JSON");
        assert_eq!(
            response["resources"]["cells"],
            "nteract://notebooks/nb%201/cells"
        );
        assert_eq!(
            response["resources"]["cell_template"],
            "nteract://notebooks/nb%201/cells/{cell_id}"
        );

        let link = result.content[1]
            .as_resource_link()
            .expect("cells resource link");
        assert_eq!(link.uri, "nteract://notebooks/nb%201/cells");
        assert_eq!(link.mime_type.as_deref(), Some("application/json"));

        let value = serde_json::to_value(&result).expect("serialize session response");
        assert_eq!(
            value["content"][1]["type"],
            serde_json::json!("resource_link")
        );
        assert_eq!(
            value["content"][1]["mimeType"],
            serde_json::json!("application/json")
        );
    }

    #[tokio::test]
    async fn readable_notebook_session_response_omits_dead_resource_link_without_session() {
        let server = NteractMcp::new(PathBuf::from("/tmp/missing.sock"), None, None);
        let result = readable_notebook_session_response(
            &server,
            serde_json::json!({"notebook_id": "daemon-only"}),
            "daemon-only",
        )
        .await;

        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.content.len(), 1);
        assert!(result.content[0].as_resource_link().is_none());

        let text = result.content[0]
            .as_text()
            .expect("response JSON text")
            .text
            .as_str();
        let response: serde_json::Value =
            serde_json::from_str(text).expect("session response should be JSON");
        assert_eq!(response["notebook_id"], "daemon-only");
        assert!(response.get("resources").is_none());
    }

    #[tokio::test]
    async fn explicit_disconnect_cancels_pending_automatic_rejoin() {
        let server = NteractMcp::new(PathBuf::from("/tmp/missing.sock"), None, None);
        let notebook_id = uuid::Uuid::new_v4().to_string();
        *server.last_session_drop.write().await = Some(SessionDropInfo {
            reason: SessionDropReason::Disconnected,
            notebook_id: notebook_id.clone(),
            notebook_path: Some("/tmp/rejoin.ipynb".to_string()),
            rejoin_target: Some("/tmp/rejoin.ipynb".to_string()),
        });
        let before = server
            .session_intent_epoch
            .load(std::sync::atomic::Ordering::Acquire);

        let result = disconnect_notebook(
            &server,
            &make_request(
                "disconnect_notebook",
                serde_json::json!({"notebook_id": notebook_id}),
            ),
        )
        .await
        .unwrap();

        assert_eq!(result.is_error, Some(false));
        assert!(first_text(&result).contains("Cancelled automatic reconnect"));
        assert!(
            server
                .session_intent_epoch
                .load(std::sync::atomic::Ordering::Acquire)
                > before
        );
        assert!(server.session.read().await.is_none());
    }

    #[tokio::test]
    async fn list_notebooks_defaults_to_desktop_listing() {
        let missing_socket = std::env::temp_dir().join(format!(
            "nteract-missing-list-notebooks-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let server = NteractMcp::new(missing_socket, None, None);
        let request = make_request("list_notebooks", serde_json::json!({}));

        let result = list_notebooks(&server, &request).await.unwrap();

        assert_eq!(result.is_error, Some(true));
        let text = first_text(&result);
        assert!(text.contains("Failed to list notebooks"));
        assert!(!text.contains("cloud domain registry"));
    }

    #[tokio::test]
    async fn list_notebooks_desktop_domain_uses_local_listing() {
        let missing_socket = std::env::temp_dir().join(format!(
            "nteract-missing-desktop-list-notebooks-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let server = NteractMcp::new(missing_socket, None, None);
        let request = make_request("list_notebooks", serde_json::json!({"domain": "desktop"}));

        let result = list_notebooks(&server, &request).await.unwrap();

        assert_eq!(result.is_error, Some(true));
        let text = first_text(&result);
        assert!(text.contains("Failed to list notebooks"));
        assert!(!text.contains("cloud domain registry"));
    }

    /// Lifecycle states that carry error_reason/error_details must be
    /// surfaced to MCP clients. Verify the predicate covers both Error
    /// and AwaitingEnvBuild (the two states that write error details).
    #[test]
    fn error_surface_covers_awaiting_env_build() {
        use runtime_doc::RuntimeLifecycle;
        let should_surface = |lc: &RuntimeLifecycle| -> bool {
            matches!(
                lc,
                RuntimeLifecycle::Error | RuntimeLifecycle::AwaitingEnvBuild
            )
        };

        assert!(
            should_surface(&RuntimeLifecycle::Error),
            "Error must surface error details"
        );
        assert!(
            should_surface(&RuntimeLifecycle::AwaitingEnvBuild),
            "AwaitingEnvBuild must surface error details"
        );
        assert!(
            !should_surface(&RuntimeLifecycle::NotStarted),
            "NotStarted must not surface error details"
        );
        assert!(
            !should_surface(&RuntimeLifecycle::Running(
                runtime_doc::KernelActivity::Idle
            )),
            "Running(Idle) must not surface error details"
        );
    }
}
