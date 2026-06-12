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

use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{debug, info, warn};

use crate::output_blob_publisher::publish_or_warn;
use crate::output_commit_context::OutputCommitContext;
use crate::output_prep::LifecycleSignal;
use crate::output_store::{self, ContentRef, OutputManifest, DEFAULT_INLINE_THRESHOLD};
use crate::stream_flush::PendingStreamFlush;
use crate::stream_terminal::{StreamOutputState, StreamTerminals};
use crate::task_supervisor::spawn_supervised;

const STREAM_COMMITTER_QUEUE_CAPACITY: usize = 32;

#[derive(Debug)]
struct PriorityStreamCommit {
    flushes: Vec<TimedPendingStreamFlush>,
    signal: Option<LifecycleSignal>,
    ack: Option<oneshot::Sender<()>>,
}

#[derive(Debug)]
struct TimedPendingStreamFlush {
    flush: PendingStreamFlush,
    requested_at: std::time::Instant,
}

struct StreamCommitterContext {
    output: OutputCommitContext,
    stream_terminals: Arc<Mutex<StreamTerminals>>,
}

#[derive(Clone)]
pub(crate) struct StreamCommitterHandle {
    periodic_tx: mpsc::Sender<TimedPendingStreamFlush>,
    priority_tx: mpsc::UnboundedSender<PriorityStreamCommit>,
    lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
}

