//! Ingress checks shared by every peer-writable Automerge document the room
//! routes (CommsDoc and keyed documents).
//!
//! A sync message carries change chunks that cannot be split, so a message is
//! admitted whole: it is applied to clones first and the originals are only
//! replaced once every new change passed.

use automerge::sync::SyncDoc;
use automerge::{sync, AutoCommit};
use automerge_recovery::{
    catch_automerge_panic, is_recoverable_sync_error, recoverable_automerge_operation,
    AutomergeOperationError, AutomergeRebuildError,
};

use crate::notebook_sync_server::RoomConnectionIdentity;

pub(crate) struct Preview {
    pub doc: AutoCommit,
    pub state: sync::State,
    pub new_changes: Vec<automerge::Change>,
}

/// Apply `message` to clones of `doc` and `state`; both originals stay
/// untouched. Panics inside Automerge come back as errors. A
/// `PatchLogMismatch` rebuilds the clone from a save and retries once with a
/// fresh state, the same recovery the CommsDoc receive path applies, so the
/// preview does not refuse a message the real receive would accept.
pub(crate) fn preview_receive(
    doc: &AutoCommit,
    state: &sync::State,
    message: sync::Message,
    label: &str,
) -> Result<Preview, AutomergeOperationError> {
    preview_receive_with(doc, state, message, label, |doc, state, message| {
        doc.sync().receive_sync_message(state, message)
    })
}

/// `preview_receive` with the receive step injectable, so tests can force
/// the recoverable error.
fn preview_receive_with(
    doc: &AutoCommit,
    state: &sync::State,
    message: sync::Message,
    label: &str,
    mut receive: impl FnMut(
        &mut AutoCommit,
        &mut sync::State,
        sync::Message,
    ) -> Result<(), automerge::AutomergeError>,
) -> Result<Preview, AutomergeOperationError> {
    let mut preview = Preview {
        doc: doc.clone(),
        state: state.clone(),
        new_changes: Vec::new(),
    };
    let heads_before = preview.doc.get_heads();
    recoverable_automerge_operation(
        label,
        &mut preview,
        |preview| receive(&mut preview.doc, &mut preview.state, message.clone()),
        is_recoverable_sync_error,
        |preview| {
            preview.state = sync::State::new();
            rebuild_from_save(&mut preview.doc)
        },
    )?;
    // Queued orphan changes are invisible to get_changes until a later
    // message supplies their dependencies. Never admit them under this
    // connection and then validate them under a different peer or producer.
    if !preview.doc.get_missing_deps(&[]).is_empty() {
        return Err(AutomergeOperationError::automerge(
            label,
            automerge::AutomergeError::MissingDeps,
        ));
    }
    preview.new_changes = preview.doc.get_changes(&heads_before);
    Ok(preview)
}

fn rebuild_from_save(doc: &mut AutoCommit) -> Result<(), AutomergeRebuildError> {
    catch_automerge_panic("keyed-doc-preview-rebuild", || {
        let actor = doc.get_actor().clone();
        let mut rebuilt = AutoCommit::load(&doc.save()).map_err(AutomergeRebuildError::load)?;
        rebuilt.set_actor(actor);
        *doc = rebuilt;
        Ok(())
    })?
}

/// A change whose actor label the connection may not author under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ForeignActor {
    pub label: String,
    /// From the identity check: principal mismatch or invalid label.
    pub reason: String,
}

