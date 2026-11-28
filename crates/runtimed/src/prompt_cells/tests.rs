#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Coordinator tests against an in-process room. The prompt agent is played
//! by the tests: they claim a dispatched execution (mark it running), write
//! the answer output and the terminal status the way the real agent does.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::cells::{
    answer_execution_id, answer_is_streaming, answer_prompt_cell_id, prompt_response_metadata,
};
use notebook_doc::CellSnapshot;
use serde_json::{json, Value};

use super::accept::{accept_prompt_cell, Accepted};
use super::answer::extract_answer;
use super::*;
use crate::blob_store::BlobStore;

const PROMPT_TEXT: &str = "what is x?";

fn test_room() -> (tempfile::TempDir, Arc<NotebookRoom>) {
    let tmp = tempfile::TempDir::new().unwrap();
    let room = Arc::new(NotebookRoom::new_fresh(
        uuid::Uuid::new_v4(),
        None,
        tmp.path(),
        Arc::new(BlobStore::new(tmp.path().join("blobs"))),
        false,
    ));
    (tmp, room)
}

/// Ensurer that counts calls and succeeds or fails on demand.
fn ensurer(result: Result<(), String>) -> (AgentEnsurer, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let ensurer: AgentEnsurer = Arc::new(move |_room| {
        counter.fetch_add(1, Ordering::SeqCst);
        let result = result.clone();
        Box::pin(async move { result })
    });
    (ensurer, calls)
}

/// `code-1`, `prompt-1`, `code-2` (in that order).
async fn add_notebook(room: &NotebookRoom) {
    let mut doc = room.doc.write().await;
    doc.add_cell(0, "code-1", "code").unwrap();
    doc.update_source("code-1", "x = 1").unwrap();
    add_prompt(&mut doc, 1, "prompt-1", PROMPT_TEXT);
    doc.add_cell(2, "code-2", "code").unwrap();
}

fn add_prompt(doc: &mut notebook_doc::NotebookDoc, index: usize, id: &str, text: &str) {
    doc.add_cell(index, id, "raw").unwrap();
    doc.update_source(id, text).unwrap();
    doc.set_cell_metadata(id, &json!({"nteract": {"prompt": {}}}))
        .unwrap();
}

async fn cells(room: &NotebookRoom) -> Vec<CellSnapshot> {
    room.doc.read().await.get_cells()
}

async fn cell_ids(room: &NotebookRoom) -> Vec<String> {
    cells(room).await.into_iter().map(|c| c.id).collect()
}

async fn queue(room: &Arc<NotebookRoom>, ensurer: &AgentEnsurer, cell_id: &str) -> String {
    match queue_prompt_cell(room, ensurer, cell_id, None, None, Some("test:actor")).await {
        NotebookResponse::CellQueued { execution_id, .. } => execution_id,
        other => panic!("expected CellQueued, got {other:?}"),
    }
}

