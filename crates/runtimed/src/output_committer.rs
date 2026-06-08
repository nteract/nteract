//! Bounded committer for ordinary non-stream execution outputs.
//!
//! `display_data`, `execute_result`, and `error` outputs are durable output
//! records, unlike best-effort widget replay and transient display updates.
//! The IOPub reader should be able to enqueue them and keep reading, but
//! terminal lifecycle signals must still wait until all queued output commits
//! are durable in RuntimeStateDoc.

use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};

use crate::output_blob_publisher::publish_or_warn;
use crate::output_commit_context::OutputCommitContext;
use crate::output_prep::LifecycleSignal;
use crate::output_store::{self, DEFAULT_INLINE_THRESHOLD};
use crate::task_supervisor::spawn_supervised;

// Keep the IOPub reader hot during rich-output bursts. A Python loop can emit
// 1000 display_data messages in a few hundred milliseconds; if this queue is
// too small, the reader backpressures while the kernel is still publishing and
// tail messages can be lost before status=idle arrives.
const OUTPUT_COMMITTER_QUEUE_CAPACITY: usize = 2048;
const OUTPUT_COMMIT_BATCH_SIZE: usize = 128;
const ERROR_INLINE_THRESHOLD: usize = 16 * 1024;

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
    /// When it fills, the IOPub reader waits only for a queue slot and then
    /// enqueues the output behind earlier outputs. That preserves durable
    /// output ordering without allowing unbounded queue growth or forcing the
    /// IOPub reader to synchronously drain all pending output work mid-burst.
    pub(crate) async fn enqueue_output(&self, output: OrdinaryOutputCommit) {
        match self.output_tx.try_send(output) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(output)) => {
                debug!("[output-committer] Queue full; waiting for output queue capacity");
                if self.output_tx.send(output).await.is_err() {
                    warn!("[output-committer] Dropping output: committer closed");
                }
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
}

async fn commit_priority_request(
    request: PriorityOutputRequest,
    output_rx: &mut mpsc::Receiver<OrdinaryOutputCommit>,
    context: &OutputCommitContext,
) {
    drain_queued_outputs(output_rx, context).await;
    if let Some(output) = request.output {
        commit_output_batch(vec![output], context).await;
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
    context: &OutputCommitContext,
) {
    loop {
        let mut batch = Vec::with_capacity(OUTPUT_COMMIT_BATCH_SIZE);
        while batch.len() < OUTPUT_COMMIT_BATCH_SIZE {
            match output_rx.try_recv() {
                Ok(output) => batch.push(output),
                Err(_) => break,
            }
        }
        if batch.is_empty() {
            break;
        }
        commit_output_batch(batch, context).await;
    }
}

async fn run_output_committer(
    mut output_rx: mpsc::Receiver<OrdinaryOutputCommit>,
    mut priority_rx: mpsc::UnboundedReceiver<PriorityOutputRequest>,
    context: OutputCommitContext,
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
                let mut batch = Vec::with_capacity(OUTPUT_COMMIT_BATCH_SIZE);
                batch.push(output);
                while batch.len() < OUTPUT_COMMIT_BATCH_SIZE {
                    match output_rx.try_recv() {
                        Ok(output) => batch.push(output),
                        Err(_) => break,
                    }
                }
                commit_output_batch(batch, &context).await;
            }

            else => break,
        }
    }
}

pub(crate) fn start_output_committer(context: OutputCommitContext) -> OutputCommitterHandle {
    start_output_committer_with_capacity(context, OUTPUT_COMMITTER_QUEUE_CAPACITY)
}