/// Every change actor must be a label of the connection's principal.
/// `Err` describes the first offending change.
pub(crate) fn check_change_actors(
    identity: &RoomConnectionIdentity,
    changes: &[automerge::Change],
) -> Result<(), ForeignActor> {
    for change in changes {
        let label = notebook_doc::actor_label_from_id(change.actor_id());
        if let Err(error) = identity.validate_actor_labels(std::iter::once(label.as_str())) {
            return Err(ForeignActor {
                label,
                reason: error.to_string(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use automerge::transaction::Transactable;
    use automerge::ROOT;
    use nteract_identity::ConnectionScope;

    fn doc_with_actor(actor: &str) -> AutoCommit {
        let mut doc = AutoCommit::new();
        doc.set_actor(automerge::ActorId::from(actor.as_bytes()));
        doc
    }

    /// A sync message from `writer` that carries its changes, as a host
    /// with an empty document would receive after the heads exchange.
    pub(crate) fn message_with_changes(writer: &mut AutoCommit) -> sync::Message {
        let mut host = AutoCommit::new();
        let (mut writer_state, mut host_state) = (sync::State::new(), sync::State::new());
        for _ in 0..8 {
            if let Some(message) = writer.sync().generate_sync_message(&mut writer_state) {
                if !message.changes.is_empty() {
                    return message;
                }
                host.sync()
                    .receive_sync_message(&mut host_state, message)
                    .unwrap();
            }
            if let Some(reply) = host.sync().generate_sync_message(&mut host_state) {
                writer
                    .sync()
                    .receive_sync_message(&mut writer_state, reply)
                    .unwrap();
            }
        }
        panic!("writer never sent its changes");
    }

    #[test]
    fn preview_leaves_the_original_untouched() {
        let mut writer = doc_with_actor("user:dev:alice/browser:a");
        writer.put(ROOT, "k", "v").unwrap();
        writer.commit();
        let message = message_with_changes(&mut writer);
        let mut host = AutoCommit::new();
        let preview = preview_receive(&host, &sync::State::new(), message, "test").unwrap();
        assert_eq!(preview.new_changes.len(), 1);
        assert!(host.get_heads().is_empty());
        let mut previewed = preview.doc;
        assert_eq!(previewed.get_heads().len(), 1);
    }

    #[test]
    fn preview_rejects_orphan_changes_before_actor_validation() {
        let mut producer = doc_with_actor("runtimed:kernel");
        producer.put(ROOT, "parent", 1).unwrap();
        let parent = producer.commit().unwrap();
        let mut forged = producer.fork();
        forged.set_actor(automerge::ActorId::from(
            "user:dev:bob/browser:b".as_bytes(),
        ));
        forged.put(ROOT, "forged", true).unwrap();
        let child = forged.commit().unwrap();
        let message = sync::Message {
            heads: vec![child],
            need: vec![],
            have: vec![],
            changes: vec![forged
                .get_change_by_hash(&child)
                .unwrap()
                .raw_bytes()
                .to_vec()]
            .into(),
            flags: None,
            version: sync::MessageVersion::V1,
        };
        let message = sync::Message::decode(&message.encode()).unwrap();

        // Automerge accepts this frame but queues the child without exposing
        // it to get_changes. A later producer frame could resolve its parent.
        let mut unchecked = AutoCommit::new();
        unchecked
            .sync()
            .receive_sync_message(&mut sync::State::new(), message.clone())
            .unwrap();
        assert!(unchecked.get_changes(&[]).is_empty());
        assert_eq!(unchecked.get_missing_deps(&[]), vec![parent]);

        let mut host = AutoCommit::new();
        let state = sync::State::new();
        let result = preview_receive(&host, &state, message, "orphan-test");
        assert!(
            result.is_err(),
            "orphan changes must not bypass actor validation"
        );
        assert!(host.get_heads().is_empty());
        assert!(host.get_missing_deps(&[]).is_empty());
        assert!(state.shared_heads.is_empty());
        assert!(!state.in_flight);
    }

    #[test]
    fn preview_accepts_a_complete_causal_chain_for_actor_validation() {
        let mut writer = doc_with_actor("user:dev:alice/browser:a");
        writer.put(ROOT, "k", 1).unwrap();
        writer.commit();
        writer.put(ROOT, "k", 2).unwrap();
        writer.commit();
        let identity = RoomConnectionIdentity::hosted_bridged(
            "user:dev:alice",
            Some("browser:a".into()),
            ConnectionScope::Editor,
        )
        .unwrap();
        let preview = preview_receive(
            &AutoCommit::new(),
            &sync::State::new(),
            message_with_changes(&mut writer),
            "complete-test",
        )
        .unwrap();
        assert_eq!(preview.new_changes.len(), 2);
        assert!(check_change_actors(&identity, &preview.new_changes).is_ok());
    }

    #[test]
    fn preview_rebuilds_and_retries_after_a_patch_log_mismatch() {
        let mut writer = doc_with_actor("user:dev:alice/browser:a");
        writer.put(ROOT, "k", "v").unwrap();
        writer.commit();
        let message = message_with_changes(&mut writer);
        let host = doc_with_actor("runtimed:keyed-hub");
        let mut stale_state = sync::State::new();
        stale_state.shared_heads = vec![automerge::ChangeHash([7; 32])];

        let mut attempts = Vec::new();
        let preview = preview_receive_with(
            &host,
            &stale_state,
            message,
            "test",
            |doc, state, message| {
                attempts.push(state.shared_heads.clone());
                if attempts.len() == 1 {
                    return Err(automerge::PatchLogMismatch.into());
                }
                doc.sync().receive_sync_message(state, message)
            },
        )
        .unwrap();
        assert_eq!(
            attempts,
            vec![vec![automerge::ChangeHash([7; 32])], vec![]],
            "the retry starts from a fresh sync state"
        );
        assert_eq!(preview.new_changes.len(), 1);
        assert_eq!(
            preview.doc.get_actor(),
            &automerge::ActorId::from("runtimed:keyed-hub".as_bytes()),
            "the rebuilt clone keeps its actor"
        );

        // Other errors are not retried.
        let mut calls = 0;
        let error = preview_receive_with(
            &host,
            &sync::State::new(),
            message_with_changes(&mut writer),
            "test",
            |_, _, _| {
                calls += 1;
                Err(automerge::AutomergeError::InvalidObjId("x".into()))
            },
        );
        assert!(error.is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn actor_check_names_the_foreign_label() {
        let identity = RoomConnectionIdentity::hosted_bridged(
            "user:dev:alice",
            Some("browser:a".into()),
            ConnectionScope::Editor,
        )
        .unwrap();
        let mut alice = doc_with_actor("user:dev:alice/browser:a");
        alice.put(ROOT, "k", "v").unwrap();
        alice.commit();
        let mut mallory = doc_with_actor("user:dev:mallory/browser:m");
        mallory.put(ROOT, "k", "w").unwrap();
        mallory.commit();
        let ok = alice.get_changes(&[]);
        let bad = mallory.get_changes(&[]);
        assert!(check_change_actors(&identity, &ok).is_ok());
        let foreign = check_change_actors(&identity, &bad).unwrap_err();
        assert_eq!(foreign.label, "user:dev:mallory/browser:m");
        assert_eq!(
            foreign.reason,
            "actor principal user:dev:mallory is not authorized for authenticated principal user:dev:alice"
        );
    }
}
