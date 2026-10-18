//! Generated document payloads for the local celld storage probe. No user data.
//! `cargo run --release -p notebook-room-host --example storage_probe > fixture.json`
//! `... -- verify recovered.json` validates the returned snapshot/chunk streams.
use automerge::{AutoCommit, ChangeHash};
use comments_doc::{CommentAnchor, CommentsDoc, NotebookCommentRef};
use notebook_doc::NotebookDoc;
use runtime_doc::{CommsDoc, RuntimeStateDoc};
use serde_json::{json, Value};
use std::error::Error;
use std::time::Instant;

fn capture(docs: [&mut AutoCommit; 4], previous: &mut [Vec<ChangeHash>; 4], phase: &str) -> Value {
    let mut records = Vec::new();
    for (index, doc) in docs.into_iter().enumerate() {
        let heads = doc.get_heads();
        let changed = heads != previous[index];
        let started = Instant::now();
        let snapshot = doc.save();
        let full_us = started.elapsed().as_micros();
        let started = Instant::now();
        let delta = if previous[index].is_empty() {
            snapshot.clone()
        } else {
            doc.save_after(&previous[index])
        };
        let delta_us = started.elapsed().as_micros();
        records.push(json!({
            "heads": heads.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "snapshot": hex::encode(snapshot), "delta": hex::encode(delta),
            "changed": changed, "native_full_us": full_us, "native_delta_us": delta_us,
        }));
        previous[index] = heads;
    }
    json!({"phase": phase, "docs": records})
}

fn main() -> Result<(), Box<dyn Error>> {
    if std::env::args().nth(1).as_deref() == Some("verify") {
        let path = std::env::args().nth(2).ok_or("missing recovery file")?;
        let recovered: Value = serde_json::from_slice(&std::fs::read(path)?)?;
        for record in recovered.as_array().ok_or("expected recovery array")? {
            let mut doc =
                AutoCommit::load(&hex::decode(record["bytes"].as_str().ok_or("bytes")?)?)?;
            let mut expected = AutoCommit::load(&hex::decode(
                record["snapshot"].as_str().ok_or("snapshot")?,
            )?)?;
            assert_eq!(doc.get_heads(), expected.get_heads());
            // All change hashes cover history and actors, not just the current projection.
            let hashes = |d: &mut AutoCommit| {
                let mut h = d
                    .get_changes(&[])
                    .iter()
                    .map(|c| c.hash())
                    .collect::<Vec<_>>();
                h.sort();
                h
            };
            assert_eq!(hashes(&mut doc), hashes(&mut expected));
            assert_eq!(doc.get_missing_deps(&[]), Vec::<ChangeHash>::new());
        }
        println!("recovered heads and complete change history match all four documents");
        return Ok(());
    }
    let id = "11111111-1111-4111-8111-111111111111";
    let mut notebook = NotebookDoc::new_with_actor(id, "user:probe:owner/desktop:probe");
    let mut runtime = RuntimeStateDoc::new_with_actor("system:probe/runtime:probe");
    let mut comms = CommsDoc::new_with_actor("user:probe:owner/desktop:probe");
    let mut comments = CommentsDoc::new_with_actor(
        "comments:generated-probe",
        &NotebookCommentRef::HostedRoom {
            room_locator: "generated-probe".into(),
        },
        "user:probe:owner/desktop:probe",
    );
    for i in 0..96 {
        let cell = format!("cell-{i}");
        notebook.add_cell(i, &cell, "code")?;
        let source = (0..12)
            .map(|j| {
                format!(
                    "# Generated observation {i:03}/{j:03}: {:016x}\n",
                    (i * 7919 + j * 104729) as u64
                )
            })
            .collect::<String>();
        notebook.update_source(&cell, &source)?;
    }
    runtime.create_execution_with_source("execution-probe", "cell-0", 0)?;
    let mut previous = std::array::from_fn(|_| Vec::new());
    let mut records = Vec::new();
    macro_rules! record {
        ($phase:expr) => {
            records.push(capture(
                [
                    notebook.doc_mut(),
                    runtime.doc_mut(),
                    comms.doc_mut(),
                    comments.doc_mut(),
                ],
                &mut previous,
                $phase,
            ));
        };
    }
    record!("seed");
    for _ in 0..50 {
        notebook.splice_source("cell-0", 0, 0, "λ")?;
        record!("edit");
    }
    for i in 0..50 {
        runtime.append_output(
            "execution-probe",
            &json!({
                "output_id": format!("output-{i}"), "output_type": "stream", "name": "stdout",
                "text": format!("Generated output {i}: {}", "x".repeat(256))
            }),
        )?;
        record!("output");
    }
    for i in 0..20 {
        comms.set_comm_state_property("probe-widget", "value", &json!(i))?;
        comments.create_thread(
            &format!("thread-{i}"),
            &format!("message-{i}"),
            &CommentAnchor::Notebook,
            &format!("Generated comment {i}"),
            None,
            "2026-10-17T00:00:00Z",
        )?;
        record!("widget-comment");
    }
    for _ in 0..50 {
        record!("unchanged");
    }
    println!("{}", serde_json::to_string(&records)?);
    Ok(())
}
