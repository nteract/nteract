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
use comments_doc::CommentsDoc;
use log::warn;
use notebook_doc::presence::PresenceState;
use runtime_doc::{CommsDoc, RuntimeStateDoc};

use crate::error::SyncError;

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

    /// Runtime state doc — runtime-authoritative, synced read-only here.
    pub(crate) state_doc: RuntimeStateDoc,

    /// Automerge sync protocol state for the RuntimeStateDoc peer.
    pub(crate) state_peer_state: sync::State,

    /// Widget comm state doc — synced alongside RuntimeStateDoc.
    pub(crate) comms_doc: CommsDoc,

    /// Automerge sync protocol state for the CommsDoc peer.
    pub(crate) comms_peer_state: sync::State,

    /// Durable comments doc — synced alongside notebook state.
    pub(crate) comments_doc: CommentsDoc,

    /// Trusted CommentsDoc authority actor labels advertised by the daemon.
    pub(crate) comments_authority_actor_labels: Vec<String>,

    /// Automerge sync protocol state for the CommentsDoc peer.
    pub(crate) comments_peer_state: sync::State,

    #[cfg(test)]
    panic_on_next_doc_sync: bool,
    #[cfg(test)]
    panic_on_next_state_sync: bool,
}

impl SharedDocState {
    /// Create a new shared state with the given document and notebook ID.
    pub fn try_new(doc: AutoCommit, notebook_id: String) -> Result<Self, SyncError> {
        Self::try_new_with_comments_doc_identity(doc, notebook_id, None, None)
    }

    /// Create a new shared state, optionally seeding CommentsDoc from the
    /// daemon-advertised identity and trusted authority actor.
    pub fn try_new_with_comments_doc_id(
        doc: AutoCommit,
        notebook_id: String,
        comments_doc_id: Option<String>,
    ) -> Result<Self, SyncError> {
        Self::try_new_with_comments_doc_identity(doc, notebook_id, comments_doc_id, None)
    }

