//! Bounded committer for ordinary non-stream execution outputs.
//!
//! `display_data`, `execute_result`, and `error` outputs are durable output
//! records, unlike best-effort widget replay and transient display updates.
//! The IOPub reader should be able to enqueue them and keep reading, but
//! terminal lifecycle signals must still wait until all queued output commits
//! are durable in RuntimeStateDoc.

use std::sync::Arc;

use runtime_doc::RuntimeStateHandle;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};

use crate::blob_store::BlobStore;
use crate::output_prep::LifecycleSignal;
use crate::output_redaction::OutputRedactor;
use crate::output_store::{self, DEFAULT_INLINE_THRESHOLD};
use crate::task_supervisor::spawn_supervised;

const OUTPUT_COMMITTER_QUEUE_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy)]
pub(crate) enum OrdinaryOutputKind {
    DisplayData,
    ExecuteResult,
    Error,
}

impl OrdinaryOutputKind {
    fn label(self) -> &'static str {
        match self {
            Self::DisplayData => "output",
            Self::ExecuteResult => "output",
            Self::Error => "error",
        }
    }

    fn transaction_label(self) -> &'static str {
        match self {
            Self::DisplayData | Self::ExecuteResult => "runtime-state-iopub-output-transaction",
            Self::Error => "runtime-state-iopub-error-transaction",
        }
    }

    fn uses_buffer_preflight(self) -> bool {
        matches!(self, Self::DisplayData | Self::ExecuteResult)
    }
}

#[derive(Debug)]
pub(crate) struct OrdinaryOutputCommit {
    pub(crate) execution_id: String,
    pub(crate) nbformat_value: serde_json::Value,
    pub(crate) buffers: Vec<Vec<u8>>,
    pub(crate) kind: OrdinaryOutputKind,
}

#[derive(Debug)]
struct PriorityOutputRequest {
    output: Option<OrdinaryOutputCommit>,
    signal: Option<LifecycleSignal>,
    ack: Option<oneshot::Sender<()>>,
}

struct OutputCommitterContext {
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    kernel_actor_id: String,
    lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
    output_redactor: Arc<OutputRedactor>,
}

#[derive(Clone)]
pub(crate) struct OutputCommitterHandle {
    output_tx: mpsc::Sender<OrdinaryOutputCommit>,
    priority_tx: mpsc::UnboundedSender<PriorityOutputRequest>,
    lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
}

impl OutputCommitterHandle {
    /// Queue an ordinary output commit.
    ///
    /// The bounded queue protects memory under sustained rich-output bursts.
    /// When it fills, the IOPub reader waits for the worker to drain earlier
    /// queued outputs and commit this output in order. That preserves durable
    /// output ordering without allowing unbounded queue growth.
    pub(crate) async fn enqueue_output(&self, output: OrdinaryOutputCommit) {
        match self.output_tx.try_send(output) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(output)) => {
                debug!("[output-committer] Queue full; committing output through priority path");
                self.commit_for_ordering(output).await;
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                warn!("[output-committer] Dropping output: committer closed");
            }
        }
    }

    /// Wait until all currently queued ordinary outputs are durable.
    pub(crate) async fn flush_for_ordering(&self) {
        let (ack_tx, ack_rx) = oneshot::channel();
        let request = PriorityOutputRequest {
            output: None,
            signal: None,
            ack: Some(ack_tx),
        };
        if self.priority_tx.send(request).is_err() {
            warn!("[output-committer] Failed to flush: committer closed");
            return;
        }
        let _ = ack_rx.await;
    }

    /// Flush queued ordinary outputs, then send a lifecycle signal.
    ///
    /// Used for `CellError` and as the final `ExecutionDone` barrier after
    /// status=idle has observed all IOPub output for an execution.
    pub(crate) fn flush_then_signal(&self, signal: LifecycleSignal) {
        let request = PriorityOutputRequest {
            output: None,
            signal: Some(signal),
            ack: None,
        };
        if let Err(err) = self.priority_tx.send(request) {
            if let Some(signal) = err.0.signal {
                let _ = self.lifecycle_tx.send(signal);
            }
        }
    }

    async fn commit_for_ordering(&self, output: OrdinaryOutputCommit) {
        let (ack_tx, ack_rx) = oneshot::channel();
        let request = PriorityOutputRequest {
            output: Some(output),
            signal: None,
            ack: Some(ack_tx),
        };
        if self.priority_tx.send(request).is_err() {
            warn!("[output-committer] Failed to commit output: committer closed");
            return;
        }
        let _ = ack_rx.await;
    }
}

