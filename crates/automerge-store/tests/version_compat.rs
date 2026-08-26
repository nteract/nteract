//! Contract tests between the Automerge version shipped by nteract 2.7 and
//! the crates.io 0.11 release.
//!
//! Types from the two crates intentionally never cross this boundary. Only
//! durable snapshots and encoded sync messages do, matching deployed peers.

#![allow(clippy::expect_used)] // Test construction should fail at the exact incompatible operation.

use automerge::{
    marks::{ExpandMark as CurrentExpandMark, Mark as CurrentMark},
    sync::{Message as CurrentMessage, State as CurrentSyncState, SyncDoc as _},
    transaction::Transactable as _,
    ActorId as CurrentActorId, AutoCommit as CurrentDoc, ObjType as CurrentObjType, ReadDoc as _,
    ROOT as CURRENT_ROOT,
};
use automerge_legacy::{
    marks::{ExpandMark as LegacyExpandMark, Mark as LegacyMark},
    sync::{Message as LegacyMessage, State as LegacySyncState, SyncDoc as _},
    transaction::Transactable as _,
    ActorId as LegacyActorId, AutoCommit as LegacyDoc, ObjType as LegacyObjType, ReadDoc as _,
    ROOT as LEGACY_ROOT,
};

const MAX_SYNC_ROUNDS: usize = 64;

fn representative_legacy_document() -> LegacyDoc {
    let mut document = LegacyDoc::new().with_actor(LegacyActorId::from(b"nteract-2.7".as_slice()));

    let notebook = document
        .put_object(LEGACY_ROOT, "notebook", LegacyObjType::Map)
        .expect("create notebook map");
    let cells = document
        .put_object(&notebook, "cells", LegacyObjType::List)
        .expect("create cells list");
    let cell = document
        .insert_object(&cells, 0, LegacyObjType::Map)
        .expect("create representative cell");
    document.put(&cell, "id", "cell-1").expect("write cell id");
    document
        .put(&cell, "cell_type", "markdown")
        .expect("write cell type");
    document
        .put(&cell, "position", "a0")
        .expect("write cell position");
    let source = document
        .put_object(&cell, "source", LegacyObjType::Text)
        .expect("create cell source text");
    document
        .splice_text(&source, 0, 0, "Legacy rich text")
        .expect("write cell source");
    document
        .mark(
            &source,
            LegacyMark::new("strong".to_string(), true, 0, 6),
            LegacyExpandMark::Both,
        )
        .expect("mark cell source");
    let metadata = document
        .put_object(&notebook, "metadata", LegacyObjType::Map)
        .expect("create notebook metadata");
    let dependencies = document
        .put_object(&metadata, "dependencies", LegacyObjType::List)
        .expect("create dependency list");
    document
        .insert(&dependencies, 0, "numpy>=2")
        .expect("write dependency");

    let runtime = document
        .put_object(LEGACY_ROOT, "runtime", LegacyObjType::Map)
        .expect("create runtime map");
    document
        .put(&runtime, "kernel_status", "idle")
        .expect("write runtime status");
    let executions = document
        .put_object(&runtime, "executions", LegacyObjType::Map)
        .expect("create execution map");
    let execution = document
        .put_object(&executions, "execution-1", LegacyObjType::Map)
        .expect("create execution entry");
    document
        .put(&execution, "status", "done")
        .expect("write execution status");
    let outputs = document
        .put_object(&execution, "outputs", LegacyObjType::List)
        .expect("create output list");
    document
        .insert(&outputs, 0, "text/plain:2")
        .expect("write output reference");

    let comms = document
        .put_object(LEGACY_ROOT, "comms", LegacyObjType::Map)
        .expect("create comms map");
    let model = document
        .put_object(&comms, "widget-1", LegacyObjType::Map)
        .expect("create widget state");
    document
        .put(&model, "value", 7_i64)
        .expect("write widget value");
    let selections = document
        .put_object(&model, "selections", LegacyObjType::List)
        .expect("create widget list");
    document
        .insert(&selections, 0, "first")
        .expect("write widget selection");

    let comments = document
        .put_object(LEGACY_ROOT, "comments", LegacyObjType::Map)
        .expect("create comments map");
    let threads = document
        .put_object(&comments, "threads", LegacyObjType::List)
        .expect("create comment threads");
    let thread = document
        .insert_object(&threads, 0, LegacyObjType::Map)
        .expect("create comment thread");
    document
        .put(&thread, "author", "human:kyle")
        .expect("write comment author");
    let body = document
        .put_object(&thread, "body", LegacyObjType::Text)
        .expect("create comment body");
    document
        .splice_text(&body, 0, 0, "Review this")
        .expect("write comment body");

    document
}

