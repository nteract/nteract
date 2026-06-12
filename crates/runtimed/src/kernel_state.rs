//! Execution state machine for the runtime agent.
//!
//! `KernelState` owns the execution queue, currently-executing id, and
//! kernel lifecycle status. It is designed to be held as a plain local
//! variable in the runtime agent's `select!` loop — no mutex needed.
//!
//! Async methods (`queue_cell`, `execution_done`, `process_next`) accept a
//! `&mut impl KernelConnection` so they can send execute requests without
//! owning the connection.

use std::collections::VecDeque;

use anyhow::Result;
use runtime_doc::RuntimeStateHandle;
use tracing::{debug, info, warn};

use crate::kernel_connection::KernelConnection;
use crate::output_prep::{KernelStatus, QueuedCell};
use crate::protocol::QueueEntry;
use runtime_doc::QueueEntry as DocQueueEntry;

// ── Helpers ────────────────────────────────────────────────────────────────

/// Convert a protocol `QueueEntry` to a `RuntimeStateDoc` `QueueEntry`.
fn to_doc_entry(e: &QueueEntry) -> DocQueueEntry {
    DocQueueEntry {
        execution_id: e.execution_id.clone(),
    }
}

/// Convert a slice of protocol `QueueEntry`s to doc entries.
fn to_doc_entries(entries: &[QueueEntry]) -> Vec<DocQueueEntry> {
    entries.iter().map(to_doc_entry).collect()
}

// ── KernelState ────────────────────────────────────────────────────────────

/// Execution state machine for the runtime agent.
///
/// Owns the queue, executing-cell slot, and kernel status. The runtime agent
/// holds this as a local variable — all mutation goes through `&mut self`.
pub struct KernelState {
    /// Cells pending execution.
    queue: VecDeque<QueuedCell>,
    /// Execution id of the currently running request.
    executing: Option<String>,
    /// Whether the current execution produced an error output.
    /// Read by `execution_done` to record success/failure in the state doc.
    execution_had_error: bool,
    /// Interrupted execution id awaiting a final kernel idle.
    interrupt_pending: Option<String>,
    /// Kernel lifecycle status.
    status: KernelStatus,

    // ── Shared references (not owned, just held) ───────────────────────
    /// Per-notebook runtime state handle (daemon-authoritative).
    state: RuntimeStateHandle,
}