async fn commit_priority_request(
    request: PriorityOutputRequest,
    output_rx: &mut mpsc::Receiver<OrdinaryOutputCommit>,
    context: &OutputCommitterContext,
) {
    drain_queued_outputs(output_rx, context).await;
    if let Some(output) = request.output {
        commit_output(output, context).await;
    }
    if let Some(signal) = request.signal {
        let _ = context.lifecycle_tx.send(signal);
    }
    if let Some(ack) = request.ack {
        let _ = ack.send(());
    }
}

async fn drain_queued_outputs(
    output_rx: &mut mpsc::Receiver<OrdinaryOutputCommit>,
    context: &OutputCommitterContext,
) {
    while let Ok(output) = output_rx.try_recv() {
        commit_output(output, context).await;
    }
}

async fn run_output_committer(
    mut output_rx: mpsc::Receiver<OrdinaryOutputCommit>,
    mut priority_rx: mpsc::UnboundedReceiver<PriorityOutputRequest>,
    context: OutputCommitterContext,
) {
    loop {
        tokio::select! {
            biased;

            request = priority_rx.recv() => {
                match request {
                    Some(request) => {
                        commit_priority_request(request, &mut output_rx, &context).await;
                    }
                    None => {
                        drain_queued_outputs(&mut output_rx, &context).await;
                        break;
                    }
                }
            }

            Some(output) = output_rx.recv() => {
                commit_output(output, &context).await;
            }

            else => break,
        }
    }
}

pub(crate) fn start_output_committer(
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    kernel_actor_id: String,
    lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
    output_redactor: Arc<OutputRedactor>,
) -> OutputCommitterHandle {
    start_output_committer_with_capacity(
        state,
        blob_store,
        kernel_actor_id,
        lifecycle_tx,
        output_redactor,
        OUTPUT_COMMITTER_QUEUE_CAPACITY,
    )
}

fn start_output_committer_with_capacity(
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    kernel_actor_id: String,
    lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
    output_redactor: Arc<OutputRedactor>,
    capacity: usize,
) -> OutputCommitterHandle {
    let (output_tx, output_rx) = mpsc::channel(capacity);
    let (priority_tx, priority_rx) = mpsc::unbounded_channel();
    let panic_lifecycle_tx = lifecycle_tx.clone();
    let context = OutputCommitterContext {
        state,
        blob_store,
        kernel_actor_id,
        lifecycle_tx: lifecycle_tx.clone(),
        output_redactor,
    };
    spawn_supervised(
        "output-committer",
        run_output_committer(output_rx, priority_rx, context),
        move |_| {
            let _ = panic_lifecycle_tx.send(LifecycleSignal::KernelDied);
        },
    );
    OutputCommitterHandle {
        output_tx,
        priority_tx,
        lifecycle_tx,
    }
}

