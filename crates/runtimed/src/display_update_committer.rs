//! Coalesced committer for `update_display_data` output updates.
//!
//! Display updates are transient by design: repeated updates for the same
//! `display_id` should collapse to the latest value. The IOPub reader should
//! not block on blob writes or RuntimeStateDoc transactions for every progress
//! update, but execution terminal state must still wait for pending display
//! updates to become durable before `ExecutionDone`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use runtime_doc::RuntimeStateHandle;
use tokio::sync::{mpsc, oneshot, Notify};
use tracing::{debug, error, warn};

use crate::blob_store::BlobStore;
use crate::output_prep::QueueCommand;
use crate::output_prep::{
    apply_display_manifest_updates, build_display_manifest_updates, collect_display_update_targets,
};
use crate::task_supervisor::spawn_supervised;

const MAX_PENDING_DISPLAY_IDS: usize = 128;

#[derive(Debug)]
struct PendingDisplayUpdate {
    data: serde_json::Value,
    metadata: serde_json::Map<String, serde_json::Value>,
    buffers: Vec<Vec<u8>>,
}

struct SharedPending {
    updates: StdMutex<HashMap<String, PendingDisplayUpdate>>,
    notify: Notify,
}

#[derive(Debug)]
struct PriorityDisplayRequest {
    ack: oneshot::Sender<()>,
}

#[derive(Clone)]
pub(crate) struct DisplayUpdateCommitterHandle {
    pending: Arc<SharedPending>,
    priority_tx: mpsc::UnboundedSender<PriorityDisplayRequest>,
}

impl DisplayUpdateCommitterHandle {
    pub(crate) fn request_update(
        &self,
        display_id: String,
        data: serde_json::Value,
        metadata: serde_json::Map<String, serde_json::Value>,
        buffers: Vec<Vec<u8>>,
    ) {
        let mut updates = self
            .pending
            .updates
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if updates.len() >= MAX_PENDING_DISPLAY_IDS && !updates.contains_key(&display_id) {
            debug!(
                "[display-update-committer] Dropping display_id={} update: pending set full",
                display_id
            );
            return;
        }

        updates.insert(
            display_id,
            PendingDisplayUpdate {
                data,
                metadata,
                buffers,
            },
        );
        drop(updates);
        // Notify is a wake hint, not the queue. The pending map above is the
        // source of truth and intentionally coalesces to the latest update per
        // display_id, so bursts do not need one stored permit per update.
        self.pending.notify.notify_one();
    }

    pub(crate) async fn flush_for_ordering(&self) {
        // Pending may already be taken by the worker but not committed yet.
        // Round-trip through the worker so terminal state waits behind any
        // in-flight display update.
        let (ack_tx, ack_rx) = oneshot::channel();
        if self
            .priority_tx
            .send(PriorityDisplayRequest { ack: ack_tx })
            .is_err()
        {
            warn!("[display-update-committer] Failed to flush: committer closed");
            return;
        }
        let _ = ack_rx.await;
    }
}

fn take_pending(pending: &SharedPending) -> HashMap<String, PendingDisplayUpdate> {
    let mut updates = pending
        .updates
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    std::mem::take(&mut *updates)
}

async fn commit_pending_updates(
    pending: &SharedPending,
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    kernel_actor_id: &str,
) {
    let updates = take_pending(pending);
    for (display_id, update) in updates {
        let preflight_wrapper = serde_json::json!({ "data": update.data });
        crate::output_store::preflight_ref_buffers(&preflight_wrapper, &update.buffers, blob_store)
            .await;

        let targets = match state.read(|sd| collect_display_update_targets(sd, &display_id)) {
            Ok(targets) => targets,
            Err(e) => {
                warn!("[runtime-state] {}", e);
                continue;
            }
        };

        let updates = build_display_manifest_updates(
            targets,
            &display_id,
            &preflight_wrapper["data"],
            &update.metadata,
            blob_store,
        )
        .await;

        match updates {
            Ok(updates) => {
                let updated = state.transact_at_current_heads(
                    Some(kernel_actor_id),
                    "runtime-state-iopub-display-update-transaction",
                    |sd| apply_display_manifest_updates(sd, &updates),
                );
                match updated {
                    Ok(true) => {
                        debug!(
                            "[display-update-committer] Updated display_id={}",
                            display_id
                        );
                    }
                    Ok(false) => {
                        error!(
                            "[display-update-committer] No output found for display_id={}",
                            display_id
                        );
                    }
                    Err(e) => {
                        warn!("[runtime-state] {}", e);
                    }
                }
            }
            Err(e) => {
                error!(
                    "[display-update-committer] Failed to update display_id={}: {}",
                    display_id, e
                );
            }
        }
    }
}