async fn wait_until<F: Fn() -> bool>(what: &str, condition: F) {
    for _ in 0..250 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

fn exec(room: &NotebookRoom, eid: &str) -> Option<runtime_doc::ExecutionState> {
    room.state.read(|sd| sd.get_execution(eid)).unwrap()
}

/// Prompt executions the agent may claim: queued with a context.
fn dispatched_ids(room: &NotebookRoom) -> Vec<String> {
    room.state
        .read(|sd| {
            sd.get_prompt_executions("queued")
                .into_iter()
                .filter(|(_, execution)| execution.context_blob.is_some())
                .map(|(id, _)| id)
                .collect()
        })
        .unwrap()
}

async fn wait_dispatched(room: &Arc<NotebookRoom>, eid: &str) {
    wait_until("dispatch to the agent", || {
        dispatched_ids(room).iter().any(|id| id == eid)
    })
    .await;
}

fn stops(room: &NotebookRoom, eid: &str) -> u64 {
    exec(room, eid).unwrap().stop_requested
}

fn markdown_output(text: &str, stopped: bool) -> Value {
    let metadata = if stopped {
        json!({"nteract": {"prompt_stopped": true}})
    } else {
        json!({})
    };
    json!({
        "output_type": "display_data",
        "output_id": "answer-output",
        "data": {"text/markdown": {"inline": text}},
        "metadata": metadata,
    })
}

/// Play the agent: claim, run, write the answer, finish.
fn agent_run(room: &NotebookRoom, eid: &str, output: Option<Value>, success: bool) {
    agent_claim(room, eid);
    agent_finish(room, eid, output, success);
}

fn agent_claim(room: &NotebookRoom, eid: &str) {
    assert_eq!(dispatched_ids(room).first().map(String::as_str), Some(eid));
    room.state
        .with_doc(|sd| sd.set_execution_running(eid))
        .unwrap();
}

fn agent_finish(room: &NotebookRoom, eid: &str, output: Option<Value>, success: bool) {
    room.state
        .with_doc(|sd| {
            if let Some(output) = &output {
                sd.append_output(eid, output)?;
            }
            sd.set_execution_done(eid, success)
        })
        .unwrap();
}

const ANSWER: &str = "Here is code:\n\n```{code-cell} python\nprint(42)\n```\nDone.";

// ── accept ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn accept_creates_prompt_execution_pointer_and_placeholder() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;

    let Accepted::Queued {
        execution_id,
        waiting_on,
        ..
    } = accept_prompt_cell(&room, "prompt-1", None, None, Some("test:actor")).await
    else {
        panic!("expected Queued");
    };
    assert!(waiting_on.is_empty());

    let execution = exec(&room, &execution_id).unwrap();
    assert_eq!(execution.status, "queued");
    assert_eq!(execution.capability.as_deref(), Some("prompt"));
    assert_eq!(execution.cell_id.as_deref(), Some("prompt-1"));
    assert_eq!(execution.source.as_deref(), Some(PROMPT_TEXT));
    assert_eq!(
        execution.submitted_by_actor_label.as_deref(),
        Some("test:actor")
    );

    let doc = room.doc.read().await;
    assert_eq!(doc.get_execution_id("prompt-1"), Some(execution_id.clone()));
    let all = doc.get_cells();
    let ids: Vec<&str> = all.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(ids[0], "code-1");
    assert_eq!(ids[1], "prompt-1");
    assert_eq!(ids[3], "code-2");
    let placeholder = &all[2];
    assert_eq!(placeholder.cell_type, "markdown");
    assert_eq!(placeholder.source, "");
    assert!(answer_is_streaming(placeholder));
    assert_eq!(
        answer_prompt_cell_id(placeholder).as_deref(),
        Some("prompt-1")
    );
    assert_eq!(answer_execution_id(placeholder), Some(execution_id));
    // The kernel never sees it.
    assert!(room
        .state
        .read(|sd| sd.get_queued_executions())
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn accept_deletes_all_old_answers_including_edited_ones() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(2, "old-a", "markdown").unwrap();
        doc.set_cell_metadata(
            "old-a",
            &prompt_response_metadata("prompt-1", "old", 0, false, false),
        )
        .unwrap();
        doc.add_cell(3, "old-b", "code").unwrap();
        doc.update_source("old-b", "edited_by_user()").unwrap();
        doc.set_cell_metadata(
            "old-b",
            &prompt_response_metadata("prompt-1", "old", 1, false, false),
        )
        .unwrap();
        // An answer of a different prompt stays.
        doc.add_cell(4, "other", "markdown").unwrap();
        doc.set_cell_metadata(
            "other",
            &prompt_response_metadata("prompt-9", "x", 0, false, false),
        )
        .unwrap();
    }
    let Accepted::Queued { .. } = accept_prompt_cell(&room, "prompt-1", None, None, None).await
    else {
        panic!("expected Queued");
    };
    let ids = cell_ids(&room).await;
    assert!(!ids.contains(&"old-a".to_string()));
    assert!(!ids.contains(&"old-b".to_string()));
    assert!(ids.contains(&"other".to_string()));
    let all = cells(&room).await;
    let prompt_index = all.iter().position(|c| c.id == "prompt-1").unwrap();
    assert!(answer_is_streaming(&all[prompt_index + 1]));
}

#[tokio::test]
async fn accept_while_active_returns_already_active_and_non_prompt_cells_error() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let Accepted::Queued { execution_id, .. } =
        accept_prompt_cell(&room, "prompt-1", None, None, None).await
    else {
        panic!("expected Queued");
    };
    match accept_prompt_cell(&room, "prompt-1", None, None, None).await {
        Accepted::AlreadyActive {
            execution_id: again,
        } => assert_eq!(again, execution_id),
        _ => panic!("expected AlreadyActive"),
    }
    // Only one placeholder.
    let placeholders = cells(&room)
        .await
        .iter()
        .filter(|c| answer_is_streaming(c))
        .count();
    assert_eq!(placeholders, 1);

    assert!(matches!(
        accept_prompt_cell(&room, "code-1", None, None, None).await,
        Accepted::Response(_)
    ));
    assert!(matches!(
        accept_prompt_cell(&room, "missing", None, None, None).await,
        Accepted::Response(_)
    ));
}

