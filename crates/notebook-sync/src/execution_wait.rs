//! Shared execution-completion helper.
//!
//! All consumers of the daemon — the Rust MCP server, the Python client,
//! and any future tooling — need the same pattern to wait for a cell
//! execution to reach terminal state and collect its outputs. This module
//! centralises that pattern so behavior (and race handling) stays consistent.
//!
//! ## Why RuntimeStateDoc, not broadcasts
//!
//! The daemon writes `set_execution_done(execution_id, success)` *after* all
//! output manifests for the execution are committed to the RuntimeStateDoc
//! (`executions.{eid}.outputs`). Listening for the `ExecutionDone` broadcast
//! and then reading outputs is racy: the broadcast arrives over a separate
//! channel and the caller's Automerge replica may not have caught up on the
//! final stream writes. Polling the RuntimeStateDoc is the authoritative
//! path — by the time status transitions to `done`/`error`, outputs are in
//! the same doc and visible after one more sync tick.
//!
//! ## Two phases
//!
//! 1. **Terminal wait.** Poll until `executions[eid].status` is `"done"` or
//!    `"error"`.
//! 2. **Output-sync grace.** If the terminal status is reached but the
//!    output list is still empty, or the terminal output includes a stream
//!    manifest that may still be updating in place, poll briefly (capped at
//!    `output_sync_grace`) for the last sync frames to land.

use std::time::{Duration, Instant};

use runtime_doc::RuntimeLifecycle;

use crate::handle::DocHandle;

/// Outcome of awaiting a single execution.
#[derive(Debug, Clone)]
pub struct ExecutionTerminalState {
    /// `"done"` | `"error"` | `"timed_out"`.
    pub status: String,
    /// `true` when the kernel reported success. `false` on error or timeout.
    pub success: bool,
    /// Raw output manifest values from `RuntimeStateDoc::executions[eid].outputs`.
    /// Empty when the execution produced no outputs or timed out before
    /// sync caught up.
    pub output_manifests: Vec<serde_json::Value>,
    /// Execution count (`In[N]`), when reported by the kernel.
    pub execution_count: Option<i64>,
}

/// Why an execution-wait returned early.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionTerminalError {
    /// The deadline elapsed before terminal status was observed.
    Timeout,
    /// The kernel transitioned to `error` or `shutdown` while this execution
    /// was pending, so there is no per-execution terminal state to report.
    KernelFailed { reason: String },
}

/// Default output-sync grace period used by [`await_execution_terminal`] when
/// the caller does not override it. Bounded so a genuinely output-free
/// execution cannot block the caller indefinitely.
pub const DEFAULT_OUTPUT_SYNC_GRACE: Duration = Duration::from_millis(500);

/// Poll frequency while waiting for terminal status.
const TERMINAL_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Poll frequency during the output-sync grace window.
const OUTPUT_POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Quiet period after the last observed terminal stream-output mutation.
const STREAM_OUTPUT_QUIET_PERIOD: Duration = Duration::from_millis(100);

/// Wait for a specific execution to reach terminal status in the
/// `RuntimeStateDoc` and return the final outputs, execution count, and
/// success flag.
///
/// `timeout` bounds the whole wait (both phases). `output_sync_grace` is
/// clamped to the time remaining at the start of phase 2; pass `None` to
/// use [`DEFAULT_OUTPUT_SYNC_GRACE`].
///
/// Returns an error only when:
///
/// * the deadline elapsed before terminal status was observed, or
/// * the kernel itself transitioned to `error` / `shutdown` while this
///   execution was still pending (in which case the caller can surface the
///   kernel error rather than pretending this execution finished).
pub async fn await_execution_terminal(
    handle: &DocHandle,
    execution_id: &str,
    timeout: Duration,
    output_sync_grace: Option<Duration>,
) -> Result<ExecutionTerminalState, ExecutionTerminalError> {
    let deadline = Instant::now() + timeout;

    // ── Phase 1: wait for terminal status ───────────────────────────────
    let mut final_state = loop {
        if Instant::now() >= deadline {
            return Err(ExecutionTerminalError::Timeout);
        }

        if let Ok(state) = handle.get_runtime_state() {
            // Targeted execution wins over kernel-level status. When the
            // daemon fails a kernel mid-run, it writes `set_execution_done`
            // for pending executions *before* flipping `kernel.status` to
            // `"error"`, so a late consumer (e.g. `Execution.result()`
            // called after the fact) must be able to read a completed
            // execution's real status/outputs rather than being handed a
            // generic `KernelFailed`.
            if let Some(exec) = state.executions.get(execution_id) {
                if exec.status == "done" || exec.status == "error" {
                    break ExecutionTerminalState {
                        status: exec.status.clone(),
                        success: exec.success.unwrap_or(false),
                        output_manifests: exec.outputs.clone(),
                        execution_count: exec.execution_count,
                    };
                }
            }

            // Fallback: kernel fault aborts only if *this* execution is
            // still non-terminal. Otherwise the caller would spin until
            // the outer timeout fires.
            if matches!(state.kernel.lifecycle, RuntimeLifecycle::Error) {
                return Err(ExecutionTerminalError::KernelFailed {
                    reason: "kernel error".to_string(),
                });
            }
            if matches!(state.kernel.lifecycle, RuntimeLifecycle::Shutdown) {
                return Err(ExecutionTerminalError::KernelFailed {
                    reason: "kernel shutdown".to_string(),
                });
            }
        }

        tokio::time::sleep(TERMINAL_POLL_INTERVAL).await;
    };

    // ── Phase 2: output-sync grace ──────────────────────────────────────
    //
    // The daemon commits outputs before `set_execution_done`, but sync
    // frames can arrive in separate batches; our local replica may be a tick
    // behind. Stream outputs are also updated in place, so a non-empty output
    // list can still contain the penultimate stream blob. Poll briefly until
    // stream outputs are quiet.
    if final_state.output_manifests.is_empty() || has_stream_output(&final_state.output_manifests) {
        let grace = output_sync_grace.unwrap_or(DEFAULT_OUTPUT_SYNC_GRACE);
        let remaining_until_deadline = deadline.saturating_duration_since(Instant::now());
        let output_deadline = Instant::now() + grace.min(remaining_until_deadline);
        let mut stream_quiet_since = if has_stream_output(&final_state.output_manifests) {
            Some(Instant::now())
        } else {
            None
        };

        while Instant::now() < output_deadline {
            if stream_quiet_since.is_some_and(|since| since.elapsed() >= STREAM_OUTPUT_QUIET_PERIOD)
            {
                break;
            }

            if let Ok(state) = handle.get_runtime_state() {
                if let Some(exec) = state.executions.get(execution_id) {
                    if exec.outputs != final_state.output_manifests {
                        final_state.output_manifests = exec.outputs.clone();
                        if final_state.execution_count.is_none() {
                            final_state.execution_count = exec.execution_count;
                        }
                        stream_quiet_since = if has_stream_output(&final_state.output_manifests) {
                            Some(Instant::now())
                        } else {
                            None
                        };

                        if !final_state.output_manifests.is_empty()
                            && !has_stream_output(&final_state.output_manifests)
                        {
                            break;
                        }
                    }
                }
            }
            tokio::time::sleep(OUTPUT_POLL_INTERVAL).await;
        }
    }

    Ok(final_state)
}

fn has_stream_output(outputs: &[serde_json::Value]) -> bool {
    outputs
        .iter()
        .any(|output| output.get("output_type").and_then(|t| t.as_str()) == Some("stream"))
}
