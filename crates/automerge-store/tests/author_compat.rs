//! Snapshot and wire compatibility at the dependency boundary, including
//! the 0.12 author extension. Older versions cannot resolve authors themselves;
//! they must preserve the bytes so a 0.12 peer can resolve them after forwarding.

#![allow(clippy::expect_used)]

use automerge::{
    sync::{Message, State, SyncDoc as _},
    transaction::Transactable as _,
    ActorId, Author, AutoCommit, ObjType, ReadDoc as _, ROOT,
};

const ACTOR_LABEL: &[u8] = b"human:kyle:codex:session-1";
const AUTHOR_LABEL: &[u8] = b"human:kyle:codex:session-1";
const MAX_SYNC_ROUNDS: usize = 64;

fn authored_document() -> AutoCommit {
    let mut document = AutoCommit::new().with_author(Some(Author::from(AUTHOR_LABEL)));
    let text = document
        .put_object(ROOT, "source", ObjType::Text)
        .expect("source text");
    document
        .splice_text(&text, 0, 0, "base")
        .expect("source contents");
    document.commit();
    document
        .put(ROOT, "second_commit", "same author")
        .expect("second author commit");
    document.commit();
    document
}

fn assert_author(document: &mut AutoCommit, actor: &ActorId) {
    assert_eq!(
        document
            .get_author_for_actor(actor)
            .expect("historical actor author")
            .as_bytes(),
        AUTHOR_LABEL,
    );
    // Subsequent changes may omit their author extension. Resolve attribution
    // from the actor index, rather than assuming Change::author is always set.
    let changes = document.get_changes(&[]);
    let authored_changes = changes
        .iter()
        .filter(|change| change.actor_id() == actor)
        .collect::<Vec<_>>();
    assert_eq!(authored_changes.len(), 2);
    assert_eq!(authored_changes[0].seq(), 1);
    assert_eq!(
        authored_changes[0]
            .author()
            .expect("first change carries author extension")
            .as_bytes(),
        AUTHOR_LABEL
    );
    assert_eq!(authored_changes[1].seq(), 2);
    assert!(
        authored_changes[1].author().is_none(),
        "subsequent change omits author extension"
    );
    for change in authored_changes {
        let metadata = document
            .get_change_meta_by_hash(&change.hash())
            .expect("resolve historical metadata");
        assert_eq!(metadata.actor.as_ref(), actor);
        assert_eq!(metadata.seq, change.seq());
        assert_eq!(
            metadata
                .author
                .expect("metadata resolves author for every sequence")
                .as_bytes(),
            AUTHOR_LABEL
        );
    }
}

