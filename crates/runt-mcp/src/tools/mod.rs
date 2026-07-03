//! MCP tool definitions and dispatch.

use std::sync::Arc;

use rmcp::model::{CallToolRequestParams, CallToolResult, Content, Meta, Tool, ToolAnnotations};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::NteractMcp;

/// Acquire the active session's `DocHandle`, or early-return a "no session" tool error.
/// Clones the handle and drops the session read-lock so other tools aren't blocked.
///
/// When the session was previously active but dropped, the error includes
/// the *reason* (evicted, disconnected, switched) and the *notebook_id*
/// so agents can recover in one turn via `connect_notebook`.
macro_rules! require_handle {
    ($server:expr) => {{
        let guard = $server.session.read().await;
        match guard.as_ref() {
            Some(s) => s.handle.clone(),
            None => {
                drop(guard);
                return $crate::tools::no_session_error($server).await;
            }
        }
    }};
}

/// The MCP Apps resource URI for the output widget.
const OUTPUT_RESOURCE_URI: &str = "ui://nteract/output.html";

/// Build `_meta` for tools that produce structured content for the MCP Apps widget.
/// Wire format: `{ "ui": { "resourceUri": "ui://nteract/output.html" } }`
fn app_tool_meta() -> Meta {
    let mut meta = serde_json::Map::new();
    meta.insert(
        "ui".to_string(),
        serde_json::json!({ "resourceUri": OUTPUT_RESOURCE_URI }),
    );
    Meta(meta)
}

/// Build `_meta` that opts a tool out of deferred-tool lists in Claude clients.
/// Claude Code / Desktop / Cowork defer all MCP tools by default; setting
/// `"anthropic/alwaysLoad": true` makes the tool immediately available
/// without requiring a ToolSearch round-trip.
fn always_load_meta() -> Meta {
    let mut meta = serde_json::Map::new();
    meta.insert("anthropic/alwaysLoad".to_string(), serde_json::json!(true));
    Meta(meta)
}

fn cell_resource_content(notebook_id: &str, cell_id: &str) -> Content {
    Content::resource_link(crate::resources::notebook_cell_resource_link(
        notebook_id,
        cell_id,
    ))
}

mod cell_crud;
mod cell_meta;
pub(crate) mod cell_read;
mod comments;
mod deps;
mod editing;
mod execution;
mod kernel;
mod session;

/// Helper to generate a tool's input schema from a type.
fn schema_for<T: JsonSchema>() -> Arc<serde_json::Map<String, serde_json::Value>> {
    #[allow(clippy::unwrap_used)] // schemars always produces valid JSON
    let value = serde_json::to_value(schemars::schema_for!(T)).unwrap();
    #[allow(clippy::unwrap_used)]
    Arc::new(value.as_object().cloned().unwrap_or_default())
}

/// Empty params for tools that take no arguments.
#[derive(Debug, Deserialize, JsonSchema)]
struct EmptyParams {}

