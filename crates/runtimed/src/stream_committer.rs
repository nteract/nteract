//! Bounded committer for stdout/stderr stream output flushes.
//!
//! The IOPub reader observes both output data and control-plane status
//! messages. It should not sit on blob storage or Automerge writes for every
//! coalesced stream flush, because that delays later status messages such as
//! `idle` after an interrupt. This worker lets the reader enqueue best-effort
//! periodic stream flushes and keep reading. Final execution completion still
//! routes through this worker so terminal status is emitted after the final
//! stream state is durable.

use std::sync::Arc;

use runtime_doc::RuntimeStateHandle;
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{debug, warn};

use crate::blob_store::BlobStore;
use crate::output_prep::QueueCommand;
use crate::output_redaction::OutputRedactor;
use crate::output_store::{self, ContentRef, OutputManifest, DEFAULT_INLINE_THRESHOLD};
use crate::stream_flush::PendingStreamFlush;
use crate::stream_terminal::{StreamOutputState, StreamTerminals};
use crate::task_supervisor::spawn_supervised;

const STREAM_COMMITTER_QUEUE_CAPACITY: usize = 32;

#[derive(Debug)]
struct PriorityStreamCommit {
    flushes: Vec<PendingStreamFlush>,
    signal: Option<QueueCommand>,
    ack: Option<oneshot::Sender<()>>,
}

struct StreamCommitterContext {
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    stream_terminals: Arc<Mutex<StreamTerminals>>,
    kernel_actor_id: String,
    lifecycle_tx: mpsc::UnboundedSender<QueueCommand>,
    output_redactor: Arc<OutputRedactor>,
}

#[derive(Clone)]
pub(crate) struct StreamCommitterHandle {
    periodic_tx: mpsc::Sender<PendingStreamFlush>,
    priority_tx: mpsc::UnboundedSender<PriorityStreamCommit>,
    lifecycle_tx: mpsc::UnboundedSender<QueueCommand>,
}