#[tokio::test]
async fn accept_computes_waiting_on_from_active_cells_above() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "done-cell", "code").unwrap();
        doc.set_execution_id("done-cell", Some("exec-done"))
            .unwrap();
        doc.set_execution_id("code-1", Some("exec-active")).unwrap();
        // A running cell below the prompt does not matter.
        doc.set_execution_id("code-2", Some("exec-below")).unwrap();
    }
    room.state
        .with_doc(|sd| {
            for (id, cell) in [
                ("exec-done", "done-cell"),
                ("exec-active", "code-1"),
                ("exec-below", "code-2"),
            ] {
                sd.create_execution_with_source_provenance(id, "", 1, None, Some(cell))?;
            }
            sd.set_execution_done("exec-done", true)
        })
        .unwrap();
    let Accepted::Queued { waiting_on, .. } =
        accept_prompt_cell(&room, "prompt-1", None, None, None).await
    else {
        panic!("expected Queued");
    };
    assert_eq!(waiting_on, BTreeSet::from(["exec-active".to_string()]));
}

#[tokio::test]
async fn accept_waits_on_a_prompt_above_that_is_terminal_but_not_finalized() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    {
        let mut doc = room.doc.write().await;
        add_prompt(&mut doc, 4, "prompt-2", "and then?");
    }
    // `prompt-1` ended, but its streaming placeholder is still there.
    let Accepted::Queued {
        execution_id: first,
        ..
    } = accept_prompt_cell(&room, "prompt-1", None, None, None).await
    else {
        panic!("expected Queued");
    };
    room.state
        .with_doc(|sd| sd.set_execution_done(&first, true))
        .unwrap();
    let Accepted::Queued { waiting_on, .. } =
        accept_prompt_cell(&room, "prompt-2", None, None, None).await
    else {
        panic!("expected Queued");
    };
    assert_eq!(waiting_on, BTreeSet::from([first]));
}

// ── dispatch ────────────────────────────────────────────────────────────

#[tokio::test]
async fn dispatch_builds_the_context_blob() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "skipped", "code").unwrap();
        doc.update_source("skipped", "secret = 1").unwrap();
        doc.set_cell_metadata("skipped", &json!({"nteract": {"context_exclude": true}}))
            .unwrap();
        doc.set_execution_id("code-1", Some("exec-code-1")).unwrap();
    }
    let blob_hash = room
        .blob_store
        .put(b"line from a blob", "text/plain")
        .await
        .unwrap();
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source_provenance("exec-code-1", "x = 1", 1, None, Some("code-1"))?;
            sd.append_output(
                "exec-code-1",
                &json!({"output_type": "stream", "output_id": "s1", "name": "stdout", "text": {"inline": "1\n"}}),
            )?;
            sd.append_output(
                "exec-code-1",
                &json!({"output_type": "display_data", "output_id": "d1",
                    "data": {"text/plain": {"blob": blob_hash, "size": 16}}, "metadata": {}}),
            )?;
            sd.set_execution_done("exec-code-1", true)
        })
        .unwrap();

    let (ensurer, ensure_calls) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;
    wait_until("agent ensured", || ensure_calls.load(Ordering::SeqCst) == 1).await;

    let execution = exec(&room, &eid).unwrap();
    assert_eq!(execution.status, "queued");
    let hash = execution.context_blob.clone().expect("context blob");
    let context = String::from_utf8(room.blob_store.get(&hash).await.unwrap().unwrap()).unwrap();
    assert!(context.starts_with("<notebook"), "{context}");
    assert!(
        context.contains("<cell id=\"code-1\" type=\"code\">\nx = 1\n</cell>"),
        "{context}"
    );
    assert!(
        context.contains("<output cell=\"code-1\">\n1\n\n</output>"),
        "{context}"
    );
    assert!(context.contains("line from a blob"), "{context}");
    assert!(
        !context.contains("secret = 1"),
        "excluded cell leaked: {context}"
    );
    assert!(
        context.ends_with(&format!("</notebook>\n\n{PROMPT_TEXT}")),
        "{context}"
    );
    assert!(!context.contains("streaming"), "{context}");

    assert_eq!(dispatched_ids(&room), vec![eid]);
}