/// Return all registered tools.
///
/// Annotation semantics (from MCP spec):
/// - `read_only` — tool does not modify its environment
/// - `destructive` — tool may perform destructive (irreversible) updates
///   (only meaningful when read_only is false)
/// - `idempotent` — calling repeatedly with the same args has no additional effect
/// - `open_world` — tool interacts with external entities beyond the notebook
pub fn all_tools() -> Vec<Tool> {
    let mut tools = vec![
        // -- Session management --
        Tool::new(
            "list_active_notebooks",
            "List active notebook sessions.",
            schema_for::<EmptyParams>(),
        )
        .annotate(ToolAnnotations::new().read_only(true).open_world(false))
        .with_meta(always_load_meta()),
        Tool::new(
            "list_notebooks",
            "List active notebook sessions.",
            schema_for::<session::ListNotebooksParams>(),
        )
        .annotate(ToolAnnotations::new().read_only(true).open_world(true))
        .with_meta(always_load_meta()),
        Tool::new(
            "connect_notebook",
            "Attach to a notebook. Pass path (.ipynb) or notebook_id (UUID) — not both.",
            schema_for::<session::OpenNotebookParams>(),
        )
        .annotate(
            ToolAnnotations::new()
                .destructive(false)
                .idempotent(true)
                .open_world(true),
        )
        .with_meta(always_load_meta()),
        Tool::new(
            "create_notebook",
            "Create a notebook. Ephemeral by default; save_notebook(path) to persist.",
            schema_for::<session::CreateNotebookParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(false).open_world(false)),
        Tool::new(
            "save_notebook",
            "Save notebook to disk. For notebooks created with create_notebook(), you must provide a path.",
            schema_for::<session::SaveNotebookParams>(),
        )
        .annotate(
            ToolAnnotations::new()
                .destructive(false)
                .idempotent(true)
                .open_world(true),
        ),
        Tool::new(
            "show_notebook",
            "Open the notebook in the nteract app for the user. Headless: returns a structured no-display reason.",
            schema_for::<session::ShowNotebookParams>(),
        )
        .annotate(ToolAnnotations::new().read_only(true).open_world(false)),
        Tool::new(
            "disconnect_notebook",
            "Release a notebook session's peer connection. Omit notebook_id to disconnect the active session.",
            schema_for::<session::DisconnectNotebookParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(true).open_world(false)),
        // -- Cell CRUD --
        Tool::new(
            "create_cell",
            "Create a cell anchored by after_cell_id; omit after_cell_id to append.",
            schema_for::<cell_crud::CreateCellParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(false).open_world(false))
        .with_meta(app_tool_meta()),
        Tool::new(
            "set_cell",
            "Replace a cell's source or type, optionally executing it and returning execution_id/output summary.",
            schema_for::<cell_crud::SetCellParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(false).open_world(false))
        .with_meta(app_tool_meta()),
        Tool::new(
            "delete_cell",
            "Delete a cell.",
            schema_for::<cell_crud::DeleteCellParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(true).open_world(false)),
        Tool::new(
            "move_cell",
            "Move a cell anchored by after_cell_id; null/omitted after_cell_id means start.",
            schema_for::<cell_crud::MoveCellParams>(),
        )
        .annotate(
            ToolAnnotations::new()
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        ),
        // -- Execution --
        Tool::new(
            "execute_cell",
            "Execute a code cell and return execution_id, status, and compact output summary.",
            schema_for::<execution::ExecuteCellParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(true).open_world(true))
        .with_meta(app_tool_meta()),
        Tool::new(
            "run_all_cells",
            "Execute all code cells in order.",
            schema_for::<execution::RunAllCellsParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(true).open_world(true))
        .with_meta(app_tool_meta()),
        Tool::new(
            "get_results",
            "Get outputs and status (done/error/running/queued) for an execution_id.",
            schema_for::<execution::GetResultsParams>(),
        )
        .annotate(ToolAnnotations::new().read_only(true).open_world(false))
        .with_meta(app_tool_meta()),
        // -- Kernel --
        Tool::new(
            "interrupt_kernel",
            "Interrupt execution.",
            schema_for::<EmptyParams>(),
        )
        .annotate(
            ToolAnnotations::new()
                .destructive(true)
                .idempotent(true)
                .open_world(false),
        ),
        Tool::new(
            "restart_kernel",
            "Restart the kernel, clearing all state.",
            schema_for::<EmptyParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(true).open_world(false)),
        // -- Dependencies --
        Tool::new(
            "manage_dependencies",
            "Review or update notebook dependencies. Returns current deps, fingerprint, and trust state.",
            schema_for::<deps::ManageDependenciesParams>(),
        )
        .annotate(
            ToolAnnotations::new()
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        ),
        // -- Editing --
        Tool::new(
            "replace_match",
            "Replace literal text in a cell. Use context_before/context_after to disambiguate repeated matches.",
            schema_for::<editing::ReplaceMatchParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(false).open_world(false))
        .with_meta(app_tool_meta()),
        Tool::new(
            "replace_regex",
            "Replace a regex match in a cell (fancy-regex). Fails if 0 or >1 matches. Replacement is literal text.",
            schema_for::<editing::ReplaceRegexParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(false).open_world(false))
        .with_meta(app_tool_meta()),
        // -- Comments --
        Tool::new(
            "create_comment",
            "Create a comment thread anchored to a cell or the notebook.",
            schema_for::<comments::CreateCommentParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(false).open_world(false)),
        Tool::new(
            "reply_comment",
            "Reply to an existing comment thread.",
            schema_for::<comments::ReplyCommentParams>(),
        )
        .annotate(ToolAnnotations::new().destructive(false).open_world(false)),
        Tool::new(
            "resolve_comment",
            "Mark a comment thread as resolved.",
            schema_for::<comments::ResolveCommentParams>(),
        )
        .annotate(
            ToolAnnotations::new()
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        ),
        Tool::new(
            "reopen_comment",
            "Reopen a resolved comment thread.",
            schema_for::<comments::ReopenCommentParams>(),
        )
        .annotate(
            ToolAnnotations::new()
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        ),
    ];

    attach_icons(&mut tools);

    tools
}

