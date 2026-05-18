//! Read-only cell tools: get_cell, get_all_cells.

use rmcp::model::{CallToolRequestParams, CallToolResult, Content};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use runtimed_outputs::output_resolver;

use crate::formatting;
use crate::NteractMcp;

use super::{arg_bool, arg_str, tool_error, tool_success};

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetCellParams {
    /// The cell ID to retrieve. Response includes execution status/id and
    /// compact output summaries before any output text.
    pub cell_id: String,
    /// Return the unabridged output text for any stream or error that was
    /// spilled to the blob store. When false (the default), outputs past the
    /// daemon's preview cap render as a head + tail + elision marker +
    /// blob URL. Pass `true` only when the agent truly needs the full
    /// text — the response can grow large and will consume context budget.
    #[serde(default)]
    pub full_output: Option<bool>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetAllCellsParams {
    /// Output format: "summary" (default), "json", or "rich".
    #[serde(default = "default_format")]
    pub format: Option<String>,
    /// Starting cell index (0-based).
    #[serde(default)]
    pub start: Option<i64>,
    /// Number of cells to return (null = all).
    #[serde(default)]
    pub count: Option<i64>,
    /// Include compact output summaries/previews in summary format.
    #[serde(default)]
    pub include_outputs: Option<bool>,
    /// Max chars for source preview in summary format.
    #[serde(default)]
    pub preview_chars: Option<i64>,
}

fn default_format() -> Option<String> {
    Some("summary".to_string())
}

/// Get a single cell by ID with source and outputs.
pub async fn get_cell(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let cell_id = arg_str(request, "cell_id")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: cell_id", None))?;
    let full_output = arg_bool(request, "full_output").unwrap_or(false);

    let handle = require_handle!(server);

    // No presence on read — get_cell is read-only, shouldn't move the cursor.

    let cell = match handle.get_cell(cell_id) {
        Some(c) => c,
        None => return tool_error(&format!("Cell not found: {cell_id}")),
    };

    // Get execution_count from RuntimeStateDoc (the source of truth)
    let ec = get_cell_execution_count_from_runtime(&handle, cell_id);

    // Outputs live in RuntimeStateDoc under execution_id/output_id. Fetch
    // them via the dedicated lookup rather than reading a (now-gone) field on
    // CellSnapshot.
    let mut raw_outputs = handle.get_cell_outputs(cell_id).unwrap_or_default();

    // If the cell has been executed but outputs haven't synced yet,
    // flush pending RuntimeStateSync frames.
    if raw_outputs.is_empty() && !ec.is_empty() {
        let _ = handle.confirm_state_sync().await;
        raw_outputs = handle.get_cell_outputs(cell_id).unwrap_or_default();
    }

    // Resolve outputs (with widget state synthesis). `get_cell` is the
    // only tool that honors `full_output=true`; all other paths hardcode
    // preview mode to protect the agent's context budget.
    let comms = handle.get_runtime_state().ok().map(|rs| rs.comms);
    let outputs = output_resolver::resolve_cell_outputs_for_llm(
        &raw_outputs,
        output_resolver::ResolveCtx {
            blob_base_url: server.blob_base_url.as_deref(),
            blob_store_path: server.blob_store_path.as_deref(),
            comms: comms.as_ref(),
            length: if full_output {
                output_resolver::OutputLength::Full
            } else {
                output_resolver::OutputLength::Preview
            },
        },
    )
    .await;

    let execution_id = handle.get_cell_execution_id(cell_id);

    // Get execution status from RuntimeState
    let status = get_cell_status(&handle, cell_id);
    let display_status =
        display_status_for_cell(&cell.cell_type, status.as_deref(), execution_id.as_deref());

    let ec_display = if ec.is_empty() {
        None
    } else {
        Some(ec.as_str())
    };
    let header = formatting::format_cell_header(
        &cell.id,
        &cell.cell_type,
        ec_display,
        display_status,
        execution_id.as_deref(),
    );

    // Include tags if present
    let tags = cell.tags();
    let header_with_tags = if tags.is_empty() {
        header
    } else {
        format!("{header}\nTags: {}", tags.join(", "))
    };

    // Return multiple Content items: header+source, then one per output
    let mut items = Vec::new();

    if !cell.source.is_empty() {
        items.push(Content::text(format!(
            "{header_with_tags}\n\n{}",
            cell.source
        )));
    } else {
        items.push(Content::text(header_with_tags));
    }

    // Each output as a separate Content item (matches Python _cell_to_content)
    let output_summaries = output_summary_lines(&outputs, &raw_outputs, 120);
    if !output_summaries.is_empty() {
        items.push(Content::text(format!(
            "Output summary:\n{}",
            output_summaries.join("\n")
        )));
    }
    items.extend(formatting::outputs_to_content_items(&outputs));

    Ok(CallToolResult::success(items))
}

/// Get all cells with configurable format.
pub async fn get_all_cells(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let handle = require_handle!(server);

    let format = arg_str(request, "format").unwrap_or("summary");
    let start = request
        .arguments
        .as_ref()
        .and_then(|a| a.get("start"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as usize;
    let count = request
        .arguments
        .as_ref()
        .and_then(|a| a.get("count"))
        .and_then(|v| v.as_i64())
        .map(|v| v as usize);
    let include_outputs = arg_bool(request, "include_outputs").unwrap_or(false);
    let preview_chars = request
        .arguments
        .as_ref()
        .and_then(|a| a.get("preview_chars"))
        .and_then(|v| v.as_i64())
        .unwrap_or(60) as usize;

    let cells = handle.get_cells();
    let end = match count {
        Some(c) => (start + c).min(cells.len()),
        None => cells.len(),
    };
    let slice = &cells[start.min(cells.len())..end.min(cells.len())];

    // Build cell status map, execution count map, and comms from RuntimeState.
    // Outputs live in RuntimeStateDoc under execution_id/output_id; fetch them
    // in bulk once so large notebooks don't pay O(N) state-doc reads.
    let cell_status_map = build_cell_status_map(&handle);
    let cell_ec_map = build_cell_execution_count_map(&handle);
    let comms = handle.get_runtime_state().ok().map(|rs| rs.comms);
    let outputs_by_cell = handle.get_all_outputs();
    let empty_outputs: Vec<serde_json::Value> = Vec::new();

    match format {
        "json" => {
            let mut json_cells = Vec::new();
            for cell in slice {
                let status = cell_status_map.get(&cell.id).map(String::as_str);
                let ec: Option<i64> = cell_ec_map.get(&cell.id).and_then(|s| s.parse().ok());
                let execution_id = handle.get_cell_execution_id(&cell.id);
                let display_status =
                    display_status_for_cell(&cell.cell_type, status, execution_id.as_deref());
                let raw_outputs = outputs_by_cell.get(&cell.id).unwrap_or(&empty_outputs);

                // Resolve outputs through the output resolver so that
                // text/llm+plain is synthesized and viz specs are summarized.
                // `get_all_cells` never fetches full blob text — a batch of
                // cells could blow context even with one large output.
                let resolved = output_resolver::resolve_cell_outputs_for_llm(
                    raw_outputs,
                    output_resolver::ResolveCtx {
                        blob_base_url: server.blob_base_url.as_deref(),
                        blob_store_path: server.blob_store_path.as_deref(),
                        comms: comms.as_ref(),
                        ..Default::default()
                    },
                )
                .await;
                let output_texts: Vec<String> = resolved
                    .iter()
                    .filter_map(formatting::format_output_text)
                    .collect();
                let output_summary = output_summary_lines(&resolved, raw_outputs, 120);

                // Extract tags from cell metadata
                let tags: Vec<String> = cell
                    .metadata
                    .get("tags")
                    .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
                    .unwrap_or_default();

                json_cells.push(serde_json::json!({
                    "cell_id": cell.id,
                    "cell_type": cell.cell_type,
                    "execution_count": ec,
                    "source": cell.source,
                    "outputs": output_texts,
                    "output_summary": output_summary,
                    "status": display_status,
                    "execution_id": execution_id,
                    "tags": tags,
                }));
            }
            let text = serde_json::to_string_pretty(&json_cells).unwrap_or_default();
            Ok(CallToolResult::success(vec![Content::text(text)]))
        }
        "rich" => {
            let mut items = Vec::new();
            for cell in slice {
                let status = cell_status_map.get(&cell.id).map(String::as_str);
                let ec = cell_ec_map.get(&cell.id).map(String::as_str);
                let execution_id = handle.get_cell_execution_id(&cell.id);
                let display_status =
                    display_status_for_cell(&cell.cell_type, status, execution_id.as_deref());
                let raw_outputs = outputs_by_cell.get(&cell.id).unwrap_or(&empty_outputs);
                let outputs = output_resolver::resolve_cell_outputs_for_llm(
                    raw_outputs,
                    output_resolver::ResolveCtx {
                        blob_base_url: server.blob_base_url.as_deref(),
                        blob_store_path: server.blob_store_path.as_deref(),
                        comms: comms.as_ref(),
                        ..Default::default()
                    },
                )
                .await;
                let header = formatting::format_cell_header(
                    &cell.id,
                    &cell.cell_type,
                    ec,
                    display_status,
                    execution_id.as_deref(),
                );
                let tags = cell.tags();
                let header = if tags.is_empty() {
                    header
                } else {
                    format!("{header}\nTags: {}", tags.join(", "))
                };
                let text = if !cell.source.is_empty() {
                    format!("{header}\n\n{}", cell.source)
                } else {
                    header
                };
                items.push(Content::text(text));
                let output_summaries = output_summary_lines(&outputs, raw_outputs, 120);
                if !output_summaries.is_empty() {
                    items.push(Content::text(format!(
                        "Output summary:\n{}",
                        output_summaries.join("\n")
                    )));
                }
                items.extend(formatting::outputs_to_content_items(&outputs));
            }
            Ok(CallToolResult::success(items))
        }
        _ => {
            // summary format
            let mut lines = Vec::new();
            for (i, cell) in slice.iter().enumerate() {
                let status = cell_status_map.get(&cell.id).map(String::as_str);
                let ec = cell_ec_map.get(&cell.id).map(String::as_str);
                let execution_id = handle.get_cell_execution_id(&cell.id);
                let display_status =
                    display_status_for_cell(&cell.cell_type, status, execution_id.as_deref());
                let line = formatting::format_cell_summary(
                    start + i,
                    &cell.id,
                    &cell.cell_type,
                    &cell.source,
                    formatting::CellSummaryContext {
                        execution_count: ec,
                        status: display_status,
                        execution_id: execution_id.as_deref(),
                    },
                    preview_chars,
                );
                let raw_outputs = outputs_by_cell.get(&cell.id).unwrap_or(&empty_outputs);
                if include_outputs && !raw_outputs.is_empty() {
                    let outputs = output_resolver::resolve_cell_outputs_for_llm(
                        raw_outputs,
                        output_resolver::ResolveCtx {
                            blob_base_url: server.blob_base_url.as_deref(),
                            blob_store_path: server.blob_store_path.as_deref(),
                            comms: comms.as_ref(),
                            ..Default::default()
                        },
                    )
                    .await;
                    let output_summaries =
                        output_summary_lines(&outputs, raw_outputs, preview_chars);
                    if !output_summaries.is_empty() {
                        let summary = output_summaries
                            .into_iter()
                            .map(|line| format!("  └─ {line}"))
                            .collect::<Vec<_>>()
                            .join("\n");
                        lines.push(format!("{line}\n{summary}"));
                    } else {
                        lines.push(line);
                    }
                } else {
                    lines.push(line);
                }
            }
            tool_success(&lines.join("\n"))
        }
    }
}

fn display_status_for_cell<'a>(
    cell_type: &str,
    runtime_status: Option<&'a str>,
    execution_id: Option<&str>,
) -> Option<&'a str> {
    runtime_status.or_else(|| {
        if cell_type == "code" && execution_id.is_none() {
            Some("never_run")
        } else {
            None
        }
    })
}

fn output_summary_lines(
    outputs: &[runtimed_outputs::resolved_output::Output],
    raw_outputs: &[serde_json::Value],
    preview_chars: usize,
) -> Vec<String> {
    let summaries = formatting::format_outputs_summary_lines(outputs, preview_chars);
    if !summaries.is_empty() {
        return summaries;
    }
    raw_output_summary_lines(raw_outputs)
}

fn raw_output_summary_lines(raw_outputs: &[serde_json::Value]) -> Vec<String> {
    raw_outputs
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let output_type = raw
                .get("output_type")
                .and_then(|v| v.as_str())
                .unwrap_or("output");
            let label = match output_type {
                "stream" => {
                    let name = raw.get("name").and_then(|v| v.as_str()).unwrap_or("stream");
                    format!("stream({name})")
                }
                "display_data" | "execute_result" => {
                    let mimes = raw
                        .get("data")
                        .and_then(|v| v.as_object())
                        .map(|data| {
                            let mut keys: Vec<&str> = data.keys().map(String::as_str).collect();
                            keys.sort_unstable();
                            keys.join(", ")
                        })
                        .filter(|mimes| !mimes.is_empty());
                    match mimes {
                        Some(mimes) => format!("{output_type}({mimes})"),
                        None => output_type.to_string(),
                    }
                }
                other => other.to_string(),
            };
            format!("out[{index}]: {label}")
        })
        .collect()
}

