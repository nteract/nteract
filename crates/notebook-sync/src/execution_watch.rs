//! RuntimeStateDoc-backed execution progress watcher.
//!
//! This is the shared "latest-state" primitive for bindings that want to
//! stream one execution without receiving Automerge frames over FFI.

use runtime_doc::{ExecutionState, RuntimeLifecycle, RuntimeState};
use tokio::sync::watch;
use tokio::time::{Duration, Instant};

use crate::handle::DocHandle;

const TERMINAL_STREAM_OUTPUT_QUIET_PERIOD: Duration = Duration::from_millis(100);
const TERMINAL_STREAM_OUTPUT_MAX_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionTerminalReason {
    Done,
    Error,
    KernelFailed,
    Interrupted,
    Timeout,
    Closed,
}

impl ExecutionTerminalReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Error => "error",
            Self::KernelFailed => "kernel_failed",
            Self::Interrupted => "interrupted",
            Self::Timeout => "timeout",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionProgressState {
    pub cell_id: String,
    pub execution_id: String,
    pub status: String,
    pub success: Option<bool>,
    pub execution_count: Option<i64>,
    pub output_manifests: Vec<serde_json::Value>,
    pub terminal: bool,
    pub terminal_reason: Option<ExecutionTerminalReason>,
}

pub struct ExecutionWatcher {
    rx: watch::Receiver<RuntimeState>,
    cell_id: String,
    execution_id: String,
    prev: Option<ExecutionState>,
    finished: bool,
}

impl ExecutionWatcher {
    pub fn new(
        handle: &DocHandle,
        cell_id: impl Into<String>,
        execution_id: impl Into<String>,
    ) -> Self {
        Self {
            rx: handle.subscribe_runtime_state(),
            cell_id: cell_id.into(),
            execution_id: execution_id.into(),
            prev: None,
            finished: false,
        }
    }

    pub async fn next(&mut self) -> Option<ExecutionProgressState> {
        if self.finished {
            return None;
        }

        loop {
            let state = self.rx.borrow_and_update().clone();
            if let Some(progress) = self.progress_from_state(&state) {
                if progress.terminal {
                    let progress = self.settle_terminal_stream_output(progress).await;
                    self.finished = true;
                    return Some(progress);
                }
                return Some(progress);
            }

            if let Some(progress) = self.kernel_terminal_from_state(&state) {
                self.finished = true;
                return Some(progress);
            }

            if self.rx.changed().await.is_err() {
                self.finished = true;
                return Some(self.synthetic_terminal(
                    "closed",
                    None,
                    Vec::new(),
                    ExecutionTerminalReason::Closed,
                ));
            }
        }
    }

    pub fn timeout(&mut self) -> Option<ExecutionProgressState> {
        if self.finished {
            return None;
        }
        self.finished = true;
        let (status, success, outputs, count) = self
            .prev
            .as_ref()
            .map(|entry| {
                (
                    entry.status.clone(),
                    entry.success,
                    entry.outputs.clone(),
                    entry.execution_count,
                )
            })
            .unwrap_or_else(|| ("timeout".to_string(), None, Vec::new(), None));
        Some(ExecutionProgressState {
            cell_id: self.cell_id.clone(),
            execution_id: self.execution_id.clone(),
            status,
            success,
            execution_count: count,
            output_manifests: outputs,
            terminal: true,
            terminal_reason: Some(ExecutionTerminalReason::Timeout),
        })
    }

    fn progress_from_state(&mut self, state: &RuntimeState) -> Option<ExecutionProgressState> {
        let entry = state.executions.get(&self.execution_id)?;
        if self.prev.as_ref() == Some(entry) {
            return None;
        }
        self.prev = Some(entry.clone());

        let terminal_reason = terminal_reason_for(entry);
        Some(ExecutionProgressState {
            cell_id: self.cell_id.clone(),
            execution_id: self.execution_id.clone(),
            status: entry.status.clone(),
            success: entry.success,
            execution_count: entry.execution_count,
            output_manifests: entry.outputs.clone(),
            terminal: terminal_reason.is_some(),
            terminal_reason,
        })
    }

    fn kernel_terminal_from_state(&self, state: &RuntimeState) -> Option<ExecutionProgressState> {
        let reason = match state.kernel.lifecycle {
            RuntimeLifecycle::Error => Some(ExecutionTerminalReason::KernelFailed),
            RuntimeLifecycle::Shutdown => Some(ExecutionTerminalReason::Closed),
            _ => None,
        }?;
        Some(self.synthetic_terminal(reason.as_str(), Some(false), Vec::new(), reason))
    }