/// Return read tools intentionally hidden from the advertised MCP tool list.
pub fn hidden_tools() -> Vec<Tool> {
    let mut tools = vec![
        Tool::new(
            "get_cell",
            "Get a cell by ID. Dispatch-only read path; resource-aware MCP clients can read nteract://notebooks/{id}/cells.",
            schema_for::<cell_read::GetCellParams>(),
        )
        .annotate(ToolAnnotations::new().read_only(true).open_world(false))
        .with_meta(app_tool_meta()),
        Tool::new(
            "get_all_cells",
            "Get all cells as summary, json, or rich output. Dispatch-only read path; resource-aware MCP clients can read nteract://notebooks/{id}/cells.",
            schema_for::<cell_read::GetAllCellsParams>(),
        )
        .annotate(ToolAnnotations::new().read_only(true).open_world(false))
        .with_meta(app_tool_meta()),
    ];

    attach_icons(&mut tools);
    tools
}

/// Return the advertised tool list plus CLI-discoverable hidden read tools.
pub fn cli_discoverable_tools() -> Vec<Tool> {
    let mut tools = all_tools();
    tools.extend(hidden_tools());
    tools
}

fn attach_icons(tools: &mut [Tool]) {
    for tool in tools {
        if let Some(icon) = crate::icons::tool_icon(tool.name.as_ref()) {
            tool.icons = Some(crate::icons::icons(icon));
        }
    }
}

/// Dispatch a tool call to its handler.
///
/// No health gating: if the daemon is unreachable, the underlying RPC
/// returns a real error. The previous short-circuit on a locally-tracked
/// `Reconnecting` state could wedge for minutes while the daemon was
/// actually healthy (see #2000).
pub async fn dispatch(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    match request.name.as_ref() {
        // Session. `open_notebook` and `launch_app` are legacy aliases kept
        // for clients whose tool caches from the previous plugin/MCPB
        // release still advertise the old names; the canonical names
        // (advertised in the tool list) are `connect_notebook` and
        // `show_notebook`. Safe to remove after one release cycle.
        "list_active_notebooks" => session::list_active_notebooks(server).await,
        "list_notebooks" => session::list_notebooks(server, request).await,
        "connect_notebook" | "open_notebook" => session::open_notebook(server, request).await,
        "create_notebook" => session::create_notebook(server, request).await,
        "save_notebook" => session::save_notebook(server, request).await,
        "show_notebook" | "launch_app" => session::show_notebook(server, request).await,
        "disconnect_notebook" => session::disconnect_notebook(server, request).await,
        // Cell read. Hidden from tool listing but still callable for backwards compat;
        // resource-aware clients should read nteract://notebooks/{notebook_id}/cells.
        "get_cell" => cell_read::get_cell(server, request).await,
        "get_all_cells" => cell_read::get_all_cells(server, request).await,
        // Cell CRUD
        "create_cell" => cell_crud::create_cell(server, request).await,
        "set_cell" => cell_crud::set_cell(server, request).await,
        "delete_cell" => cell_crud::delete_cell(server, request).await,
        "move_cell" => cell_crud::move_cell(server, request).await,
        // Hidden from tool listing but still callable for backwards compat
        "clear_outputs" => cell_crud::clear_outputs(server, request).await,
        "add_cell_tags" => cell_meta::add_cell_tags(server, request).await,
        "remove_cell_tags" => cell_meta::remove_cell_tags(server, request).await,
        "set_cells_source_hidden" => cell_meta::set_cells_source_hidden(server, request).await,
        "set_cells_outputs_hidden" => cell_meta::set_cells_outputs_hidden(server, request).await,
        "sync_environment" => deps::sync_environment(server, request).await,
        // Execution
        "execute_cell" => execution::execute_cell(server, request).await,
        "run_all_cells" => execution::run_all_cells(server, request).await,
        "get_results" => execution::get_results(server, request).await,
        // Kernel
        "interrupt_kernel" => kernel::interrupt_kernel(server, request).await,
        "restart_kernel" => kernel::restart_kernel(server, request).await,
        // Dependencies
        "manage_dependencies" => deps::manage_dependencies(server, request).await,
        "add_dependency" => deps::add_dependency(server, request).await,
        "remove_dependency" => deps::remove_dependency(server, request).await,
        "get_dependencies" => deps::get_dependencies(server, request).await,
        "approve_trust" => deps::approve_trust(server, request).await,
        // Editing
        "replace_match" => editing::replace_match(server, request).await,
        "replace_regex" => editing::replace_regex(server, request).await,
        // Comments
        "create_comment" => comments::create_comment(server, request).await,
        "reply_comment" => comments::reply_comment(server, request).await,
        "resolve_comment" => comments::resolve_comment(server, request).await,
        "reopen_comment" => comments::reopen_comment(server, request).await,
        _ => Err(McpError::invalid_params(
            format!("Unknown tool: {}", request.name),
            None,
        )),
    }
}