#[tokio::test]
async fn dispatch_failure_records_error_and_deletes_placeholder() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Err("Could not start the prompt agent: nope".into()));
    let eid = queue(&room, &ensurer, "prompt-1").await;

    wait_until("execution error", || {
        exec(&room, &eid).is_some_and(|e| e.status == "error")
    })
    .await;
    let execution = exec(&room, &eid).unwrap();
    assert_eq!(execution.success, Some(false));
    assert_eq!(execution.outputs[0]["ename"], "PromptError");
    assert!(execution.outputs[0]["evalue"]
        .as_str()
        .unwrap()
        .contains("nope"));
    assert!(dispatched_ids(&room).is_empty());
    wait_until("placeholder removed", || {
        room.doc
            .try_read()
            .map(|d| !d.get_cells().iter().any(answer_is_streaming))
            .unwrap_or(false)
    })
    .await;
}

#[tokio::test]
async fn waiting_prompt_dispatches_after_the_kernel_cell_finishes() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    room.doc
        .write()
        .await
        .set_execution_id("code-1", Some("exec-code-1"))
        .unwrap();
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source_provenance(
                "exec-code-1",
                "x = 1",
                1,
                None,
                Some("code-1"),
            )
        })
        .unwrap();

    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        dispatched_ids(&room).is_empty(),
        "must wait for the cell above"
    );
    assert!(exec(&room, &eid).unwrap().context_blob.is_none());

    room.state
        .with_doc(|sd| {
            sd.append_output(
                "exec-code-1",
                &json!({"output_type": "stream", "output_id": "s1", "name": "stdout", "text": {"inline": "late output\n"}}),
            )?;
            sd.set_execution_done("exec-code-1", true)
        })
        .unwrap();
    wait_dispatched(&room, &eid).await;
    let hash = exec(&room, &eid).unwrap().context_blob.unwrap();
    let context = String::from_utf8(room.blob_store.get(&hash).await.unwrap().unwrap()).unwrap();
    assert!(context.contains("late output"), "{context}");
}

// ── finalize ────────────────────────────────────────────────────────────

#[tokio::test]
async fn finalize_splits_markdown_and_code_at_the_placeholder_position() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;
    agent_run(&room, &eid, Some(markdown_output(ANSWER, false)), true);

    wait_until("answer cells", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().len() == 6 && !d.get_cells().iter().any(answer_is_streaming))
            .unwrap_or(false)
    })
    .await;
    let all = cells(&room).await;
    let ids: Vec<&str> = all.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids[0], "code-1");
    assert_eq!(ids[1], "prompt-1");
    assert_eq!(ids[5], "code-2");
    let answers = &all[2..5];
    assert_eq!(
        answers
            .iter()
            .map(|c| c.cell_type.as_str())
            .collect::<Vec<_>>(),
        ["markdown", "code", "markdown"]
    );
    assert_eq!(answers[0].source, "Here is code:");
    assert_eq!(answers[1].source, "print(42)");
    assert_eq!(answers[2].source, "Done.");
    for (index, cell) in answers.iter().enumerate() {
        assert_eq!(answer_prompt_cell_id(cell).as_deref(), Some("prompt-1"));
        assert_eq!(answer_execution_id(cell).as_deref(), Some(eid.as_str()));
        assert!(!answer_is_streaming(cell));
        let response = &cell.metadata["nteract"]["prompt_response"];
        assert_eq!(response["part"], index);
        assert!(response.get("stopped").is_none());
    }
    // The prompt cell keeps the execution pointer.
    assert_eq!(
        room.doc.read().await.get_execution_id("prompt-1"),
        Some(eid)
    );
}

#[tokio::test]
async fn finalize_marks_stopped_answers_and_reads_blob_backed_text() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;

    let hash = room
        .blob_store
        .put(b"partial answer", "text/markdown")
        .await
        .unwrap();
    let output = json!({
        "output_type": "display_data", "output_id": "o",
        "data": {"text/markdown": {"blob": hash, "size": 14}},
        "metadata": {"nteract": {"prompt_stopped": true}},
    });
    agent_run(&room, &eid, Some(output), false);

    wait_until("stopped answer", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().iter().any(|c| c.source == "partial answer"))
            .unwrap_or(false)
    })
    .await;
    let all = cells(&room).await;
    let answer = all.iter().find(|c| c.source == "partial answer").unwrap();
    assert_eq!(
        answer.metadata["nteract"]["prompt_response"]["stopped"],
        true
    );
    assert!(!all.iter().any(answer_is_streaming));
}

