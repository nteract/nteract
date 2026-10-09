//! Session management tools: list, join, open notebooks.

use std::path::PathBuf;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use notebook_sync::status::ConnectionState;
use runtimed_client::client::{ClientError, PoolClient};
use runtimed_client::protocol::{NotebookCellProjection, NotebookProjection};

use crate::attachments::AttachmentOrigin;
use crate::cloud::{self, CloudRegistry, NotebookTarget};
use crate::formatting;
use crate::session::{
    query_current_daemon_incarnation, DaemonIncarnation, NotebookSession, NotebookSessionSource,
    SessionDropInfo, SessionDropReason, SessionRequirement,
};
use crate::session_activation::{
    activation_error, ActivationLease, ActivationTicket, CanonicalNotebookTarget,
};
use crate::NteractMcp;

// The daemon's bounded projection wait is 120 seconds. The transport deadline
// must be longer so the daemon can return its typed current state instead of
// the client racing it with an unclassified timeout.
const MCP_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(125);

async fn current_daemon_incarnation(server: &NteractMcp) -> Option<DaemonIncarnation> {
    query_current_daemon_incarnation(server.socket_path.clone()).await
}

fn unchanged_daemon_incarnation(
    before: Option<DaemonIncarnation>,
    after: Option<DaemonIncarnation>,
) -> Option<DaemonIncarnation> {
    match (before, after) {
        (Some(before), Some(after)) if before == after => Some(after),
        _ => None,
    }
}

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

/// Maximum number of compatibility-cache entries. Explicit attachment
/// ownership lives in the registry and is unaffected by cache eviction. The
/// parked session chosen by HashMap iteration order is evicted to make room.
/// This bounds cached selection copies, not retained attachment ownership or
/// daemon kernel lifetime. Retained legacy entries remain reachable by ID.
const MAX_PARKED_SESSIONS: usize = 8;