    fn synthetic_terminal(
        &self,
        status: &str,
        success: Option<bool>,
        output_manifests: Vec<serde_json::Value>,
        reason: ExecutionTerminalReason,
    ) -> ExecutionProgressState {
        ExecutionProgressState {
            cell_id: self.cell_id.clone(),
            execution_id: self.execution_id.clone(),
            status: status.to_string(),
            success,
            execution_count: None,
            output_manifests,
            terminal: true,
            terminal_reason: Some(reason),
        }
    }

    async fn settle_terminal_stream_output(
        &mut self,
        mut progress: ExecutionProgressState,
    ) -> ExecutionProgressState {
        if !has_stream_output(&progress.output_manifests) {
            return progress;
        }

        let max_deadline = Instant::now() + TERMINAL_STREAM_OUTPUT_MAX_GRACE;
        let mut quiet_deadline = Instant::now() + TERMINAL_STREAM_OUTPUT_QUIET_PERIOD;

        loop {
            let now = Instant::now();
            let next_deadline = quiet_deadline.min(max_deadline);
            if now >= next_deadline {
                return progress;
            }

            match tokio::time::timeout_at(next_deadline, self.rx.changed()).await {
                Ok(Ok(())) => {
                    let state = self.rx.borrow_and_update().clone();
                    if let Some(next) = self.progress_from_state(&state) {
                        if next.terminal {
                            progress = next;
                            if !has_stream_output(&progress.output_manifests) {
                                return progress;
                            }
                            quiet_deadline = Instant::now() + TERMINAL_STREAM_OUTPUT_QUIET_PERIOD;
                        }
                    }
                }
                Ok(Err(_)) | Err(_) => return progress,
            }
        }
    }
}

fn terminal_reason_for(entry: &ExecutionState) -> Option<ExecutionTerminalReason> {
    match entry.status.as_str() {
        "done" => Some(ExecutionTerminalReason::Done),
        "error" if entry.outputs.is_empty() => Some(ExecutionTerminalReason::Interrupted),
        "error" => Some(ExecutionTerminalReason::Error),
        _ => None,
    }
}