impl KernelState {
    /// Create a new `KernelState` with initial status `Starting`.
    pub fn new(state: RuntimeStateHandle) -> Self {
        Self {
            queue: VecDeque::new(),
            executing: None,
            execution_had_error: false,
            interrupt_pending: None,
            status: KernelStatus::Starting,
            state,
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /// Clear all execution state for a new kernel launch.
    pub fn reset(&mut self) {
        self.queue.clear();
        self.executing = None;
        self.execution_had_error = false;
        self.interrupt_pending = None;
        self.status = KernelStatus::Starting;
    }

    /// Transition to idle after kernel launch completes.
    pub fn set_idle(&mut self) {
        self.interrupt_pending = None;
        self.status = KernelStatus::Idle;
    }

    // ── Queue operations ───────────────────────────────────────────────

    /// Queue code for execution.
    ///
    /// Idempotent: if the cell is already executing or queued, returns the
    /// existing `execution_id` instead of generating a new one.
    ///
    /// After queuing, calls `process_next` to start execution if nothing is
    /// currently running.
    pub async fn queue_cell(
        &mut self,
        execution_id: String,
        cell_id: Option<String>,
        source: String,
        conn: &mut impl KernelConnection,
    ) -> Result<String> {
        // Idempotent: return existing execution_id if already executing or queued
        if self.executing.as_deref() == Some(execution_id.as_str()) {
            info!(
                "[kernel-state] Execution {} already running, skipping",
                execution_id
            );
            return Ok(execution_id);
        }
        if let Some(existing) = self.queue.iter().find(|c| c.execution_id == execution_id) {
            info!(
                "[kernel-state] Execution {} already queued, skipping",
                existing.execution_id
            );
            return Ok(existing.execution_id.clone());
        }

        info!("[kernel-state] Queuing execution: {}", execution_id);

        // Add to queue.
        self.queue.push_back(QueuedCell {
            execution_id: execution_id.clone(),
            cell_id,
            code: source,
            queued_at: std::time::Instant::now(),
        });

        // Write to state doc
        {
            let doc_exec = self.executing_entry().as_ref().map(to_doc_entry);
            let doc_queued = to_doc_entries(&self.queued_entries());
            if let Err(e) = self.state.with_doc(|sd| {
                sd.create_execution(&execution_id)?;
                sd.set_queue(doc_exec.as_ref(), &doc_queued)?;
                Ok(())
            }) {
                warn!("[runtime-state] {}", e);
            }
        }

        // Try to process if nothing executing
        self.process_next(conn).await?;
        Ok(execution_id)
    }

    /// Mark a cell execution as complete and process the next queued cell.
    ///
    /// Only acts if `execution_id` matches the currently executing cell.
    pub async fn execution_done(
        &mut self,
        execution_id: &str,
        conn: &mut impl KernelConnection,
    ) -> Result<()> {
        let matches = self
            .executing
            .as_ref()
            .is_some_and(|eid| eid == execution_id);
        if matches {
            let success = !self.execution_had_error;
            self.executing = None;
            self.execution_had_error = false;
            self.status = KernelStatus::Idle;

            // Write to state doc
            {
                let doc_queued = to_doc_entries(&self.queued_entries());
                if let Err(e) = self.state.with_doc(|sd| {
                    sd.set_execution_done(execution_id, success)?;
                    sd.set_queue(None, &doc_queued)?;
                    Ok(())
                }) {
                    warn!("[runtime-state] {}", e);
                }
            }

            // Process next
            self.process_next(conn).await?;
        }
        Ok(())
    }

    /// Record that the current execution produced an error output.
    ///
    /// Called before `execution_done` so it can determine success/failure.
    /// Returns `false` for stale errors from an already-interrupted execution.
    pub fn mark_execution_error(&mut self, execution_id: &str) -> bool {
        let is_current = self
            .executing
            .as_ref()
            .is_some_and(|eid| eid == execution_id);
        if is_current {
            self.execution_had_error = true;
        } else {
            debug!(
                "[kernel-state] Ignoring stale CellError for execution={}",
                execution_id
            );
        }
        is_current
    }

    /// Clear local execution state after an interrupt request is accepted.
    ///
    /// The Jupyter kernel may still deliver late IOPub for the interrupted
    /// request. Clearing `executing` here makes those late messages harmless
    /// stale events, while `interrupt_pending` prevents sending new execute
    /// requests until the kernel reports a real idle state.
    pub fn interrupt(&mut self) -> (Option<QueueEntry>, Vec<QueueEntry>) {
        let interrupted = self.executing.take().map(|execution_id| QueueEntry {
            cell_id: String::new(),
            execution_id,
        });
        self.interrupt_pending = interrupted.as_ref().map(|entry| entry.execution_id.clone());
        let cleared = self.clear_queue();
        self.execution_had_error = false;
        self.status = if self.interrupt_pending.is_some() {
            KernelStatus::Busy
        } else {
            KernelStatus::Idle
        };
        (interrupted, cleared)
    }

    /// Release the interrupt gate when the interrupted execution reports idle.
    pub async fn kernel_idle(
        &mut self,
        execution_id: Option<&str>,
        conn: &mut impl KernelConnection,
    ) -> Result<()> {
        let should_release = self
            .interrupt_pending
            .as_deref()
            .is_some_and(|pending| Some(pending) == execution_id);
        if should_release {
            self.interrupt_pending = None;
            self.status = KernelStatus::Idle;
            self.process_next(conn).await?;
        }
        Ok(())
    }

    /// Drain the execution queue.
    ///
    /// Returns the cleared entries. Does NOT clear the executing cell — that
    /// is the caller's responsibility (e.g., via interrupt or kernel_died).
    pub fn clear_queue(&mut self) -> Vec<QueueEntry> {
        let cleared: Vec<QueueEntry> = self
            .queue
            .drain(..)
            .map(|c| QueueEntry {
                cell_id: String::new(),
                execution_id: c.execution_id,
            })
            .collect();

        cleared
    }

    /// Handle kernel death (process exit or heartbeat failure).
    ///
    /// Sets status to `Dead`, clears the executing cell and queue, broadcasts
    /// error status. Returns the interrupted execution (if any) and cleared
    /// queue entries.
    ///
    /// Idempotent — multiple calls (e.g., from both process watcher and
    /// heartbeat monitor) are safe.
    pub fn kernel_died(&mut self) -> (Option<String>, Vec<QueueEntry>) {
        // Idempotent: if already dead, don't re-broadcast
        if self.status == KernelStatus::Dead {
            debug!("[kernel-state] kernel_died called but already dead, ignoring");
            return (None, vec![]);
        }

        warn!(
            "[kernel-state] Kernel died, executing={:?}, queued={}",
            self.executing,
            self.queue.len()
        );

        // Capture the interrupted execution before clearing
        let interrupted = self.executing.take();
        self.status = KernelStatus::Dead;

        // Clear any queued cells — they can't execute without a kernel
        let cleared = self.clear_queue();
        if !cleared.is_empty() {
            info!(
                "[kernel-state] Cleared {} queued cells due to kernel death",
                cleared.len()
            );
        }

        // Note: state_doc writes for kernel_died happen in the async command
        // processor (`handle_lifecycle_signal` in runtime_agent.rs for the
        // `LifecycleSignal::KernelDied` arm).
        // state_doc.set_lifecycle_with_error(&RuntimeLifecycle::Error, None) +
        // set_queue(None, &[]) + set_execution_done for interrupted + cleared entries

        (interrupted, cleared)
    }

    // ── Internal: process next ─────────────────────────────────────────

    /// Pop the next cell from the queue and send an execute request.
    ///
    /// No-op if something is already executing or the queue is empty.
    async fn process_next(&mut self, conn: &mut impl KernelConnection) -> Result<()> {
        // Already executing?
        if self.executing.is_some() {
            return Ok(());
        }
        if self.interrupt_pending.is_some() {
            return Ok(());
        }

        // Get next cell
        let Some(cell) = self.queue.pop_front() else {
            return Ok(());
        };
        let queue_wait_ms = cell.queued_at.elapsed().as_millis();
        let remaining_queue = self.queue.len();

        self.executing = Some(cell.execution_id.clone());
        self.status = KernelStatus::Busy;

        // Write to state doc
        {
            let doc_exec = self.executing_entry().as_ref().map(to_doc_entry);
            let doc_queued = to_doc_entries(&self.queued_entries());
            if let Err(e) = self.state.with_doc(|sd| {
                sd.set_execution_running(&cell.execution_id)?;
                sd.set_queue(doc_exec.as_ref(), &doc_queued)?;
                Ok(())
            }) {
                warn!("[runtime-state] {}", e);
            }
        }

        // Send execute request via the connection
        conn.execute(&cell.execution_id, cell.cell_id.as_deref(), &cell.code)
            .await?;

        info!(
            "[kernel-state] Sent execute_request: execution_id={} queue_wait_ms={} remaining_queue={}",
            cell.execution_id, queue_wait_ms, remaining_queue
        );

        Ok(())
    }

    // ── Read-only accessors ────────────────────────────────────────────

    /// Current kernel lifecycle status.
    pub fn status(&self) -> KernelStatus {
        self.status
    }

    /// Whether the kernel is running (not Dead, not ShuttingDown).
    pub fn is_running(&self) -> bool {
        !matches!(self.status, KernelStatus::Dead | KernelStatus::ShuttingDown)
    }

    /// The currently executing id, if any.
    pub fn executing_cell(&self) -> Option<&String> {
        self.executing.as_ref()
    }

    /// Snapshot of queued entries as protocol `QueueEntry`s.
    pub fn queued_entries(&self) -> Vec<QueueEntry> {
        self.queue
            .iter()
            .map(|c| QueueEntry {
                cell_id: String::new(),
                execution_id: c.execution_id.clone(),
            })
            .collect()
    }

    /// The currently executing entry as a protocol `QueueEntry`, if any.
    pub fn executing_entry(&self) -> Option<QueueEntry> {
        self.executing.as_ref().map(|eid| QueueEntry {
            cell_id: String::new(),
            execution_id: eid.clone(),
        })
    }

    /// Write current queue state to the RuntimeStateDoc.
    ///
    /// Used by callers that need to sync state doc after modifying the queue
    /// externally (e.g., interrupt handler).
    pub fn write_queue_to_state_doc(&self) {
        let doc_exec = self.executing_entry().as_ref().map(to_doc_entry);
        let doc_queued = to_doc_entries(&self.queued_entries());
        if let Err(e) = self.state.with_doc(|sd| {
            sd.set_queue(doc_exec.as_ref(), &doc_queued)?;
            Ok(())
        }) {
            warn!("[runtime-state] {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel_connection::{KernelConnection, KernelLaunchConfig, KernelSharedRefs};
    use crate::output_prep::QueueCommandReceivers;
    use crate::protocol::CompletionItem;
    use anyhow::Result;
    use notebook_protocol::protocol::LaunchedEnvConfig;
    use std::path::PathBuf;

    /// Minimal mock that records execute calls and succeeds.
    struct MockKernel {
        executes: Vec<String>,
    }

    impl MockKernel {
        fn new() -> Self {
            Self {
                executes: Vec::new(),
            }
        }
    }

    impl KernelConnection for MockKernel {
        async fn launch(
            _config: KernelLaunchConfig,
            _shared: KernelSharedRefs,
        ) -> Result<(Self, QueueCommandReceivers)> {
            unimplemented!("tests create MockKernel directly")
        }

        async fn execute(
            &mut self,
            execution_id: &str,
            _cell_id: Option<&str>,
            _source: &str,
        ) -> Result<()> {
            self.executes.push(execution_id.to_string());
            Ok(())
        }

        async fn interrupt(&mut self) -> Result<()> {
            Ok(())
        }
        async fn shutdown(&mut self) -> Result<()> {
            Ok(())
        }
        async fn send_comm_message(
            &mut self,
            _: notebook_protocol::protocol::CommRequestMessage,
        ) -> Result<()> {
            Ok(())
        }
        async fn send_comm_update(
            &mut self,
            _: &str,
            _: serde_json::Value,
            _: Vec<Vec<String>>,
            _: Vec<Vec<u8>>,
        ) -> Result<()> {
            Ok(())
        }
        async fn complete(
            &mut self,
            _: &str,
            _: usize,
        ) -> Result<(Vec<CompletionItem>, usize, usize)> {
            Ok((vec![], 0, 0))
        }
        async fn get_history(
            &mut self,
            _: Option<&str>,
            _: i32,
            _: bool,
        ) -> Result<Vec<crate::protocol::HistoryEntry>> {
            Ok(vec![])
        }
        fn kernel_type(&self) -> &str {
            "python"
        }
        fn env_source(&self) -> &str {
            "test"
        }
        fn launched_config(&self) -> &LaunchedEnvConfig {
            // Leak a static default — fine for tests.
            Box::leak(Box::new(LaunchedEnvConfig::default()))
        }
        fn env_path(&self) -> Option<&PathBuf> {
            None
        }
        fn is_connected(&self) -> bool {
            true
        }
        fn update_launched_uv_deps(&mut self, _: Vec<String>) {}
    }

    /// Build a `KernelState` wired to a fresh `RuntimeStateHandle`.
    fn test_state() -> (KernelState, RuntimeStateHandle) {
        let (state_changed_tx, _) = tokio::sync::broadcast::channel(64);
        let handle = RuntimeStateHandle::new(runtime_doc::RuntimeStateDoc::new(), state_changed_tx);
        let state = KernelState::new(handle.clone());
        (state, handle)
    }

    // ── kernel_died tests ────────────────────────────────────────────────

    #[tokio::test]
    async fn kernel_died_returns_interrupted_execution_and_cleared_queue() {
        let (mut state, _handle) = test_state();
        let mut mock = MockKernel::new();
        state.set_idle();

        // Queue two cells — first starts executing, second stays queued
        state
            .queue_cell("e1".into(), None, "x=1".into(), &mut mock)
            .await
            .unwrap();
        state
            .queue_cell("e2".into(), None, "x=2".into(), &mut mock)
            .await
            .unwrap();

        assert!(state.executing_cell().is_some());
        assert_eq!(state.queued_entries().len(), 1);

        let (interrupted, cleared) = state.kernel_died();

        // Should return the executing id
        assert_eq!(interrupted.unwrap(), "e1");

        // Should return the cleared queued entry
        assert_eq!(cleared.len(), 1);
        assert_eq!(cleared[0].execution_id, "e2");

        // State should be cleared
        assert!(state.executing_cell().is_none());
        assert!(state.queued_entries().is_empty());
    }

    #[tokio::test]
    async fn kernel_died_idempotent_when_already_dead() {
        let (mut state, _handle) = test_state();
        let mut mock = MockKernel::new();
        state.set_idle();

        state
            .queue_cell("e1".into(), None, "x=1".into(), &mut mock)
            .await
            .unwrap();

        // First call returns data
        let (interrupted, _) = state.kernel_died();
        assert!(interrupted.is_some());

        // Second call is a no-op
        let (interrupted2, cleared2) = state.kernel_died();
        assert!(interrupted2.is_none());
        assert!(cleared2.is_empty());
    }

    #[tokio::test]
    async fn kernel_died_with_empty_queue() {
        let (mut state, _handle) = test_state();
        state.set_idle();

        let (interrupted, cleared) = state.kernel_died();
        assert!(interrupted.is_none());
        assert!(cleared.is_empty());
    }

    // ── reset tests ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn reset_clears_executing_and_queue() {
        let (mut state, _handle) = test_state();
        let mut mock = MockKernel::new();
        state.set_idle();

        state
            .queue_cell("e1".into(), None, "x=1".into(), &mut mock)
            .await
            .unwrap();
        state
            .queue_cell("e2".into(), None, "x=2".into(), &mut mock)
            .await
            .unwrap();

        assert!(state.executing_cell().is_some());
        assert_eq!(state.queued_entries().len(), 1);

        state.reset();

        assert!(state.executing_cell().is_none());
        assert!(state.queued_entries().is_empty());
    }
}