fn assert_current_shape(document: &CurrentDoc) {
    let (notebook_value, notebook) = document
        .get(CURRENT_ROOT, "notebook")
        .expect("read notebook")
        .expect("notebook exists");
    assert!(notebook_value.is_object(), "notebook is a map");
    let (cells_value, cells) = document
        .get(&notebook, "cells")
        .expect("read cells")
        .expect("cells exist");
    assert!(cells_value.is_object(), "cells is a list");
    assert_eq!(document.length(&cells), 1);
    let (cell_value, cell) = document
        .get(&cells, 0)
        .expect("read cell")
        .expect("cell exists");
    assert!(cell_value.is_object(), "cell is a map");
    let (source_value, source) = document
        .get(&cell, "source")
        .expect("read source")
        .expect("source exists");
    assert!(source_value.is_object(), "source is text");
    assert_eq!(
        document.text(&source).expect("read source text"),
        "Legacy rich text"
    );
    let marks = document.marks(&source).expect("read source marks");
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0].name(), "strong");

    for key in ["runtime", "comms", "comments"] {
        assert!(
            document
                .get(CURRENT_ROOT, key)
                .is_ok_and(|value| value.is_some()),
            "missing {key} structure"
        );
    }
}

fn add_current_rich_text(document: &mut CurrentDoc) {
    let text = document
        .put_object(CURRENT_ROOT, "current_text", CurrentObjType::Text)
        .expect("create current rich text");
    document
        .splice_text(&text, 0, 0, "Current rich text")
        .expect("write current rich text");
    document
        .mark(
            &text,
            CurrentMark::new("emphasis".to_string(), "current", 0, 7),
            CurrentExpandMark::Both,
        )
        .expect("mark current rich text");
}

fn assert_legacy_shape(document: &LegacyDoc) {
    for key in ["notebook", "runtime", "comms", "comments"] {
        assert!(
            document
                .get(LEGACY_ROOT, key)
                .expect("read structure")
                .is_some(),
            "missing {key} structure"
        );
    }
    assert!(document
        .get(LEGACY_ROOT, "current_mutation")
        .expect("read current mutation")
        .is_some());
    let (text_value, text) = document
        .get(LEGACY_ROOT, "current_text")
        .expect("read current rich text")
        .expect("current rich text exists");
    assert!(text_value.is_object(), "current rich text is text");
    assert_eq!(
        document
            .text(&text)
            .expect("read current rich text content"),
        "Current rich text"
    );
    let marks = document.marks(&text).expect("read current rich text marks");
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0].name(), "emphasis");
    assert_eq!(marks[0].start, 0);
    assert_eq!(marks[0].end, 7);
    assert_eq!(marks[0].value().to_str(), Some("current"));
}

fn legacy_to_current(
    legacy: &mut LegacyDoc,
    legacy_state: &mut LegacySyncState,
    current: &mut CurrentDoc,
    current_state: &mut CurrentSyncState,
) -> bool {
    let Some(message) = legacy.sync().generate_sync_message(legacy_state) else {
        return false;
    };
    let encoded = message.encode();
    let decoded = CurrentMessage::decode(&encoded).expect("0.11 decodes legacy sync message");
    current
        .sync()
        .receive_sync_message(current_state, decoded)
        .expect("0.11 applies legacy sync message");
    true
}