fn has_stream_output(outputs: &[serde_json::Value]) -> bool {
    outputs
        .iter()
        .any(|output| output.get("output_type").and_then(|t| t.as_str()) == Some("stream"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use tokio::sync::{mpsc, watch};

    use crate::handle::DocHandle;
    use crate::shared::SharedDocState;
    use crate::snapshot::NotebookSnapshot;
    use crate::status::SyncStatus;

    fn make_handle() -> (DocHandle, watch::Sender<RuntimeState>) {
        let nd = notebook_doc::NotebookDoc::new("test-notebook");
        let shared = Arc::new(Mutex::new(SharedDocState::new(
            nd.into_inner(),
            "test-notebook".into(),
        )));
        let (snapshot_tx, snapshot_rx) = watch::channel(NotebookSnapshot::empty());
        let snapshot_tx = Arc::new(snapshot_tx);
        let (runtime_state_tx, runtime_state_rx) = watch::channel(RuntimeState::default());
        let (_status_tx, status_rx) = watch::channel(SyncStatus::connected_pending());
        let (changed_tx, _changed_rx) = mpsc::unbounded_channel();
        let (cmd_tx, _cmd_rx) = mpsc::channel(32);
        let handle = DocHandle::new(
            shared,
            changed_tx,
            cmd_tx,
            snapshot_tx,
            snapshot_rx,
            runtime_state_rx,
            status_rx,
            "test-notebook".into(),
        );
        (handle, runtime_state_tx)
    }

    fn set_execution(
        tx: &watch::Sender<RuntimeState>,
        execution_id: &str,
        _cell_id: &str,
        status: &str,
        outputs: Vec<serde_json::Value>,
    ) {
        let mut runtime = tx.borrow().clone();
        runtime.executions.insert(
            execution_id.to_string(),
            ExecutionState {
                status: status.to_string(),
                execution_count: None,
                success: (status == "done")
                    .then_some(true)
                    .or((status == "error").then_some(false)),
                outputs,
                source: Some("print('hi')".to_string()),
                cell_id: None,
                seq: Some(1),
                submitted_by_actor_label: None,
            },
        );
        tx.send(runtime).expect("send runtime");
    }

    #[tokio::test]
    async fn watcher_suppresses_duplicate_states_and_emits_terminal() {
        let (handle, tx) = make_handle();
        let mut watcher = ExecutionWatcher::new(&handle, "cell-1", "exec-1");

        set_execution(&tx, "exec-1", "cell-1", "running", Vec::new());
        let first = watcher.next().await.expect("first progress");
        assert_eq!(first.status, "running");
        assert!(!first.terminal);

        set_execution(&tx, "exec-1", "cell-1", "running", Vec::new());
        set_execution(&tx, "exec-1", "cell-1", "done", Vec::new());
        let terminal = watcher.next().await.expect("terminal progress");
        assert_eq!(
            terminal.terminal_reason,
            Some(ExecutionTerminalReason::Done)
        );
        assert!(watcher.next().await.is_none());
    }

    #[tokio::test]
    async fn watcher_emits_output_growth() {
        let (handle, tx) = make_handle();
        let mut watcher = ExecutionWatcher::new(&handle, "cell-1", "exec-1");

        set_execution(&tx, "exec-1", "cell-1", "running", Vec::new());
        let _ = watcher.next().await.expect("first progress");

        set_execution(
            &tx,
            "exec-1",
            "cell-1",
            "running",
            vec![serde_json::json!({"output_type": "stream", "text": "hi"})],
        );
        let progress = watcher.next().await.expect("output progress");
        assert_eq!(progress.output_manifests.len(), 1);
        assert!(!progress.terminal);
    }

    #[tokio::test]
    async fn watcher_waits_for_terminal_stream_output_to_settle() {
        let (handle, tx) = make_handle();
        let mut watcher = ExecutionWatcher::new(&handle, "cell-1", "exec-1");

        set_execution(&tx, "exec-1", "cell-1", "running", Vec::new());
        let _ = watcher.next().await.expect("first progress");

        set_execution(
            &tx,
            "exec-1",
            "cell-1",
            "done",
            vec![serde_json::json!({
                "output_type": "stream",
                "name": "stdout",
                "text": {"inline": "partial"},
            })],
        );

        let tx_for_task = tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            set_execution(
                &tx_for_task,
                "exec-1",
                "cell-1",
                "done",
                vec![serde_json::json!({
                    "output_type": "stream",
                    "name": "stdout",
                    "text": {"inline": "final"},
                })],
            );
        });

        let terminal = watcher.next().await.expect("terminal progress");
        assert_eq!(
            terminal.terminal_reason,
            Some(ExecutionTerminalReason::Done)
        );
        assert_eq!(terminal.output_manifests[0]["text"]["inline"], "final");
    }

    #[tokio::test]
    async fn watcher_reports_interrupted_terminal_reason() {
        let (handle, tx) = make_handle();
        let mut watcher = ExecutionWatcher::new(&handle, "cell-1", "exec-1");

        set_execution(&tx, "exec-1", "cell-1", "running", Vec::new());
        let _ = watcher.next().await.expect("first progress");

        set_execution(&tx, "exec-1", "cell-1", "error", Vec::new());
        let progress = watcher.next().await.expect("interrupted progress");
        assert_eq!(
            progress.terminal_reason,
            Some(ExecutionTerminalReason::Interrupted)
        );
        assert!(progress.terminal);
    }

    #[tokio::test]
    async fn watcher_reports_kernel_failure_terminal_reason() {
        let (handle, tx) = make_handle();
        let mut watcher = ExecutionWatcher::new(&handle, "cell-1", "exec-1");

        let mut runtime = tx.borrow().clone();
        runtime.kernel.lifecycle = RuntimeLifecycle::Error;
        tx.send(runtime).expect("send runtime");

        let progress = watcher.next().await.expect("kernel failure progress");
        assert_eq!(
            progress.terminal_reason,
            Some(ExecutionTerminalReason::KernelFailed)
        );
        assert!(progress.terminal);
    }

    #[test]
    fn timeout_snapshot_is_terminal() {
        let (handle, _tx) = make_handle();
        let mut watcher = ExecutionWatcher::new(&handle, "cell-1", "exec-1");
        let timeout = watcher.timeout().expect("timeout progress");
        assert_eq!(
            timeout.terminal_reason,
            Some(ExecutionTerminalReason::Timeout)
        );
        assert!(watcher.timeout().is_none());
    }
}