    pub fn try_new_with_comments_doc_identity(
        doc: AutoCommit,
        notebook_id: String,
        comments_doc_id: Option<String>,
        comments_authority_actor_label: Option<String>,
    ) -> Result<Self, SyncError> {
        let derived_comments_identity = comments_identity_for_notebook_id(&notebook_id);
        let comments_doc_id =
            comments_doc_id.unwrap_or_else(|| derived_comments_identity.comments_doc_id.clone());
        let comments_authority_actor_labels = comments_authority_actor_label
            .into_iter()
            .filter(|label| !label.trim().is_empty())
            .collect();
        Ok(Self {
            doc,
            peer_state: sync::State::new(),
            notebook_id,
            presence: PresenceState::new(),
            state_doc: RuntimeStateDoc::try_new_empty()?,
            state_peer_state: sync::State::new(),
            comms_doc: CommsDoc::try_new_empty()?,
            comms_peer_state: sync::State::new(),
            comments_doc: CommentsDoc::try_new_sync_target(&comments_doc_id)?,
            comments_authority_actor_labels,
            comments_peer_state: sync::State::new(),
            #[cfg(test)]
            panic_on_next_doc_sync: false,
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
        #[cfg(test)]
        if self.panic_on_next_doc_sync {
            self.panic_on_next_doc_sync = false;
            panic!("injected AutomergeSync panic");
        }

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

    // ── CommsDoc sync ───────────────────────────────────────────────

    pub(crate) fn generate_comms_sync_message_recovering(
        &mut self,
        label: &str,
    ) -> Result<Option<sync::Message>, AutomergeOperationError> {
        self.comms_doc
            .generate_sync_message_recovering(&mut self.comms_peer_state, label)
    }

    pub(crate) fn receive_comms_sync_message(
        &mut self,
        message: sync::Message,
    ) -> Result<(), automerge::AutomergeError> {
        self.comms_doc
            .doc_mut()
            .sync()
            .receive_sync_message(&mut self.comms_peer_state, message)
    }

    pub(crate) fn receive_comms_sync_message_recovering(
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
                context.state.receive_comms_sync_message(message)
            },
            is_recoverable_sync_error,
            |context| context.state.rebuild_comms_doc(),
        )
    }

    pub(crate) fn rebuild_comms_doc(&mut self) -> Result<(), AutomergeRebuildError> {
        let rebuilt = self.comms_doc.rebuild_from_save();
        if let Err(err) = &rebuilt {
            warn!(
                "[notebook-sync] Failed to rebuild CommsDoc after recoverable Automerge failure: {}; \
                 resetting comms sync protocol only",
                err
            );
        }
        self.comms_peer_state = sync::State::new();
        rebuilt
    }

    // ── CommentsDoc sync ────────────────────────────────────────────

    pub(crate) fn generate_comments_sync_message_recovering(
        &mut self,
        label: &str,
    ) -> Result<Option<sync::Message>, comments_doc::CommentsDocError> {
        self.comments_doc
            .generate_sync_message_recovering(&mut self.comments_peer_state, label)
            .map_err(Into::into)
    }

    pub(crate) fn receive_comments_sync_message_recovering(
        &mut self,
        message: sync::Message,
        label: &str,
    ) -> Result<bool, comments_doc::CommentsDocError> {
        self.comments_doc
            .receive_sync_message_with_changes_recovering(
                &mut self.comments_peer_state,
                message,
                label,
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
    pub(crate) fn panic_on_next_doc_sync_for_test(&mut self) {
        self.panic_on_next_doc_sync = true;
    }

    #[cfg(test)]
    pub(crate) fn panic_on_next_state_sync_for_test(&mut self) {
        self.panic_on_next_state_sync = true;
    }
}

fn comments_identity_for_notebook_id(notebook_id: &str) -> comments_doc::LocalCommentsIdentity {
    if uuid::Uuid::parse_str(notebook_id).is_ok() {
        comments_doc::local_room_comments_identity(notebook_id.to_string())
    } else {
        comments_doc::local_path_comments_identity(notebook_id.to_string())
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
            .create_execution_with_source("exec-1", "x = 1", 1)
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

    #[test]
    fn shared_state_seeds_comments_doc_from_local_path_identity() {
        let state =
            SharedDocState::new(AutoCommit::new(), "/tmp/example-notebook.ipynb".to_string());
        let expected_doc_id =
            comments_doc::local_path_comments_doc_id("/tmp/example-notebook.ipynb");

        assert_eq!(
            state.comments_doc.comments_doc_id().as_deref(),
            Some(expected_doc_id.as_str())
        );
        assert!(!state.comments_doc.is_materialized());
        assert_eq!(state.comments_doc.notebook_ref(), None);
    }

    #[test]
    fn shared_state_seeds_comments_doc_from_room_uuid_identity() {
        let room_id = "b98a5f0c-c4bb-4d44-8ab4-7e369da72401";
        let state = SharedDocState::new(AutoCommit::new(), room_id.to_string());
        let expected_doc_id = comments_doc::local_room_comments_doc_id(room_id);

        assert_eq!(
            state.comments_doc.comments_doc_id().as_deref(),
            Some(expected_doc_id.as_str())
        );
        assert!(!state.comments_doc.is_materialized());
        assert_eq!(state.comments_doc.notebook_ref(), None);
    }

    #[test]
    fn shared_state_uses_daemon_advertised_comments_doc_identity() {
        let room_id = "b98a5f0c-c4bb-4d44-8ab4-7e369da72401";
        let path_doc_id = comments_doc::local_path_comments_doc_id("/tmp/file-backed.ipynb");
        let state = SharedDocState::try_new_with_comments_doc_id(
            AutoCommit::new(),
            room_id.to_string(),
            Some(path_doc_id.clone()),
        )
        .unwrap();

        assert_eq!(
            state.comments_doc.comments_doc_id().as_deref(),
            Some(path_doc_id.as_str())
        );
        assert!(!state.comments_doc.is_materialized());
        assert_eq!(state.comments_doc.notebook_ref(), None);
    }

    #[test]
    fn shared_state_stores_daemon_advertised_comments_authority_actor() {
        let room_id = "b98a5f0c-c4bb-4d44-8ab4-7e369da72401";
        let state = SharedDocState::try_new_with_comments_doc_identity(
            AutoCommit::new(),
            room_id.to_string(),
            None,
            Some(comments_doc::COMMENTS_DOC_DEFAULT_ACTOR.to_string()),
        )
        .unwrap();

        assert_eq!(
            state.comments_authority_actor_labels,
            vec![comments_doc::COMMENTS_DOC_DEFAULT_ACTOR.to_string()]
        );
    }
}
