//! Cell CRUD tools: create_cell, set_cell, delete_cell, move_cell, clear_outputs.

use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, Content};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::execution;
use crate::NteractMcp;

use super::{
    arg_bool, arg_str, arg_string_array, assert_cell_exists, reject_unknown_args, tool_error,
    tool_success,
};

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateCellParams {
    /// Cell source code or markdown content.
    #[serde(default)]
    pub source: Option<String>,
    /// Cell type: "code", "markdown", or "raw".
    #[serde(default)]
    pub cell_type: Option<String>,
    /// Insert after this cell. Omit to append at the end; pass null to insert at the beginning.
    pub after_cell_id: Option<String>,
    /// Execute the cell immediately after creation. Response includes the
    /// execution_id plus a compact output summary when the cell is code.
    #[serde(default)]
    pub and_run: Option<bool>,
    /// Max seconds to wait for execution.
    #[serde(default)]
    pub timeout_secs: Option<f64>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetCellParams {
    /// The cell ID to update.
    pub cell_id: String,
    /// New source code (None to leave unchanged).
    #[serde(default)]
    pub source: Option<String>,
    /// New cell type (None to leave unchanged).
    #[serde(default)]
    pub cell_type: Option<String>,
    /// Execute the cell after changes (code cells only). Response includes
    /// the execution_id plus a compact output summary.
    #[serde(default)]
    pub and_run: Option<bool>,
    /// Max seconds to wait for execution.
    #[serde(default)]
    pub timeout_secs: Option<f64>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteCellParams {
    /// The cell ID to delete.
    pub cell_id: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MoveCellParams {
    /// The cell ID to move.
    pub cell_id: String,
    /// Move after this cell, or null for start.
    #[serde(default)]
    pub after_cell_id: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClearOutputsParams {
    /// Cell IDs to clear outputs for. If omitted or empty, clears outputs for ALL cells (destructive).
    pub cell_ids: Option<Vec<String>>,
}

/// Valid cell types per the nbformat spec.
///
/// TODO: promote to a shared `CellType` enum in `notebook-doc` so
/// deserialization rejects invalid types at the boundary rather than
/// requiring runtime checks in each consumer.
const VALID_CELL_TYPES: &[&str] = &["code", "markdown", "raw"];

/// Create a new cell, optionally executing it.
pub async fn create_cell(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(
        request,
        &[
            "source",
            "cell_type",
            "after_cell_id",
            "and_run",
            "timeout_secs",
        ],
    )?;
    let source = arg_str(request, "source").unwrap_or("");
    let cell_type = arg_str(request, "cell_type").unwrap_or("code");

    if !VALID_CELL_TYPES.contains(&cell_type) {
        return tool_error(&format!(
            "Invalid cell_type: \"{cell_type}\". Must be one of: {}",
            VALID_CELL_TYPES.join(", ")
        ));
    }
    let explicit_after_cell_id = explicit_after_cell_id_arg(request)?;
    let and_run = arg_bool(request, "and_run").unwrap_or(false);
    let timeout_secs = request
        .arguments
        .as_ref()
        .and_then(|a| a.get("timeout_secs"))
        .and_then(|v| v.as_f64())
        .unwrap_or(30.0);

    // Clone handle, then drop the session lock so other tools
    // (interrupt_kernel, etc.) aren't blocked during execution.
    let (handle, cell_id) = {
        let handle = require_handle!(server);
        let cell_id = format!("cell-{}", uuid::Uuid::new_v4());

        let after_cell_id = match explicit_after_cell_id {
            Some(anchor) => anchor.map(str::to_string),
            None => handle.last_cell_id(),
        };
        if let Some(anchor) = after_cell_id.as_deref() {
            assert_cell_exists(&handle, anchor)?;
        }

        handle
            .add_cell_with_source(&cell_id, cell_type, after_cell_id.as_deref(), source)
            .map_err(|e| McpError::internal_error(format!("Failed to create cell: {e}"), None))?;

        (handle, cell_id)
    };

    // Cursor at end of source (shows "finished typing")
    let peer_label = server.get_peer_label().await;
    let (end_line, end_col) = crate::presence::offset_to_line_col(source, source.len());
    crate::presence::emit_cursor(&handle, &cell_id, end_line, end_col, &peer_label).await;

    if and_run && cell_type == "code" {
        let result = execution::execute_and_wait(
            &handle,
            &cell_id,
            Duration::from_secs_f64(timeout_secs),
            &server.blob_base_url,
            &server.blob_store_path,
        )
        .await;

        return super::build_execution_result(&result, &handle, server).await;
    }

    confirm_document_sync(&handle, "create_cell").await?;

    cell_resource_success(
        format!("Created cell: {cell_id}"),
        handle.notebook_id(),
        &cell_id,
    )
}

/// Update a cell's source and/or type.
pub async fn set_cell(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(
        request,
        &["cell_id", "source", "cell_type", "and_run", "timeout_secs"],
    )?;
    let cell_id = arg_str(request, "cell_id")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: cell_id", None))?;

    let source = arg_str(request, "source");
    let cell_type = arg_str(request, "cell_type");
    let and_run = arg_bool(request, "and_run").unwrap_or(false);
    let timeout_secs = request
        .arguments
        .as_ref()
        .and_then(|a| a.get("timeout_secs"))
        .and_then(|v| v.as_f64())
        .unwrap_or(30.0);

    let handle = require_handle!(server);
    assert_cell_exists(&handle, cell_id)?;

    if source.is_none() && cell_type.is_none() {
        return cell_resource_success(
            format!("Cell \"{cell_id}\" unchanged (no updates specified)"),
            handle.notebook_id(),
            cell_id,
        );
    }

    if let Some(src) = source {
        handle
            .update_source(cell_id, src)
            .map_err(|e| McpError::internal_error(format!("Failed to update source: {e}"), None))?;

        // Cursor at end of new source
        let peer_label = server.get_peer_label().await;
        let (end_line, end_col) = crate::presence::offset_to_line_col(src, src.len());
        crate::presence::emit_cursor(&handle, cell_id, end_line, end_col, &peer_label).await;
    }
    if let Some(ct) = cell_type {
        if !VALID_CELL_TYPES.contains(&ct) {
            return tool_error(&format!(
                "Invalid cell_type: \"{ct}\". Must be one of: {}",
                VALID_CELL_TYPES.join(", ")
            ));
        }
        handle
            .set_cell_type(cell_id, ct)
            .map_err(|e| McpError::internal_error(format!("Failed to set cell type: {e}"), None))?;
    }

    confirm_document_sync(&handle, "set_cell").await?;

    let current_type = handle.get_cell_type(cell_id).unwrap_or_default();
    if and_run && current_type == "code" {
        let result = execution::execute_and_wait(
            &handle,
            cell_id,
            Duration::from_secs_f64(timeout_secs),
            &server.blob_base_url,
            &server.blob_store_path,
        )
        .await;

        return super::build_execution_result(&result, &handle, server).await;
    }

    cell_resource_success(
        format!("Cell \"{cell_id}\" updated"),
        handle.notebook_id(),
        cell_id,
    )
}

/// Delete a cell by ID.
pub async fn delete_cell(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["cell_id"])?;
    let cell_id = arg_str(request, "cell_id")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: cell_id", None))?;

    let handle = require_handle!(server);
    assert_cell_exists(&handle, cell_id)?;

    let peer_label = server.get_peer_label().await;
    crate::presence::emit_focus(&handle, cell_id, &peer_label).await;

    handle
        .delete_cell(cell_id)
        .map_err(|e| McpError::internal_error(format!("Failed to delete cell: {e}"), None))?;

    confirm_document_sync(&handle, "delete_cell").await?;

    let result = serde_json::json!({
        "cell_id": cell_id,
        "deleted": true,
        "resources": crate::resources::notebook_resources_json(handle.notebook_id()),
    });
    cells_resource_json_success(result, handle.notebook_id())
}

/// Move a cell after another cell, or to the start.
pub async fn move_cell(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["cell_id", "after_cell_id"])?;
    let cell_id = arg_str(request, "cell_id")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: cell_id", None))?;

    let handle = require_handle!(server);

    let after_cell_id = explicit_after_cell_id_arg(request)?.flatten();

    assert_cell_exists(&handle, cell_id)?;
    if let Some(anchor) = after_cell_id {
        assert_cell_exists(&handle, anchor)?;
    }

    handle
        .move_cell(cell_id, after_cell_id)
        .map_err(|e| McpError::internal_error(format!("Failed to move cell: {e}"), None))?;

    let peer_label = server.get_peer_label().await;
    crate::presence::emit_focus(&handle, cell_id, &peer_label).await;

    confirm_document_sync(&handle, "move_cell").await?;

    let result = serde_json::json!({
        "cell_id": cell_id,
        "after_cell_id": after_cell_id,
        "moved": true,
        "uri": crate::resources::notebook_cell_uri(handle.notebook_id(), cell_id),
    });
    cell_resource_json_success(result, handle.notebook_id(), cell_id)
}

/// Clear a cell's outputs.
pub async fn clear_outputs(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["cell_ids"])?;
    let explicit_ids: Option<Vec<String>> = arg_string_array(request, "cell_ids");

    let handle = require_handle!(server);

    // If cell_ids provided, clear those (empty list = no-op); otherwise clear all.
    let cell_ids: Vec<String> = match explicit_ids {
        Some(ids) => ids,
        None => handle.get_cell_ids(),
    };

    // Validate that all requested cell IDs exist in the notebook.
    if !cell_ids.is_empty() {
        let all_ids = handle.get_cell_ids();
        let unknown: Vec<&str> = cell_ids
            .iter()
            .filter(|id| !all_ids.contains(id))
            .map(|s| s.as_str())
            .collect();
        if !unknown.is_empty() {
            return tool_error(&format!("Unknown cell IDs: {}", unknown.join(", ")));
        }
    }

    let peer_label = server.get_peer_label().await;

    for id in &cell_ids {
        crate::presence::emit_focus(&handle, id, &peer_label).await;
    }

    let cleared = if cell_ids.is_empty() {
        0
    } else {
        match handle.clear_outputs_for_cells(&cell_ids) {
            Ok(count) => count,
            Err(e) => return tool_error(&format!("Failed to clear outputs: {e}")),
        }
    };

    if cleared > 0 {
        confirm_document_sync(&handle, "clear_outputs").await?;
    }

    let result = serde_json::json!({ "cleared": cleared });
    tool_success(&serde_json::to_string_pretty(&result).unwrap_or_default())
}

fn cell_resource_success(
    message: String,
    notebook_id: &str,
    cell_id: &str,
) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![
        Content::text(message),
        Content::resource_link(crate::resources::notebook_cell_resource_link(
            notebook_id,
            cell_id,
        )),
    ]))
}

