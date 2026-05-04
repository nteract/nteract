use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

use automerge::sync;
#[cfg(test)]
use automerge_recovery::{catch_automerge_panic, AutomergeOperationError};

use crate::{ForeignSyncView, RuntimeStateDoc, RuntimeStateError};

/// Handle to a per-notebook RuntimeStateDoc.
///
/// Mutations go through `with_doc` for synchronous document-owned writes.
/// Use RuntimeStateDoc transactions inside `with_doc` when applying writes at
/// captured heads; keep `fork`/`merge` for true async fork work.
/// Notification is automatic via heads comparison. Clone is cheap.
///
/// Uses `std::sync::Mutex`, not `tokio::sync::RwLock`. Automerge writes are
/// microsecond-fast. The `!Send` guard prevents holding across `.await`.
#[derive(Clone)]
pub struct RuntimeStateHandle {
    doc: Arc<Mutex<RuntimeStateDoc>>,
    changed_tx: broadcast::Sender<()>,
}

impl RuntimeStateHandle {
    pub fn new(doc: RuntimeStateDoc, changed_tx: broadcast::Sender<()>) -> Self {
        Self {
            doc: Arc::new(Mutex::new(doc)),
            changed_tx,
        }
    }

    /// Synchronous mutation. Acquires mutex, runs closure, notifies if heads changed.
    ///
    /// Notification fires even if the closure returns `Err`, because earlier
    /// mutations in a batched closure may have already changed the doc before
    /// a later write failed.
    pub fn with_doc<F, T>(&self, f: F) -> Result<T, RuntimeStateError>
    where
        F: FnOnce(&mut RuntimeStateDoc) -> Result<T, RuntimeStateError>,
    {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        let heads_before = sd.get_heads();
        let result = f(&mut sd);
        if sd.get_heads() != heads_before {
            let _ = self.changed_tx.send(());
        }
        result
    }

    /// Fork at current heads for async runtime-state work.
    pub fn fork(&self, actor_label: &str) -> Result<RuntimeStateDoc, RuntimeStateError> {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        Ok(sd.fork_with_actor(actor_label))
    }

    /// Merge a fork back. Notifies if heads changed.
    ///
    /// If merge panics (Automerge's apply path is not transactional),
    /// catches the unwind and rebuilds the doc via save/load to restore
    /// a consistent state. The fork's writes are lost but the session
    /// continues.
    pub fn merge(&self, fork: &mut RuntimeStateDoc) -> Result<(), RuntimeStateError> {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        let heads_before = sd.get_heads();
        match sd.merge_recovering(fork, "runtime-state-merge") {
            Ok(_) => {}
            Err(err) => {
                tracing::warn!("[runtime-state] {}", err);
                return Err(err.into());
            }
        }
        if sd.get_heads() != heads_before {
            let _ = self.changed_tx.send(());
        }
        Ok(())
    }

    /// Run a document-owned transaction at the current heads.
    ///
    /// Use this for synchronous writes that previously forked only to assign
    /// an actor. The handle owns locking and change notification; Automerge
    /// owns the actor sequence on the live document.
    pub fn transact_at_current_heads<F, T>(
        &self,
        actor: Option<&str>,
        label: &str,
        f: F,
    ) -> Result<T, RuntimeStateError>
    where
        F: FnOnce(&mut RuntimeStateDoc) -> Result<T, RuntimeStateError>,
    {
        self.with_doc(|sd| {
            let heads = sd.get_heads();
            sd.transact_at_heads_recovering(&heads, actor, label, f)
        })
    }

    pub fn generate_sync_message_recovering(
        &self,
        peer_state: &mut sync::State,
        label: &str,
    ) -> Result<Option<sync::Message>, RuntimeStateError> {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        sd.generate_sync_message_recovering(peer_state, label)
            .map_err(Into::into)
    }

    pub fn generate_sync_message_bounded_encoded_recovering(
        &self,
        peer_state: &mut sync::State,
        max_encoded_bytes: usize,
        label: &str,
    ) -> Result<Option<Vec<u8>>, RuntimeStateError> {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        sd.generate_sync_message_bounded_encoded_recovering(peer_state, max_encoded_bytes, label)
            .map_err(Into::into)
    }

