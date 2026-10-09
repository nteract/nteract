//! Execution tools: execute_cell, run_all_cells, get_results.

use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData as McpError;
use runtimed_outputs::output_resolver;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::execution;
use crate::formatting;
use crate::NteractMcp;

use super::{arg_bool, arg_str, assert_cell_exists, tool_error};

fn cells_resource_result(message: String, notebook_id: &str) -> CallToolResult {
    CallToolResult::success(vec![
        formatting::assistant_text(message),
        super::cells_resource_content(notebook_id),
    ])
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ExecuteCellParams {
    /// The cell ID to execute.
    pub cell_id: String,
    /// Max seconds to wait; returns execution_id and partial results if exceeded.
    #[serde(default)]
    pub timeout_secs: Option<f64>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct RunAllCellsParams {
    /// Max seconds to wait for all cells to finish. Default: 300.
    #[serde(default)]
    pub timeout_secs: Option<f64>,
    /// If true (default), wait for all cells to finish and return outputs.
    /// If false, queue cells and return immediately.
    #[serde(default)]
    pub wait: Option<bool>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetResultsParams {
    /// Wait 0–50 seconds for this existing run to settle. Default 0 (read immediately); never submits a new run.
    pub timeout_secs: Option<f64>,
    /// The execution ID returned by `execute_cell`, `set_cell(and_run=true)`,
    /// `create_cell(and_run=true)`, or `run_all_cells`.
    pub execution_id: String,
    /// Return unabridged output text (like `get_cell(full_output=true)`).
    /// Default: false (preview mode to protect context budget).
    #[serde(default)]
    pub full_output: Option<bool>,
}

/// Execute a cell and return results (with structured content for MCP Apps).
pub async fn execute_cell(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let cell_id = arg_str(request, "cell_id")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: cell_id", None))?;

    let access = require_session_access!(server, Execute);
    let metadata = server.local_metadata_for_access(&access);
    let handle = access.handle.clone();

    let timeout_secs = request
        .arguments
        .as_ref()
        .and_then(|a| a.get("timeout_secs"))
        .and_then(|v| v.as_f64())
        .unwrap_or(30.0);

    assert_cell_exists(&handle, cell_id)?;

    // Only code cells can be executed. Markdown/raw cells get queued by the
    // daemon but the kernel never processes them, so the agent would see
    // "running" forever with no outputs. Fail early with a clear message.
    let cell_type = handle.get_cell_type(cell_id).unwrap_or_default();
    if cell_type != "code" {
        return tool_error(&format!(
            "Cannot execute cell '{cell_id}' of type '{cell_type}'. \
             Only 'code' cells can be executed."
        ));
    }

    let peer_label = server.get_peer_label().await;
    crate::presence::emit_focus(&handle, cell_id, &peer_label).await;
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }

    let result = match execution::execute_and_wait(
        &handle,
        cell_id,
        Duration::from_secs_f64(timeout_secs),
        &metadata.blob_base_url,
        &metadata.blob_store_path,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => return super::execution_dispatch_error(error),
    };
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }

    super::build_execution_result(&result, &handle, &metadata).await
}

/// Execute all code cells in order.
///
/// With `wait=true` (default): waits for completion and returns per-cell outputs
/// with structured content, like `execute_cell` but for every code cell.
///
/// With `wait=false`: queues all cells and returns immediately.
pub async fn run_all_cells(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let access = require_session_access!(server, Execute);
    let metadata = server.local_metadata_for_access(&access);
    let handle = access.handle.clone();

    let wait = arg_bool(request, "wait").unwrap_or(true);

    let timeout_secs = request
        .arguments
        .as_ref()
        .and_then(|a| a.get("timeout_secs"))
        .and_then(|v| v.as_f64())
        .unwrap_or(300.0);

    // Fire-and-forget: queue cells and return immediately.
    if !wait {
        if let Err(error) = server.ensure_session_access_current(&access).await {
            return super::session_access_error(error);
        }
        let result = match execution::run_all_and_queue(&handle).await {
            Ok(result) => result,
            Err(error) => return super::execution_dispatch_error(error),
        };
        if let Err(error) = server.ensure_session_access_current(&access).await {
            return super::session_access_error(error);
        }
        let n = result.cell_execution_ids.len();
        let mut lines = vec![format!("Queued {n} cells for execution")];
        for (cell_id, exec_id) in &result.cell_execution_ids {
            lines.push(format!("  {cell_id} → {exec_id}"));
        }
        return Ok(cells_resource_result(
            lines.join("\n"),
            handle.notebook_id(),
        ));
    }

    // Wait mode: run all cells and collect outputs.
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }
    let result =
        match execution::run_all_and_wait(&handle, Duration::from_secs_f64(timeout_secs)).await {
            Ok(result) => result,
            Err(error) => return super::execution_dispatch_error(error),
        };
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }

    let cells = handle.get_cells();
    let runtime_state = handle.get_runtime_state().ok();
    let mut execution_cell_map = execution::execution_cell_map(&handle);
    for (cell_id, execution_id) in &result.cell_execution_ids {
        execution_cell_map.insert(execution_id.clone(), cell_id.clone());
    }

    // Look up this run's execution state for a given cell.
    let run_exec = |cell_id: &str| -> Option<&runtime_doc::ExecutionState> {
        let eid = result.cell_execution_ids.get(cell_id)?;
        runtime_state.as_ref()?.executions.get(eid.as_str())
    };

    // Count code cells by status for the header.
    let mut succeeded = 0usize;
    let mut errored = 0usize;
    let mut cancelled = 0usize;
    let mut running = 0usize;
    let mut queued = 0usize;

    for cell in &cells {
        if cell.cell_type != "code" {
            continue;
        }
        if let Some(exec) = run_exec(&cell.id) {
            match exec.status.as_str() {
                "done" => succeeded += 1,
                "cancelled" => cancelled += 1,
                "error" => errored += 1,
                "running" => running += 1,
                "queued" => queued += 1,
                _ => {}
            }
        }
    }

    // Build status header line.
    let header = match result.status.as_str() {
        "timed_out" => {
            let done = succeeded + errored;
            let total = done + cancelled + running + queued;
            let mut parts = vec![format!("{done} completed")];
            if running > 0 {
                parts.push(format!("{running} running"));
            }
            if queued > 0 {
                parts.push(format!("{queued} queued"));
            }
            format!("Execution timed out ({total} cells: {})", parts.join(", "))
        }
        "error" => {
            let mut parts = Vec::new();
            if succeeded > 0 {
                parts.push(format!("{succeeded} succeeded"));
            }
            if errored > 0 {
                parts.push(format!("{errored} errored"));
            }
            if cancelled > 0 {
                parts.push(format!("{cancelled} cancelled"));
            }
            format!("Execution error ({})", parts.join(", "))
        }
        _ => {
            format!("Execution completed ({succeeded} succeeded)")
        }
    };

    // Build per-cell output content.
    let comms = runtime_state.as_ref().map(|rs| &rs.comms);
    let mut content_items = vec![
        formatting::assistant_text(header.clone()),
        super::cells_resource_content(handle.notebook_id()),
    ];
    let mut structured_cells: Vec<serde_json::Value> = Vec::new();

    for cell in &cells {
        if cell.cell_type != "code" {
            continue;
        }

        let exec = match run_exec(&cell.id) {
            Some(e) => e,
            None => continue,
        };

        let display_status = exec.status.as_str();
        let ec_str = exec.execution_count.map(|c| c.to_string());

        // Resolve outputs from the execution's output manifests.
        let output_manifests = &exec.outputs;
        let (outputs, resolved_outputs_by_manifest) = if !output_manifests.is_empty() {
            // Batch execute path — always preview mode. No per-cell opt-out.
            let aligned = runtimed_outputs::output_resolver::resolve_cell_outputs_for_llm_aligned(
                output_manifests,
                runtimed_outputs::output_resolver::ResolveCtx {
                    blob_base_url: metadata.blob_base_url.as_deref(),
                    blob_store_path: metadata.blob_store_path.as_deref(),
                    comms,
                    execution_cell_map: Some(&execution_cell_map),
                    ..Default::default()
                },
            )
            .await;
            let outputs = aligned.iter().flatten().cloned().collect();
            (outputs, aligned)
        } else {
            (Vec::new(), Vec::new())
        };

        // Text content: cell header + output text items.
        let eid = result.cell_execution_ids.get(&cell.id).map(|s| s.as_str());
        let cell_header = formatting::format_cell_header(
            &cell.id,
            "code",
            ec_str.as_deref(),
            Some(display_status),
            eid,
        );
        content_items.push(formatting::assistant_text(cell_header));
        let output_summaries = formatting::format_outputs_summary_lines_aligned(
            &resolved_outputs_by_manifest,
            output_manifests,
            120,
        );
        if !output_summaries.is_empty() {
            content_items.push(formatting::assistant_text(format!(
                "Output summary:\n{}",
                output_summaries.join("\n")
            )));
        }
        content_items.extend(formatting::outputs_to_content_items(&outputs));

        // Structured content for MCP Apps: use the same manifest slice resolved
        // above so resolved summaries stay aligned to their source manifests.
        // Extract the inner "cell" object — cell_structured_content_from_manifests
        // returns {"cell": {...}, "blob_base_url": "..."} but the multi-cell
        // wrapper expects CellData directly in the cells[] array.
        let cell_snapshot = handle.get_cell(&cell.id);
        if let Some(snap) = cell_snapshot {
            if !output_manifests.is_empty() {
                let wrapped = crate::structured::cell_structured_content_from_manifests(
                    crate::structured::CellStructuredContentManifestInput {
                        cell_id: &snap.id,
                        cell_type: &snap.cell_type,
                        source: &snap.source,
                        output_manifests,
                        execution_count: exec.execution_count,
                        status: display_status,
                        blob_base_url: &metadata.blob_base_url,
                        comms,
                        resolved_outputs_by_manifest: Some(&resolved_outputs_by_manifest),
                    },
                );
                if let Some(mut cell_data) = wrapped.get("cell").cloned() {
                    if let Some(obj) = cell_data.as_object_mut() {
                        obj.insert(
                            "uri".to_string(),
                            serde_json::Value::String(super::cell_resource_uri(
                                handle.notebook_id(),
                                &cell.id,
                            )),
                        );
                        if let Some(eid) = eid {
                            if let Some(base) = metadata.output_resource_base(eid) {
                                obj.insert(
                                    "output_resource_base".into(),
                                    serde_json::Value::String(base),
                                );
                            }
                            obj.insert(
                                "execution_id".to_string(),
                                serde_json::Value::String(eid.to_string()),
                            );
                        }
                    }
                    structured_cells.push(cell_data);
                }
            }
        }
    }

    let mut call_result = rmcp::model::CallToolResult::success(content_items);

    // Wrap structured content as {"cells": [...]} for multi-cell responses.
    if !structured_cells.is_empty() {
        let mut wrapper = serde_json::json!({
            "cells": structured_cells,
        });
        if let Some(base) = &metadata.blob_base_url {
            wrapper["blob_base_url"] = serde_json::Value::String(base.clone());
        }
        call_result.structured_content = Some(wrapper);
    }

    Ok(call_result)
}