/// Helper: extract a string argument.
pub fn arg_str<'a>(request: &'a CallToolRequestParams, key: &str) -> Option<&'a str> {
    request
        .arguments
        .as_ref()
        .and_then(|args| args.get(key))
        .and_then(|v| v.as_str())
}

/// Reject parameters outside a tool's advertised schema.
pub fn reject_unknown_args(
    request: &CallToolRequestParams,
    allowed: &[&str],
) -> Result<(), McpError> {
    let Some(args) = request.arguments.as_ref() else {
        return Ok(());
    };

    let mut unknown = args
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if unknown.is_empty() {
        return Ok(());
    }
    unknown.sort();

    let mut message = format!(
        "Unknown parameter(s): {}. Allowed parameters: {}.",
        unknown.join(", "),
        allowed.join(", ")
    );
    if allowed.contains(&"after_cell_id")
        && unknown
            .iter()
            .any(|key| key == "position" || key == "index")
    {
        message.push_str(" Cell ordering uses after_cell_id; numeric positions are not supported.");
    }
    Err(McpError::invalid_params(message, None))
}

/// Helper: extract a boolean argument, tolerating string "true"/"false".
///
/// Claude Code's MCP client has a known bug where boolean params are sometimes
/// serialized as strings (e.g., `"true"` instead of `true`). This affects
/// tools with `required` fields inconsistently.
/// See: https://github.com/anthropics/claude-code/issues/32524
pub fn arg_bool(request: &CallToolRequestParams, key: &str) -> Option<bool> {
    let val = request.arguments.as_ref()?.get(key)?;
    if let Some(b) = val.as_bool() {
        return Some(b);
    }
    match val.as_str() {
        Some("true") => {
            tracing::warn!(
                "[mcp] Boolean param '{key}' arrived as string \"true\" (claude-code#32524)"
            );
            Some(true)
        }
        Some("false") => {
            tracing::warn!(
                "[mcp] Boolean param '{key}' arrived as string \"false\" (claude-code#32524)"
            );
            Some(false)
        }
        _ => None,
    }
}

/// Helper: extract a string array argument, tolerating common agent
/// serialization quirks.
///
/// Accepted forms (most → least preferred):
///  1. Native JSON array: `["numpy", "pandas"]`
///  2. JSON-encoded string: `"[\"numpy\",\"pandas\"]"` (claude-code#32524)
///  3. Python-repr string: `"['numpy','pandas']"` (gremlin/agent #2084)
///  4. Bare scalar string: `"numpy"` → `["numpy"]`
///
/// Returns `None` only when the key is missing from the arguments map.
/// Returns `Some(vec![])` when the value is present but unparseable (with
/// a warning log), so callers can distinguish "not provided" from "provided
/// but empty/malformed".
pub fn arg_string_array(request: &CallToolRequestParams, key: &str) -> Option<Vec<String>> {
    let val = request.arguments.as_ref()?.get(key)?;

    // Case 1: native JSON array
    if let Some(arr) = val.as_array() {
        return Some(
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
        );
    }

    if let Some(s) = val.as_str() {
        let trimmed = s.trim();

        // Case 2: JSON-encoded string  e.g. "[\"numpy\"]"
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
            tracing::warn!("[mcp] Array param '{key}' arrived as JSON string (claude-code#32524)");
            return Some(parsed);
        }

        // Case 3: Python-repr string  e.g. "['numpy','pandas']"
        // Convert single quotes → double quotes and retry.
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let json_ified = trimmed.replace('\'', "\"");
            if let Ok(parsed) = serde_json::from_str::<Vec<String>>(&json_ified) {
                tracing::warn!(
                    "[mcp] Array param '{key}' arrived as Python-repr string \
                     (single-quoted list); coerced to JSON array (#2084)"
                );
                return Some(parsed);
            }
            // Looks like an array literal but couldn't parse — warn and
            // return empty so the caller knows something was provided.
            tracing::warn!(
                "[mcp] Array param '{key}' looks like a list but failed to parse: {trimmed}"
            );
            return Some(vec![]);
        }

        // Case 4: bare scalar string → single-element array
        if !trimmed.is_empty() {
            tracing::warn!(
                "[mcp] Array param '{key}' arrived as bare string \"{trimmed}\"; \
                 wrapping in single-element array (#2084)"
            );
            return Some(vec![trimmed.to_string()]);
        }
    }

    // Present but wrong type (number, bool, object, etc.)
    tracing::warn!("[mcp] Array param '{key}' has unexpected type: {}", val);
    Some(vec![])
}