#[tokio::test]
async fn finalize_error_without_text_deletes_placeholder_and_keeps_the_error() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;
    let error = json!({"output_type": "error", "output_id": "e", "ename": "PromptError",
        "evalue": "not logged in", "traceback": []});
    agent_run(&room, &eid, Some(error), false);

    wait_until("placeholder deleted", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().len() == 3)
            .unwrap_or(false)
    })
    .await;
    assert_eq!(cell_ids(&room).await, ["code-1", "prompt-1", "code-2"]);
    assert_eq!(
        exec(&room, &eid).unwrap().outputs[0]["evalue"],
        "not logged in"
    );
}

#[tokio::test]
async fn finalize_writes_nothing_when_the_user_deleted_the_placeholder() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;
    {
        let mut doc = room.doc.write().await;
        let placeholder = doc
            .get_cells()
            .into_iter()
            .find(answer_is_streaming)
            .unwrap();
        doc.delete_cell(&placeholder.id).unwrap();
    }
    agent_run(&room, &eid, Some(markdown_output(ANSWER, false)), true);
    // Let the coordinator observe the terminal status.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(cell_ids(&room).await, ["code-1", "prompt-1", "code-2"]);
}

/// A finalize that fails (here: the durability boundary is closed) must not
/// leave the placeholder streaming for good: the coordinator retries on its
/// next scan.
#[tokio::test]
async fn a_failed_finalize_is_retried_so_the_placeholder_does_not_stay_streaming() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;

    room.durability.freeze_commits();
    agent_run(
        &room,
        &eid,
        Some(markdown_output("Just prose.", false)),
        true,
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(cells(&room).await.iter().any(answer_is_streaming));

    room.durability.thaw_commits();
    // Any state change makes the coordinator scan again.
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source_provenance("nudge", "", 1, None, Some("code-1"))
        })
        .unwrap();
    wait_until("answer written on retry", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().iter().any(|c| c.source == "Just prose."))
            .unwrap_or(false)
    })
    .await;
    assert!(!cells(&room).await.iter().any(answer_is_streaming));
}

/// A prompt whose finalize failed still counts as unfinished for a prompt
/// below it: that one must not dispatch without the earlier answer.
#[tokio::test]
async fn a_waiter_whose_finalize_failed_is_not_settled() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    {
        let mut doc = room.doc.write().await;
        add_prompt(&mut doc, 4, "prompt-2", "and then?");
    }
    let (ensurer, _) = ensurer(Ok(()));
    let first = queue(&room, &ensurer, "prompt-1").await;
    let second = queue(&room, &ensurer, "prompt-2").await;
    wait_dispatched(&room, &first).await;

    room.durability.freeze_commits();
    agent_run(&room, &first, Some(markdown_output(ANSWER, false)), true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        exec(&room, &second).unwrap().context_blob.is_none(),
        "the prompt below waits for the earlier answer cells"
    );

    room.durability.thaw_commits();
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source_provenance("nudge", "", 1, None, Some("code-1"))
        })
        .unwrap();
    wait_dispatched(&room, &second).await;
    let hash = exec(&room, &second).unwrap().context_blob.unwrap();
    let context = String::from_utf8(room.blob_store.get(&hash).await.unwrap().unwrap()).unwrap();
    assert!(context.contains("print(42)"), "{context}");
}

#[tokio::test]
async fn finalize_inserts_where_a_moved_placeholder_is() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;
    let placeholder_id = {
        let mut doc = room.doc.write().await;
        let placeholder = doc
            .get_cells()
            .into_iter()
            .find(answer_is_streaming)
            .unwrap();
        // Move it to the very end.
        doc.move_cell(&placeholder.id, Some("code-2")).unwrap();
        placeholder.id
    };
    agent_run(
        &room,
        &eid,
        Some(markdown_output("Just prose.", false)),
        true,
    );
    wait_until("moved answer", || {
        room.doc
            .try_read()
            .map(|d| d.get_cell(&placeholder_id).is_none())
            .unwrap_or(false)
    })
    .await;
    assert_eq!(
        cells(&room).await.last().unwrap().source,
        "Just prose.",
        "answer lands where the placeholder was"
    );
}