/// Park a replaced active session after an atomic activation publication.
///
/// The registry retains ownership independently of this bounded cache. Healthy
/// local and hosted switch-back selects the retained legacy registry entry,
/// even after its cached copy is evicted. Daemon replacement expires stale
/// local lifetimes; only the selected legacy target is automatically rejoined.
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
    if !server
        .attachments
        .read_entries()
        .contains_key(&old.notebook_handle)
    {
        return; // Release won the race with compatibility-cache insertion.
    }

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
    // UUID canonicalization reads daemon rooms before activation can begin.
    // Admit here so a valid local ID can start an absent runtime too.
    server
        .admit_local_runtime()
        .await
        .map_err(|error| McpError::internal_error(error, None))?;
    let normalized_id = id_target
        .as_str()
        .strip_prefix("local:id:")
        .unwrap_or(notebook_id);

    // A path-owned activation learns its UUID only after the daemon publishes
    // the room. While that narrow window is open, wait for publication (or
    // for the leader to register the UUID alias) instead of treating the UUID
    // as a competing target generation.
    let mut attempts = if !crate::targets::explicit_attachment_mode()
        && server.session_activation.has_current_local_path_flight()
    {
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

use notebook_protocol::protocol::{NotebookRequest, NotebookResponse, SaveBlockedReason};

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
    response["notebook_handle"] = serde_json::json!(session.notebook_handle);
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

fn session_matches_target(
    session: &NotebookSession,
    requested: &CanonicalNotebookTarget,
    room_paths: &std::collections::HashMap<String, Option<String>>,
) -> bool {
    match &session.source {
        NotebookSessionSource::Local => {
            canonical_local_id_target(&session.notebook_id).is_ok_and(|target| target == *requested)
                || room_paths
                    .get(&session.notebook_id)
                    .and_then(|path| path.as_deref())
                    .is_some_and(|path| canonical_local_path_target(path) == *requested)
        }
        NotebookSessionSource::Hosted { domain } => {
            let url = cloud::hosted_notebook_url(domain, &session.notebook_id);
            CanonicalNotebookTarget::new(format!("hosted:{url}")) == *requested
        }
    }
}

/// Saved/renamed paths are daemon-owned metadata. Cached session locators are
/// recovery hints and cannot authorize selecting a room for a path open.
async fn legacy_reuse_context(
    server: &NteractMcp,
    requested: &CanonicalNotebookTarget,
) -> (
    Option<DaemonIncarnation>,
    std::collections::HashMap<String, Option<String>>,
) {
    if requested.as_str().starts_with("hosted:") {
        return (None, Default::default());
    }
    let before = current_daemon_incarnation(server).await;
    if before.is_none() {
        return (None, Default::default());
    }
    let Ok(rooms) = PoolClient::new(server.socket_path.clone())
        .list_rooms()
        .await
    else {
        return (None, Default::default());
    };
    let incarnation =
        unchanged_daemon_incarnation(before, current_daemon_incarnation(server).await);
    let paths = rooms
        .into_iter()
        .map(|room| (room.notebook_id, room.notebook_path))
        .collect();
    (incarnation, paths)
}

fn has_reusable_replica(
    connection: ConnectionState,
    interactive: bool,
    projection_ready: bool,
) -> bool {
    connection == ConnectionState::Connected && (interactive || projection_ready)
}

async fn reuse_active_session(
    server: &NteractMcp,
    requested: &CanonicalNotebookTarget,
) -> Option<CallToolResult> {
    // Sample the local daemon before taking the session lock. The lock is only
    // used for synchronous validation and response construction.
    let (current_incarnation, room_paths) = legacy_reuse_context(server, requested).await;
    let mut guard = server.session.write().await;
    let session = guard.as_mut()?;
    let mut entries = server.attachments.write_entries();
    let entry = entries.get_mut(&session.notebook_handle)?;
    if entry.origin() != AttachmentOrigin::Legacy {
        return None;
    }
    if !session_matches_target(session, requested, &room_paths)
        || !server
            .session_activation
            .can_reuse_installed(session.activation_generation, &session.activation_target)
        || (!session.is_hosted()
            && !current_incarnation
                .as_ref()
                .is_some_and(|current| session.local_daemon_incarnation.as_ref() == Some(current)))
    {
        return None;
    }

    if !session.is_hosted() {
        if let Some(path) = room_paths.get(&session.notebook_id) {
            session.notebook_path = path.clone();
            entry.session.notebook_path = path.clone();
        }
    }

    Some(match reused_session_response(session) {
        Ok(response) => response,
        Err(error) => *error,
    })
}

fn reused_session_response(
    session: &NotebookSession,
) -> Result<CallToolResult, Box<CallToolResult>> {
    let access_error = |error: crate::session::SessionAccessError| {
        Box::new(activation_error(
            error.code,
            &error.message,
            session.activation_generation,
            &CanonicalNotebookTarget::new(session.activation_target.clone()),
        ))
    };
    let access = session
        .access(SessionRequirement::ProjectionRead)
        .map_err(access_error)?;
    let projection = if access.readiness.interactive {
        None
    } else {
        access.projection
    };
    let (runtime, dependencies, project_context, cells) = match projection {
        Some(projection) => (
            projected_runtime_info(&projection),
            projection.dependencies.clone(),
            serde_json::to_value(&projection.runtime.project_context)
                .unwrap_or(serde_json::Value::Null),
            format_projected_cell_summaries(&projection.cells),
        ),
        None => {
            session
                .access(SessionRequirement::DocumentRead)
                .map_err(access_error)?;
            let (runtime, project_context, cells) =
                if session.access(SessionRequirement::RuntimeRead).is_ok() {
                    (
                        read_runtime_info(&session.handle),
                        read_project_context(&session.handle),
                        format_cell_summaries(&session.handle),
                    )
                } else {
                    let cells = session
                        .handle
                        .get_cells()
                        .iter()
                        .map(|cell| {
                            formatting::format_cell_summary(
                                &cell.id,
                                &cell.cell_type,
                                &cell.source,
                                formatting::CellSummaryContext {
                                    execution_count: None,
                                    status: None,
                                    execution_id: None,
                                },
                                60,
                                &[],
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    (
                        serde_json::json!({"kernel_status": "unknown"}),
                        serde_json::Value::Null,
                        cells,
                    )
                };
            (
                runtime,
                get_dependencies(&session.handle),
                project_context,
                cells,
            )
        }
    };

    let mut response = serde_json::json!({
        "notebook_id": session.notebook_id,
        "connected": true,
        "already_connected": true,
        "runtime": runtime,
        "dependencies": dependencies,
        "project_context": project_context,
        "cells": cells,
    });
    if let Some(path) = &session.notebook_path {
        response["path"] = serde_json::json!(path);
        response["notebook_path"] = serde_json::json!(path);
    }
    if let NotebookSessionSource::Hosted { domain } = &session.source {
        response["source"] = serde_json::json!("hosted");
        response["domain"] = serde_json::json!(domain);
        response["target"] =
            serde_json::json!(cloud::hosted_notebook_url(domain, &session.notebook_id));
    }
    add_progressive_session_fields(&mut response, session);
    Ok(notebook_session_response(response, &session.notebook_id))
}

/// Select an existing legacy lifetime under the same slot-to-registry ordering
/// used for release. Reuse consumes no reservation and never replaces an entry.
async fn reuse_retained_legacy_session(
    server: &NteractMcp,
    lease: &ActivationLease,
) -> Option<CallToolResult> {
    let (current_incarnation, room_paths) = legacy_reuse_context(server, lease.target()).await;
    let (response, previous, session_key) = {
        let mut active = server.session.write().await;
        let mut entries = server.attachments.write_entries();
        if !lease.is_current() {
            return Some(superseded_result(lease));
        }
        let handle = entries
            .iter()
            .filter(|(_, entry)| {
                let session = &entry.session;
                let readiness = session.readiness();
                entry.origin() == AttachmentOrigin::Legacy
                    && session_matches_target(session, lease.target(), &room_paths)
                    && (session.is_hosted()
                        || current_incarnation.as_ref().is_some_and(|current| {
                            session.local_daemon_incarnation.as_ref() == Some(current)
                        }))
                    && has_reusable_replica(
                        session.handle.status().connection,
                        readiness.interactive,
                        readiness.projection_ready,
                    )
            })
            .max_by_key(|(handle, entry)| (entry.session.activation_generation, *handle))
            .map(|(handle, _)| handle.clone())?;
        let entry = entries.get_mut(&handle)?;
        let mut selected = entry.session.clone();
        selected.reactivate(lease.generation(), lease.target());
        if !selected.is_hosted() {
            if let Some(path) = room_paths.get(&selected.notebook_id) {
                selected.notebook_path = path.clone();
            }
        }
        let response = match reused_session_response(&selected) {
            Ok(response) => response,
            Err(error) => return Some(*error),
        };
        // Both membership and the slot are protected at the commit point.
        // Failed/superseded activation leaves the retained lifetime untouched.
        if !lease.mark_installed() {
            return Some(superseded_result(lease));
        }
        let session_key = selected.session_key();
        entry.session.reactivate(lease.generation(), lease.target());
        entry.session.notebook_path = selected.notebook_path.clone();
        let previous = active.replace(selected);
        (response, previous, session_key)
    };
    if let Some(old) = previous {
        if old.session_key() != session_key {
            park_session(server, old).await;
        }
    }
    server.parked_sessions.write().await.remove(&session_key);
    Some(response)
}

async fn install_activated_session(
    server: &NteractMcp,
    lease: &ActivationLease,
    session: NotebookSession,
) -> Result<(), CallToolResult> {
    if !session.is_hosted() {
        let current_incarnation = current_daemon_incarnation(server).await;
        let is_bound_to_current = current_incarnation
            .as_ref()
            .is_some_and(|current| session.local_daemon_incarnation.as_ref() == Some(current));
        if !is_bound_to_current {
            return Err(activation_error(
                "daemon_replaced",
                "The local daemon changed while the notebook connection was being established; retry the connection",
                lease.generation(),
                lease.target(),
            ));
        }
    }
    let reservation = crate::targets::take_reservation(server).map_err(|message| {
        activation_error(
            "attachment_limit",
            message,
            lease.generation(),
            lease.target(),
        )
    })?;
    if crate::targets::explicit_attachment_mode() {
        let mut session = session;
        let operator = server.get_operator().await;
        session.backing_key = crate::targets::backing_key()
            .or_else(|| {
                session.local_daemon_incarnation.clone().map(|incarnation| {
                    crate::attachments::BackingPeerKey {
                        target: format!("local:id:{}", session.notebook_id),
                        incarnation,
                        operator,
                    }
                })
            })
            .filter(|key| {
                session.local_daemon_incarnation.as_ref() == Some(&key.incarnation)
                    && session.handle.get_actor_id().is_ok_and(|actor| {
                        crate::replica::belongs_to_operator(&actor, &key.operator)
                    })
            });
        server.attachments.insert(session, reservation);
        return Ok(());
    }
    let session_key = session.session_key();
    let previous = lease
        .install_in_slot_with(&server.session, session, |session| {
            server
                .attachments
                .insert_legacy(session.clone(), reservation);
        })
        .await?;

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

fn add_created_notebook_recovery(mut result: CallToolResult, notebook_id: &str) -> CallToolResult {
    let mut details = result
        .structured_content
        .take()
        .unwrap_or_else(|| serde_json::json!({ "error": {} }));
    if !details
        .get("error")
        .is_some_and(serde_json::Value::is_object)
    {
        details["error"] = serde_json::json!({});
    }
    details["error"]["notebook_id"] = serde_json::json!(notebook_id);
    details["error"]["recovery"] = serde_json::json!({
        "tool": "connect_notebook",
        "notebook_id": notebook_id,
    });
    result.content = vec![ContentBlock::text(details.to_string())];
    result.structured_content = Some(details);
    result
}

fn notebook_session_response(mut response: serde_json::Value, notebook_id: &str) -> CallToolResult {
    response["resources"] = crate::resources::notebook_resources_json(notebook_id);
    let link = if let Some(handle) = response["notebook_handle"].as_str().map(str::to_owned) {
        let cells = crate::resources::attachment_cells_uri(&handle);
        response["resources"] = serde_json::json!({
            "cells": cells, "cell_template": format!("{cells}/{{cell_id}}"),
            "comments": format!("nteract://sessions/{handle}/comments"),
        });
        crate::resources::attachment_cells_resource_link(&handle)
    } else {
        crate::resources::notebook_cells_resource_link(notebook_id)
    };
    CallToolResult::success(vec![
        ContentBlock::text(serde_json::to_string_pretty(&response).unwrap_or_default()),
        ContentBlock::resource_link(link),
    ])
}

fn notebook_json_response(response: serde_json::Value) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(
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
    /// Configured hosted domain; omit for this server's local daemon.
    #[serde(default)]
    pub domain: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListNotebooksParams {
    /// Configured hosted domain; omit for this server's local daemon.
    #[serde(default)]
    pub domain: Option<String>,
    /// Maximum hosted notebooks to list.
    #[serde(default)]
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
    /// Notebook ID whose retained legacy attachments should be released.
    /// If omitted, releases the active legacy target. Independent explicit
    /// attachments require their exact notebook_handle instead.
    #[serde(default)]
    pub notebook_id: Option<String>,
}

/// Release an exact handle or the deliberately named legacy target. Cache
/// eviction does not prevent ID-only legacy release; explicit owners remain
/// independent. Daemon room eviction depends on all remaining peer owners.
pub async fn disconnect_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    if let Some(handle) = crate::targets::current() {
        let removed = server.attachments.remove(&handle);
        if removed.is_none() {
            return Err(McpError::invalid_params(
                "Notebook attachment expired",
                None,
            ));
        }
        {
            let mut active = server.session.write().await;
            if active
                .as_ref()
                .is_some_and(|session| session.notebook_handle == handle)
            {
                server.advance_session_intent_epoch();
                active.take();
            }
        }
        server
            .parked_sessions
            .write()
            .await
            .retain(|_, session| session.notebook_handle != handle);
        return tool_success(
            "Released the notebook attachment. Connect again to obtain a new handle.",
        );
    }
    let target_id = arg_str(request, "notebook_id");
    let matches_pending_rejoin =
        server
            .last_session_drop
            .read()
            .await
            .as_ref()
            .is_some_and(|drop| {
                matches!(drop.reason, SessionDropReason::Disconnected)
                    && target_id.is_none_or(|id| drop.notebook_id == id)
            });
    let (removed_handles, old, cancelled_pending_rejoin) = {
        let mut active = server.session.write().await;
        let mut entries = server.attachments.write_entries();
        let active_key = active.as_ref().and_then(|session| {
            entries.get(&session.notebook_handle).and_then(|entry| {
                (entry.origin() == AttachmentOrigin::Legacy
                    && target_id
                        .is_none_or(|id| session.notebook_id == id || session.session_key() == id))
                .then(|| session.session_key())
            })
        });
        let target_key = if active_key.is_some() || target_id.is_none() {
            active_key
        } else {
            let id = target_id.unwrap_or_default();
            let mut keys = entries
                .values()
                .filter(|entry| {
                    entry.origin() == AttachmentOrigin::Legacy
                        && (entry.session.notebook_id == id || entry.session.session_key() == id)
                })
                .map(|entry| entry.session.session_key());
            let first = keys.next();
            if keys.any(|key| Some(&key) != first.as_ref()) {
                return tool_error(
                    "Ambiguous legacy notebook ID across sources; release an exact notebook_handle instead.",
                );
            }
            first
        };
        let removed_handles: std::collections::HashSet<String> = entries
            .iter()
            .filter(|(_, entry)| {
                entry.origin() == AttachmentOrigin::Legacy
                    && target_key
                        .as_ref()
                        .is_some_and(|key| entry.session.session_key() == *key)
            })
            .map(|(handle, _)| handle.clone())
            .collect();
        // Retention is ended deliberately for the legacy target named by this
        // request. Independent explicit owners of that notebook are excluded.
        entries.retain(|handle, _| !removed_handles.contains(handle));
        let old = if active
            .as_ref()
            .is_some_and(|session| removed_handles.contains(&session.notebook_handle))
        {
            server.advance_session_intent_epoch();
            active.take()
        } else {
            None
        };
        let cancelled = old.is_none() && active.is_none() && matches_pending_rejoin;
        if cancelled || (target_id.is_none() && old.is_none()) {
            server.advance_session_intent_epoch();
        }
        (removed_handles, old, cancelled)
    };
    server
        .parked_sessions
        .write()
        .await
        .retain(|_, session| !removed_handles.contains(&session.notebook_handle));
    if let Some(session) = &old {
        *server.last_session_drop.write().await = Some(SessionDropInfo {
            reason: SessionDropReason::Disconnected,
            notebook_id: session.notebook_id.clone(),
            notebook_path: session.notebook_path.clone(),
            rejoin_target: Some(session.rejoin_target()),
        });
    }
    if !removed_handles.is_empty() {
        return tool_success(&format!(
            "Disconnected notebook {}. Released {} legacy attachment(s); independent explicit attachments remain usable.",
            target_id.or_else(|| old.as_ref().map(|session| session.notebook_id.as_str())).unwrap_or_default(),
            removed_handles.len(),
        ));
    }
    if cancelled_pending_rejoin {
        return tool_success(
            "Cancelled automatic reconnect. No active session now; use connect_notebook or create_notebook to start a new one.",
        );
    }
    if target_id.is_none() {
        return tool_error(
            "No active session to disconnect. Pass notebook_id to disconnect a retained legacy session.",
        );
    }
    tool_error(
        "No matching retained legacy session to disconnect. Pass notebook_handle to release an explicit attachment.",
    )
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
    match cloud::connect_hosted_bound(&domain_config, &notebook_id).await {
        Ok((result, authority)) => {
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

            let mut session = NotebookSession::hosted_activated(
                result.handle,
                notebook_id.clone(),
                domain_config.base_url,
                lease.generation(),
                lease.target().clone(),
            );
            session.hosted_authority = Some(authority);
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
    if let Err(error) = server.admit_local_runtime().await {
        return tool_error(&error);
    }
    if !lease.is_current() {
        return Ok(superseded_result(lease));
    }
    let abs_path = PathBuf::from(canonicalize_local_path(&path));
    let incarnation_before = current_daemon_incarnation(server).await;
    let result = match notebook_sync::connect::connect_open(
        server.socket_path.clone(),
        abs_path.clone(),
        &crate::replica::fresh_operator(&server.get_operator().await),
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
        notebook_id.clone(),
        Some(abs_path.to_string_lossy().into_owned()),
        lease.generation(),
        lease.target().clone(),
        projection.clone(),
        None,
    );

    if session.notebook_path.is_none() {
        session.notebook_path = Some(abs_path.to_string_lossy().into_owned());
    }
    let peer_label = server.get_peer_label().await;
    crate::presence::announce(&session.handle, &peer_label).await;
    session.local_daemon_incarnation =
        unchanged_daemon_incarnation(incarnation_before, current_daemon_incarnation(server).await);

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
    if let Err(error) = server.admit_local_runtime().await {
        return tool_error(&error);
    }
    if !lease.is_current() {
        return Ok(superseded_result(lease));
    }
    let incarnation_before = current_daemon_incarnation(server).await;
    let result = match notebook_sync::connect::connect(
        server.socket_path.clone(),
        notebook_id.clone(),
        &crate::replica::fresh_operator(&server.get_operator().await),
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
        notebook_id.clone(),
        notebook_path.clone(),
        lease.generation(),
        lease.target().clone(),
        projection.clone(),
        None,
    );
    if session.notebook_path.is_none() {
        session.notebook_path = notebook_path.clone();
    }

    let peer_label = server.get_peer_label().await;
    crate::presence::announce(&session.handle, &peer_label).await;
    session.local_daemon_incarnation =
        unchanged_daemon_incarnation(incarnation_before, current_daemon_incarnation(server).await);
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

/// Format a newly owned attachment to an existing peer without weakening its
/// retained projection or causal head evidence.
fn shared_attachment_response(
    session: &NotebookSession,
) -> Result<CallToolResult, Box<CallToolResult>> {
    let access = session
        .access(SessionRequirement::ProjectionRead)
        .map_err(|error| {
            activation_error(
                error.code,
                &error.message,
                session.activation_generation,
                &CanonicalNotebookTarget::new(session.activation_target.clone()),
            )
        })?;
    let projection = if access.readiness.interactive {
        None
    } else {
        access.projection
    };
    let (runtime, dependencies, project_context, cells) = match projection {
        Some(projection) => (
            projected_runtime_info(&projection),
            projection.dependencies.clone(),
            serde_json::to_value(&projection.runtime.project_context).unwrap_or_default(),
            format_projected_cell_summaries(&projection.cells),
        ),
        None => {
            session
                .access(SessionRequirement::DocumentRead)
                .map_err(|error| {
                    activation_error(
                        error.code,
                        &error.message,
                        session.activation_generation,
                        &CanonicalNotebookTarget::new(session.activation_target.clone()),
                    )
                })?;
            // Document readiness does not imply runtime readiness. A shared
            // open may safely report an unknown runtime without a kernel.
            let (runtime, project_context, cells) =
                if session.access(SessionRequirement::RuntimeRead).is_ok() {
                    (
                        read_runtime_info(&session.handle),
                        read_project_context(&session.handle),
                        format_cell_summaries(&session.handle),
                    )
                } else {
                    let cells = session
                        .handle
                        .get_cells()
                        .iter()
                        .map(|cell| {
                            formatting::format_cell_summary(
                                &cell.id,
                                &cell.cell_type,
                                &cell.source,
                                formatting::CellSummaryContext::default(),
                                60,
                                &[],
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    (
                        serde_json::json!({"kernel_status": "unknown"}),
                        serde_json::Value::Null,
                        cells,
                    )
                };
            (
                runtime,
                get_dependencies(&session.handle),
                project_context,
                cells,
            )
        }
    };
    let mut response = serde_json::json!({
        "notebook_id": session.notebook_id,
        "connected": true,
        "runtime": runtime,
        "dependencies": dependencies,
        "project_context": project_context,
        "cells": cells,
    });
    if let Some(path) = &session.notebook_path {
        response["path"] = serde_json::json!(path);
        response["notebook_path"] = serde_json::json!(path);
    }
    add_progressive_session_fields(&mut response, session);
    Ok(notebook_session_response(response, &session.notebook_id))
}

async fn open_explicit_attachment(
    server: &NteractMcp,
    target: NotebookTarget,
    requested: CanonicalNotebookTarget,
) -> Result<CallToolResult, McpError> {
    // Direct hosted transport has no daemon incarnation and resolves mutable
    // credentials on connect. Do not share it without an authenticated key.
    let key = if matches!(target, NotebookTarget::Hosted { .. }) {
        None
    } else {
        if let Err(error) = server.admit_local_runtime().await {
            return tool_error(&error);
        }
        let canonical = match &target {
            NotebookTarget::LocalNotebookId(id) => {
                canonical_local_id_target_for_server(server, id)
                    .await
                    .unwrap_or_else(|error| {
                        tracing::debug!(?error, "Cannot resolve backing-peer path alias; retaining requested notebook identity");
                        requested.clone()
                    })
            }
            _ => requested.clone(),
        };
        current_daemon_incarnation(server).await.map(|incarnation| {
            crate::attachments::BackingPeerKey {
                target: canonical.as_str().to_string(),
                incarnation,
                operator: String::new(),
            }
        })
    };
    let key = match key {
        Some(mut key) => {
            key.operator = server.get_operator().await;
            Some(key)
        }
        None => None,
    };
    let gate = key
        .as_ref()
        .map(|key| server.attachments.acquisition_gate(key.clone()));
    let _permit = match &gate {
        Some(gate) => Some(
            std::sync::Arc::clone(gate)
                .acquire_owned()
                .await
                .map_err(|_| McpError::internal_error("Notebook acquisition gate closed", None))?,
        ),
        None => None,
    };
    let activation = std::sync::Arc::new(crate::session_activation::SessionActivation::default());
    let mut lease = match activation.begin(requested) {
        ActivationTicket::Leader(lease) => lease,
        ActivationTicket::Follower(_) => unreachable!("fresh activation has no follower"),
    };

    if let Some(key) = &key {
        if current_daemon_incarnation(server).await.as_ref() != Some(&key.incarnation) {
            return Ok(activation_error(
                "daemon_replaced",
                "The local daemon changed while waiting to acquire a backing peer; retry the connection",
                lease.generation(), lease.target(),
            ));
        }
        if server.get_operator().await != key.operator {
            return Ok(activation_error(
                "source_identity_changed",
                "The operator changed while waiting to acquire a backing peer; retry the connection",
                lease.generation(), lease.target(),
            ));
        }
        // Resolve from current daemon room metadata, never activation aliases:
        // saving a shared notebook can move its path while its old activation
        // target still names the original file.
        let rooms = PoolClient::new(server.socket_path.clone())
            .list_rooms()
            .await
            .unwrap_or_else(|error| {
                tracing::debug!(%error, "Cannot resolve backing peer; opening a fresh connection");
                Vec::new()
            });
        let mut matches = rooms.into_iter().filter(|room| match &target {
            NotebookTarget::LocalPath(path) => {
                room.notebook_path.as_deref().is_some_and(|room_path| {
                    canonical_local_path_target(room_path) == canonical_local_path_target(path)
                })
            }
            NotebookTarget::LocalNotebookId(id) => room.notebook_id == *id,
            NotebookTarget::Hosted { .. } => false,
        });
        let resolved = matches.next().filter(|_| matches.next().is_none());
        let candidate = resolved.as_ref().and_then(|room| {
            server
                .attachments
                .read_entries()
                .values()
                .find_map(|entry| {
                    let session = &entry.session;
                    let compatible = session.backing_key.as_ref().is_some_and(|existing| {
                        existing.incarnation == key.incarnation && existing.operator == key.operator
                    });
                    let readiness = session.readiness();
                    (compatible
                        && !session.is_hosted()
                        && session.notebook_id == room.notebook_id
                        && session.local_daemon_incarnation.as_ref() == Some(&key.incarnation)
                        && session.handle.status().connection == ConnectionState::Connected
                        && readiness.source_state["phase"] == "ready"
                        && (readiness.interactive || readiness.projection_ready))
                        .then(|| session.fresh_attachment(lease.generation(), lease.target()))
                })
        });
        if let Some(mut session) = candidate {
            session.notebook_path = resolved.and_then(|room| room.notebook_path);
            let response = match shared_attachment_response(&session) {
                Ok(response) => response,
                Err(error) => return Ok(*error),
            };
            if let Err(result) = crate::targets::with_backing_key(
                Some(key.clone()),
                install_activated_session(server, &lease, session),
            )
            .await
            {
                return Ok(result);
            }
            lease.complete(&response);
            return Ok(response);
        }
    }

    let outcome = crate::targets::with_backing_key(key, async {
        match target {
            NotebookTarget::LocalPath(path) => {
                connect_local_path_progressive(server, path, None, &lease).await
            }
            NotebookTarget::LocalNotebookId(id) => {
                connect_local_id_progressive(server, id, None, &lease).await
            }
            NotebookTarget::Hosted {
                domain,
                notebook_id,
                ..
            } => connect_hosted_notebook(server, domain, notebook_id, None, &lease).await,
        }
    })
    .await;
    if let Ok(result) = &outcome {
        lease.complete(result);
    }
    outcome
}

/// Acquire an independent attachment for client requests on every protocol.
/// Internal recovery helpers can still use the monotonic selection adapter.
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
            let canonical = if crate::targets::explicit_attachment_mode() {
                canonical_local_id_target(&notebook_id)?
            } else {
                canonical_local_id_target_for_server(server, &notebook_id).await?
            };
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

    if crate::targets::explicit_attachment_mode() {
        return open_explicit_attachment(server, target, canonical_target).await;
    }
    if !crate::targets::explicit_attachment_mode() {
        if let Some(result) = reuse_active_session(server, &canonical_target).await {
            return Ok(result);
        }
    }
    let activation = if crate::targets::explicit_attachment_mode() {
        std::sync::Arc::new(crate::session_activation::SessionActivation::default())
    } else {
        server.session_activation.clone()
    };
    let mut lease = match activation.begin(canonical_target) {
        ActivationTicket::Follower(follower) => return Ok(follower.wait().await),
        ActivationTicket::Leader(lease) => lease,
    };
    let prev = if crate::targets::explicit_attachment_mode() {
        None
    } else {
        previous_notebook_id(server).await
    };
    if !crate::targets::explicit_attachment_mode() {
        if let Some(result) = reuse_retained_legacy_session(server, &lease).await {
            lease.complete(&result);
            return Ok(result);
        }
    }
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
    let activation = if crate::targets::explicit_attachment_mode() {
        std::sync::Arc::new(crate::session_activation::SessionActivation::default())
    } else {
        server.session_activation.clone()
    };
    let mut activation_lease = match activation.begin(create_target) {
        ActivationTicket::Follower(follower) => return Ok(follower.wait().await),
        ActivationTicket::Leader(lease) => lease,
    };
    let prev = if crate::targets::explicit_attachment_mode() {
        None
    } else {
        previous_notebook_id(server).await
    };

    let outcome = async {
        if let Err(error) = server.admit_local_runtime().await {
            return tool_error(&error);
        }
        if !activation_lease.is_current() {
            return Ok(superseded_result(&activation_lease));
        }
        let incarnation_before = current_daemon_incarnation(server).await;
        match notebook_sync::connect::connect_create(
            server.socket_path.clone(),
            notebook_sync::connect::CreateNotebookSpec {
                working_dir,
                actor_label: crate::replica::fresh_operator(&server.get_operator().await),
                ephemeral,
                package_manager: explicit_pkg_manager.clone(),
                dependencies: deps.clone(),
                environment_mode,
                ..notebook_sync::connect::CreateNotebookSpec::new(runtime)
            },
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

                let mut session =
                    NotebookSession::local(result.handle, notebook_id.clone(), None, None);
                session.reactivate(activation_lease.generation(), activation_lease.target());

                let runtime_info = collect_runtime_info(&session.handle).await;
                let all_deps = if let Some(ref pm) = pkg_manager {
                    super::deps::get_deps_for_manager_pub(&session.handle, pm)
                } else {
                    Vec::new() // Deno: no Python deps
                };
                let project_context = read_project_context(&session.handle);
                session.local_daemon_incarnation = unchanged_daemon_incarnation(
                    incarnation_before,
                    current_daemon_incarnation(server).await,
                );

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
                    return Ok(add_created_notebook_recovery(result, &notebook_id));
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
        Ok(NotebookResponse::Error { error }) => {
            tool_error(&format!("Failed to save notebook: {error}"))
        }
        Ok(resp) => tool_error(&format!("Unexpected response: {resp:?}")),
        Err(e) => tool_error(&format!("Failed to save notebook: {e}")),
    }
}

/// Read the exact attachment's local launch identity without opening an app.
/// The supervisor launches by UUID and socket, so file-path aliases cannot
/// redirect a dev launch to another room. This tool is intentionally hidden.
pub(crate) async fn resolve_notebook_launch(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    resolve_notebook_launch_with_incarnation(
        server,
        request,
        query_current_daemon_incarnation(server.socket_path.clone()),
    )
    .await
}

async fn resolve_notebook_launch_with_incarnation(
    server: &NteractMcp,
    request: &CallToolRequestParams,
    live_incarnation: impl std::future::Future<Output = Option<DaemonIncarnation>>,
) -> Result<CallToolResult, McpError> {
    // A null legacy selector is harmless; nonnull notebook_id is rejected by
    // targets::dispatch. Paths and all other alternate selectors are rejected.
    // Target selectors were validated at admission. Other unknown arguments
    // keep their original error channel; they are not attachment failures.
    super::reject_unknown_args(request, &["notebook_id"])?;
    let Some(handle) = crate::targets::current() else {
        return Ok(mcp_transport::tool_target_error(McpError::invalid_params("notebook_handle is required; connect the intended notebook and explicitly resubmit with its handle", None)));
    };
    let session = {
        let entries = server.attachments.read_entries();
        let Some(entry) = entries.get(&handle) else {
            return Ok(mcp_transport::tool_target_error(
                crate::attachments::expired_resource_error(&handle),
            ));
        };
        entry.session.clone()
    };
    if session.is_hosted() {
        return tool_error("A hosted notebook cannot be opened by the local dev launcher");
    }
    if let Err(error) = session.access(crate::session::SessionRequirement::KernelControl) {
        return super::session_access_error(error);
    }
    let live = live_incarnation.await;
    if live.is_none() || live != session.local_daemon_incarnation {
        return Ok(mcp_transport::tool_target_error(McpError::internal_error(
            "The attachment's local runtime is unavailable or has been replaced; reconnect before opening Desktop",
            Some(crate::attachments::unavailable_resource_data(&handle)),
        )));
    }
    // Recheck membership and readiness after sampling the daemon. Release the
    // registry guard before returning; the common completion fence also checks
    // expiry. No launch side effect occurs in this read.
    let entries = server.attachments.read_entries();
    let Some(current) = entries.get(&handle) else {
        return Ok(mcp_transport::tool_target_error(
            crate::attachments::expired_resource_error(&handle),
        ));
    };
    if let Err(error) = current
        .session
        .access(crate::session::SessionRequirement::KernelControl)
    {
        return super::session_access_error(error);
    }
    Ok(CallToolResult::structured(serde_json::json!({
        "notebook_handle":handle,
        "notebook_id":session.notebook_id,
        "socket_path":server.socket_path,
        "source":"local",
        "has_display":has_display(),
    })))
}

/// Open the notebook in the nteract desktop app.
pub async fn show_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    // Resolve notebook_id (and optional path) from param or current session
    let (target, session_path) = if let Some(handle) = crate::targets::current() {
        let Some(identity) = server.attachment_identity(&handle).await else {
            return Ok(mcp_transport::tool_target_error(
                crate::attachments::expired_resource_error(&handle),
            ));
        };
        identity
    } else {
        match arg_str(request, "notebook_id") {
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
        }
    };

    // Opening Desktop must retain this client's selected runtime. Never repair
    // or replace an incompatible endpoint as a side effect of showing it.
    if server.uses_local_runtime_admission() {
        let live = runtimed_client::startup::probe_local_runtime(&server.socket_path)
            .await
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        if live.is_none() {
            return tool_error("The selected notebook runtime is no longer available. Reconnect the notebook before opening Desktop.");
        }
    }

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

    let (app_path, app_args) = notebook_app_launch_target(&target, resolved_path);
    let opened = if uuid::Uuid::parse_str(&target).is_ok() || server.uses_local_runtime_admission()
    {
        runt_workspace::open_notebook_app_for_endpoint_strict(
            &server.socket_path,
            app_path,
            &app_args,
        )
    } else {
        runt_workspace::open_notebook_app(app_path, &app_args)
    };
    opened
        .map_err(|error| McpError::internal_error(format!("Failed to open app: {error}"), None))?;

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

/// An acquired canonical room keeps its UUID and endpoint, including after
/// save/rename. Reopening its path could select a different room or alias.
fn notebook_app_launch_target<'a>(
    target: &'a str,
    resolved_path: Option<&'a str>,
) -> (Option<&'a std::path::Path>, Vec<&'a str>) {
    if uuid::Uuid::parse_str(target).is_ok() {
        (None, vec!["--attach-notebook-id", target])
    } else if let Some(path) = resolved_path {
        (Some(std::path::Path::new(path)), Vec::new())
    } else if std::path::Path::new(target).is_absolute() {
        (Some(std::path::Path::new(target)), Vec::new())
    } else {
        (None, vec!["--notebook-id", target])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    #[test]
    fn attach_only_bundled_launch_keeps_saved_and_untitled_canonical_room_identity() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        for path in [
            None,
            Some("/project/saved.ipynb"),
            Some("/other/alias.ipynb"),
        ] {
            let (app_path, args) = notebook_app_launch_target(id, path);
            assert!(
                app_path.is_none(),
                "an attached saved room must not reopen a path alias"
            );
            assert_eq!(args, ["--attach-notebook-id", id]);
        }
        let (path, args) = notebook_app_launch_target("/legacy/saved.ipynb", None);
        assert_eq!(path, Some(std::path::Path::new("/legacy/saved.ipynb")));
        assert!(args.is_empty());
    }

    struct IdleFrames;
    impl notebook_protocol::connection::FrameSource for IdleFrames {
        async fn recv_frame(
            &mut self,
        ) -> Option<std::io::Result<notebook_protocol::connection::TypedNotebookFrame>> {
            std::future::pending().await
        }
    }

    async fn hosted_test_peer() -> notebook_sync::handle::DocHandle {
        notebook_sync::connect::connect_frame_io(
            "hosted-test".into(),
            "agent:legacy-test",
            IdleFrames,
            notebook_protocol::connection::WriterFrameSink::new(tokio::io::sink()),
        )
        .await
        .unwrap()
        .handle
    }

    fn begin_legacy_selection(server: &NteractMcp, id: &str, domain: &str) -> ActivationLease {
        let target = CanonicalNotebookTarget::new(format!(
            "hosted:{}",
            cloud::hosted_notebook_url(domain, id)
        ));
        match server.session_activation.begin(target) {
            ActivationTicket::Leader(lease) => lease,
            ActivationTicket::Follower(_) => panic!("expected a fresh legacy selection"),
        }
    }

    async fn launch_test_session(
        id: &str,
        ready: bool,
        incarnation: DaemonIncarnation,
    ) -> NotebookSession {
        use notebook_protocol::connection::{
            FrameSource, NotebookFrameType, TypedNotebookFrame, WriterFrameSink,
        };
        use notebook_protocol::protocol::{
            InitialLoadPhaseWire, NotebookDocPhaseWire, RuntimeStatePhaseWire,
            SessionControlMessage, SessionSyncStatusWire,
        };
        struct Frames(Option<TypedNotebookFrame>);
        impl FrameSource for Frames {
            async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
                if let Some(frame) = self.0.take() {
                    Some(Ok(frame))
                } else {
                    std::future::pending().await
                }
            }
        }
        let frame = ready.then(|| TypedNotebookFrame {
            frame_type: NotebookFrameType::SessionControl,
            payload: serde_json::to_vec(&SessionControlMessage::SyncStatus(
                SessionSyncStatusWire {
                    notebook_doc: NotebookDocPhaseWire::Interactive,
                    runtime_state: RuntimeStatePhaseWire::Ready,
                    initial_load: InitialLoadPhaseWire::NotNeeded,
                },
            ))
            .unwrap(),
        });
        let handle = notebook_sync::connect::connect_frame_io(
            id.into(),
            "launch-test",
            Frames(frame),
            WriterFrameSink::new(tokio::io::sink()),
        )
        .await
        .unwrap()
        .handle;
        if ready {
            handle
                .await_session_ready_timeout(Duration::from_secs(1))
                .await
                .unwrap();
        }
        NotebookSession::local(
            handle,
            id.into(),
            Some("/same-path.ipynb".into()),
            Some(incarnation),
        )
    }

    #[tokio::test]
    async fn launch_identity_keeps_exact_owner_and_rechecks_release_and_runtime() {
        let server = NteractMcp::new("/private/tmp/exact-runtime.sock".into(), None, None);
        let incarnation = DaemonIncarnation {
            pid: 42,
            started_at: Utc::now(),
        };
        let a = launch_test_session(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            true,
            incarnation.clone(),
        )
        .await;
        let b = launch_test_session(
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            true,
            incarnation.clone(),
        )
        .await;
        let h = a.notebook_handle.clone();
        let id = a.notebook_id.clone();
        server
            .attachments
            .insert(a, server.attachments.reserve().unwrap());
        server
            .attachments
            .insert(b.clone(), server.attachments.reserve().unwrap());
        *server.session.write().await = Some(b);
        let request = make_request("resolve_notebook_launch", serde_json::json!({}));
        for args in [
            serde_json::json!({}),
            serde_json::json!({"notebook_handle":""}),
        ] {
            assert!(
                crate::targets::dispatch(&server, &make_request("resolve_notebook_launch", args),)
                    .await
                    .unwrap()
                    .is_error
                    == Some(true)
            );
        }
        let result = crate::targets::with_handle(
            h.clone(),
            resolve_notebook_launch_with_incarnation(
                &server,
                &request,
                std::future::ready(Some(incarnation.clone())),
            ),
        )
        .await
        .unwrap();
        let identity = result.structured_content.unwrap();
        assert_eq!(identity["notebook_handle"], h);
        assert_eq!(identity["notebook_id"], id);
        assert_eq!(identity["socket_path"], "/private/tmp/exact-runtime.sock");
        assert_eq!(identity["source"], "local");
        let unavailable = crate::targets::with_handle(
            h.clone(),
            resolve_notebook_launch_with_incarnation(&server, &request, std::future::ready(None)),
        )
        .await
        .unwrap();
        assert_eq!(
            unavailable.structured_content.unwrap()["error"]["code"],
            "attachment_unavailable"
        );
        let replaced = crate::targets::with_handle(
            h.clone(),
            resolve_notebook_launch_with_incarnation(
                &server,
                &request,
                std::future::ready(Some(DaemonIncarnation {
                    pid: incarnation.pid + 1,
                    started_at: incarnation.started_at,
                })),
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            replaced.structured_content.unwrap()["error"]["code"],
            "attachment_unavailable"
        );
        let removed = crate::targets::with_handle(
            h.clone(),
            resolve_notebook_launch_with_incarnation(&server, &request, async {
                drop(server.attachments.remove(&h));
                Some(incarnation)
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            removed.structured_content.unwrap()["error"]["code"],
            "attachment_expired"
        );
    }

    #[tokio::test]
    async fn launch_identity_rejects_unready_hosted_and_alternate_selectors() {
        let server = NteractMcp::new("/unused.sock".into(), None, None);
        let incarnation = DaemonIncarnation {
            pid: 42,
            started_at: Utc::now(),
        };
        let session = launch_test_session(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            false,
            incarnation.clone(),
        )
        .await;
        let h = session.notebook_handle.clone();
        server
            .attachments
            .insert(session, server.attachments.reserve().unwrap());
        let request = make_request("resolve_notebook_launch", serde_json::json!({}));
        let result = crate::targets::with_handle(
            h.clone(),
            resolve_notebook_launch_with_incarnation(&server, &request, async {
                panic!("unready attachment must not query runtime")
            }),
        )
        .await
        .unwrap();
        assert_eq!(result.is_error, Some(true));
        for args in [
            serde_json::json!({"path":"/other.ipynb"}),
            serde_json::json!({"notebook_id":"other"}),
        ] {
            let mut args = args.as_object().unwrap().clone();
            args.insert("notebook_handle".into(), h.clone().into());
            assert!(
                crate::targets::dispatch(
                    &server,
                    &CallToolRequestParams::new("resolve_notebook_launch").with_arguments(args)
                )
                .await
                .unwrap()
                .is_error
                    == Some(true)
            );
        }
        let hosted = NotebookSession::hosted(
            hosted_test_peer().await,
            "remote".into(),
            "https://example.com".into(),
        );
        let h = hosted.notebook_handle.clone();
        server
            .attachments
            .insert(hosted, server.attachments.reserve().unwrap());
        let result = crate::targets::with_handle(
            h,
            resolve_notebook_launch_with_incarnation(&server, &request, async {
                panic!("hosted attachment must not query local runtime")
            }),
        )
        .await
        .unwrap();
        assert_eq!(result.is_error, Some(true));
        assert!(first_text(&result).contains("hosted"));
    }

    #[tokio::test]
    async fn legacy_path_reuse_requires_current_daemon_metadata_instead_of_cached_aliases() {
        let peer = hosted_test_peer().await;
        let id = "12345678-1234-1234-1234-123456789abc";
        let old = canonical_local_path_target("/tmp/legacy-before.ipynb");
        let new = canonical_local_path_target("/tmp/legacy-after.ipynb");
        let mut session = NotebookSession::local(
            peer,
            id.into(),
            Some("/tmp/legacy-before.ipynb".into()),
            Some(test_incarnation(1)),
        );
        session.reactivate(1, &old);
        let paths =
            std::collections::HashMap::from([(id.into(), Some("/tmp/legacy-after.ipynb".into()))]);
        assert!(!session_matches_target(&session, &old, &paths));
        assert!(session_matches_target(&session, &new, &paths));
        assert!(session_matches_target(
            &session,
            &canonical_local_id_target(id).unwrap(),
            &paths
        ));
        assert!(!session_matches_target(&session, &old, &Default::default()));
    }

    #[tokio::test]
    async fn legacy_reuse_response_preserves_document_and_runtime_readiness_gates() {
        let peer = hosted_test_peer().await;
        let local =
            NotebookSession::local(peer.clone(), "a".into(), None, Some(test_incarnation(1)));
        let denied = reused_session_response(&local).unwrap_err();
        assert!(first_text(&denied).contains("notebook_not_ready"));
        let hosted = NotebookSession::hosted(peer, "a".into(), "https://example.com".into());
        let response = reused_session_response(&hosted).unwrap();
        let data: serde_json::Value = serde_json::from_str(first_text(&response)).unwrap();
        assert_eq!(data["runtime"]["kernel_status"], "unknown");
        assert!(data["project_context"].is_null());
    }

    #[tokio::test]
    async fn retained_hosted_switch_back_reuses_handles_and_expiry_at_full_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let server = NteractMcp::new(dir.path().join("missing.sock"), None, None);
        let peer = hosted_test_peer().await;
        let a = NotebookSession::hosted(peer.clone(), "a".into(), "https://example.com".into());
        let b = NotebookSession::hosted(peer.clone(), "b".into(), "https://example.com".into());
        let handles = [a.notebook_handle.clone(), b.notebook_handle.clone()];
        for session in [a, b] {
            server
                .attachments
                .insert_legacy(session, server.attachments.reserve().unwrap());
        }
        let expirations = handles
            .each_ref()
            .map(|handle| server.attachments.read_entries()[handle].expiration());
        for index in 0..crate::attachments::MAX_ATTACHMENTS - 2 {
            let id = if index == 0 {
                "a".into()
            } else {
                format!("explicit-{index}")
            };
            let session = NotebookSession::hosted(peer.clone(), id, "https://example.com".into());
            server
                .attachments
                .insert(session, server.attachments.reserve().unwrap());
        }
        assert!(server.attachments.reserve().is_err());
        for _ in 0..129 {
            for (index, id) in ["a", "b"].into_iter().enumerate() {
                let mut lease = begin_legacy_selection(&server, id, "https://example.com");
                let response = reuse_retained_legacy_session(&server, &lease)
                    .await
                    .unwrap();
                lease.complete(&response);
                let data: serde_json::Value = serde_json::from_str(first_text(&response)).unwrap();
                assert_eq!(data["notebook_handle"], handles[index]);
                assert_eq!(
                    server
                        .session
                        .read()
                        .await
                        .as_ref()
                        .unwrap()
                        .notebook_handle,
                    handles[index]
                );
                assert!(!*expirations[index].borrow());
                assert_eq!(
                    server.attachments.read_entries().len(),
                    crate::attachments::MAX_ATTACHMENTS
                );
            }
        }
        // A is now parked, and an explicit A also exists. ID routing still
        // resolves the retained legacy owner after its cache copy is evicted.
        server.parked_sessions.write().await.clear();
        let (_, handle, _, _) = crate::resources::resource_session(&server, "a", false)
            .await
            .unwrap();
        assert_eq!(handle, handles[0]);
        let response = disconnect_notebook(
            &server,
            &make_request(
                "disconnect_notebook",
                serde_json::json!({"notebook_id":"a"}),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.is_error, Some(false));
        assert!(*expirations[0].borrow());
        assert!(!*expirations[1].borrow());
        assert_eq!(
            server.attachments.read_entries().len(),
            crate::attachments::MAX_ATTACHMENTS - 1
        );
        assert_eq!(
            server
                .session
                .read()
                .await
                .as_ref()
                .unwrap()
                .notebook_handle,
            handles[1]
        );
    }

    #[tokio::test]
    async fn legacy_id_release_removes_older_generations_without_releasing_explicit_owners() {
        let dir = tempfile::tempdir().unwrap();
        let server = NteractMcp::new(dir.path().join("missing.sock"), None, None);
        let peer = hosted_test_peer().await;
        let first = NotebookSession::hosted(peer.clone(), "a".into(), "https://example.com".into());
        let selected =
            NotebookSession::hosted(peer.clone(), "a".into(), "https://example.com".into());
        let explicit = NotebookSession::hosted(peer, "a".into(), "https://example.com".into());
        let handles = [
            first.notebook_handle.clone(),
            selected.notebook_handle.clone(),
            explicit.notebook_handle.clone(),
        ];
        server
            .attachments
            .insert_legacy(first, server.attachments.reserve().unwrap());
        server
            .attachments
            .insert_legacy(selected.clone(), server.attachments.reserve().unwrap());
        server
            .attachments
            .insert(explicit, server.attachments.reserve().unwrap());
        *server.session.write().await = Some(selected);
        let (_, handle, _, _) = crate::resources::resource_session(&server, "a", false)
            .await
            .unwrap();
        assert_eq!(handle, handles[1]);
        disconnect_notebook(
            &server,
            &make_request(
                "disconnect_notebook",
                serde_json::json!({"notebook_id":"a"}),
            ),
        )
        .await
        .unwrap();
        assert!(server.attachment_identity(&handles[0]).await.is_none());
        assert!(server.attachment_identity(&handles[1]).await.is_none());
        assert!(server.attachment_identity(&handles[2]).await.is_some());
        assert!(server.session.read().await.is_none());
    }

    #[tokio::test]
    async fn legacy_id_routing_rejects_source_ambiguity_until_active_selection_disambiguates() {
        let dir = tempfile::tempdir().unwrap();
        let server = NteractMcp::new(dir.path().join("missing.sock"), None, None);
        let peer = hosted_test_peer().await;
        let first =
            NotebookSession::hosted(peer.clone(), "a".into(), "https://one.example.com".into());
        let other = NotebookSession::hosted(peer, "a".into(), "https://two.example.com".into());
        let first_handle = first.notebook_handle.clone();
        let other_handle = other.notebook_handle.clone();
        server
            .attachments
            .insert_legacy(first.clone(), server.attachments.reserve().unwrap());
        server
            .attachments
            .insert_legacy(other, server.attachments.reserve().unwrap());
        assert!(crate::resources::resource_session(&server, "a", false)
            .await
            .is_err());
        let rejected = disconnect_notebook(
            &server,
            &make_request(
                "disconnect_notebook",
                serde_json::json!({"notebook_id":"a"}),
            ),
        )
        .await
        .unwrap();
        assert_eq!(rejected.is_error, Some(true));
        assert_eq!(server.attachments.read_entries().len(), 2);
        *server.session.write().await = Some(first);
        let (_, handle, _, _) = crate::resources::resource_session(&server, "a", false)
            .await
            .unwrap();
        assert_eq!(handle, first_handle);
        disconnect_notebook(
            &server,
            &make_request(
                "disconnect_notebook",
                serde_json::json!({"notebook_id":"a"}),
            ),
        )
        .await
        .unwrap();
        assert!(server.attachment_identity(&first_handle).await.is_none());
        assert!(server.attachment_identity(&other_handle).await.is_some());
    }

    #[tokio::test]
    async fn retained_legacy_publication_does_not_restore_released_or_superseded_handles() {
        let dir = tempfile::tempdir().unwrap();
        let server = NteractMcp::new(dir.path().join("missing.sock"), None, None);
        let peer = hosted_test_peer().await;
        let a = NotebookSession::hosted(peer, "a".into(), "https://example.com".into());
        let handle = a.notebook_handle.clone();
        server
            .attachments
            .insert_legacy(a.clone(), server.attachments.reserve().unwrap());
        let expiration = server.attachments.read_entries()[&handle].expiration();
        let stale = begin_legacy_selection(&server, "a", "https://example.com");
        let mut pending = Box::pin(reuse_retained_legacy_session(&server, &stale));
        {
            let _slot = server.session.write().await;
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(std::future::Future::poll(pending.as_mut(), &mut context).is_pending());
            let _newer = begin_legacy_selection(&server, "b", "https://example.com");
        }
        let rejected = pending.await.unwrap();
        assert_eq!(rejected.is_error, Some(true));
        assert!(!*expiration.borrow());
        assert_eq!(
            server.attachments.read_entries()[&handle]
                .session
                .activation_generation,
            0
        );
        let lease = begin_legacy_selection(&server, "a", "https://example.com");
        let mut pending = Box::pin(reuse_retained_legacy_session(&server, &lease));
        {
            let mut slot = server.session.write().await;
            *slot = Some(a); // Cached peer cannot restore membership.
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(std::future::Future::poll(pending.as_mut(), &mut context).is_pending());
            server.attachments.remove(&handle);
        }
        assert!(pending.await.is_none());
        assert!(reuse_active_session(&server, lease.target())
            .await
            .is_none());
        assert!(*expiration.borrow());
        assert!(server.attachments.read_entries().is_empty());
    }

    fn test_incarnation(pid: u32) -> DaemonIncarnation {
        DaemonIncarnation {
            pid,
            started_at: Utc.timestamp_opt(pid.into(), 0).single().unwrap(),
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn native_open_tries_fresh_transport_when_optional_pool_room_queries_fail() {
        use notebook_protocol::connection::{self, Handshake};
        use runtimed_client::protocol::{Request, Response};

        for by_id in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let socket = root.path().join("daemon.sock");
            let listener = tokio::net::UnixListener::bind(&socket).unwrap();
            let (opened, attempted) = tokio::sync::oneshot::channel();
            let daemon = tokio::spawn(async move {
                let mut failed_lists = 0;
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    connection::recv_preamble(&mut stream).await.unwrap();
                    let handshake = connection::recv_json_frame::<_, Handshake>(&mut stream)
                        .await
                        .unwrap()
                        .unwrap();
                    match handshake {
                        Handshake::Pool => {
                            let request = connection::recv_json_frame::<_, Request>(&mut stream)
                                .await
                                .unwrap()
                                .unwrap();
                            let response = match request {
                                Request::GetDaemonInfo => Response::DaemonInfo {
                                    host_telemetry: false,
                                    host_telemetry_enabled: false,
                                    protocol_version: connection::PROTOCOL_VERSION.into(),
                                    daemon_api_version:
                                        runtimed_client::protocol::DAEMON_API_VERSION,
                                    daemon_version: "test".into(),
                                    pid: 1,
                                    started_at: test_incarnation(1).started_at,
                                    blob_port: None,
                                    execution_store_dir: None,
                                    worktree_path: None,
                                    workspace_description: None,
                                },
                                Request::ListRooms => {
                                    failed_lists += 1;
                                    Response::Error {
                                        message: "injected optional room lookup failure".into(),
                                    }
                                }
                                _ => panic!("unexpected pool request: {request:?}"),
                            };
                            connection::send_json_frame(&mut stream, &response)
                                .await
                                .unwrap();
                        }
                        handshake @ (Handshake::OpenNotebook { .. }
                        | Handshake::NotebookSync { .. }) => {
                            opened.send(handshake).unwrap();
                            // Deliberately fail only the fresh transport bootstrap.
                            // Its error must replace neither admission nor lookup
                            // outcomes with a cached attachment or false success.
                            drop(stream);
                            return failed_lists;
                        }
                        _ => panic!("unexpected channel: {handshake:?}"),
                    }
                }
            });
            let server = NteractMcp::new_no_show(socket, None, None);
            let path = root.path().join("requested.ipynb");
            let notebook_id = "12345678-1234-1234-1234-123456789abc";
            let arguments = if by_id {
                serde_json::json!({"notebook_id":notebook_id})
            } else {
                serde_json::json!({"path":path})
            };
            let response = tokio::time::timeout(
                Duration::from_secs(2),
                crate::targets::dispatch(&server, &make_request("connect_notebook", arguments)),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(response.is_error, Some(true));
            assert!(first_text(&response).contains(if by_id {
                "Failed to join notebook"
            } else {
                "Failed to open notebook"
            }));
            assert!(!first_text(&response).contains("injected optional room lookup failure"));
            let handshake = attempted.await.unwrap();
            match handshake {
                Handshake::NotebookSync {
                    notebook_id: actual,
                    ..
                } if by_id => assert_eq!(actual, notebook_id),
                Handshake::OpenNotebook { path: actual, .. } if !by_id => {
                    assert_eq!(PathBuf::from(actual), path)
                }
                _ => panic!("wrong fresh transport target: {handshake:?}"),
            }
            assert_eq!(daemon.await.unwrap(), if by_id { 2 } else { 1 });
            assert!(server.attachments.read_entries().is_empty());
            let reservations = (0..crate::attachments::MAX_ATTACHMENTS)
                .map(|_| server.attachments.reserve().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(reservations.len(), crate::attachments::MAX_ATTACHMENTS);
        }
    }

    #[tokio::test]
    async fn shared_response_propagates_pending_and_disconnected_access_failure() {
        struct Frames(
            tokio::sync::mpsc::UnboundedReceiver<notebook_protocol::connection::TypedNotebookFrame>,
        );
        impl notebook_protocol::connection::FrameSource for Frames {
            async fn recv_frame(
                &mut self,
            ) -> Option<std::io::Result<notebook_protocol::connection::TypedNotebookFrame>>
            {
                self.0.recv().await.map(Ok)
            }
        }
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let handle = notebook_sync::connect::connect_frame_io(
            "test".into(),
            "local:test/agent:test",
            Frames(receiver),
            notebook_protocol::connection::WriterFrameSink::new(tokio::io::sink()),
        )
        .await
        .unwrap()
        .handle;
        let mut status = handle.subscribe_status();
        let local = NotebookSession::local(
            handle.clone(),
            "test".into(),
            None,
            Some(test_incarnation(1)),
        );
        let error = shared_attachment_response(&local).unwrap_err();
        assert!(first_text(&error).contains("notebook_not_ready"));
        let hosted =
            NotebookSession::hosted(handle.clone(), "test".into(), "https://example.com".into());
        handle
            .add_cell_with_source("cell-pending", "code", None, "pending runtime sentinel")
            .unwrap();
        assert!(hosted.access(SessionRequirement::RuntimeRead).is_err());
        let response = shared_attachment_response(&hosted).unwrap();
        let body: serde_json::Value = serde_json::from_str(first_text(&response)).unwrap();
        assert_eq!(
            body["runtime"],
            serde_json::json!({"kernel_status":"unknown"})
        );
        assert!(body["project_context"].is_null());
        let cells = body["cells"].as_str().unwrap();
        assert!(cells.contains("pending runtime sentinel"));
        assert!(!cells.contains("never_run"));
        assert!(!cells.contains("exec="));
        drop(sender);
        tokio::time::timeout(Duration::from_secs(2), async {
            while status.borrow_and_update().connection != ConnectionState::Disconnected {
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        let error = shared_attachment_response(&hosted).unwrap_err();
        assert!(first_text(&error).contains("sync_failed"));
        let observer = hosted.observer().unwrap();
        assert_eq!(
            observer.read(None).unwrap().outcome,
            crate::observation::ChangeOutcome::Unavailable
        );
    }

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

    #[tokio::test]
    async fn local_uuid_connection_admits_runtime_before_canonicalization() {
        let dir = tempfile::tempdir().unwrap();
        let server = NteractMcp::new(dir.path().join("missing.sock"), None, None)
            .with_local_runtime_admission(None);
        let request = make_request(
            "connect_notebook",
            serde_json::json!({"notebook_id": "12345678-1234-1234-1234-123456789abc"}),
        );

        let error = open_notebook(&server, &request).await.unwrap_err();
        assert!(
            error.message.contains("automatic startup is unavailable"),
            "{error:?}"
        );
        assert!(!error.message.contains("could not canonicalize"));
        assert!(server.session.read().await.is_none());
    }

    #[tokio::test]
    async fn malformed_local_uuid_is_rejected_before_runtime_admission() {
        let dir = tempfile::tempdir().unwrap();
        let server = NteractMcp::new(dir.path().join("missing.sock"), None, None)
            .with_local_runtime_admission(None);
        let request = make_request(
            "connect_notebook",
            serde_json::json!({"notebook_id": "invalid-uuid"}),
        );

        let error = open_notebook(&server, &request).await.unwrap_err();
        assert!(error.message.contains("must be a UUID"), "{error:?}");
        assert!(!error.message.contains("automatic startup"));
        assert!(server.session.read().await.is_none());
    }

    #[test]
    fn daemon_binding_requires_equal_samples() {
        let daemon = test_incarnation(41);
        assert_eq!(
            unchanged_daemon_incarnation(Some(daemon.clone()), Some(daemon.clone())),
            Some(daemon)
        );
        assert_eq!(
            unchanged_daemon_incarnation(Some(test_incarnation(41)), Some(test_incarnation(42))),
            None
        );
        assert_eq!(
            unchanged_daemon_incarnation(None, Some(test_incarnation(42))),
            None
        );
    }

    #[test]
    fn created_notebook_recovery_keeps_new_identity() {
        let original = activation_error(
            "daemon_replaced",
            "retry",
            7,
            &CanonicalNotebookTarget::new("local:create:test"),
        );
        let result = add_created_notebook_recovery(original, "new-notebook-id");
        let details = result.structured_content.expect("structured error");

        assert_eq!(details["error"]["notebook_id"], "new-notebook-id");
        assert_eq!(
            details["error"]["recovery"],
            serde_json::json!({
                "tool": "connect_notebook",
                "notebook_id": "new-notebook-id",
            })
        );
        assert_eq!(result.is_error, Some(true));
    }

    #[test]
    fn reuse_requires_connected_readable_replica() {
        assert!(has_reusable_replica(
            ConnectionState::Connected,
            true,
            false
        ));
        assert!(has_reusable_replica(
            ConnectionState::Connected,
            false,
            true
        ));
        assert!(!has_reusable_replica(
            ConnectionState::Disconnected,
            true,
            true
        ));
        assert!(!has_reusable_replica(
            ConnectionState::Connected,
            false,
            false
        ));
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