/// Build a context-rich "no active session" error.
///
/// If we have drop context (from a previous session), the error message
/// includes *why* the session was lost and *which notebook_id* to reconnect
/// to — enabling agents to recover in one turn instead of wasting turns on
/// `list_active_notebooks`.
pub async fn no_session_error(server: &crate::NteractMcp) -> Result<CallToolResult, McpError> {
    let drop_info = server.last_session_drop.read().await;
    match drop_info.as_ref() {
        Some(info) => {
            let mut msg = format!("No active notebook session ({}). ", info.reason);
            if let Some(target) = info.rejoin_target.as_deref() {
                msg.push_str(&format!(
                    "Reconnect with: connect_notebook(target=\"{target}\")"
                ));
            } else {
                msg.push_str(&format!(
                    "Reconnect with: connect_notebook(notebook_id=\"{}\")",
                    info.notebook_id
                ));
            }
            if let Some(ref path) = info.notebook_path {
                msg.push_str(&format!(" — file: {path}"));
            }
            tool_error(&msg)
        }
        None => tool_error(
            "No active notebook session. \
             Call connect_notebook or create_notebook first.",
        ),
    }
}

/// Assert that a cell exists in the notebook, or return an `McpError`.
///
/// Call this early in any tool that takes a `cell_id` parameter so the agent
/// gets a clear "Cell not found" message instead of a cryptic Automerge error
/// or silent no-op.
///
/// Usage: `assert_cell_exists(&handle, cell_id)?;`
pub fn assert_cell_exists(
    handle: &notebook_sync::handle::DocHandle,
    cell_id: &str,
) -> Result<(), McpError> {
    if handle.get_cell(cell_id).is_some() {
        Ok(())
    } else {
        Err(McpError::invalid_params(
            format!("Cell not found: {cell_id}"),
            None,
        ))
    }
}

/// Helper: create a text error result.
pub fn tool_error(msg: &str) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::error(vec![Content::text(msg.to_string())]))
}

/// Helper: create a text success result.
pub fn tool_success(msg: &str) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![Content::text(
        msg.to_string(),
    )]))
}