// Each instantiation uses its own Rust types on the old side. Only encoded
// messages, snapshots and plain bytes ever cross versions.
macro_rules! old_peer_contract {
    ($module:ident, $old:ident) => {
        mod $module {
            use super::*;
            use $old::{
                sync::{Message as OldMessage, State as OldState, SyncDoc as _},
                transaction::Transactable as _,
                ActorId as OldActorId, AutoCommit as OldDoc, ObjType as OldObjType, ReadDoc as _,
                ROOT as OLD_ROOT,
            };

            fn converge(
                old: &mut OldDoc,
                old_state: &mut OldState,
                current: &mut AutoCommit,
                state: &mut State,
            ) {
                for _ in 0..MAX_SYNC_ROUNDS {
                    let mut sent = false;
                    if let Some(message) = old.sync().generate_sync_message(old_state) {
                        current
                            .sync()
                            .receive_sync_message(
                                state,
                                Message::decode(&message.encode()).expect("decode old wire bytes"),
                            )
                            .expect("receive old wire bytes");
                        sent = true;
                    }
                    if let Some(message) = current.sync().generate_sync_message(state) {
                        old.sync()
                            .receive_sync_message(
                                old_state,
                                OldMessage::decode(&message.encode())
                                    .expect("decode current wire bytes"),
                            )
                            .expect("receive current wire bytes");
                        sent = true;
                    }
                    if !sent {
                        assert_eq!(
                            old.get_heads()
                                .iter()
                                .map(|head| head.0)
                                .collect::<Vec<_>>(),
                            current
                                .get_heads()
                                .iter()
                                .map(|head| head.0)
                                .collect::<Vec<_>>()
                        );
                        return;
                    }
                }
                panic!("old/current peers did not converge");
            }

            fn old_document() -> OldDoc {
                let mut old = OldDoc::new().with_actor(OldActorId::from(ACTOR_LABEL));
                let text = old
                    .put_object(OLD_ROOT, "source", OldObjType::Text)
                    .expect("source object");
                old.splice_text(&text, 0, 0, "base")
                    .expect("initial source");
                old
            }

            fn assert_content(document: &AutoCommit, expected: &str) {
                let (_, text) = document
                    .get(ROOT, "source")
                    .expect("read source")
                    .expect("source exists");
                assert_eq!(document.text(text).expect("read text"), expected);
            }

            #[test]
            fn existing_actor_attribution_survives_snapshot_round_trip() {
                let mut old = old_document();
                let original_changes = old
                    .get_changes(&[])
                    .iter()
                    .map(|change| (change.hash().0, change.raw_bytes().to_vec()))
                    .collect::<Vec<_>>();
                let mut current = AutoCommit::load(&old.save()).expect("load older snapshot");
                assert_content(&current, "base");
                let initial_changes = current.get_changes(&[]);
                assert_eq!(
                    initial_changes
                        .iter()
                        .map(|change| (change.hash().0, change.raw_bytes().to_vec()))
                        .collect::<Vec<_>>(),
                    original_changes
                );
                assert_eq!(initial_changes[0].actor_id().to_bytes(), ACTOR_LABEL);
                assert!(current
                    .get_author_for_actor(&ActorId::from(ACTOR_LABEL))
                    .is_none());
                current
                    .put(ROOT, "new_value", "0.12")
                    .expect("current edit");
                let mut older =
                    OldDoc::load(&current.save()).expect("older reads current snapshot");
                older
                    .put(OLD_ROOT, "old_value", "older")
                    .expect("older edit");
                let mut reloaded =
                    AutoCommit::load(&older.save()).expect("current reads older re-save");
                assert_content(&reloaded, "base");
                for (key, expected) in [("new_value", "0.12"), ("old_value", "older")] {
                    assert_eq!(
                        reloaded
                            .get(ROOT, key)
                            .expect("read edit")
                            .expect("edit exists")
                            .0
                            .as_str(),
                        Some(expected)
                    );
                }
                assert_eq!(
                    (
                        reloaded.get_changes(&[])[0].hash().0,
                        reloaded.get_changes(&[])[0].raw_bytes().to_vec()
                    ),
                    original_changes[0]
                );
            }

            #[test]
            fn concurrent_text_edits_converge_over_encoded_sync() {
                let mut old = old_document();
                let mut current = AutoCommit::new();
                let mut old_state = OldState::new();
                let mut state = State::new();
                converge(&mut old, &mut old_state, &mut current, &mut state);
                let (_, old_text) = old
                    .get(OLD_ROOT, "source")
                    .expect("old source")
                    .expect("source exists");
                let (_, text) = current
                    .get(ROOT, "source")
                    .expect("current source")
                    .expect("source exists");
                old.splice_text(&old_text, 0, 0, "old-")
                    .expect("concurrent older edit");
                current
                    .splice_text(&text, 0, 0, "current-")
                    .expect("concurrent current edit");
                converge(&mut old, &mut old_state, &mut current, &mut state);
                let result = current.text(&text).expect("merged current text");
                assert_eq!(old.text(old_text).expect("merged older text"), result);
                assert!(
                    result == "old-current-base" || result == "current-old-base",
                    "{result}"
                );
                assert_content(&current, &result);
                assert!(current
                    .get_changes(&[])
                    .iter()
                    .any(|change| change.actor_id().to_bytes() == ACTOR_LABEL));
                let reloaded = AutoCommit::load(&old.save()).expect("reload synced old peer");
                assert_content(&reloaded, &result);
            }

            #[test]
            fn authors_survive_older_peer_snapshot_mutation_and_resave() {
                let mut current = authored_document();
                let actor = current.get_actor().clone();
                let original_changes = current
                    .get_changes(&[])
                    .iter()
                    .map(|change| (change.hash().0, change.raw_bytes().to_vec()))
                    .collect::<Vec<_>>();
                let original_heads = current.get_heads();
                let mut old =
                    OldDoc::load(&current.save()).expect("old peer reads author extension");
                assert_eq!(
                    old.get_heads()
                        .iter()
                        .map(|head| head.0)
                        .collect::<Vec<_>>(),
                    original_heads.iter().map(|head| head.0).collect::<Vec<_>>()
                );
                assert_eq!(
                    old.get_changes(&[])
                        .iter()
                        .map(|change| (change.hash().0, change.raw_bytes().to_vec()))
                        .collect::<Vec<_>>(),
                    original_changes
                );
                old.put(OLD_ROOT, "older_edit", "retained")
                    .expect("older mutation");
                let older_heads = old
                    .get_heads()
                    .iter()
                    .map(|head| head.0)
                    .collect::<Vec<_>>();
                let mut reloaded =
                    AutoCommit::load(&old.save()).expect("reload author extension from old peer");
                assert_eq!(
                    reloaded
                        .get_heads()
                        .iter()
                        .map(|head| head.0)
                        .collect::<Vec<_>>(),
                    older_heads
                );
                assert_content(&reloaded, "base");
                assert_author(&mut reloaded, &actor);
                assert_eq!(
                    reloaded
                        .get(ROOT, "older_edit")
                        .expect("read older edit")
                        .expect("edit exists")
                        .0
                        .as_str(),
                    Some("retained")
                );
                for original in &original_changes {
                    assert!(reloaded
                        .get_changes(&[])
                        .iter()
                        .any(|change| change.hash().0 == original.0
                            && change.raw_bytes() == original.1));
                }
            }

            #[test]
            fn authors_survive_sync_through_older_peer_to_fresh_current_peer() {
                let mut current = authored_document();
                let actor = current.get_actor().clone();
                let original_changes = current
                    .get_changes(&[])
                    .iter()
                    .map(|change| (change.hash().0, change.raw_bytes().to_vec()))
                    .collect::<Vec<_>>();
                let mut old = OldDoc::new();
                converge(
                    &mut old,
                    &mut OldState::new(),
                    &mut current,
                    &mut State::new(),
                );
                old.put(OLD_ROOT, "older_edit", "forwarded")
                    .expect("older mutation");
                let mut fresh = AutoCommit::new();
                converge(
                    &mut old,
                    &mut OldState::new(),
                    &mut fresh,
                    &mut State::new(),
                );
                assert_author(&mut fresh, &actor);
                assert_content(&fresh, "base");
                assert_eq!(
                    fresh
                        .get(ROOT, "older_edit")
                        .expect("read older edit")
                        .expect("edit exists")
                        .0
                        .as_str(),
                    Some("forwarded")
                );
                for original in &original_changes {
                    assert!(fresh
                        .get_changes(&[])
                        .iter()
                        .any(|change| change.hash().0 == original.0
                            && change.raw_bytes() == original.1));
                }
            }
        }
    };
}