impl StreamCommitterHandle {
    /// Queue a best-effort periodic stream flush.
    ///
    /// If the bounded committer queue is full, this flush is dropped. That is
    /// intentional: stream terminals already hold the latest rendered state,
    /// and a later flush (especially the final execution flush) will publish
    /// the newest content.
    pub(crate) fn request_flush(&self, flush: PendingStreamFlush) {
        match self.periodic_tx.try_send(flush) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                debug!("[stream-committer] Dropping periodic stream flush: queue full");
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                warn!("[stream-committer] Dropping stream flush: committer closed");
            }
        }
    }

    pub(crate) fn request_flushes(&self, flushes: Vec<PendingStreamFlush>) {
        for flush in flushes {
            self.request_flush(flush);
        }
    }

    /// Flush streams through the committer before the caller performs an
    /// ordering-sensitive output transition such as a display/error boundary.
    pub(crate) async fn flush_for_ordering(&self, flushes: Vec<PendingStreamFlush>) {
        if flushes.is_empty() {
            return;
        }

        let (ack_tx, ack_rx) = oneshot::channel();
        let request = PriorityStreamCommit {
            flushes,
            signal: None,
            ack: Some(ack_tx),
        };
        if self.priority_tx.send(request).is_err() {
            warn!("[stream-committer] Failed to order stream flush: committer closed");
            return;
        }
        let _ = ack_rx.await;
    }

    /// Flush all pending streams, then send a lifecycle signal.
    ///
    /// Used for `ExecutionDone`: queue release must remain causally after the
    /// final stream output commit, but the IOPub reader itself should keep
    /// reading instead of awaiting output transport.
    pub(crate) fn flush_then_signal(&self, flushes: Vec<PendingStreamFlush>, signal: QueueCommand) {
        debug_assert!(
            signal.is_lifecycle(),
            "stream committer may only release lifecycle signals"
        );

        if flushes.is_empty() {
            let _ = self.lifecycle_tx.send(signal);
            return;
        }

        let request = PriorityStreamCommit {
            flushes,
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

async fn commit_priority_streams(
    request: PriorityStreamCommit,
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    stream_terminals: &Arc<Mutex<StreamTerminals>>,
    kernel_actor_id: &str,
    lifecycle_tx: &mpsc::UnboundedSender<QueueCommand>,
    output_redactor: &OutputRedactor,
) {
    for flush in request.flushes {
        commit_stream_flush(
            state,
            blob_store,
            stream_terminals,
            kernel_actor_id,
            flush,
            output_redactor,
        )
        .await;
    }
    if let Some(signal) = request.signal {
        let _ = lifecycle_tx.send(signal);
    }
    if let Some(ack) = request.ack {
        let _ = ack.send(());
    }
}

async fn commit_periodic_stream(
    flush: PendingStreamFlush,
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    stream_terminals: &Arc<Mutex<StreamTerminals>>,
    kernel_actor_id: &str,
    output_redactor: &OutputRedactor,
) {
    commit_stream_flush(
        state,
        blob_store,
        stream_terminals,
        kernel_actor_id,
        flush,
        output_redactor,
    )
    .await;
}

async fn run_stream_committer(
    mut periodic_rx: mpsc::Receiver<PendingStreamFlush>,
    mut priority_rx: mpsc::UnboundedReceiver<PriorityStreamCommit>,
    context: StreamCommitterContext,
) {
    loop {
        tokio::select! {
            biased;

            Some(request) = priority_rx.recv() => {
                commit_priority_streams(
                    request,
                    &context.state,
                    &context.blob_store,
                    &context.stream_terminals,
                    &context.kernel_actor_id,
                    &context.lifecycle_tx,
                    &context.output_redactor,
                ).await;
            }

            Some(flush) = periodic_rx.recv() => {
                commit_periodic_stream(
                    flush,
                    &context.state,
                    &context.blob_store,
                    &context.stream_terminals,
                    &context.kernel_actor_id,
                    &context.output_redactor,
                ).await;
            }

            else => break,
        }
    }
}

pub(crate) fn start_stream_committer(
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    stream_terminals: Arc<Mutex<StreamTerminals>>,
    kernel_actor_id: String,
    lifecycle_tx: mpsc::UnboundedSender<QueueCommand>,
    output_redactor: Arc<OutputRedactor>,
) -> StreamCommitterHandle {
    let (periodic_tx, periodic_rx) = mpsc::channel(STREAM_COMMITTER_QUEUE_CAPACITY);
    let (priority_tx, priority_rx) = mpsc::unbounded_channel();
    let panic_lifecycle_tx = lifecycle_tx.clone();
    let context = StreamCommitterContext {
        state,
        blob_store,
        stream_terminals,
        kernel_actor_id,
        lifecycle_tx: lifecycle_tx.clone(),
        output_redactor,
    };
    spawn_supervised(
        "stream-committer",
        run_stream_committer(periodic_rx, priority_rx, context),
        move |_| {
            let _ = panic_lifecycle_tx.send(QueueCommand::KernelDied);
        },
    );
    StreamCommitterHandle {
        periodic_tx,
        priority_tx,
        lifecycle_tx,
    }
}

pub(crate) async fn commit_stream_flush(
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    stream_terminals: &Arc<Mutex<StreamTerminals>>,
    kernel_actor_id: &str,
    flush: PendingStreamFlush,
    output_redactor: &OutputRedactor,
) {
    let (known_state, rendered_text) = {
        let terminals = stream_terminals.lock().await;
        if !terminals.has_stream(&flush.execution_id, &flush.stream_name) {
            debug!(
                "[stream-committer] Skipping stale stream flush for execution={} stream={}",
                flush.execution_id, flush.stream_name
            );
            return;
        }
        (
            terminals
                .get_output_state(&flush.execution_id, &flush.stream_name)
                .cloned(),
            terminals
                .render(&flush.execution_id, &flush.stream_name)
                .unwrap_or_default(),
        )
    };

    let nbformat_value = serde_json::json!({
        "output_type": "stream",
        "name": flush.stream_name,
        "text": rendered_text,
    });

    let manifest = match output_store::create_manifest_with_redactor(
        &nbformat_value,
        blob_store,
        DEFAULT_INLINE_THRESHOLD,
        output_redactor,
    )
    .await
    {
        Ok(manifest) => manifest,
        Err(e) => {
            warn!("[stream-committer] Failed to create stream manifest: {}", e);
            return;
        }
    };
    let manifest_json = manifest.to_json();

    let blob_hash = if let OutputManifest::Stream { ref text, .. } = manifest {
        match text {
            ContentRef::Blob { blob, .. } => blob.clone(),
            ContentRef::Inline { inline } => inline.clone(),
        }
    } else {
        String::new()
    };

    let upsert_result = match state.transact_at_current_heads(
        Some(kernel_actor_id),
        "runtime-state-iopub-stream-transaction",
        |sd| match sd.upsert_stream_output(
            &flush.execution_id,
            &flush.stream_name,
            &manifest_json,
            known_state.as_ref(),
        ) {
            Ok(result) => Ok(result),
            Err(e) => {
                warn!("[stream-committer] Failed to upsert stream output: {}", e);
                Err(e)
            }
        },
    ) {
        Ok(result) => result,
        Err(e) => {
            warn!("[runtime-state] {}", e);
            return;
        }
    };

    let (_updated, output_id) = upsert_result;
    let mut terminals = stream_terminals.lock().await;
    terminals.set_output_state(
        &flush.execution_id,
        &flush.stream_name,
        StreamOutputState {
            output_id,
            blob_hash,
        },
    );
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

    #[tokio::test]
    async fn flush_then_signal_commits_stream_before_lifecycle_signal() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);

        let terminals = Arc::new(Mutex::new(StreamTerminals::new()));
        {
            let mut terminals = terminals.lock().await;
            terminals.feed_chunk("exec-1", "stdout", "hello\n");
        }

        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_stream_committer(
            state.clone(),
            blob_store,
            terminals,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
        );

        handle.flush_then_signal(
            vec![PendingStreamFlush {
                execution_id: "exec-1".to_string(),
                stream_name: "stdout".to_string(),
            }],
            QueueCommand::ExecutionDone {
                execution_id: "exec-1".to_string(),
            },
        );

        let received = tokio::time::timeout(std::time::Duration::from_secs(1), lifecycle_rx.recv())
            .await
            .expect("signal timeout")
            .expect("signal");
        assert!(matches!(received, QueueCommand::ExecutionDone { .. }));

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["name"], "stdout");
    }

    #[tokio::test]
    async fn flush_for_ordering_commits_without_lifecycle_signal() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);

        let terminals = Arc::new(Mutex::new(StreamTerminals::new()));
        {
            let mut terminals = terminals.lock().await;
            terminals.feed_chunk("exec-1", "stdout", "before-display\n");
        }

        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_stream_committer(
            state.clone(),
            blob_store,
            terminals,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
        );

        handle
            .flush_for_ordering(vec![PendingStreamFlush {
                execution_id: "exec-1".to_string(),
                stream_name: "stdout".to_string(),
            }])
            .await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert!(lifecycle_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn stale_stream_flush_after_clear_is_ignored() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = BlobStore::new(dir.path().to_path_buf());
        let state = runtime_state();
        create_execution(&state);
        let terminals = Arc::new(Mutex::new(StreamTerminals::new()));

        commit_stream_flush(
            &state,
            &blob_store,
            &terminals,
            "rt:kernel:test",
            PendingStreamFlush {
                execution_id: "exec-1".to_string(),
                stream_name: "stdout".to_string(),
            },
            &OutputRedactor::disabled(),
        )
        .await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert!(outputs.is_empty());
    }

    #[test]
    fn flush_then_signal_without_flushes_sends_lifecycle_immediately() {
        let (periodic_tx, _periodic_rx) = mpsc::channel(1);
        let (priority_tx, _priority_rx) = mpsc::unbounded_channel();
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let handle = StreamCommitterHandle {
            periodic_tx,
            priority_tx,
            lifecycle_tx,
        };

        handle.flush_then_signal(
            Vec::new(),
            QueueCommand::ExecutionDone {
                execution_id: "exec-1".to_string(),
            },
        );

        let received = lifecycle_rx.try_recv().expect("lifecycle signal");
        assert!(matches!(
            received,
            QueueCommand::ExecutionDone {
                execution_id
            } if execution_id == "exec-1"
        ));
    }

    #[test]
    fn periodic_flush_is_dropped_when_committer_queue_is_full() {
        let (periodic_tx, mut periodic_rx) = mpsc::channel(1);
        let (priority_tx, _priority_rx) = mpsc::unbounded_channel();
        let (lifecycle_tx, _lifecycle_rx) = mpsc::unbounded_channel();
        let handle = StreamCommitterHandle {
            periodic_tx,
            priority_tx,
            lifecycle_tx,
        };

        handle.request_flush(PendingStreamFlush {
            execution_id: "exec-1".to_string(),
            stream_name: "stdout".to_string(),
        });
        handle.request_flush(PendingStreamFlush {
            execution_id: "exec-2".to_string(),
            stream_name: "stdout".to_string(),
        });

        let received = periodic_rx.try_recv().expect("first flush stays queued");
        assert_eq!(received.execution_id, "exec-1");
        assert_eq!(received.stream_name, "stdout");
        assert!(
            periodic_rx.try_recv().is_err(),
            "second flush should be dropped"
        );
    }
}
