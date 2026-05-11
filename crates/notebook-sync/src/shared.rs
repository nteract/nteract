//! Shared document state behind `Arc<Mutex<_>>`.
//!
//! This is the core state shared between `DocHandle` (callers) and the sync task
//! (network I/O). All document mutations happen through the mutex. The sync task
//! also acquires the mutex briefly to apply incoming sync messages and generate
//! outgoing ones.

use automerge::sync;
use automerge::sync::SyncDoc;
use automerge::AutoCommit;
use automerge_recovery::{
    catch_automerge_panic, is_recoverable_sync_error, recoverable_automerge_operation,
    AutomergeOperationError, AutomergeRebuildError,
};
use log::warn;
use notebook_doc::presence::PresenceState;
use runtime_doc::RuntimeStateDoc;

/// The shared state behind `Arc<Mutex<SharedDocState>>`.
///
/// Contains the Automerge document, sync protocol state, and notebook identity.
/// Both the `DocHandle` and the sync task hold `Arc<Mutex<SharedDocState>>`.
pub struct SharedDocState {
    /// The Automerge document — source of truth for all notebook content.
    pub(crate) doc: AutoCommit,

    /// Automerge sync protocol state for the daemon peer.
    pub(crate) peer_state: sync::State,

    /// The notebook identifier (canonical path for file-backed notebooks,
    /// UUID for ephemeral/untitled notebooks).
    pub(crate) notebook_id: String,

    /// Incoming presence state from remote peers (cursors, selections, etc.).
    pub(crate) presence: PresenceState,

    /// Runtime state doc — daemon-authoritative, synced read-only.
    pub(crate) state_doc: RuntimeStateDoc,

    /// Automerge sync protocol state for the RuntimeStateDoc peer.
    pub(crate) state_peer_state: sync::State,

    #[cfg(test)]
    panic_on_next_state_sync: bool,
}

impl SharedDocState {
    /// Create a new shared state with the given document and notebook ID.
    pub fn try_new(
        doc: AutoCommit,
        notebook_id: String,
    ) -> Result<Self, runtime_doc::RuntimeStateError> {
        Ok(Self {
            doc,
            peer_state: sync::State::new(),
            notebook_id,
            presence: PresenceState::new(),
            state_doc: RuntimeStateDoc::try_new_empty()?,
            state_peer_state: sync::State::new(),
            #[cfg(test)]
            panic_on_next_state_sync: false,
        })
    }

    pub fn new(doc: AutoCommit, notebook_id: String) -> Self {
        Self::try_new(doc, notebook_id)
            .unwrap_or_else(|err| panic!("create bootstrap runtime state doc: {err}"))
    }

    /// Get a reference to the notebook ID.
    pub fn notebook_id(&self) -> &str {
        &self.notebook_id
    }

    /// Generate an outgoing sync message for the daemon peer, if any changes
    /// need to be sent.
    ///
    /// Returns `None` if the daemon already has all our changes.
    pub fn generate_sync_message(&mut self) -> Option<sync::Message> {
        self.doc.sync().generate_sync_message(&mut self.peer_state)
    }

    /// Apply an incoming sync message from the daemon peer.
    pub fn receive_sync_message(
        &mut self,
        message: sync::Message,
    ) -> Result<(), automerge::AutomergeError> {
        self.doc
            .sync()
            .receive_sync_message(&mut self.peer_state, message)
    }

    pub(crate) fn generate_sync_message_recovering(
        &mut self,
        label: &str,
    ) -> Result<Option<sync::Message>, AutomergeOperationError> {
        recoverable_automerge_operation(
            label,
            self,
            |state| Ok(state.generate_sync_message()),
            |_| false,
            |state| state.rebuild_doc(),
        )
    }