#[tokio::test]
async fn a_prompt_below_another_sees_the_finished_answer_not_the_placeholder() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    {
        let mut doc = room.doc.write().await;
        add_prompt(&mut doc, 4, "prompt-2", "and then?");
    }
    let (ensurer, _) = ensurer(Ok(()));
    let first = queue(&room, &ensurer, "prompt-1").await;
    let second = queue(&room, &ensurer, "prompt-2").await;
    wait_dispatched(&room, &first).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        dispatched_ids(&room),
        vec![first.clone()],
        "second waits on the first"
    );

    agent_run(&room, &first, Some(markdown_output(ANSWER, false)), true);
    wait_dispatched(&room, &second).await;
    let hash = exec(&room, &second).unwrap().context_blob.unwrap();
    let context = String::from_utf8(room.blob_store.get(&hash).await.unwrap().unwrap()).unwrap();
    assert!(context.contains("type=\"answer\""), "{context}");
    assert!(context.contains("print(42)"), "{context}");
    assert!(context.contains("type=\"prompt\""), "{context}");
    // The earlier prompt's streamed text reaches the model once, as the answer
    // cells; its execution outputs are not repeated.
    assert_eq!(context.matches("print(42)").count(), 1, "{context}");
    assert!(!context.contains("<output cell=\"prompt-1\">"), "{context}");
}

#[tokio::test]
async fn extract_answer_reads_the_first_markdown_output_and_ignores_others() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blobs = BlobStore::new(tmp.path().join("blobs"));
    let manifests = vec![
        json!({"output_type": "stream", "name": "stdout", "text": {"inline": "ignored"}}),
        markdown_output("one", true),
        markdown_output("two", false),
    ];
    let answer = extract_answer(&manifests, &blobs).await;
    assert_eq!(answer.text.as_deref(), Some("one"));
    assert!(answer.stopped);
    assert_eq!(extract_answer(&[], &blobs).await.text, None);
}

#[tokio::test]
async fn text_next_to_a_prompt_error_counts_as_stopped() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blobs = BlobStore::new(tmp.path().join("blobs"));
    let error = json!({"output_type": "error", "ename": "PromptError", "evalue": "gone"});
    let with_text = extract_answer(&[markdown_output("half", false), error.clone()], &blobs).await;
    assert!(with_text.stopped);
    let without_text = extract_answer(&[error], &blobs).await;
    assert!(!without_text.stopped && without_text.text.is_none());
}

// ── interrupt ───────────────────────────────────────────────────────────

#[tokio::test]
async fn interrupt_pending_cancels_without_dispatching() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    room.doc
        .write()
        .await
        .set_execution_id("code-1", Some("exec-code-1"))
        .unwrap();
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source_provenance("exec-code-1", "x", 1, None, Some("code-1"))
        })
        .unwrap();
    let (ensurer, ensure_calls) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;

    assert!(matches!(
        interrupt_prompt(&room, "prompt-1").await,
        NotebookResponse::InterruptSent {}
    ));
    assert_eq!(exec(&room, &eid).unwrap().status, "cancelled");
    wait_until("placeholder removed", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().len() == 3)
            .unwrap_or(false)
    })
    .await;

    // The cell above finishing must not dispatch the cancelled prompt.
    room.state
        .with_doc(|sd| sd.set_execution_done("exec-code-1", true))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(dispatched_ids(&room).is_empty());
    assert_eq!(ensure_calls.load(Ordering::SeqCst), 0);
    // Kernel executions are untouched.
    assert_eq!(exec(&room, "exec-code-1").unwrap().status, "done");
}

/// After dispatch only the agent moves the execution out of `queued`: the
/// daemon records the Stop and leaves the status alone; the agent cancels
/// it, and the coordinator then removes the placeholder.
#[tokio::test]
async fn interrupt_dispatched_leaves_the_cancel_to_the_agent() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;

    assert!(matches!(
        interrupt_prompt(&room, "prompt-1").await,
        NotebookResponse::InterruptSent {}
    ));
    assert_eq!(stops(&room, &eid), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        exec(&room, &eid).unwrap().status,
        "queued",
        "the daemon never cancels a dispatched execution"
    );
    assert!(cells(&room).await.iter().any(answer_is_streaming));

    // The agent sees the Stop on a run it has not claimed and cancels it.
    room.state
        .with_doc(|sd| sd.set_execution_cancelled(&eid))
        .unwrap();
    wait_until("placeholder removed", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().len() == 3)
            .unwrap_or(false)
    })
    .await;
}