/// Get the execution_count for a cell from RuntimeStateDoc.
///
/// Looks at the executions map for the most recent execution of this cell
/// that has an execution_count set (from the kernel's execute_input message).
/// Returns an empty string if no execution_count is found, matching the
/// convention used by formatting functions.
pub fn get_cell_execution_count_from_runtime(
    handle: &notebook_sync::handle::DocHandle,
    cell_id: &str,
) -> String {
    let Some(execution_id) = handle.get_cell_execution_id(cell_id) else {
        return String::new();
    };
    if let Ok(state) = handle.get_runtime_state() {
        if let Some(exec) = state.executions.get(&execution_id) {
            if let Some(count) = exec.execution_count {
                return count.to_string();
            }
        }
    }
    String::new()
}

/// Get cell execution status from RuntimeState.
///
/// Checks queue first (running/queued), then falls back to the executions
/// map for terminal status (done/error). Without this fallback, agents
/// cannot distinguish "executed with output" from "never ran."
fn get_cell_status(handle: &notebook_sync::handle::DocHandle, cell_id: &str) -> Option<String> {
    let execution_id = handle.get_cell_execution_id(cell_id);
    if let (Some(execution_id), Ok(state)) = (execution_id, handle.get_runtime_state()) {
        if state
            .queue
            .executing
            .as_ref()
            .is_some_and(|e| e.execution_id == execution_id)
        {
            return Some("running".to_string());
        }
        if state
            .queue
            .queued
            .iter()
            .any(|e| e.execution_id == execution_id)
        {
            return Some("queued".to_string());
        }
        if let Some(exec) = state.executions.get(&execution_id) {
            if exec.status == "done" || exec.status == "error" {
                return Some(exec.status.clone());
            }
        }
    }
    None
}