async fn run_display_update_committer(
    pending: Arc<SharedPending>,
    mut priority_rx: mpsc::UnboundedReceiver<PriorityDisplayRequest>,
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    kernel_actor_id: String,
) {
    loop {
        tokio::select! {
            biased;

            // Priority flushes drain the same pending map as normal wakes. If
            // a notify permit is also ready, this arm still commits every
            // pending update before acknowledging the ordering boundary.
            request = priority_rx.recv() => {
                match request {
                    Some(request) => {
                        commit_pending_updates(&pending, &state, &blob_store, &kernel_actor_id).await;
                        let _ = request.ack.send(());
                    }
                    None => {
                        commit_pending_updates(&pending, &state, &blob_store, &kernel_actor_id).await;
                        break;
                    }
                }
            }

            // Individual notifications are not individual updates; each wake
            // drains all currently pending display_ids.
            _ = pending.notify.notified() => {
                commit_pending_updates(&pending, &state, &blob_store, &kernel_actor_id).await;
            }

            else => break,
        }
    }
}

pub(crate) fn start_display_update_committer(
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    kernel_actor_id: String,
    lifecycle_tx: mpsc::UnboundedSender<QueueCommand>,
) -> DisplayUpdateCommitterHandle {
    let pending = Arc::new(SharedPending {
        updates: StdMutex::new(HashMap::new()),
        notify: Notify::new(),
    });
    let (priority_tx, priority_rx) = mpsc::unbounded_channel();
    let worker_pending = pending.clone();
    spawn_supervised(
        "display-update-committer",
        run_display_update_committer(
            worker_pending,
            priority_rx,
            state,
            blob_store,
            kernel_actor_id,
        ),
        move |_| {
            let _ = lifecycle_tx.send(QueueCommand::KernelDied);
        },
    );
    DisplayUpdateCommitterHandle {
        pending,
        priority_tx,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output_store::DEFAULT_INLINE_THRESHOLD;

    fn runtime_state() -> RuntimeStateHandle {
        let state_doc =
            runtime_doc::RuntimeStateDoc::try_new_with_actor("test-runtime").expect("state doc");
        let (state_changed_tx, _state_changed_rx) = tokio::sync::broadcast::channel(8);
        RuntimeStateHandle::new(state_doc, state_changed_tx)
    }

    async fn insert_display_output(
        state: &RuntimeStateHandle,
        blob_store: &BlobStore,
        display_id: &str,
    ) {
        let output = serde_json::json!({
            "output_type": "display_data",
            "data": { "text/plain": "old" },
            "metadata": {},
            "transient": { "display_id": display_id },
        });
        let manifest =
            crate::output_store::create_manifest(&output, blob_store, DEFAULT_INLINE_THRESHOLD)
                .await
                .expect("manifest");
        let manifest_json = manifest.to_json();
        state
            .with_doc(|sd| {
                sd.create_execution("exec-1", "cell-1")?;
                sd.append_output("exec-1", &manifest_json)?;
                Ok(())
            })
            .expect("insert output");
    }

    #[tokio::test]
    async fn display_updates_coalesce_to_latest_value() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_state();
        insert_display_output(&state, &blob_store, "progress").await;

        let (lifecycle_tx, _lifecycle_rx) = mpsc::unbounded_channel();
        let handle = start_display_update_committer(
            state.clone(),
            blob_store,
            "rt:kernel:test".to_string(),
            lifecycle_tx,
        );

        handle.request_update(
            "progress".to_string(),
            serde_json::json!({ "text/plain": "first" }),
            serde_json::Map::new(),
            Vec::new(),
        );
        handle.request_update(
            "progress".to_string(),
            serde_json::json!({ "text/plain": "latest" }),
            serde_json::Map::new(),
            Vec::new(),
        );
        handle.flush_for_ordering().await;

        let outputs = state
            .read(|sd| sd.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["data"]["text/plain"]["inline"], "latest");
    }
}