impl StreamCommitterHandle {
    /// Queue a best-effort periodic stream flush.
    ///
    /// If the bounded committer queue is full, this flush is dropped. That is
    /// intentional: stream terminals already hold the latest rendered state,
    /// and a later flush (especially the final execution flush) will publish
    /// the newest content.
    pub(crate) fn request_flush(&self, flush: PendingStreamFlush) {
        let timed = TimedPendingStreamFlush {
            flush,
            requested_at: std::time::Instant::now(),
        };
        match self.periodic_tx.try_send(timed) {
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
            flushes: timed_stream_flushes(flushes),
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
    pub(crate) fn flush_then_signal(
        &self,
        flushes: Vec<PendingStreamFlush>,
        signal: LifecycleSignal,
    ) {
        // The signal type (LifecycleSignal) was previously QueueCommand with a
        // runtime debug_assert!(signal.is_lifecycle()); the split into
        // LifecycleSignal vs WorkCommand makes that assertion structural.
        // See output_prep.rs and execution-pipeline.md Decision 2.
        //
        // Empty flushes still ride the priority committer (EP-11): sending
        // the signal directly on lifecycle_tx would let a no-output
        // execution's ExecutionDone jump ahead of an earlier execution's
        // still-queued priority commit, breaking "terminal runtime state is
        // causally after the final stream manifest". The empty-vec loop in
        // commit_priority_streams costs nothing.

        let request = PriorityStreamCommit {
            flushes: timed_stream_flushes(flushes),
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

fn timed_stream_flushes(flushes: Vec<PendingStreamFlush>) -> Vec<TimedPendingStreamFlush> {
    let now = std::time::Instant::now();
    flushes
        .into_iter()
        .map(|flush| TimedPendingStreamFlush {
            flush,
            requested_at: now,
        })
        .collect()
}

fn lifecycle_signal_label(signal: &LifecycleSignal) -> &'static str {
    match signal {
        LifecycleSignal::ExecutionDone { .. } => "execution_done",
        LifecycleSignal::KernelIdle { .. } => "kernel_idle",
        LifecycleSignal::CellError { .. } => "cell_error",
        LifecycleSignal::KernelDied => "kernel_died",
    }
}

async fn commit_priority_streams(request: PriorityStreamCommit, context: &StreamCommitterContext) {
    let commit_started = std::time::Instant::now();
    let flush_count = request.flushes.len();
    let max_request_age_ms = request
        .flushes
        .iter()
        .map(|flush| flush.requested_at.elapsed().as_millis())
        .max()
        .unwrap_or(0);
    let signal_label = request
        .signal
        .as_ref()
        .map(lifecycle_signal_label)
        .unwrap_or("none");
    for flush in request.flushes {
        commit_stream_flush(&context.output, &context.stream_terminals, flush.flush).await;
    }
    if let Some(signal) = request.signal {
        let _ = context.output.lifecycle_tx.send(signal);
    }
    if flush_count > 0 || signal_label != "none" {
        info!(
            "[stream-committer-timing] priority stream flush committed flush_count={} max_request_age_ms={} elapsed_ms={} signal={}",
            flush_count,
            max_request_age_ms,
            commit_started.elapsed().as_millis(),
            signal_label
        );
    }
    if let Some(ack) = request.ack {
        let _ = ack.send(());
    }
}

async fn commit_periodic_stream(flush: TimedPendingStreamFlush, context: &StreamCommitterContext) {
    let commit_started = std::time::Instant::now();
    let request_age_ms = flush.requested_at.elapsed().as_millis();
    commit_stream_flush(&context.output, &context.stream_terminals, flush.flush).await;
    let elapsed_ms = commit_started.elapsed().as_millis();
    if request_age_ms >= 100 || elapsed_ms >= 100 {
        info!(
            "[stream-committer-timing] periodic stream flush committed request_age_ms={} elapsed_ms={}",
            request_age_ms,
            elapsed_ms
        );
    } else {
        debug!(
            "[stream-committer-timing] periodic stream flush committed request_age_ms={} elapsed_ms={}",
            request_age_ms,
            elapsed_ms
        );
    }
}

async fn run_stream_committer(
    mut periodic_rx: mpsc::Receiver<TimedPendingStreamFlush>,
    mut priority_rx: mpsc::UnboundedReceiver<PriorityStreamCommit>,
    context: StreamCommitterContext,
) {
    loop {
        tokio::select! {
            biased;

            Some(request) = priority_rx.recv() => {
                commit_priority_streams(
                    request,
                    &context,
                ).await;
            }

            Some(flush) = periodic_rx.recv() => {
                commit_periodic_stream(
                    flush,
                    &context,
                ).await;
            }

            else => break,
        }
    }
}

pub(crate) fn start_stream_committer(
    output: OutputCommitContext,
    stream_terminals: Arc<Mutex<StreamTerminals>>,
) -> StreamCommitterHandle {
    let (periodic_tx, periodic_rx) = mpsc::channel(STREAM_COMMITTER_QUEUE_CAPACITY);
    let (priority_tx, priority_rx) = mpsc::unbounded_channel();
    let lifecycle_tx = output.lifecycle_tx.clone();
    let panic_lifecycle_tx = lifecycle_tx.clone();
    let context = StreamCommitterContext {
        output,
        stream_terminals,
    };
    // If the committer task panics, route `KernelDied` to the lifecycle
    // channel so the queue releases. The runtime agent treats this signal
    // as terminal in the same way it does an IOPub-disconnect KernelDied:
    // the durable record was the previous output write, anything after the
    // panic is lost, and the queue must not stay stuck. Punchlist EP-12.
    spawn_supervised(
        "stream-committer",
        run_stream_committer(periodic_rx, priority_rx, context),
        move |_| {
            let _ = panic_lifecycle_tx.send(LifecycleSignal::KernelDied);
        },
    );
    StreamCommitterHandle {
        periodic_tx,
        priority_tx,
        lifecycle_tx,
    }
}

pub(crate) async fn commit_stream_flush(
    context: &OutputCommitContext,
    stream_terminals: &Arc<Mutex<StreamTerminals>>,
    flush: PendingStreamFlush,
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
        &context.blob_store,
        DEFAULT_INLINE_THRESHOLD,
        &context.redactor,
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
    if publish_or_warn(
        &context.blob_publisher,
        &manifest,
        &context.blob_store,
        "stream output blob publish failed",
    )
    .await
    .is_err()
    {
        return;
    }

    let blob_hash = if let OutputManifest::Stream { ref text, .. } = manifest {
        match text {
            ContentRef::Blob { blob, .. } => blob.clone(),
            ContentRef::Inline { inline } => inline.clone(),
        }
    } else {
        String::new()
    };

    let upsert_result = match context.state.transact_at_current_heads(
        Some(&context.kernel_actor_id),
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

    #[tokio::test]
    async fn flush_then_signal_commits_stream_before_lifecycle_signal() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);

        // Subscribe after the setup write so the only expected change
        // notification is the committer's stream upsert transaction.
        let mut state_changes = state.subscribe();

        let terminals = Arc::new(Mutex::new(StreamTerminals::new()));
        {
            let mut terminals = terminals.lock().await;
            terminals.feed_chunk("exec-1", "stdout", "hello\n");
        }

        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_stream_committer(
            commit_context(state.clone(), blob_store, lifecycle_tx),
            terminals,
        );

        handle.flush_then_signal(
            vec![PendingStreamFlush {
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

        // Durable change order, not just signal arrival order (EP-1). The
        // handle broadcasts a change notification synchronously inside the
        // upsert transaction, and the committer sends the lifecycle signal
        // afterward from the same task, so a correct implementation
        // guarantees the notification is observable wherever the signal is.
        // A refactor that routes ExecutionDone past the priority commit path
        // delivers the signal with no preceding document change and fails
        // here.
        assert!(
            state_changes.try_recv().is_ok(),
            "stream upsert must be durable in RuntimeStateDoc before ExecutionDone is signaled"
        );

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
            commit_context(state.clone(), blob_store, lifecycle_tx),
            terminals,
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
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        create_execution(&state);
        let terminals = Arc::new(Mutex::new(StreamTerminals::new()));
        let (lifecycle_tx, _lifecycle_rx) = mpsc::unbounded_channel();
        let context = commit_context(state.clone(), blob_store, lifecycle_tx);

        commit_stream_flush(
            &context,
            &terminals,
            PendingStreamFlush {
                execution_id: "exec-1".to_string(),
                stream_name: "stdout".to_string(),
            },
        )
        .await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert!(outputs.is_empty());
    }

    /// EP-11: a no-output execution's signal must still ride the priority
    /// committer queue — a direct lifecycle_tx send would let its
    /// ExecutionDone jump ahead of an earlier execution's queued stream
    /// commit, putting terminal runtime state causally before the final
    /// stream manifest.
    #[test]
    fn flush_then_signal_without_flushes_rides_priority_queue() {
        let (periodic_tx, _periodic_rx) = mpsc::channel(1);
        let (priority_tx, mut priority_rx) = mpsc::unbounded_channel();
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::unbounded_channel();
        let handle = StreamCommitterHandle {
            periodic_tx,
            priority_tx,
            lifecycle_tx,
        };

        handle.flush_then_signal(
            Vec::new(),
            LifecycleSignal::ExecutionDone {
                execution_id: "exec-1".to_string(),
            },
        );

        assert!(
            lifecycle_rx.try_recv().is_err(),
            "signal must not bypass the priority committer"
        );
        let request = priority_rx.try_recv().expect("priority commit request");
        assert!(request.flushes.is_empty());
        assert!(matches!(
            request.signal,
            Some(LifecycleSignal::ExecutionDone { ref execution_id }) if execution_id == "exec-1"
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
        assert_eq!(received.flush.execution_id, "exec-1");
        assert_eq!(received.flush.stream_name, "stdout");
        assert!(
            periodic_rx.try_recv().is_err(),
            "second flush should be dropped"
        );
    }
}