/// Get outputs for a specific execution by ID.
///
/// Standalone read-only tool — no cell_id needed. Looks up the execution
/// in RuntimeStateDoc, renders status prominently so agents know whether
/// outputs are partial (still running) or complete.
pub async fn get_results(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let execution_id = arg_str(request, "execution_id").ok_or_else(|| {
        McpError::invalid_params("Missing required parameter: execution_id", None)
    })?;
    let full_output = arg_bool(request, "full_output").unwrap_or(false);
    // Preserve the existing CLI/string handling for full_output. Only the new
    // timeout argument needs numeric validation here.
    let timeout_secs = request
        .arguments
        .as_ref()
        .and_then(|args| args.get("timeout_secs"))
        .filter(|value| !value.is_null())
        .map(|value| {
            value.as_f64().ok_or_else(|| {
                McpError::invalid_params("timeout_secs must be a number between 0 and 50", None)
            })
        })
        .transpose()?;
    let timeout = super::observation::bounded_timeout(timeout_secs, 0.0)?;
    let deadline = tokio::time::Instant::now() + timeout;
    let _permit = if timeout.is_zero() {
        None
    } else {
        Some(super::observation::wait_permit(server)?)
    };

    let read = async {
        // Durable results still require one readable, explicitly selected notebook.
        // A global execution UUID is not proof that it belongs to this target.
        let (access, runtime_handle, access_error) = match server
            .session_access(crate::session::SessionRequirement::RuntimeRead)
            .await
        {
            // Runtime reads remain available when source recovery gates edits.
            Ok(Some(access)) => {
                let handle = access.handle.clone();
                (access, Some(handle), None)
            }
            Ok(None) => (require_session_access!(server, ProjectionRead), None, None),
            Err(error) => (
                require_session_access!(server, ProjectionRead),
                None,
                Some(error),
            ),
        };
        let metadata = server.local_metadata_for_access(&access);
        if let Some(handle) = runtime_handle.as_ref() {
            let state = handle
                .get_runtime_state()
                .map_err(|_| McpError::internal_error("Failed to read RuntimeStateDoc", None))?;
            if let Some(exec) = state.executions.get(execution_id) {
                if timeout.is_zero() {
                    return render_execution_result(
                        &metadata,
                        execution_id,
                        exec,
                        Some(&state.comms),
                        exec.cell_id.as_deref().and_then(|id| handle.get_cell(id)),
                        Some(execution::execution_cell_map(handle)),
                        full_output,
                    )
                    .await;
                }
            } else if let Some(record) = read_durable_execution(
                &metadata,
                &access.notebook_id,
                access.is_hosted,
                execution_id,
            )
            .await
            {
                return render_durable_result(&metadata, execution_id, record, full_output).await;
            }
            if !timeout.is_zero() {
                let Ok(mut expiration) =
                    super::observation::expiration(server, &access.notebook_handle)
                else {
                    return Ok(unavailable_result(execution_id, "attachment_expired"));
                };
                let Some((_, observer)) =
                    server.observer_for_handle(&access.notebook_handle).await?
                else {
                    return Ok(unavailable_result(execution_id, "attachment_unavailable"));
                };
                let result = tokio::select! {
                    result = wait_existing_result(&metadata, &observer, execution_id, deadline, full_output) => result?,
                    _ = super::observation::expired(&mut expiration) => return Ok(unavailable_result(execution_id, "attachment_expired")),
                };
                if super::observation::is_expired(&expiration) {
                    return Ok(unavailable_result(execution_id, "attachment_expired"));
                }
                return Ok(result);
            }
        }
        if let Some(record) = read_durable_execution(
            &metadata,
            &access.notebook_id,
            access.is_hosted,
            execution_id,
        )
        .await
        {
            return render_durable_result(&metadata, execution_id, record, full_output).await;
        }
        if let Some(error) = access_error {
            return super::session_access_error(error);
        }
        tool_error(&format!("Execution not found in notebook {}: {execution_id}. It may have been evicted and no notebook-qualified durable result record was found.", access.notebook_id))
    };
    if timeout.is_zero() {
        read.await
    } else {
        match tokio::time::timeout_at(deadline, read).await {
            Ok(result) => result,
            Err(_) => Ok(CallToolResult::structured(
                serde_json::json!({"execution_id":execution_id,"outcome":"timed_out","execution_status":null,"outputs_pending":true}),
            )),
        }
    }
}