/// Stop is state: each Stop on a running prompt raises its count (the agent
/// interrupts on 1 and kills on 2) without changing its status.
#[tokio::test]
async fn interrupt_running_records_each_stop_and_a_second_one_escalates() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let (ensurer, _) = ensurer(Ok(()));
    let eid = queue(&room, &ensurer, "prompt-1").await;
    wait_dispatched(&room, &eid).await;
    agent_claim(&room, &eid);

    for expected in [1, 2] {
        assert!(matches!(
            interrupt_prompt(&room, "prompt-1").await,
            NotebookResponse::InterruptSent {}
        ));
        assert_eq!(stops(&room, &eid), expected);
    }
    // Still running: the agent ends it, the coordinator then finalizes.
    assert_eq!(exec(&room, &eid).unwrap().status, "running");
    agent_finish(&room, &eid, Some(markdown_output("partial", true)), false);
    wait_until("partial kept", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().iter().any(|c| c.source == "partial"))
            .unwrap_or(false)
    })
    .await;

    // A late Stop for the finished run changes nothing.
    assert!(matches!(
        interrupt_prompt(&room, "prompt-1").await,
        NotebookResponse::InterruptSent {}
    ));
    assert_eq!(stops(&room, &eid), 2);
}

/// Stop while the dispatch task is still ensuring the agent, after the agent
/// already claimed the run: the run is finalized only after the agent ended
/// it, so the partial text it bound is kept (and marked stopped).
#[tokio::test]
async fn interrupt_while_dispatching_keeps_the_partial_text_the_agent_wrote() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let blocked: AgentEnsurer = {
        let gate = Arc::clone(&gate);
        Arc::new(move |_room| {
            let gate = Arc::clone(&gate);
            Box::pin(async move {
                gate.notified().await;
                Ok(())
            })
        })
    };
    let eid = queue(&room, &blocked, "prompt-1").await;
    wait_dispatched(&room, &eid).await;
    // The agent claims the run and streams some text.
    agent_claim(&room, &eid);
    room.state
        .with_doc(|sd| {
            sd.append_output(&eid, &markdown_output("partial", false))
                .map(|_| ())
        })
        .unwrap();

    assert!(matches!(
        interrupt_prompt(&room, "prompt-1").await,
        NotebookResponse::InterruptSent {}
    ));
    assert_eq!(stops(&room, &eid), 1, "the running agent sees the stop");
    // The agent ends the run with its final, stopped text; the dispatch task
    // is still blocked. Nothing is finalized yet.
    agent_finish(
        &room,
        &eid,
        Some(markdown_output("partial text", true)),
        false,
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        cells(&room).await.iter().any(answer_is_streaming),
        "no finalize before the dispatch outcome"
    );

    gate.notify_one();
    wait_until("stopped partial kept", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().iter().any(|c| c.source == "partial text"))
            .unwrap_or(false)
    })
    .await;
    let all = cells(&room).await;
    let answer = all.iter().find(|c| c.source == "partial text").unwrap();
    assert_eq!(
        answer.metadata["nteract"]["prompt_response"]["stopped"],
        true
    );
    assert!(!all.iter().any(answer_is_streaming));
}

#[tokio::test]
async fn interrupt_without_a_coordinator_stops_the_pointed_execution() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_capability("e-x", "q", 1, None, Some("prompt-1"), "prompt")?;
            sd.set_execution_context("e-x", "hash")
        })
        .unwrap();
    room.doc
        .write()
        .await
        .set_execution_id("prompt-1", Some("e-x"))
        .unwrap();
    assert!(matches!(
        interrupt_prompt(&room, "prompt-1").await,
        NotebookResponse::InterruptSent {}
    ));
    // Dispatched: the Stop is recorded for the agent, which cancels it.
    let execution = exec(&room, "e-x").unwrap();
    assert_eq!(execution.status, "queued");
    assert_eq!(execution.stop_requested, 1);
}

#[test]
fn the_prompt_error_manifest_is_a_valid_inline_error_manifest() {
    let manifest = prompt_error_manifest("boom");
    let parsed: crate::output_store::OutputManifest =
        serde_json::from_value(manifest).expect("valid manifest");
    match parsed {
        crate::output_store::OutputManifest::Error {
            ename,
            evalue,
            traceback,
            ..
        } => {
            assert_eq!(ename, PROMPT_ERROR_ENAME);
            assert_eq!(evalue, "boom");
            assert!(matches!(
                traceback,
                crate::output_store::ContentRef::Inline { .. }
            ));
        }
        other => panic!("expected an error manifest, got {other:?}"),
    }
}