/// Build a `CallToolResult` from an execution result, including structured content
/// for the MCP Apps widget. Shared by cell_crud, editing, and execution tools.
pub async fn build_execution_result(
    result: &crate::execution::ExecutionResult,
    handle: &notebook_sync::handle::DocHandle,
    server: &NteractMcp,
) -> Result<CallToolResult, McpError> {
    let header = crate::formatting::format_cell_header(
        &result.cell_id,
        "code",
        result.execution_count.as_deref(),
        Some(&result.status),
        result.execution_id.as_deref(),
    );

    let mut items = vec![
        Content::text(header),
        cell_resource_content(handle.notebook_id(), &result.cell_id),
    ];
    let output_summaries = crate::formatting::format_outputs_summary_lines(&result.outputs, 120);
    if output_summaries.is_empty() {
        items.push(Content::text("Output summary: 0 outputs".to_string()));
    } else {
        items.push(Content::text(format!(
            "Output summary:\n{}",
            output_summaries.join("\n")
        )));
    }
    items.extend(crate::formatting::outputs_to_content_items(&result.outputs));

    // Build structured content directly from manifest Values + blob URLs.
    // No blob fetches — inline ContentRefs pass through, blobs become URLs.
    // Use the same manifest slice captured during execution resolution so
    // resolved summaries stay aligned to their source manifests.
    let cell_snapshot = handle.get_cell(&result.cell_id);
    let runtime_comms = handle.get_runtime_state().ok().map(|rs| rs.comms);
    let mut structured_content = if let Some(snap) = cell_snapshot {
        let ec_str = cell_read::get_cell_execution_count_from_runtime(handle, &snap.id);
        let ec: Option<i64> = if ec_str.is_empty() {
            None
        } else {
            ec_str.parse().ok()
        };
        Some(crate::structured::cell_structured_content_from_manifests(
            crate::structured::CellStructuredContentManifestInput {
                cell_id: &snap.id,
                cell_type: &snap.cell_type,
                source: &snap.source,
                output_manifests: &result.output_manifests,
                execution_count: ec,
                status: &result.status,
                blob_base_url: &server.blob_base_url,
                comms: runtime_comms.as_ref(),
                resolved_outputs_by_manifest: Some(&result.resolved_outputs_by_manifest),
            },
        ))
    } else {
        None
    };

    let mut call_result = CallToolResult::success(items);
    if let Some(ref mut sc) = structured_content {
        if let Some(cell_obj) = sc.get_mut("cell").and_then(|c| c.as_object_mut()) {
            cell_obj.insert(
                "uri".to_string(),
                serde_json::Value::String(crate::resources::notebook_cell_uri(
                    handle.notebook_id(),
                    &result.cell_id,
                )),
            );
            // Inject execution_id into structured content so MCP App renderers
            // can associate outputs with a specific execution.
            if let Some(ref eid) = result.execution_id {
                cell_obj.insert(
                    "execution_id".to_string(),
                    serde_json::Value::String(eid.clone()),
                );
            }
        }
    }
    call_result.structured_content = structured_content;
    Ok(call_result)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn make_request(args: serde_json::Value) -> CallToolRequestParams {
        serde_json::from_value(serde_json::json!({
            "name": "test",
            "arguments": args,
        }))
        .unwrap()
    }

    fn make_named_request(name: &str, args: serde_json::Value) -> CallToolRequestParams {
        serde_json::from_value(serde_json::json!({
            "name": name,
            "arguments": args,
        }))
        .unwrap()
    }

    fn registered_tool(name: &str) -> Tool {
        all_tools()
            .into_iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("missing registered tool: {name}"))
    }

    fn assert_light_dark_icons(tool: &Tool) {
        let icons = tool.icons.as_ref().expect("tool icons");
        assert_eq!(icons.len(), 2);
        assert!(icons
            .iter()
            .all(|icon| icon.src.starts_with("data:image/png;base64,")));
        assert!(icons.iter().any(|icon| {
            icon.theme == Some(rmcp::model::IconTheme::Light)
                && icon.mime_type.as_deref() == Some("image/png")
        }));
        assert!(icons.iter().any(|icon| {
            icon.theme == Some(rmcp::model::IconTheme::Dark)
                && icon.mime_type.as_deref() == Some("image/png")
        }));
    }

    #[test]
    fn registered_tools_advertise_mcp_icons() {
        for tool in all_tools() {
            assert_light_dark_icons(&tool);
        }
    }

    #[test]
    fn manage_dependencies_tool_exposes_trust_and_fingerprint_schema() {
        let tool = registered_tool("manage_dependencies");
        let properties = tool
            .input_schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .expect("manage_dependencies schema should expose properties");

        assert!(properties.contains_key("add"));
        assert!(properties.contains_key("remove"));
        assert!(properties.contains_key("trust"));
        assert!(properties.contains_key("dependency_fingerprint"));
        assert!(properties.contains_key("apply"));
        let fingerprint_is_required = tool
            .input_schema
            .get("required")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|required| {
                required
                    .iter()
                    .any(|field| field == "dependency_fingerprint")
            });
        assert!(!fingerprint_is_required);

        let annotations = tool
            .annotations
            .expect("manage_dependencies should advertise safe mutation hints");
        assert_eq!(annotations.destructive_hint, Some(false));
        assert_eq!(annotations.idempotent_hint, Some(true));
        assert_eq!(annotations.open_world_hint, Some(false));
    }

    #[test]
    fn manage_dependencies_tool_advertises_apply_modes() {
        let tool = registered_tool("manage_dependencies");

        let examples = tool
            .input_schema
            .get("properties")
            .and_then(|p| p.get("apply"))
            .and_then(|a| a.get("examples"))
            .and_then(serde_json::Value::as_array)
            .expect("manage_dependencies.apply should advertise example values");
        let examples: Vec<&str> = examples.iter().filter_map(|v| v.as_str()).collect();
        assert!(examples.contains(&"sync"));
        assert!(examples.contains(&"restart"));

        let annotations = tool
            .annotations
            .expect("manage_dependencies should advertise mutation hints");
        assert_eq!(annotations.destructive_hint, Some(false));
        assert_eq!(annotations.idempotent_hint, Some(true));
        assert_eq!(annotations.open_world_hint, Some(false));
    }

    #[test]
    fn create_notebook_tool_exposes_environment_mode() {
        let tool = registered_tool("create_notebook");
        let properties = tool
            .input_schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .expect("create_notebook schema should expose properties");

        assert!(properties.contains_key("environment_mode"));
    }

    #[test]
    fn create_cell_tool_uses_after_cell_id_not_index() {
        let tool = registered_tool("create_cell");
        let properties = tool
            .input_schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .expect("create_cell schema should expose properties");

        assert!(properties.contains_key("after_cell_id"));
        assert!(properties
            .get("after_cell_id")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|schema| !schema.contains_key("default")));
        assert!(!properties.contains_key("index"));
        assert!(!properties.contains_key("position"));
        assert_eq!(
            tool.input_schema.get("additionalProperties"),
            Some(&serde_json::Value::Bool(false))
        );
    }

    #[test]
    fn move_cell_tool_points_agents_to_after_cell_id() {
        let tool = registered_tool("move_cell");
        let properties = tool
            .input_schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .expect("move_cell schema should expose properties");

        let description = tool
            .description
            .as_ref()
            .expect("move_cell should have a description");
        assert!(description.contains("after_cell_id"));
        assert!(properties.contains_key("after_cell_id"));
        assert!(!properties.contains_key("index"));
        assert!(!properties.contains_key("position"));
        assert_eq!(
            tool.input_schema.get("additionalProperties"),
            Some(&serde_json::Value::Bool(false))
        );
    }

    #[test]
    fn cell_read_tools_are_hidden_from_advertised_tool_list() {
        let tools = all_tools();

        assert!(tools.iter().all(|tool| tool.name != "get_cell"));
        assert!(tools.iter().all(|tool| tool.name != "get_all_cells"));
    }

    #[test]
    fn hidden_cell_read_tools_are_discoverable_as_callable_tools() {
        let hidden_names = hidden_tools()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(hidden_names.iter().any(|name| name == "get_cell"));
        assert!(hidden_names.iter().any(|name| name == "get_all_cells"));

        let callable_names = cli_discoverable_tools()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(callable_names.iter().any(|name| name == "create_cell"));
        assert!(callable_names.iter().any(|name| name == "get_cell"));
        assert!(callable_names.iter().any(|name| name == "get_all_cells"));
    }

    #[tokio::test]
    async fn hidden_cell_read_tools_remain_callable_for_cached_clients() {
        let server = NteractMcp::new(PathBuf::from("/tmp/missing.sock"), None, None);

        for (tool_name, args) in [
            ("get_cell", serde_json::json!({"cell_id": "cell-1"})),
            ("get_all_cells", serde_json::json!({})),
        ] {
            let result = dispatch(&server, &make_named_request(tool_name, args))
                .await
                .unwrap();

            assert_eq!(
                result.is_error,
                Some(true),
                "{tool_name} should be a tool error"
            );
            let text = result.content[0]
                .as_text()
                .expect("text content")
                .text
                .as_str();
            assert!(
                text.contains("No active notebook session"),
                "{tool_name} should dispatch to the legacy handler, got {text:?}"
            );
        }
    }

    #[test]
    fn execution_cell_resource_content_serializes_as_mcp_resource_link() {
        let expected_uri = "nteract://notebooks/nb%201/cells/cell%2F1";
        let content = cell_resource_content("nb 1", "cell/1");
        let value = serde_json::to_value(&content).expect("serialize content");

        assert_eq!(value.get("type"), Some(&serde_json::json!("resource_link")));
        assert_eq!(value.get("uri"), Some(&serde_json::json!(expected_uri)));
        assert_eq!(
            value.get("mimeType"),
            Some(&serde_json::json!("application/json"))
        );
        assert!(value.get("mime_type").is_none());

        let decoded: Content = serde_json::from_value(value).expect("deserialize content");
        let link = decoded.as_resource_link().expect("resource link");
        assert_eq!(link.uri, expected_uri);
        assert_eq!(link.mime_type.as_deref(), Some("application/json"));
    }

    #[test]
    fn reject_unknown_args_calls_out_numeric_cell_ordering() {
        let req = make_request(serde_json::json!({
            "cell_id": "cell-a",
            "position": 3,
        }));
        let err = reject_unknown_args(&req, &["cell_id", "after_cell_id"]).unwrap_err();
        let message = err.message.to_string();

        assert!(message.contains("Unknown parameter(s): position"));
        assert!(message.contains("after_cell_id"));
        assert!(message.contains("numeric positions are not supported"));
    }

    #[test]
    fn arg_bool_json_true() {
        let req = make_request(serde_json::json!({"flag": true}));
        assert_eq!(arg_bool(&req, "flag"), Some(true));
    }

    #[test]
    fn arg_bool_json_false() {
        let req = make_request(serde_json::json!({"flag": false}));
        assert_eq!(arg_bool(&req, "flag"), Some(false));
    }

    #[test]
    fn arg_bool_string_true() {
        let req = make_request(serde_json::json!({"flag": "true"}));
        assert_eq!(arg_bool(&req, "flag"), Some(true));
    }

    #[test]
    fn arg_bool_string_false() {
        let req = make_request(serde_json::json!({"flag": "false"}));
        assert_eq!(arg_bool(&req, "flag"), Some(false));
    }

    #[test]
    fn arg_bool_missing_key() {
        let req = make_request(serde_json::json!({"other": 1}));
        assert_eq!(arg_bool(&req, "flag"), None);
    }

    #[test]
    fn arg_bool_invalid_string() {
        let req = make_request(serde_json::json!({"flag": "yes"}));
        assert_eq!(arg_bool(&req, "flag"), None);
    }

    #[test]
    fn arg_bool_number() {
        let req = make_request(serde_json::json!({"flag": 1}));
        assert_eq!(arg_bool(&req, "flag"), None);
    }

    #[test]
    fn arg_bool_null() {
        let req = make_request(serde_json::json!({"flag": null}));
        assert_eq!(arg_bool(&req, "flag"), None);
    }

    #[test]
    fn arg_string_array_json_array() {
        let req = make_request(serde_json::json!({"deps": ["numpy", "pandas"]}));
        assert_eq!(
            arg_string_array(&req, "deps"),
            Some(vec!["numpy".to_string(), "pandas".to_string()])
        );
    }

    #[test]
    fn arg_string_array_string_coercion() {
        let req = make_request(serde_json::json!({"deps": "[\"numpy\", \"pandas\"]"}));
        assert_eq!(
            arg_string_array(&req, "deps"),
            Some(vec!["numpy".to_string(), "pandas".to_string()])
        );
    }

    #[test]
    fn arg_string_array_empty() {
        let req = make_request(serde_json::json!({"deps": []}));
        assert_eq!(arg_string_array(&req, "deps"), Some(vec![]));
    }

    #[test]
    fn arg_string_array_missing() {
        let req = make_request(serde_json::json!({"other": 1}));
        assert_eq!(arg_string_array(&req, "deps"), None);
    }

    #[test]
    fn arg_string_array_bare_string_becomes_single_element() {
        let req = make_request(serde_json::json!({"deps": "numpy"}));
        assert_eq!(
            arg_string_array(&req, "deps"),
            Some(vec!["numpy".to_string()])
        );
    }

    #[test]
    fn arg_string_array_python_repr_single_quotes() {
        let req = make_request(serde_json::json!({"deps": "['pandas','numpy']"}));
        assert_eq!(
            arg_string_array(&req, "deps"),
            Some(vec!["pandas".to_string(), "numpy".to_string()])
        );
    }

    #[test]
    fn arg_string_array_python_repr_with_spaces() {
        let req = make_request(serde_json::json!({"deps": "['pandas', 'numpy>=2.0']"}));
        assert_eq!(
            arg_string_array(&req, "deps"),
            Some(vec!["pandas".to_string(), "numpy>=2.0".to_string()])
        );
    }

    #[test]
    fn arg_string_array_wrong_type_returns_empty() {
        let req = make_request(serde_json::json!({"deps": 42}));
        assert_eq!(arg_string_array(&req, "deps"), Some(vec![]));
    }

    #[test]
    fn dependency_tool_listing_prefers_manage_dependencies() {
        let names = all_tools()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();
        assert!(names.contains(&"manage_dependencies".to_string()));
        assert!(!names.contains(&"add_dependency".to_string()));
        assert!(!names.contains(&"remove_dependency".to_string()));
        assert!(!names.contains(&"get_dependencies".to_string()));
        assert!(!names.contains(&"approve_trust".to_string()));
    }
}