async fn read_durable_execution(
    metadata: &crate::LocalRuntimeMetadata,
    notebook_id: &str,
    is_hosted: bool,
    execution_id: &str,
) -> Option<runtimed_client::execution_store::ExecutionRecord> {
    if is_hosted {
        return None;
    }
    let record = runtimed_client::execution_store::ExecutionStore::new(
        metadata.execution_store_path.as_ref()?,
    )
    .read_record(execution_id)
    .await?;
    // Old path-only contexts cannot establish identity after a path is rebound.
    (record.context_kind == "notebook"
        && record.context_id == notebook_id
        && record.execution_id == execution_id)
        .then_some(record)
}

async fn render_durable_result(
    metadata: &crate::LocalRuntimeMetadata,
    execution_id: &str,
    record: runtimed_client::execution_store::ExecutionRecord,
    full_output: bool,
) -> Result<CallToolResult, McpError> {
    let exec = runtime_doc::ExecutionState {
        status: record.status,
        execution_count: record.execution_count,
        success: record.success,
        outputs: record.outputs,
        source: record.source,
        cell_id: record.cell_id.clone(),
        seq: record.seq,
        submitted_by_actor_label: record.submitted_by_actor_label,
    };
    let mapping = record
        .cell_id
        .map(|id| std::collections::HashMap::from([(execution_id.to_owned(), id)]));
    render_execution_result(
        metadata,
        execution_id,
        &exec,
        None,
        None,
        mapping,
        full_output,
    )
    .await
}