fn cell_resource_json_success(
    result: serde_json::Value,
    notebook_id: &str,
    cell_id: &str,
) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![
        Content::text(serde_json::to_string_pretty(&result).unwrap_or_default()),
        Content::resource_link(crate::resources::notebook_cell_resource_link(
            notebook_id,
            cell_id,
        )),
    ]))
}

fn cells_resource_json_success(
    result: serde_json::Value,
    notebook_id: &str,
) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![
        Content::text(serde_json::to_string_pretty(&result).unwrap_or_default()),
        Content::resource_link(crate::resources::notebook_cells_resource_link(notebook_id)),
    ]))
}

async fn confirm_document_sync(
    handle: &notebook_sync::handle::DocHandle,
    action: &str,
) -> Result<(), McpError> {
    handle
        .confirm_sync()
        .await
        .map_err(|e| McpError::internal_error(format!("Failed to sync after {action}: {e}"), None))
}

fn explicit_after_cell_id_arg(
    request: &CallToolRequestParams,
) -> Result<Option<Option<&str>>, McpError> {
    let Some(args) = request.arguments.as_ref() else {
        return Ok(None);
    };
    let Some(value) = args.get("after_cell_id") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(None));
    }
    if let Some(cell_id) = value.as_str() {
        return Ok(Some(Some(cell_id)));
    }
    Err(McpError::invalid_params(
        "after_cell_id must be a cell ID string or null",
        None,
    ))
}
