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
//! 1. **Terminal wait.** Poll until `executions[eid].status` is `"done"`,
//!    `"error"`, or `"cancelled"`.
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
    /// `"done"` | `"error"` | `"cancelled"` | `"timed_out"`.
    ///
    /// `"cancelled"` means the execution was dropped from the queue without
    /// running (an earlier cell errored, an interrupt, or kernel
    /// death/restart).
    pub status: String,
    /// `true` when the kernel reported success. `false` on error, cancel, or
    /// timeout.
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
/// Default output-sync grace for blob-backed terminal streams, which can lag
/// behind terminal status under CI load because the manifest update and blob
/// write are larger than ordinary inline outputs.
pub const DEFAULT_BLOB_OUTPUT_SYNC_GRACE: Duration = Duration::from_secs(3);

/// Poll frequency while waiting for terminal status.
const TERMINAL_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Poll frequency during the output-sync grace window.
const OUTPUT_POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Quiet period after the last observed terminal stream-output mutation.
const STREAM_OUTPUT_QUIET_PERIOD: Duration = Duration::from_millis(100);
/// Quiet period for blob-backed terminal streams.
const BLOB_STREAM_OUTPUT_QUIET_PERIOD: Duration = Duration::from_millis(500);

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
                if exec.status == "done" || exec.status == "error" || exec.status == "cancelled" {
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
    if final_state.output_manifests.is_empty()
        || stream_output_settle_window(&final_state.output_manifests).is_some()
    {
        let (default_quiet_period, default_grace) =
            stream_output_settle_window(&final_state.output_manifests)
                .unwrap_or((STREAM_OUTPUT_QUIET_PERIOD, DEFAULT_OUTPUT_SYNC_GRACE));
        let grace = output_sync_grace.unwrap_or(default_grace);
        let remaining_until_deadline = deadline.saturating_duration_since(Instant::now());
        let output_deadline = Instant::now() + grace.min(remaining_until_deadline);
        let mut stream_quiet_since =
            stream_output_settle_window(&final_state.output_manifests).map(|_| Instant::now());
        let mut quiet_period = default_quiet_period;

        while Instant::now() < output_deadline {
            if stream_quiet_since.is_some_and(|since| since.elapsed() >= quiet_period) {
                break;
            }

            if let Ok(state) = handle.get_runtime_state() {
                if let Some(exec) = state.executions.get(execution_id) {
                    if exec.outputs != final_state.output_manifests {
                        final_state.output_manifests = exec.outputs.clone();
                        if final_state.execution_count.is_none() {
                            final_state.execution_count = exec.execution_count;
                        }
                        let stream_window =
                            stream_output_settle_window(&final_state.output_manifests);
                        if let Some((next_quiet_period, _)) = stream_window {
                            quiet_period = next_quiet_period;
                            stream_quiet_since = Some(Instant::now());
                        } else {
                            stream_quiet_since = None;
                        }

                        if !final_state.output_manifests.is_empty()
                            && stream_output_settle_window(&final_state.output_manifests).is_none()
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

/// Outcome of awaiting a batch of executions queued together (run-all).
///
/// Timeout and kernel failure map to fields rather than an error because a
/// batch wait always has a reportable summary; callers read per-execution
/// statuses from the RuntimeStateDoc afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllExecutionsTerminal {
    /// The shared deadline elapsed before every execution reached terminal
    /// status.
    pub timed_out: bool,
    /// Some execution terminalized as `"error"`, or the kernel failed
    /// (`error`/`shutdown`) while an execution was still pending.
    pub has_error: bool,
}

/// Wait for every execution in `execution_ids` to reach terminal status
/// against one shared deadline, then run one trailing output-sync grace pass.
///
/// The per-execution waits use zero output-sync grace: with the default
/// grace, N output-free executions would serialize into N x
/// [`DEFAULT_OUTPUT_SYNC_GRACE`] of sleep on large notebooks. Output settling
/// is instead deferred to a single trailing pass that re-awaits the
/// non-cancelled executions concurrently under the default grace rules, so
/// trailing executions with empty manifests or still-settling stream outputs
/// share one grace window (bounded by the time remaining until the deadline)
/// before this returns.
///
/// Error mappings:
///
/// * [`ExecutionTerminalError::Timeout`] on any execution sets `timed_out`
///   and stops waiting — the deadline is shared, so it has elapsed for the
///   remaining executions too, and no time remains for a grace pass.
/// * [`ExecutionTerminalError::KernelFailed`] sets `has_error` and stops
///   waiting for new terminal transitions — the kernel is gone, so pending
///   executions cannot run. Executions that did reach terminal state still
///   get the trailing grace pass, so their durable outputs sync before the
///   batch reports.
pub async fn await_all_executions_terminal(
    handle: &DocHandle,
    execution_ids: &[String],
    timeout: Duration,
) -> AllExecutionsTerminal {
    let deadline = Instant::now() + timeout;
    let mut has_error = false;

    // ── Phase 1: all-terminal, zero grace, one shared deadline ──────────
    let mut terminal: Vec<(&str, ExecutionTerminalState)> = Vec::with_capacity(execution_ids.len());
    for execution_id in execution_ids {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match await_execution_terminal(handle, execution_id, remaining, Some(Duration::ZERO)).await
        {
            Ok(state) => {
                has_error |= state.status == "error";
                terminal.push((execution_id, state));
            }
            Err(ExecutionTerminalError::Timeout) => {
                return AllExecutionsTerminal {
                    timed_out: true,
                    has_error,
                };
            }
            // The kernel is gone, so this execution can never terminalize.
            // Record the failure and keep sweeping: with the kernel in a
            // failed lifecycle the remaining awaits return on their first
            // poll — either an already-terminal state (collected for the
            // trailing grace pass below) or another immediate KernelFailed —
            // so the batch stops waiting for new terminal transitions while
            // executions that did terminalize still get their grace window.
            Err(ExecutionTerminalError::KernelFailed { .. }) => {
                has_error = true;
            }
        }
    }

    // ── Phase 2: one trailing output-sync grace pass ─────────────────────
    //
    // Terminal status is written after outputs, but this replica can be a
    // sync tick behind (see the module docs). Re-await the executions
    // concurrently with the default grace rules; `await_execution_terminal`
    // returns immediately for executions whose outputs are already settled,
    // so the settle predicate stays in one place and the pass costs one
    // grace window of wall clock, not one per execution.
    let mut settle = tokio::task::JoinSet::new();
    for (execution_id, state) in terminal {
        // Cancelled executions never receive outputs; waiting on them would
        // spend the full grace window for nothing.
        if state.status == "cancelled" {
            continue;
        }
        let handle = handle.clone();
        let execution_id = execution_id.to_string();
        let remaining = deadline.saturating_duration_since(Instant::now());
        settle.spawn(async move {
            // Best-effort: statuses are already terminal, so a grace pass
            // cut short by the deadline does not change the outcome.
            let _ = await_execution_terminal(&handle, &execution_id, remaining, None).await;
        });
    }
    while settle.join_next().await.is_some() {}

    AllExecutionsTerminal {
        timed_out: false,
        has_error,
    }
}

fn stream_output_settle_window(outputs: &[serde_json::Value]) -> Option<(Duration, Duration)> {
    let has_blob_stream = outputs.iter().any(|output| {
        output.get("output_type").and_then(|t| t.as_str()) == Some("stream")
            && output
                .get("text")
                .and_then(|text| text.get("blob"))
                .is_some()
    });
    if has_blob_stream {
        return Some((
            BLOB_STREAM_OUTPUT_QUIET_PERIOD,
            DEFAULT_BLOB_OUTPUT_SYNC_GRACE,
        ));
    }

    outputs
        .iter()
        .any(|output| output.get("output_type").and_then(|t| t.as_str()) == Some("stream"))
        .then_some((STREAM_OUTPUT_QUIET_PERIOD, DEFAULT_OUTPUT_SYNC_GRACE))
}
