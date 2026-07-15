//! Execution pipeline: submit cell → poll RuntimeStateDoc → collect outputs.
//!
//! This module handles the async execution lifecycle for `execute_cell` and
//! tools that use `and_run`. It polls the RuntimeStateDoc (the daemon-owned
//! Automerge CRDT) for execution lifecycle state, using the CRDT as the
//! source of truth instead of relying on broadcast hints.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use notebook_protocol::protocol::{NotebookRequest, NotebookResponse};
use notebook_sync::execution_wait::{
    await_execution_terminal, ExecutionTerminalError, ExecutionTerminalState,
};
use notebook_sync::handle::DocHandle;
use runtimed_outputs::output_resolver;
use runtimed_outputs::resolved_output::Output;
use tracing::warn;

#[derive(Debug, Clone)]
pub struct ExecutionDispatchError {
    pub code: &'static str,
    pub message: String,
}

impl ExecutionDispatchError {
    fn sync_failed(message: impl Into<String>) -> Self {
        Self {
            code: "sync_failed",
            message: message.into(),
        }
    }

    fn not_ready(message: impl Into<String>) -> Self {
        Self {
            code: "notebook_not_ready",
            message: message.into(),
        }
    }
}

/// Result of executing a cell.
pub struct ExecutionResult {
    /// The cell ID that was executed.
    pub cell_id: String,
    /// The execution ID assigned by the daemon (from `CellQueued`).
    /// Agents can pass this to `get_cell(execution_id=...)` to read
    /// outputs for this specific execution, bypassing the cell's
    /// current pointer.
    pub execution_id: String,
    /// Resolved outputs from the cell after execution.
    pub outputs: Vec<Output>,
    /// Output manifests that produced `outputs` and `resolved_outputs_by_manifest`.
    pub output_manifests: Vec<serde_json::Value>,
    /// Resolved outputs indexed to the original output manifest positions.
    pub resolved_outputs_by_manifest: Vec<Option<Output>>,
    /// Execution count (e.g., "5" for In[5]).
    pub execution_count: Option<String>,
    /// Final status: "done", "error", "running" (if timed out).
    pub status: String,
    /// Whether the execution completed successfully.
    pub success: bool,
}

/// Build the current execution_id -> cell_id map from NotebookDoc pointers.
///
/// RuntimeStateDoc intentionally does not require cell IDs, because some
/// executions are notebook-less. Notebook callers can still provide this
/// best-effort map to LLM output resolution for traceback provenance.
pub fn execution_cell_map(handle: &DocHandle) -> HashMap<String, String> {
    handle
        .get_cell_execution_pointers()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(cell_id, execution_id)| execution_id.map(|eid| (eid, cell_id)))
        .collect()
}

/// Execute a cell and wait for completion.
///
/// 1. Captures current Automerge heads as a causal precondition.
/// 2. Sends `ExecuteCell` request.
/// 3. Polls RuntimeStateDoc until the execution reaches terminal status.
/// 4. Collects and resolves outputs from the CRDT.
///
/// The daemon writes `set_execution_done` AFTER all outputs are written,
/// so once the synced execution status is `"done"` or `"error"`, outputs
/// are guaranteed to be present.
pub async fn execute_and_wait(
    handle: &DocHandle,
    cell_id: &str,
    timeout: Duration,
    blob_base_url: &Option<String>,
    blob_store_path: &Option<std::path::PathBuf>,
) -> Result<ExecutionResult, ExecutionDispatchError> {
    // Step 1: Capture the source version this command is meant to observe.
    let required_heads = handle.current_heads_hex().map_err(|error| {
        ExecutionDispatchError::sync_failed(format!(
            "Could not capture the notebook heads required for execution: {error}"
        ))
    })?;

    // Step 2: Submit execution request
    let request = NotebookRequest::ExecuteCell {
        cell_id: cell_id.to_string(),
        execution_id: None,
    };
    let response = handle
        .send_request_after_heads(request, required_heads)
        .await;

    let execution_id = match response {
        Ok(NotebookResponse::CellQueued { execution_id, .. }) => execution_id,
        Ok(NotebookResponse::Error { error })
        | Ok(NotebookResponse::GuardRejected { reason: error }) => {
            return Err(ExecutionDispatchError::not_ready(format!(
                "Execution was not queued: {error}"
            )));
        }
        Ok(other) => {
            return Err(ExecutionDispatchError::sync_failed(format!(
                "Execution returned an unexpected daemon response: {other:?}"
            )));
        }
        Err(error) => {
            return Err(ExecutionDispatchError::sync_failed(format!(
                "Execution could not be queued after the required heads: {error}"
            )));
        }
    };

    // Step 3: Wait for terminal state via the shared helper. This uses
    // the RuntimeStateDoc as the source of truth (no broadcast dependency)
    // and applies a bounded output-sync grace period to catch the case
    // where the last stream writes arrive in a sync frame after the
    // status transition.
    let mut final_status = "running".to_string();
    let mut success = false;
    let mut output_manifests: Vec<serde_json::Value> = Vec::new();
    let mut execution_count_from_wait: Option<i64> = None;

    match await_execution_terminal(handle, &execution_id, timeout, None).await {
        Ok(ExecutionTerminalState {
            status,
            success: s,
            output_manifests: outs,
            execution_count,
        }) => {
            final_status = status;
            success = s;
            output_manifests = outs;
            execution_count_from_wait = execution_count;
        }
        Err(ExecutionTerminalError::Timeout) => {
            // Leave `running` and fall through — caller can surface
            // timeout based on the status field.
        }
        Err(ExecutionTerminalError::KernelFailed { reason }) => {
            warn!("kernel failed during execution: {reason}");
            final_status = "error".to_string();
        }
    }

    // Step 4: Collect outputs from CRDT.
    // Prefer output hashes from RuntimeStateDoc (already returned above).
    let execution_count = execution_count_from_wait.map(|count| count.to_string());

    let comms = handle.get_runtime_state().ok().map(|rs| rs.comms);
    let mut execution_cell_map = execution_cell_map(handle);
    execution_cell_map
        .entry(execution_id.clone())
        .or_insert_with(|| cell_id.to_string());
    // Execute paths (and `and_run` variants) always use preview mode —
    // agents that need unabridged output should call `get_cell(full_output=true)`
    // afterwards rather than paying for it on every run.
    let ctx = output_resolver::ResolveCtx {
        blob_base_url: blob_base_url.as_deref(),
        blob_store_path: blob_store_path.as_deref(),
        comms: comms.as_ref(),
        execution_cell_map: Some(&execution_cell_map),
        ..Default::default()
    };
    let output_manifests = if !output_manifests.is_empty() {
        output_manifests
    } else {
        // Outputs live in RuntimeStateDoc under execution_id/output_id. Fetch
        // via the explicit lookup — CellSnapshot no longer carries them.
        handle.get_cell_outputs(cell_id).unwrap_or_default()
    };

    let (outputs, resolved_outputs_by_manifest) = if output_manifests.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let aligned =
            output_resolver::resolve_cell_outputs_for_llm_aligned(&output_manifests, ctx).await;
        let outputs = aligned.iter().flatten().cloned().collect();
        (outputs, aligned)
    };

    Ok(ExecutionResult {
        cell_id: cell_id.to_string(),
        execution_id,
        outputs,
        output_manifests,
        resolved_outputs_by_manifest,
        execution_count,
        status: final_status,
        success,
    })
}