fn current_to_legacy(
    current: &mut CurrentDoc,
    current_state: &mut CurrentSyncState,
    legacy: &mut LegacyDoc,
    legacy_state: &mut LegacySyncState,
) -> bool {
    let Some(message) = current.sync().generate_sync_message(current_state) else {
        return false;
    };
    let encoded = message.encode();
    let decoded = LegacyMessage::decode(&encoded).expect("legacy decodes 0.11 sync message");
    legacy
        .sync()
        .receive_sync_message(legacy_state, decoded)
        .expect("legacy applies 0.11 sync message");
    true
}

fn converge(
    legacy: &mut LegacyDoc,
    legacy_state: &mut LegacySyncState,
    current: &mut CurrentDoc,
    current_state: &mut CurrentSyncState,
) {
    for _ in 0..MAX_SYNC_ROUNDS {
        let sent_legacy = legacy_to_current(legacy, legacy_state, current, current_state);
        let sent_current = current_to_legacy(current, current_state, legacy, legacy_state);
        if !sent_legacy && !sent_current {
            assert_eq!(
                legacy
                    .get_heads()
                    .iter()
                    .map(|head| head.0)
                    .collect::<Vec<_>>(),
                current
                    .get_heads()
                    .iter()
                    .map(|head| head.0)
                    .collect::<Vec<_>>(),
                "quiescent peers must share the same heads",
            );
            return;
        }
    }
    panic!("Automerge peers did not converge within {MAX_SYNC_ROUNDS} rounds");
}

#[test]
fn legacy_and_current_snapshots_round_trip_both_directions() {
    let mut legacy = representative_legacy_document();
    let legacy_snapshot = legacy.save();

    let mut current = CurrentDoc::load(&legacy_snapshot)
        .expect("Automerge 0.11 loads the nteract 2.7 snapshot")
        .with_actor(CurrentActorId::from(b"automerge-0.11".as_slice()));
    assert_current_shape(&current);
    current
        .put(CURRENT_ROOT, "current_mutation", "preserved by legacy")
        .expect("mutate with Automerge 0.11");
    add_current_rich_text(&mut current);
    let current_snapshot = current.save();

    let mut legacy_reloaded = LegacyDoc::load(&current_snapshot)
        .expect("nteract 2.7 Automerge loads the 0.11 snapshot")
        .with_actor(LegacyActorId::from(b"legacy-reload".as_slice()));
    assert_legacy_shape(&legacy_reloaded);
    legacy_reloaded
        .put(LEGACY_ROOT, "legacy_mutation", "preserved by current")
        .expect("mutate with legacy Automerge");

    let current_reloaded = CurrentDoc::load(&legacy_reloaded.save())
        .expect("Automerge 0.11 reloads the legacy-mutated snapshot");
    assert_current_shape(&current_reloaded);
    assert!(current_reloaded
        .get(CURRENT_ROOT, "legacy_mutation")
        .is_ok_and(|value| value.is_some()));
}

#[test]
fn legacy_and_current_encoded_sync_messages_converge_bidirectionally() {
    let mut legacy = representative_legacy_document();
    let mut current = CurrentDoc::new().with_actor(CurrentActorId::from(b"0.11-peer".as_slice()));
    let mut legacy_state = LegacySyncState::new();
    let mut current_state = CurrentSyncState::new();

    converge(
        &mut legacy,
        &mut legacy_state,
        &mut current,
        &mut current_state,
    );
    assert_current_shape(&current);

    current
        .put(CURRENT_ROOT, "from_current", "0.11")
        .expect("write current peer mutation");
    current
        .put(CURRENT_ROOT, "current_mutation", "preserved by legacy")
        .expect("write current compatibility marker");
    add_current_rich_text(&mut current);
    legacy
        .put(LEGACY_ROOT, "from_legacy", "2.7")
        .expect("write legacy peer mutation");
    converge(
        &mut legacy,
        &mut legacy_state,
        &mut current,
        &mut current_state,
    );

    assert!(current
        .get(CURRENT_ROOT, "from_legacy")
        .is_ok_and(|value| value.is_some()));
    assert!(legacy
        .get(LEGACY_ROOT, "from_current")
        .is_ok_and(|value| value.is_some()));
    assert_legacy_shape(&legacy);
}