// ── routing, sweep ──────────────────────────────────────────────────────

#[tokio::test]
async fn stale_placeholders_are_finalized_or_deleted_when_the_coordinator_starts() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    {
        let mut doc = room.doc.write().await;
        // Execution missing entirely (daemon restart): deleted.
        doc.add_cell(2, "ph-missing", "markdown").unwrap();
        doc.set_cell_metadata(
            "ph-missing",
            &prompt_response_metadata("prompt-1", "gone", 0, true, false),
        )
        .unwrap();
        // Execution terminal with text: finalized.
        doc.add_cell(3, "ph-text", "markdown").unwrap();
        doc.set_cell_metadata(
            "ph-text",
            &prompt_response_metadata("prompt-1", "term", 0, true, false),
        )
        .unwrap();
        // Execution still running and dispatched: left alone.
        doc.add_cell(4, "ph-live", "markdown").unwrap();
        doc.set_cell_metadata(
            "ph-live",
            &prompt_response_metadata("prompt-1", "live", 0, true, false),
        )
        .unwrap();
    }
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_capability("term", "q", 1, None, Some("prompt-1"), "prompt")?;
            sd.append_output("term", &markdown_output("Recovered text.", false))?;
            sd.set_execution_done("term", true)?;
            sd.create_execution_with_capability("live", "q", 2, None, Some("prompt-1"), "prompt")?;
            sd.set_execution_context("live", "hash")?;
            sd.set_execution_running("live")
        })
        .unwrap();

    let (ensurer, _) = ensurer(Ok(()));
    let _tx = ensure_coordinator(&room, &ensurer);
    wait_until("sweep", || {
        room.doc
            .try_read()
            .map(|d| {
                let all = d.get_cells();
                !all.iter().any(|c| c.id == "ph-missing")
                    && !all.iter().any(|c| c.id == "ph-text")
                    && all.iter().any(|c| c.source == "Recovered text.")
            })
            .unwrap_or(false)
    })
    .await;
    let all = cells(&room).await;
    let live = all.iter().find(|c| c.id == "ph-live").unwrap();
    assert!(answer_is_streaming(live));

    // The adopted live run is finalized once it ends.
    agent_finish(
        &room,
        "live",
        Some(markdown_output("Live done.", false)),
        true,
    );
    wait_until("adopted run finalized", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().iter().any(|c| c.source == "Live done."))
            .unwrap_or(false)
    })
    .await;
}

/// A new coordinator adopts a live run that was never dispatched (its
/// coordinator died, or its `Accepted` is still in flight): it waits on what
/// is active above it and then dispatches as usual.
#[tokio::test]
async fn a_new_coordinator_adopts_an_undispatched_run() {
    let (_tmp, room) = test_room();
    add_notebook(&room).await;
    room.doc
        .write()
        .await
        .set_execution_id("code-1", Some("exec-code-1"))
        .unwrap();
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source_provenance("exec-code-1", "x", 1, None, Some("code-1"))
        })
        .unwrap();
    // Accepted, but no coordinator ever heard of it.
    let Accepted::Queued {
        execution_id: eid, ..
    } = accept_prompt_cell(&room, "prompt-1", None, None, None).await
    else {
        panic!("expected Queued");
    };

    let (ensurer, _) = ensurer(Ok(()));
    let _tx = ensure_coordinator(&room, &ensurer);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(dispatched_ids(&room).is_empty(), "waits on the cell above");

    room.state
        .with_doc(|sd| sd.set_execution_done("exec-code-1", true))
        .unwrap();
    wait_dispatched(&room, &eid).await;
    agent_run(&room, &eid, Some(markdown_output("Adopted.", false)), true);
    wait_until("adopted run finalized", || {
        room.doc
            .try_read()
            .map(|d| d.get_cells().iter().any(|c| c.source == "Adopted."))
            .unwrap_or(false)
    })
    .await;
}

#[tokio::test]
async fn ensure_coordinator_restarts_after_the_task_ended() {
    let (_tmp, room) = test_room();
    let (ensurer, _) = ensurer(Ok(()));
    let first = ensure_coordinator(&room, &ensurer);
    assert!(!first.is_closed());
    // Room teardown takes the sender: all strong senders drop, the task ends.
    drop(room.prompt_coordinator.lock().unwrap().take());
    drop(first);
    let second = ensure_coordinator(&room, &ensurer);
    assert!(!second.is_closed());
    assert!(room.prompt_coordinator.lock().unwrap().is_some());
}