/// Result of running all cells.
pub struct RunAllResult {
    /// Whether the deadline was hit before all cells finished.
    pub timed_out: bool,
    /// Overall status: "completed", "error", or "timed_out".
    pub status: String,
    /// Map of cell_id → execution_id for this run's queued cells.
    /// Used to scope status lookups to this specific run.
    pub cell_execution_ids: HashMap<String, String>,
}

/// Queue all cells for execution without waiting for completion.
///
/// 1. Captures current Automerge heads as a causal precondition.
/// 2. Sends `RunAllCells` request.
///
/// Returns immediately with the queued cell→execution ID mapping.
pub async fn run_all_and_queue(handle: &DocHandle) -> Result<RunAllResult, ExecutionDispatchError> {
    let required_heads = handle.current_heads_hex().map_err(|error| {
        ExecutionDispatchError::sync_failed(format!(
            "Could not capture the notebook heads required to run all cells: {error}"
        ))
    })?;

    let response = handle
        .send_request_after_heads(
            NotebookRequest::RunAllCells {
                cell_execution_ids: None,
            },
            required_heads,
        )
        .await;

    let cell_execution_ids: HashMap<String, String> = match response {
        Ok(NotebookResponse::AllCellsQueued { queued }) => queued
            .into_iter()
            .map(|q| (q.cell_id, q.execution_id))
            .collect(),
        Ok(NotebookResponse::Error { error })
        | Ok(NotebookResponse::GuardRejected { reason: error }) => {
            return Err(ExecutionDispatchError::not_ready(format!(
                "Run all was not queued: {error}"
            )));
        }
        Ok(other) => {
            return Err(ExecutionDispatchError::sync_failed(format!(
                "Run all returned an unexpected daemon response: {other:?}"
            )));
        }
        Err(error) => {
            return Err(ExecutionDispatchError::sync_failed(format!(
                "Run all could not be queued after the required heads: {error}"
            )));
        }
    };

    let status = if cell_execution_ids.is_empty() {
        "completed"
    } else {
        "queued"
    }
    .to_string();

    Ok(RunAllResult {
        timed_out: false,
        status,
        cell_execution_ids,
    })
}

/// Run all cells and wait for completion.
///
/// Composes `run_all_and_queue` with a polling phase that waits for all
/// queued execution IDs to reach terminal status in the RuntimeStateDoc.
///
/// Returns a lightweight `RunAllResult` with overall status. The caller should
/// read the full notebook state after this returns to build the summary view.
pub async fn run_all_and_wait(
    handle: &DocHandle,
    timeout: Duration,
) -> Result<RunAllResult, ExecutionDispatchError> {
    let mut result = run_all_and_queue(handle).await?;

    if result.status == "error" || result.cell_execution_ids.is_empty() {
        return Ok(result);
    }

    let execution_ids: HashSet<&str> = result
        .cell_execution_ids
        .values()
        .map(|s| s.as_str())
        .collect();

    // Poll RuntimeStateDoc for all execution IDs to reach terminal status.
    let deadline = Instant::now() + timeout;
    let mut all_terminal = false;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        if let Ok(state) = handle.get_runtime_state() {
            all_terminal = execution_ids.iter().all(|eid| {
                state.executions.get(*eid).is_some_and(|exec| {
                    exec.status == "done" || exec.status == "error" || exec.status == "cancelled"
                })
            });
            if all_terminal {
                break;
            }
        }

        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Derive overall status.
    let timed_out = !all_terminal;
    let has_error = handle.get_runtime_state().ok().is_some_and(|state| {
        execution_ids.iter().any(|eid| {
            state
                .executions
                .get(*eid)
                .is_some_and(|exec| exec.status == "error")
        })
    });

    result.timed_out = timed_out;
    result.status = if timed_out {
        "timed_out"
    } else if has_error {
        "error"
    } else {
        "completed"
    }
    .to_string();

    Ok(result)
}