async fn commit_output(output: OrdinaryOutputCommit, context: &OutputCommitterContext) {
    if output.kind.uses_buffer_preflight() {
        output_store::preflight_ref_buffers(
            &output.nbformat_value,
            &output.buffers,
            &context.blob_store,
        )
        .await;
    }

    let manifest_json = match output_store::create_manifest_with_redactor(
        &output.nbformat_value,
        &context.blob_store,
        DEFAULT_INLINE_THRESHOLD,
        &context.output_redactor,
    )
    .await
    {
        Ok(manifest) => manifest.to_json(),
        Err(e) => {
            warn!(
                "[output-committer] Failed to create {} manifest: {}",
                output.kind.label(),
                e
            );
            let redacted = context
                .output_redactor
                .redact_output_value(&output.nbformat_value);
            crate::notebook_sync_server::fallback_output_with_id(&redacted)
        }
    };

    if let Err(e) = context.state.transact_at_current_heads(
        Some(&context.kernel_actor_id),
        output.kind.transaction_label(),
        |sd| {
            if let Err(e) = sd.append_output(&output.execution_id, &manifest_json) {
                warn!(
                    "[output-committer] Failed to append {} output to state doc: {}",
                    output.kind.label(),
                    e
                );
            }
            Ok(())
        },
    ) {
        warn!("[runtime-state] {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_state() -> RuntimeStateHandle {
        let state_doc =
            runtime_doc::RuntimeStateDoc::try_new_with_actor("test-runtime").expect("state doc");
        let (state_changed_tx, _state_changed_rx) = tokio::sync::broadcast::channel(8);
        RuntimeStateHandle::new(state_doc, state_changed_tx)
    }

    fn create_execution(state: &RuntimeStateHandle) {
        state
            .with_doc(|sd| {
                sd.create_execution("exec-1")?;
                Ok(())
            })
            .expect("execution entry");
    }

    fn display_output(text: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "display_data",
            "data": { "text/plain": text },
            "metadata": {},
        })
    }

    fn display_output_with_id(text: &str, display_id: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "display_data",
            "data": { "text/plain": text },
            "metadata": {},
            "transient": { "display_id": display_id },
        })
    }

    fn error_output(text: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "error",
            "ename": "MeasuredError",
            "evalue": text,
            "traceback": [text],
        })
    }

    #[tokio::test]
    async fn flush_then_signal_waits_for_queued_outputs() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_output_committer_with_capacity(
            state.clone(),
            blob_store,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
            8,
        );

        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: display_output("display-before-done"),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::DisplayData,
            })
            .await;
        handle.flush_then_signal(LifecycleSignal::ExecutionDone {
            execution_id: "exec-1".to_string(),
        });

        let received = tokio::time::timeout(std::time::Duration::from_secs(1), lifecycle_rx.recv())
            .await
            .expect("signal timeout")
            .expect("signal");
        assert!(matches!(received, LifecycleSignal::ExecutionDone { .. }));

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(
            outputs[0]["data"]["text/plain"]["inline"],
            "display-before-done"
        );
    }

    #[tokio::test]
    async fn queued_outputs_preserve_order() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_output_committer_with_capacity(
            state.clone(),
            blob_store,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
            1,
        );

        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: display_output("first"),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::DisplayData,
            })
            .await;
        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: display_output("second"),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::DisplayData,
            })
            .await;
        handle.flush_for_ordering().await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0]["data"]["text/plain"]["inline"], "first");
        assert_eq!(outputs[1]["data"]["text/plain"]["inline"], "second");
    }

    #[tokio::test]
    async fn cell_error_signal_waits_for_error_output() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_output_committer_with_capacity(
            state.clone(),
            blob_store,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
            8,
        );

        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: error_output("boom"),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::Error,
            })
            .await;
        handle.flush_then_signal(LifecycleSignal::CellError {
            execution_id: "exec-1".to_string(),
        });

        let received = tokio::time::timeout(std::time::Duration::from_secs(1), lifecycle_rx.recv())
            .await
            .expect("signal timeout")
            .expect("signal");
        assert!(matches!(received, LifecycleSignal::CellError { .. }));

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["ename"], "MeasuredError");
    }

    #[tokio::test]
    async fn execution_done_waits_for_outputs_before_final_stream_flush() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let output_handle = start_output_committer_with_capacity(
            state.clone(),
            blob_store.clone(),
            "rt:kernel:test".to_string(),
            lifecycle_tx.clone(),
            Arc::new(OutputRedactor::disabled()),
            8,
        );

        let terminals = Arc::new(tokio::sync::Mutex::new(
            crate::stream_terminal::StreamTerminals::new(),
        ));
        {
            let mut terminals = terminals.lock().await;
            terminals.feed_chunk("exec-1", "stdout", "stream-after-display\n");
        }
        let stream_handle = crate::stream_committer::start_stream_committer(
            state.clone(),
            blob_store,
            terminals,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
        );

        output_handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: display_output("display-before-stream"),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::DisplayData,
            })
            .await;

        output_handle.flush_for_ordering().await;
        stream_handle.flush_then_signal(
            vec![crate::stream_flush::PendingStreamFlush {
                execution_id: "exec-1".to_string(),
                stream_name: "stdout".to_string(),
            }],
            LifecycleSignal::ExecutionDone {
                execution_id: "exec-1".to_string(),
            },
        );

        let received = tokio::time::timeout(std::time::Duration::from_secs(1), lifecycle_rx.recv())
            .await
            .expect("signal timeout")
            .expect("signal");
        assert!(matches!(received, LifecycleSignal::ExecutionDone { .. }));

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 2);
        assert_eq!(
            outputs[0]["data"]["text/plain"]["inline"],
            "display-before-stream"
        );
        assert_eq!(outputs[1]["name"], "stdout");
    }

    #[tokio::test]
    async fn display_update_can_target_preceding_queued_display_output() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::unbounded_channel();
        let output_handle = start_output_committer_with_capacity(
            state.clone(),
            blob_store.clone(),
            "rt:kernel:test".to_string(),
            lifecycle_tx.clone(),
            Arc::new(OutputRedactor::disabled()),
            8,
        );
        let display_handle = crate::display_update_committer::start_display_update_committer(
            state.clone(),
            blob_store,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
        );

        output_handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: display_output_with_id("old", "progress"),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::DisplayData,
            })
            .await;
        output_handle.flush_for_ordering().await;

        display_handle.request_update(
            "progress".to_string(),
            serde_json::json!({ "text/plain": "updated" }),
            serde_json::Map::new(),
            Vec::new(),
        );
        display_handle.flush_for_ordering().await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["data"]["text/plain"]["inline"], "updated");
    }
}