fn unavailable_result(execution_id: &str, reason: &str) -> CallToolResult {
    CallToolResult::structured(
        serde_json::json!({"execution_id":execution_id,"outcome":"unavailable","reason":reason}),
    )
}

async fn wait_existing_result(
    metadata: &crate::LocalRuntimeMetadata,
    observer: &crate::observation::ObservationReader,
    execution_id: &str,
    deadline: tokio::time::Instant,
    full_output: bool,
) -> Result<CallToolResult, McpError> {
    use crate::observation::ChangeOutcome;
    use notebook_sync::execution_watch::ExecutionTerminalReason;
    let (read, progress) =
        super::observation::observe_execution(observer, execution_id, None, deadline).await?;
    if read.outcome == ChangeOutcome::Unavailable {
        return Ok(unavailable_result(execution_id, "attachment_unavailable"));
    }
    let reason = progress
        .as_ref()
        .and_then(|value| value.terminal_reason.as_ref());
    if let Some(reason) = reason.filter(|reason| {
        !matches!(
            reason,
            ExecutionTerminalReason::Done
                | ExecutionTerminalReason::Error
                | ExecutionTerminalReason::Cancelled
                | ExecutionTerminalReason::Interrupted
        )
    }) {
        return Ok(unavailable_result(execution_id, reason.as_str()));
    }
    let Some(exec) = read.snapshot.runtime.executions.get(execution_id) else {
        return Ok(CallToolResult::structured(
            serde_json::json!({"execution_id":execution_id,"outcome":"timed_out","execution_status":null}),
        ));
    };
    let outcome = if read.outcome == ChangeOutcome::TimedOut {
        "timed_out"
    } else {
        "completed"
    };
    // Keep partial state available even when the wait used its deadline. Do not
    // begin potentially slow output resolution after the deadline has elapsed.
    let partial = || {
        CallToolResult::structured(serde_json::json!({
            "execution_id":execution_id,"outcome":"timed_out","execution_status":exec.status,
            "cell_id":exec.cell_id,"execution_count":exec.execution_count,
            "output_count":exec.outputs.len(),"outputs_pending":true,
        }))
    };
    if tokio::time::Instant::now() >= deadline {
        return Ok(partial());
    }
    let cell = exec
        .cell_id
        .as_deref()
        .and_then(|id| read.snapshot.notebook.get_cell(id))
        .cloned();
    let mapping = exec
        .cell_id
        .as_ref()
        .map(|id| std::collections::HashMap::from([(execution_id.to_owned(), id.clone())]));
    let mut result = match tokio::time::timeout_at(
        deadline,
        render_execution_result(
            metadata,
            execution_id,
            exec,
            Some(&read.snapshot.runtime.comms),
            cell,
            mapping,
            full_output,
        ),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => return Ok(partial()),
    };
    if observer
        .read(None)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?
        .outcome
        == ChangeOutcome::Unavailable
    {
        return Ok(unavailable_result(execution_id, "attachment_unavailable"));
    }
    let data = result
        .structured_content
        .get_or_insert_with(|| serde_json::json!({}));
    data["outcome"] = serde_json::json!(outcome);
    data["execution_id"] = serde_json::json!(execution_id);
    data["execution_status"] = serde_json::json!(exec.status);
    result.content.push(formatting::assistant_text(format!(
        "Execution {execution_id}: {outcome}"
    )));
    Ok(result)
}