    pub(crate) fn receive_sync_message_recovering(
        &mut self,
        message: sync::Message,
        label: &str,
    ) -> Result<(), AutomergeOperationError> {
        let mut context = SharedDocReceiveRecoveryContext {
            state: self,
            next_message: Some(message.clone()),
            retry_message: message,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context.state.receive_sync_message(message)
            },
            is_recoverable_sync_error,
            |context| context.state.rebuild_doc(),
        )
    }

    // ── RuntimeStateDoc sync ────────────────────────────────────────

    /// Generate an outgoing sync reply for the RuntimeStateDoc.
    pub fn generate_state_sync_message(&mut self) -> Option<sync::Message> {
        self.state_doc
            .doc_mut()
            .sync()
            .generate_sync_message(&mut self.state_peer_state)
    }

    pub(crate) fn generate_state_sync_message_recovering(
        &mut self,
        label: &str,
    ) -> Result<Option<sync::Message>, AutomergeOperationError> {
        self.state_doc
            .generate_sync_message_recovering(&mut self.state_peer_state, label)
    }

    /// Apply an incoming RuntimeStateSync message from the daemon.
    /// No change stripping — the client is a read-only consumer.
    pub fn receive_state_sync_message(
        &mut self,
        message: sync::Message,
    ) -> Result<(), automerge::AutomergeError> {
        #[cfg(test)]
        if self.panic_on_next_state_sync {
            self.panic_on_next_state_sync = false;
            panic!("injected RuntimeStateSync panic");
        }

        self.state_doc
            .doc_mut()
            .sync()
            .receive_sync_message(&mut self.state_peer_state, message)
    }

    pub(crate) fn receive_state_sync_message_recovering(
        &mut self,
        message: sync::Message,
        label: &str,
    ) -> Result<(), AutomergeOperationError> {
        let mut context = SharedDocReceiveRecoveryContext {
            state: self,
            next_message: Some(message.clone()),
            retry_message: message,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context.state.receive_state_sync_message(message)
            },
            is_recoverable_sync_error,
            |context| context.state.rebuild_state_doc(),
        )
    }

    /// Rebuild the RuntimeStateDoc via save→load and reset its sync state.
    ///
    /// Used after a caller-marked recoverable Automerge failure during
    /// `RuntimeStateSync` processing — the same recovery pattern as
    /// `rebuild_doc` for the notebook doc, but targeting the state doc.
    pub fn rebuild_state_doc(&mut self) -> Result<(), AutomergeRebuildError> {
        let rebuilt = self.state_doc.rebuild_from_save();
        if let Err(err) = &rebuilt {
            warn!(
                "[notebook-sync] Failed to rebuild RuntimeStateDoc after recoverable Automerge failure: {}; \
                 resetting state sync protocol only",
                err
            );
        }
        self.state_peer_state = sync::State::new();
        rebuilt
    }

    fn rebuild_doc(&mut self) -> Result<(), AutomergeRebuildError> {
        let rebuilt = catch_automerge_panic("notebook-sync-rebuild-doc", || {
            let actor = self.doc.get_actor().clone();
            let pre_cell_count = notebook_doc::get_cells_from_doc(&self.doc).len();
            let bytes = self.doc.save();
            match AutoCommit::load(&bytes) {
                Ok(mut doc) => {
                    let post_cell_count = notebook_doc::get_cells_from_doc(&doc).len();
                    if post_cell_count < pre_cell_count {
                        warn!(
                            "[notebook-sync] rebuild doc would lose cells ({} -> {}), resetting sync state only",
                            pre_cell_count, post_cell_count
                        );
                        return Err(AutomergeRebuildError::cell_loss(
                            pre_cell_count,
                            post_cell_count,
                        ));
                    }
                    doc.set_actor(actor);
                    self.doc = doc;
                    Ok(())
                }
                Err(e) => {
                    warn!(
                        "[notebook-sync] failed to rebuild doc after recoverable Automerge failure: {}; resetting sync state only",
                        e
                    );
                    Err(AutomergeRebuildError::load(e))
                }
            }
        });

        self.peer_state = sync::State::new();
        match rebuilt {
            Ok(rebuilt) => rebuilt,
            Err(e) => {
                warn!(
                    "[notebook-sync] panic while rebuilding doc after recoverable Automerge failure: {}; resetting sync state only",
                    e
                );
                Err(e.into())
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn panic_on_next_state_sync_for_test(&mut self) {
        self.panic_on_next_state_sync = true;
    }
}

struct SharedDocReceiveRecoveryContext<'a> {
    state: &'a mut SharedDocState,
    next_message: Option<sync::Message>,
    retry_message: sync::Message,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuild_state_doc_preserves_state_and_restarts_sync_handshake() {
        let mut state = SharedDocState::new(AutoCommit::new(), "test-notebook".into());
        state
            .state_doc
            .create_execution_with_source("exec-1", "cell-1", "x = 1", 1)
            .expect("execution created");

        assert!(
            state.generate_state_sync_message().is_some(),
            "first sync round should advertise runtime-state changes"
        );
        assert!(
            state.generate_state_sync_message().is_none(),
            "peer state should suppress duplicate messages before rebuild"
        );

        assert!(state.rebuild_state_doc().is_ok());

        let runtime_state = state.state_doc.read_state();
        assert!(
            runtime_state.executions.contains_key("exec-1"),
            "save/load rebuild must not drop runtime-state data"
        );
        assert!(
            state.generate_state_sync_message().is_some(),
            "reset sync state should force a fresh runtime-state handshake"
        );
    }
}