    pub fn receive_sync_message_with_changes_recovering(
        &self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<bool, RuntimeStateError> {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        sd.receive_sync_message_with_changes_recovering(peer_state, message, label)
            .map_err(Into::into)
    }

    pub fn receive_sync_and_foreign_comms_recovering<F>(
        &self,
        peer_state: &mut sync::State,
        message: sync::Message,
        is_foreign: F,
        label: &str,
    ) -> Result<ForeignSyncView, RuntimeStateError>
    where
        F: Fn(&automerge::ActorId) -> bool,
    {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        sd.receive_sync_and_foreign_comms_recovering(peer_state, message, is_foreign, label)
            .map_err(Into::into)
    }

    /// Read-only access. No notification.
    pub fn read<F, T>(&self, f: F) -> Result<T, RuntimeStateError>
    where
        F: FnOnce(&RuntimeStateDoc) -> T,
    {
        let sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        Ok(f(&sd))
    }

    /// Subscribe to change notifications.
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changed_tx.subscribe()
    }

    #[cfg(test)]
    fn recover_injected_panic_for_test(&self) -> Result<(), RuntimeStateError> {
        let mut sd = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        match catch_automerge_panic("runtime-state-handle-test", || {
            panic!("injected runtime-state panic")
        }) {
            Ok(()) => Ok(()),
            Err(err) => {
                if let Err(source) = sd.rebuild_from_save() {
                    return Err(AutomergeOperationError::rebuild_failed(
                        "runtime-state-handle-test",
                        source,
                    )
                    .into());
                }
                Err(AutomergeOperationError::Panic(err).into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{KernelActivity, RuntimeLifecycle};

    fn make_handle() -> RuntimeStateHandle {
        let doc = RuntimeStateDoc::new();
        let (tx, _) = broadcast::channel(16);
        RuntimeStateHandle::new(doc, tx)
    }

    fn busy() -> RuntimeLifecycle {
        RuntimeLifecycle::Running(KernelActivity::Busy)
    }

    fn idle() -> RuntimeLifecycle {
        RuntimeLifecycle::Running(KernelActivity::Idle)
    }

    #[test]
    fn with_doc_notifies_on_change() {
        let handle = make_handle();
        let mut rx = handle.subscribe();
        handle.with_doc(|sd| sd.set_lifecycle(&busy())).unwrap();
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn with_doc_skips_notification_when_unchanged() {
        let handle = make_handle();
        handle.with_doc(|sd| sd.set_lifecycle(&busy())).unwrap();
        let mut rx = handle.subscribe();
        handle.with_doc(|sd| sd.set_lifecycle(&busy())).unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn batched_writes_single_notification() {
        let handle = make_handle();
        let mut rx = handle.subscribe();
        handle
            .with_doc(|sd| {
                sd.set_lifecycle(&RuntimeLifecycle::Resolving)?;
                sd.set_kernel_info("kernel", "python", "uv:prewarmed")?;
                Ok(())
            })
            .unwrap();
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn recovery_panic_inside_handle_does_not_poison_mutex() {
        let handle = make_handle();
        let err = handle
            .recover_injected_panic_for_test()
            .expect_err("injected panic should be reported");
        assert!(err.to_string().contains("injected runtime-state panic"));

        handle.with_doc(|sd| sd.set_lifecycle(&busy())).unwrap();
        assert_eq!(
            handle.read(|sd| sd.read_state().kernel.lifecycle).unwrap(),
            busy()
        );
    }

    #[test]
    fn fork_and_merge_notifies() {
        let handle = make_handle();
        let mut rx = handle.subscribe();
        let mut fork = handle.fork("test-fork").unwrap();
        fork.set_lifecycle(&idle()).unwrap();
        handle.merge(&mut fork).unwrap();
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn transact_at_current_heads_notifies_with_stable_actor() {
        let handle = make_handle();
        let mut rx = handle.subscribe();

        handle
            .transact_at_current_heads(Some("rt:kernel:test"), "handle-transaction-a", |sd| {
                sd.create_execution("exec-a", "cell-a")?;
                Ok(())
            })
            .unwrap();
        handle
            .transact_at_current_heads(Some("rt:kernel:test"), "handle-transaction-b", |sd| {
                sd.create_execution("exec-b", "cell-b")?;
                Ok(())
            })
            .unwrap();

        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_ok());
        let state = handle.read(|sd| sd.read_state()).unwrap();
        assert_eq!(state.executions["exec-a"].cell_id, "cell-a");
        assert_eq!(state.executions["exec-b"].cell_id, "cell-b");
    }

    #[test]
    fn read_does_not_notify() {
        let handle = make_handle();
        handle.with_doc(|sd| sd.set_lifecycle(&busy())).unwrap();
        let mut rx = handle.subscribe();
        let lifecycle = handle
            .read(|sd| sd.read_state().kernel.lifecycle.clone())
            .unwrap();
        assert_eq!(lifecycle, busy());
        assert!(rx.try_recv().is_err());
    }
}