pub(super) async fn render_execution_result(
    metadata: &crate::LocalRuntimeMetadata,
    execution_id: &str,
    exec: &runtime_doc::ExecutionState,
    comms: Option<&std::collections::HashMap<String, runtime_doc::CommDocEntry>>,
    cell: Option<notebook_doc::CellSnapshot>,
    execution_cell_map: Option<std::collections::HashMap<String, String>>,
    full_output: bool,
) -> Result<CallToolResult, McpError> {
    // Determine display status with clear indication of completeness
    let (display_status, is_terminal) = match exec.status.as_str() {
        "done" => ("done", true),
        "cancelled" => ("cancelled", true),
        "error" => ("error", true),
        "running" => ("running (partial — outputs may be incomplete)", false),
        "queued" => ("queued (no outputs yet)", false),
        other => (other, false),
    };

    let ec_str = exec.execution_count.map(|c| c.to_string());
    let cell_id = cell
        .as_ref()
        .map(|cell| cell.id.as_str())
        .or(exec.cell_id.as_deref())
        .unwrap_or(execution_id);

    // Build header with execution state front and center
    let header = formatting::format_cell_header(
        cell_id,
        "code",
        ec_str.as_deref(),
        Some(display_status),
        Some(execution_id),
    );

    // Resolve outputs from the execution's manifests
    let (outputs, resolved_outputs_by_manifest) = if !exec.outputs.is_empty() {
        let aligned = output_resolver::resolve_cell_outputs_for_llm_aligned(
            &exec.outputs,
            output_resolver::ResolveCtx {
                blob_base_url: metadata.blob_base_url.as_deref(),
                blob_store_path: metadata.blob_store_path.as_deref(),
                comms,
                length: if full_output {
                    output_resolver::OutputLength::Full
                } else {
                    output_resolver::OutputLength::Preview
                },
                execution_cell_map: execution_cell_map.as_ref(),
            },
        )
        .await;
        let outputs = aligned.iter().flatten().cloned().collect();
        (outputs, aligned)
    } else {
        (Vec::new(), Vec::new())
    };

    let mut items = vec![formatting::assistant_text(header)];
    let output_summaries = formatting::format_outputs_summary_lines_aligned(
        &resolved_outputs_by_manifest,
        &exec.outputs,
        120,
    );
    if output_summaries.is_empty() {
        items.push(formatting::assistant_text("Output summary: 0 outputs"));
    } else {
        items.push(formatting::assistant_text(format!(
            "Output summary:\n{}",
            output_summaries.join("\n")
        )));
    }

    if !is_terminal && outputs.is_empty() {
        // No outputs yet — make it crystal clear
        items.push(formatting::assistant_text(format!(
            "Status: {display_status}. No outputs available yet."
        )));
    } else if !is_terminal {
        items.push(formatting::assistant_text(format!(
            "⚠ Status: {display_status}. Outputs below may be incomplete."
        )));
        items.extend(formatting::outputs_to_content_items(&outputs));
    } else {
        items.extend(formatting::outputs_to_content_items(&outputs));
    }

    // Build structured content from the execution's output manifests
    let fallback_source = exec.source.as_deref().unwrap_or_default();
    let fallback_cell = notebook_doc::CellSnapshot {
        id: exec
            .cell_id
            .clone()
            .unwrap_or_else(|| execution_id.to_string()),
        cell_type: "code".to_string(),
        position: String::new(),
        source: fallback_source.to_string(),
        execution_count: exec
            .execution_count
            .map(|count| count.to_string())
            .unwrap_or_else(|| "null".to_string()),
        metadata: serde_json::json!({}),
        resolved_assets: std::collections::HashMap::new(),
        attachments: std::collections::HashMap::new(),
    };
    let mut snap = cell.unwrap_or(fallback_cell);
    // Execution output always belongs to the captured executed source, not a later edit.
    snap.source = fallback_source.to_string();
    snap.cell_type = "code".to_owned();
    let mut structured_content = if exec.outputs.is_empty() {
        None
    } else {
        let wrapped = crate::structured::cell_structured_content_from_manifests(
            crate::structured::CellStructuredContentManifestInput {
                cell_id: &snap.id,
                cell_type: &snap.cell_type,
                source: &snap.source,
                output_manifests: &exec.outputs,
                execution_count: exec.execution_count,
                status: display_status,
                blob_base_url: &metadata.blob_base_url,
                comms,
                resolved_outputs_by_manifest: Some(&resolved_outputs_by_manifest),
            },
        );
        wrapped.get("cell").cloned().map(|mut cell_data| {
            if let Some(obj) = cell_data.as_object_mut() {
                if let Some(base) = metadata.output_resource_base(execution_id) {
                    obj.insert(
                        "output_resource_base".into(),
                        serde_json::Value::String(base),
                    );
                }
                obj.insert(
                    "execution_id".to_string(),
                    serde_json::Value::String(execution_id.to_string()),
                );
            }
            // Wrap as top-level with blob_base_url
            let mut top = serde_json::json!({ "cell": cell_data });
            if let Some(base) = &metadata.blob_base_url {
                top["blob_base_url"] = serde_json::Value::String(base.clone());
            }
            top
        })
    };

    let mut data = structured_content
        .take()
        .unwrap_or_else(|| serde_json::json!({}));
    data["outcome"] = serde_json::json!("snapshot");
    data["execution_id"] = serde_json::json!(execution_id);
    data["execution_status"] = serde_json::json!(exec.status);
    data["cell_id"] = serde_json::json!(exec.cell_id);
    data["execution_source_available"] = serde_json::json!(exec.source.is_some());
    if exec.source.is_none() {
        if let Some(cell) = data
            .get_mut("cell")
            .and_then(serde_json::Value::as_object_mut)
        {
            cell.remove("source");
            cell.insert(
                "execution_source_available".into(),
                serde_json::json!(false),
            );
        }
    }
    let mut call_result = rmcp::model::CallToolResult::success(items);
    call_result.structured_content = Some(data);
    Ok(call_result)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn make_request(args: serde_json::Value) -> CallToolRequestParams {
        serde_json::from_value(serde_json::json!({
            "name": "get_results",
            "arguments": args,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn execution_resolution_keeps_one_blob_snapshot_after_runtime_metadata_changes() {
        let server = NteractMcp::new(
            "unused.sock".into(),
            Some("http://localhost:12345".into()),
            None,
        );
        let metadata = server.local_runtime_metadata().await;
        server.local_metadata.write().unwrap().blob_base_url =
            Some("http://localhost:54321".into());
        let execution: runtime_doc::ExecutionState = serde_json::from_value(serde_json::json!({
            "status": "done",
            "outputs": [{
                "output_type": "stream", "name": "stdout",
                "text": {"blob": "stream_hash", "size": 50000},
                "llm_preview": {"head": "first\n", "tail": "last\n", "total_bytes": 50000, "total_lines": 100}
            }]
        })).unwrap();
        let result = render_execution_result(
            &metadata,
            "exec-snapshot",
            &execution,
            None,
            None,
            None,
            false,
        )
        .await
        .unwrap();
        let text = serde_json::to_string(&result.content).unwrap();
        assert!(
            text.contains("http://localhost:12345/blob/stream_hash"),
            "{text}"
        );
        assert!(!text.contains("54321"));
        let structured = result.structured_content.unwrap();
        assert_eq!(structured["blob_base_url"], "http://localhost:12345");
        assert_eq!(
            structured["cell"]["outputs"][0]["text"],
            "http://localhost:12345/blob/stream_hash"
        );
    }

    async fn durable_fixture() -> (tempfile::TempDir, crate::LocalRuntimeMetadata) {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = runtimed_client::execution_store::ExecutionStore::new(tmp.path());
        for (id, context) in [
            ("run-a", "notebook-a"),
            ("path-only", "/tmp/notebook.ipynb"),
        ] {
            store.write_record(runtimed_client::execution_store::ExecutionRecord {
                schema_version: runtimed_client::execution_store::EXECUTION_RECORD_SCHEMA_VERSION,
                execution_id: id.into(), context_kind:"notebook".into(), context_id:context.into(),
                notebook_path:Some("/tmp/notebook.ipynb".into()), cell_id:Some("cell-1".into()),
                status:"done".into(),success:Some(true),execution_count:Some(3),source:Some("print('notebook A secret')".into()),
                seq:Some(0),submitted_by_actor_label:None,
                outputs:vec![serde_json::json!({"output_type":"stream","name":"stdout","text":{"inline":"notebook A secret"}})],
                created_at:chrono::Utc::now(),updated_at:chrono::Utc::now(),
            }).await.unwrap();
        }
        let metadata = NteractMcp::new(PathBuf::from("unused.sock"), None, None)
            .with_execution_store_path(Some(tmp.path().into()))
            .local_runtime_metadata()
            .await;
        (tmp, metadata)
    }

    #[tokio::test]
    async fn durable_results_require_exact_local_notebook_identity() {
        let (_tmp, metadata) = durable_fixture().await;
        let record = read_durable_execution(&metadata, "notebook-a", false, "run-a")
            .await
            .unwrap();
        let result = render_durable_result(&metadata, "run-a", record, false)
            .await
            .unwrap();
        assert!(serde_json::to_string(&result.content)
            .unwrap()
            .contains("notebook A secret"));
        // A known execution ID does not grant access through B or a hosted notebook.
        assert!(
            read_durable_execution(&metadata, "notebook-b", false, "run-a")
                .await
                .is_none()
        );
        assert!(
            read_durable_execution(&metadata, "notebook-a", true, "run-a")
                .await
                .is_none()
        );
        assert!(
            read_durable_execution(&metadata, "notebook-a", false, "path-only")
                .await
                .is_none()
        );
        assert!(
            read_durable_execution(&metadata, "notebook-a", false, "missing")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn get_results_without_target_cannot_read_global_durable_records() {
        let (tmp, _) = durable_fixture().await;
        let server = NteractMcp::new("unused.sock".into(), None, None)
            .with_execution_store_path(Some(tmp.path().into()));
        let result = get_results(
            &server,
            &make_request(serde_json::json!({"execution_id":"run-a"})),
        )
        .await
        .unwrap();
        assert_eq!(result.is_error, Some(true));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("notebook A secret"));
    }

    async fn ready_test_session(id: &str) -> crate::session::NotebookSession {
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
        let frame = TypedNotebookFrame {
            frame_type: NotebookFrameType::SessionControl,
            payload: serde_json::to_vec(&SessionControlMessage::SyncStatus(
                SessionSyncStatusWire {
                    notebook_doc: NotebookDocPhaseWire::Interactive,
                    runtime_state: RuntimeStatePhaseWire::Ready,
                    initial_load: InitialLoadPhaseWire::NotNeeded,
                },
            ))
            .unwrap(),
        };
        let peer = notebook_sync::connect::connect_frame_io(
            id.into(),
            "agent:results-test",
            Frames(Some(frame)),
            WriterFrameSink::new(tokio::io::sink()),
        )
        .await
        .unwrap()
        .handle;
        peer.await_session_ready_timeout(Duration::from_secs(1))
            .await
            .unwrap();
        crate::session::NotebookSession::local(peer, id.into(), None, None)
    }

    #[tokio::test]
    async fn get_results_dispatch_cannot_read_a_through_target_b() {
        let (tmp, _) = durable_fixture().await;
        let server = NteractMcp::new("unused.sock".into(), None, None)
            .with_execution_store_path(Some(tmp.path().into()));
        for (id, allowed) in [("notebook-b", false), ("notebook-a", true)] {
            let session = ready_test_session(id).await;
            let handle = session.notebook_handle.clone();
            server
                .attachments
                .insert(session, server.attachments.reserve().unwrap());
            let result = crate::targets::dispatch(
                &server,
                &make_request(serde_json::json!({"notebook_handle":handle,"execution_id":"run-a"})),
            )
            .await
            .unwrap();
            let text = serde_json::to_string(&result).unwrap();
            assert_eq!(text.contains("notebook A secret"), allowed, "{text}");
            assert_eq!(result.is_error, Some(!allowed), "{text}");
        }
    }

    fn execution_state(source: Option<&str>) -> runtime_doc::ExecutionState {
        serde_json::from_value(serde_json::json!({"cell_id":"cell-1","source":source,"status":"done","outputs":[{"output_type":"stream","name":"stdout","text":{"inline":"captured output"}}]})).unwrap()
    }

    #[tokio::test]
    async fn execution_rendering_never_pairs_old_outputs_with_new_cell_source() {
        let metadata = NteractMcp::new("unused.sock".into(), None, None)
            .local_runtime_metadata()
            .await;
        let edited = crate::observation::tests::edited("new unexecuted source");
        let mut current_cell = edited.cells().first().unwrap().clone();
        current_cell.cell_type = "markdown".into();
        for source in [Some("executed source"), None] {
            let result = render_execution_result(
                &metadata,
                "old-run",
                &execution_state(source),
                None,
                Some(current_cell.clone()),
                None,
                false,
            )
            .await
            .unwrap();
            let serialized = serde_json::to_string(&result).unwrap();
            assert!(!serialized.contains("new unexecuted source"));
            let data = result.structured_content.unwrap();
            assert_eq!(data["execution_source_available"], source.is_some());
            assert_eq!(data["cell"]["cell_type"], "code");
            if let Some(source) = source {
                assert_eq!(data["cell"]["source"], source);
            } else {
                assert!(data["cell"].get("source").is_none());
            }
        }
    }

    #[tokio::test]
    async fn get_results_wait_follows_exact_run_through_rerun_and_trailing_output() {
        let fixture = crate::observation::tests::fixture();
        fixture
            .notebook
            .send_replace(crate::observation::tests::edited("new run source"));
        fixture.notebook.send_modify(|view| {
            std::sync::Arc::make_mut(&mut view.execution_pointers)
                .insert("cell-1".into(), "new-run".into());
        });
        fixture.runtime.send_modify(|state| {
            let mut old = execution_state(Some("old run source"));
            old.status = "running".into();
            old.outputs.clear();
            state.executions.insert("old-run".into(), old);
            state
                .executions
                .insert("new-run".into(), execution_state(Some("new run source")));
        });
        let publisher = fixture.runtime.clone();
        let updates = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            publisher.send_modify(|state| {
                *state.executions.get_mut("old-run").unwrap() =
                    execution_state(Some("old run source"));
            });
            tokio::time::sleep(Duration::from_millis(20)).await;
            publisher.send_modify(|state| { state.executions.get_mut("old-run").unwrap().outputs.push(serde_json::json!({"output_type":"stream","name":"stdout","text":{"inline":"trailing output"}})); });
        });
        let metadata = NteractMcp::new("unused.sock".into(), None, None)
            .local_runtime_metadata()
            .await;
        let result = wait_existing_result(
            &metadata,
            &fixture.owner.reader(),
            "old-run",
            tokio::time::Instant::now() + Duration::from_secs(2),
            false,
        )
        .await
        .unwrap();
        updates.await.unwrap();
        let data = result.structured_content.as_ref().unwrap();
        assert_eq!(data["outcome"], "completed");
        assert_eq!(data["execution_id"], "old-run");
        assert_eq!(data["cell"]["source"], "old run source");
        let text = serde_json::to_string(&result).unwrap();
        assert!(text.contains("trailing output"));
        assert!(!text.contains("new run source"));
        assert_eq!(fixture.runtime.borrow().executions.len(), 2);
    }

    #[tokio::test]
    async fn get_results_wait_timeout_and_observer_release_never_submit_or_interrupt() {
        let fixture = crate::observation::tests::fixture();
        let metadata = NteractMcp::new("unused.sock".into(), None, None)
            .local_runtime_metadata()
            .await;
        fixture.runtime.send_modify(|state| {
            let mut run = execution_state(Some("pending"));
            run.status = "running".into();
            state.executions.insert("pending-run".into(), run);
            state
                .executions
                .insert("unrelated".into(), execution_state(Some("done")));
        });
        let observer = fixture.owner.reader();
        let result = wait_existing_result(
            &metadata,
            &observer,
            "pending-run",
            tokio::time::Instant::now() + Duration::from_millis(10),
            false,
        )
        .await
        .unwrap();
        let data = result.structured_content.unwrap();
        assert_eq!(data["outcome"], "timed_out");
        assert_eq!(data["execution_status"], "running");
        assert_eq!(
            fixture.runtime.borrow().executions["pending-run"].status,
            "running"
        );
        drop(fixture.owner);
        let result = wait_existing_result(
            &metadata,
            &observer,
            "pending-run",
            tokio::time::Instant::now() + Duration::from_secs(1),
            false,
        )
        .await
        .unwrap();
        assert_eq!(result.structured_content.unwrap()["outcome"], "unavailable");
        assert_eq!(fixture.runtime.borrow().executions.len(), 2);
    }

    #[tokio::test]
    async fn get_results_keeps_full_output_opt_in() {
        let mut metadata = NteractMcp::new("unused.sock".into(), None, None)
            .local_runtime_metadata()
            .await;
        let mut exec = execution_state(Some("source"));
        let text = (0..1000)
            .map(|n| format!("line {n}: a long output line\n"))
            .collect::<String>();
        let tmp = tempfile::TempDir::new().unwrap();
        let hash = "a".repeat(64);
        std::fs::create_dir_all(tmp.path().join(&hash[..2])).unwrap();
        std::fs::write(tmp.path().join(&hash[..2]).join(&hash[2..]), &text).unwrap();
        metadata.blob_store_path = Some(tmp.path().into());
        exec.outputs = vec![
            serde_json::json!({"output_type":"stream","name":"stdout","text":{"blob":hash,"size":text.len()},"llm_preview":{"head":"line 0","tail":"line 999","total_bytes":text.len(),"total_lines":1000}}),
        ];
        let preview = render_execution_result(&metadata, "run", &exec, None, None, None, false)
            .await
            .unwrap();
        let full = render_execution_result(&metadata, "run", &exec, None, None, None, true)
            .await
            .unwrap();
        let text_content = |result: &CallToolResult| {
            result
                .content
                .iter()
                .filter_map(|item| item.as_text())
                .map(|item| item.text.clone())
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert!(text_content(&full).contains("line 500:"));
        assert!(text_content(&full).len() > text_content(&preview).len());
    }

    #[test]
    fn run_all_queued_response_returns_cells_resource_link() {
        let result = cells_resource_result("Queued 2 cells for execution".into(), "nb 1");

        assert_eq!(result.is_error, Some(false));
        assert_eq!(
            result.content[0].as_text().expect("queue message").text,
            "Queued 2 cells for execution"
        );

        let link = result.content[1]
            .as_resource_link()
            .expect("cells resource link");
        assert_eq!(link.uri, "nteract://notebooks/nb%201/cells");
        assert_eq!(link.mime_type.as_deref(), Some("application/json"));

        let value = serde_json::to_value(&result).expect("serialize run_all response");
        assert_eq!(
            value["content"][1]["type"],
            serde_json::json!("resource_link")
        );
        assert_eq!(
            value["content"][1]["mimeType"],
            serde_json::json!("application/json")
        );
    }
}