old_peer_contract!(previous_011, automerge_previous);
old_peer_contract!(deployed_010, automerge_legacy);

#[test]
fn independent_forks_keep_the_same_author_and_use_distinct_actors() {
    let mut original = authored_document();
    let original_actor = original.get_actor().clone();
    let mut first = original.fork();
    let mut second = original.fork();
    assert_ne!(first.get_actor(), second.get_actor());
    assert_ne!(first.get_actor(), &original_actor);
    assert_ne!(second.get_actor(), &original_actor);
    assert_eq!(
        first.get_author().expect("fork retains author").as_bytes(),
        AUTHOR_LABEL
    );
    assert_eq!(
        second.get_author().expect("fork retains author").as_bytes(),
        AUTHOR_LABEL
    );
    let first_actor = first.get_actor().clone();
    let second_actor = second.get_actor().clone();
    first
        .put(ROOT, "first", "Codex session 1")
        .expect("first fork write");
    second
        .put(ROOT, "second", "Codex session 2")
        .expect("second fork write");
    first
        .merge(&mut second)
        .expect("merge independent same-author forks");
    for actor in [&original_actor, &first_actor, &second_actor] {
        assert_eq!(
            first
                .get_author_for_actor(actor)
                .expect("all actors map to same author")
                .as_bytes(),
            AUTHOR_LABEL
        );
    }
    let reloaded = AutoCommit::load(&first.save()).expect("reload merged forks");
    for (key, value) in [("first", "Codex session 1"), ("second", "Codex session 2")] {
        assert_eq!(
            reloaded
                .get(ROOT, key)
                .expect("read fork edit")
                .expect("fork edit exists")
                .0
                .as_str(),
            Some(value)
        );
    }
    assert_eq!(
        reloaded
            .get_actors_for_author(&Author::from(AUTHOR_LABEL))
            .len(),
        3
    );
}

#[test]
fn cloning_does_not_create_an_independent_writer_even_with_authors() {
    let mut original = authored_document();
    let mut cloned = original.clone();
    assert_eq!(original.get_actor(), cloned.get_actor());
    // Assigning the same author is deliberately a no-op: it cannot repair
    // duplicated actors. Independently writable replicas must use fork/load.
    cloned.set_author(Some(Author::from(AUTHOR_LABEL)));
    assert_eq!(original.get_actor(), cloned.get_actor());
    original
        .put(ROOT, "original_edit", "first")
        .expect("original write");
    cloned
        .put(ROOT, "cloned_edit", "second")
        .expect("cloned write");
    assert!(matches!(
        original.merge(&mut cloned),
        Err(automerge::AutomergeError::DuplicateSeqNumber(3, _))
    ));
}