/// Build a map of cell_id -> execution_count string from RuntimeState.
///
/// For each cell, finds the most recent execution with an execution_count
/// and stores it as a string (e.g. "5"). Cells without execution_count
/// are absent from the map.
pub fn build_cell_execution_count_map(
    handle: &notebook_sync::handle::DocHandle,
) -> std::collections::HashMap<String, String> {
    let mut map: std::collections::HashMap<String, (i64, String)> =
        std::collections::HashMap::new();
    if let Ok(state) = handle.get_runtime_state() {
        for cell in handle.get_cells() {
            let Some(execution_id) = handle.get_cell_execution_id(&cell.id) else {
                continue;
            };
            if let Some(count) = state
                .executions
                .get(&execution_id)
                .and_then(|exec| exec.execution_count)
            {
                let entry = map.entry(cell.id);
                match entry {
                    std::collections::hash_map::Entry::Vacant(e) => {
                        e.insert((count, count.to_string()));
                    }
                    std::collections::hash_map::Entry::Occupied(mut e) => {
                        if count > e.get().0 {
                            e.insert((count, count.to_string()));
                        }
                    }
                }
            }
        }
    }
    map.into_iter().map(|(k, (_, v))| (k, v)).collect()
}

/// Build a map of cell_id -> status from RuntimeState.
pub fn build_cell_status_map(
    handle: &notebook_sync::handle::DocHandle,
) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Ok(state) = handle.get_runtime_state() {
        for cell in handle.get_cells() {
            let Some(execution_id) = handle.get_cell_execution_id(&cell.id) else {
                continue;
            };
            if state
                .queue
                .executing
                .as_ref()
                .is_some_and(|e| e.execution_id == execution_id)
            {
                map.insert(cell.id.clone(), "running".to_string());
                continue;
            }
            if state
                .queue
                .queued
                .iter()
                .any(|e| e.execution_id == execution_id)
            {
                map.insert(cell.id.clone(), "queued".to_string());
                continue;
            }
            if let Some(exec) = state.executions.get(&execution_id) {
                if exec.status == "done" || exec.status == "error" {
                    map.entry(cell.id).or_insert_with(|| exec.status.clone());
                }
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtimed_outputs::resolved_output::Output;

    #[test]
    fn raw_output_summary_falls_back_when_resolver_returns_no_outputs() {
        let raw_outputs = vec![serde_json::json!({
            "output_type": "display_data",
            "data": {
                "application/x-custom": {"inline": "payload"},
                "text/html": {"inline": "<b>hi</b>"}
            }
        })];

        let lines = output_summary_lines(&[], &raw_outputs, 80);
        assert_eq!(
            lines,
            vec!["out[0]: display_data(application/x-custom, text/html)"]
        );
    }

    #[test]
    fn resolved_output_summary_wins_over_raw_fallback() {
        let raw_outputs = vec![serde_json::json!({
            "output_type": "stream",
            "name": "stderr",
            "text": {"inline": "raw"}
        })];
        let resolved = vec![Output::stream("stdout", "resolved")];

        let lines = output_summary_lines(&resolved, &raw_outputs, 80);
        assert_eq!(lines, vec!["out[0]: stream(stdout) \"resolved\""]);
    }

    #[test]
    fn code_cell_without_execution_id_is_never_run() {
        assert_eq!(
            display_status_for_cell("code", None, None),
            Some("never_run")
        );
        assert_eq!(display_status_for_cell("markdown", None, None), None);
        assert_eq!(
            display_status_for_cell("code", Some("running"), None),
            Some("running")
        );
    }
}