fn start_output_committer_with_capacity(
    context: OutputCommitContext,
    capacity: usize,
) -> OutputCommitterHandle {
    let (output_tx, output_rx) = mpsc::channel(capacity);
    let (priority_tx, priority_rx) = mpsc::unbounded_channel();
    let lifecycle_tx = context.lifecycle_tx.clone();
    let panic_lifecycle_tx = lifecycle_tx.clone();
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

async fn commit_output_batch(outputs: Vec<OrdinaryOutputCommit>, context: &OutputCommitContext) {
    if outputs.is_empty() {
        return;
    }

    let mut manifests = Vec::with_capacity(outputs.len());
    for output in &outputs {
        manifests.push(create_manifest_json(output, context).await);
    }

    if let Err(e) = context.state.transact_at_current_heads(
        Some(&context.kernel_actor_id),
        "runtime-state-iopub-output-batch-transaction",
        |sd| {
            let mut index = 0;
            while index < outputs.len() {
                let execution_id = outputs[index].execution_id.as_str();
                let start = index;
                while index < outputs.len() && outputs[index].execution_id == execution_id {
                    index += 1;
                }
                if let Err(e) = sd.append_outputs(execution_id, &manifests[start..index]) {
                    warn!("[output-committer] Failed to append output batch to state doc: {e}");
                }
            }
            Ok(())
        },
    ) {
        warn!("[runtime-state] {}", e);
    }
}

async fn create_manifest_json(
    output: &OrdinaryOutputCommit,
    context: &OutputCommitContext,
) -> serde_json::Value {
    if output.kind.uses_buffer_preflight() {
        output_store::preflight_ref_buffers(
            &output.nbformat_value,
            &output.buffers,
            &context.blob_store,
        )
        .await;
    }

    let inline_threshold = match output.kind {
        OrdinaryOutputKind::Error => ERROR_INLINE_THRESHOLD,
        OrdinaryOutputKind::DisplayData | OrdinaryOutputKind::ExecuteResult => {
            DEFAULT_INLINE_THRESHOLD
        }
    };

    match output_store::create_manifest_with_redactor(
        &output.nbformat_value,
        &context.blob_store,
        inline_threshold,
        &context.redactor,
    )
    .await
    {
        Ok(manifest) => {
            if let Err(error) = publish_or_warn(
                &context.blob_publisher,
                &manifest,
                &context.blob_store,
                "ordinary output blob publish failed",
            )
            .await
            {
                return blob_publish_failure_output(output.kind.label(), &error);
            }
            manifest.to_json()
        }
        Err(e) => {
            warn!(
                "[output-committer] Failed to create {} manifest: {}",
                output.kind.label(),
                e
            );
            let redacted = context.redactor.redact_output_value(&output.nbformat_value);
            crate::notebook_sync_server::fallback_output_with_id(&redacted)
        }
    }
}

fn blob_publish_failure_output(kind: &str, error: &dyn std::error::Error) -> serde_json::Value {
    serde_json::json!({
        "output_type": "error",
        "ename": "OutputBlobPublishError",
        "evalue": format!("Unable to publish {kind} blob before syncing output: {error}"),
        "traceback": [
            format!("Unable to publish {kind} blob before syncing output: {error}")
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use runtime_doc::RuntimeStateHandle;

    use crate::blob_store::BlobStore;
    use crate::output_blob_publisher::OutputBlobPublisher;
    use crate::output_redaction::OutputRedactor;

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

    fn commit_context(
        state: RuntimeStateHandle,
        blob_store: Arc<BlobStore>,
        lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
    ) -> OutputCommitContext {
        OutputCommitContext::new(
            state,
            blob_store,
            OutputBlobPublisher::none(),
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
        )
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

    fn rich_error_output(text: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "display_data",
            "data": {
                crate::user_error::TRACEBACK_MIME: {
                    "ename": "MeasuredError",
                    "evalue": text,
                    "frames": [{
                        "filename": "cell.py",
                        "lineno": 1,
                        "name": "<module>",
                        "lines": [{ "lineno": 1, "source": text, "highlight": true }]
                    }],
                    "language": "python",
                    "text": text,
                }
            },
            "metadata": {},
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
            commit_context(state.clone(), blob_store, lifecycle_tx),
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
            commit_context(state.clone(), blob_store, lifecycle_tx),
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
            commit_context(state.clone(), blob_store, lifecycle_tx),
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
    async fn modest_error_tracebacks_stay_inline_for_fast_cloud_rendering() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_output_committer_with_capacity(
            commit_context(state.clone(), blob_store, lifecycle_tx),
            8,
        );
        let traceback = format!(
            "RuntimeError: {}\n",
            "x".repeat(DEFAULT_INLINE_THRESHOLD + 256)
        );

        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: error_output(&traceback),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::Error,
            })
            .await;
        handle.flush_for_ordering().await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert!(
            outputs[0]["traceback"]["inline"]
                .as_str()
                .is_some_and(|value| value.contains("RuntimeError")),
            "modest traceback should be inlined instead of forcing a cloud blob upload"
        );
        assert!(outputs[0].get("llm_preview").is_none());
    }

    #[tokio::test]
    async fn rich_error_tracebacks_use_error_inline_budget() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_output_committer_with_capacity(
            commit_context(state.clone(), blob_store, lifecycle_tx),
            8,
        );
        let traceback = format!(
            "RuntimeError: {}\n",
            "x".repeat(DEFAULT_INLINE_THRESHOLD + 256)
        );

        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: rich_error_output(&traceback),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::Error,
            })
            .await;
        handle.flush_for_ordering().await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert!(
            outputs[0]["rich"]["inline"]
                .as_str()
                .is_some_and(|value| value.contains("RuntimeError")),
            "launcher rich traceback should not force a cloud blob upload"
        );
    }

    #[tokio::test]
    async fn execution_done_waits_for_outputs_before_final_stream_flush() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let output_context =
            commit_context(state.clone(), blob_store.clone(), lifecycle_tx.clone());
        let output_handle = start_output_committer_with_capacity(output_context.clone(), 8);

        let terminals = Arc::new(tokio::sync::Mutex::new(
            crate::stream_terminal::StreamTerminals::new(),
        ));
        {
            let mut terminals = terminals.lock().await;
            terminals.feed_chunk("exec-1", "stdout", "stream-after-display\n");
        }
        let stream_handle =
            crate::stream_committer::start_stream_committer(output_context, terminals);

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
        let output_context =
            commit_context(state.clone(), blob_store.clone(), lifecycle_tx.clone());
        let output_handle = start_output_committer_with_capacity(output_context.clone(), 8);
        let display_handle =
            crate::display_update_committer::start_display_update_committer(output_context);

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
