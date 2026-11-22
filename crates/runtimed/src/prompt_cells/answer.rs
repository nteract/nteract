//! Answer binding: turns a finished prompt execution into answer cells.
//!
//! While a prompt runs, a streaming placeholder cell (an empty markdown cell
//! with `prompt_response.streaming == true`) sits right below the prompt.
//! When the execution is terminal the coordinator replaces the placeholder
//! with the shaped answer (prose -> markdown cells, `{code-cell}` fences ->
//! code cells), or deletes it when the run produced no text (R10). A
//! placeholder the user deleted is not recreated (R11); one the user moved
//! keeps its place (the answer lands where the placeholder is).

use super::cells::{
    answer_execution_id, answer_is_streaming, answer_prompt_cell_id, prompt_response_metadata,
};
use super::shape::{shape_answer, AnswerPart};
use loro_fractional_index::FractionalIndex;
use notebook_doc::{CellSnapshot, NotebookDoc};
use serde_json::Value;
use tracing::debug;

use crate::blob_store::BlobStore;
use crate::notebook_sync_server::durability::commit_daemon_notebook_mutation;
use crate::notebook_sync_server::NotebookRoom;

/// Actor label for coordinator writes to the NotebookDoc.
pub(crate) const PROMPT_ACTOR: &str = "runtimed:prompt";

/// The text and stop marker of a prompt execution's outputs.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct AnswerText {
    pub text: Option<String>,
    pub stopped: bool,
}

/// Read the answer markdown from an execution's output manifests: the
/// `text/markdown` of the first `display_data` output (inline or blob-backed),
/// the one the prompt agent rewrites in place. `stopped` is set when that
/// output carries `metadata.nteract.prompt_stopped`, or when text exists next
/// to a `PromptError` output: that is a run cut short by an agent crash,
/// disconnect or teardown, so its text is partial.
pub(crate) async fn extract_answer(manifests: &[Value], blob_store: &BlobStore) -> AnswerText {
    let answer = manifests.iter().find_map(|manifest| {
        if manifest["output_type"] != "display_data" {
            return None;
        }
        Some((manifest, manifest.get("data")?.get("text/markdown")?))
    });
    let text = match answer {
        Some((_, content)) => content_text(content, blob_store).await,
        None => None,
    };
    let marked_stopped = answer.is_some_and(|(manifest, _)| {
        manifest.pointer("/metadata/nteract/prompt_stopped") == Some(&Value::Bool(true))
    });
    let prompt_error = manifests.iter().any(|manifest| {
        manifest["output_type"] == "error" && manifest["ename"] == super::PROMPT_ERROR_ENAME
    });
    AnswerText {
        stopped: marked_stopped || (prompt_error && text.is_some()),
        text,
    }
}

async fn content_text(content: &Value, blob_store: &BlobStore) -> Option<String> {
    if let Some(inline) = content.get("inline") {
        return inline.as_str().map(str::to_string);
    }
    let hash = content.get("blob")?.as_str()?;
    let bytes = blob_store.get(hash).await.ok()??;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The streaming placeholder of execution `execution_id`, if present.
pub(crate) fn find_placeholder<'a>(
    cells: &'a [CellSnapshot],
    execution_id: &str,
) -> Option<(usize, &'a CellSnapshot)> {
    cells.iter().enumerate().find(|(_, cell)| {
        answer_is_streaming(cell) && answer_execution_id(cell).as_deref() == Some(execution_id)
    })
}

/// `(prompt_cell_id, execution_id)` of every streaming placeholder.
pub(crate) fn streaming_placeholders(cells: &[CellSnapshot]) -> Vec<(String, String)> {
    cells
        .iter()
        .filter(|cell| answer_is_streaming(cell))
        .filter_map(|cell| Some((answer_prompt_cell_id(cell)?, answer_execution_id(cell)?)))
        .collect()
}

/// Position strictly after `left` and before `right` (or after `left` when
/// `right` is absent or no key fits between).
pub(super) fn position_between(left: &str, right: Option<&str>) -> String {
    let left = FractionalIndex::from_hex_string(left);
    let between = right.and_then(|right| {
        FractionalIndex::new_between(&left, &FractionalIndex::from_hex_string(right))
    });
    between
        .unwrap_or_else(|| FractionalIndex::new_after(&left))
        .to_string()
}

/// Insert `parts` where the placeholder at `placeholder_index` is and delete
/// the placeholder. `cells` is the document's cell list before the change.
pub(crate) fn replace_placeholder(
    doc: &mut NotebookDoc,
    cells: &[CellSnapshot],
    placeholder_index: usize,
    prompt_cell_id: &str,
    execution_id: &str,
    parts: &[AnswerPart],
    stopped: bool,
) -> Result<(), automerge::AutomergeError> {
    let placeholder = &cells[placeholder_index];
    let next_position = cells
        .get(placeholder_index + 1)
        .map(|c| c.position.as_str());
    let mut left = placeholder.position.clone();
    for (index, part) in parts.iter().enumerate() {
        let position = position_between(&left, next_position);
        let metadata =
            prompt_response_metadata(prompt_cell_id, execution_id, index, false, stopped);
        doc.add_cell_full(
            &uuid::Uuid::new_v4().to_string(),
            part.cell_type,
            &position,
            &part.source,
            "null",
            &metadata,
        )?;
        left = position;
    }
    doc.delete_cell(&placeholder.id)?;
    Ok(())
}

/// Finalize a terminal prompt execution into answer cells. Returns how many
/// were written (0 when the run had no text or the user deleted the
/// placeholder).
pub(crate) async fn finalize(
    room: &NotebookRoom,
    prompt_cell_id: &str,
    execution_id: &str,
) -> Result<usize, String> {
    let manifests = room
        .state
        .read(|state| state.get_outputs(execution_id))
        .map_err(|error| format!("read outputs: {error}"))?;
    let answer = extract_answer(&manifests, &room.blob_store).await;

    let mut doc = room.doc.write().await;
    let cells = doc.get_cells();
    let Some((placeholder_index, _)) = find_placeholder(&cells, execution_id) else {
        debug!("[prompt-cells] Placeholder for {execution_id} is gone; writing no answer");
        return Ok(0);
    };
    let runtime = doc.detect_runtime();
    let parts = answer
        .text
        .as_deref()
        .map(|text| shape_answer(text, runtime.as_deref()))
        .unwrap_or_default();

    let rollback_actor = doc.get_actor_id();
    let rollback_snapshot = doc.save();
    let baseline_heads = doc.get_heads();
    doc.transact_at_heads_recovering(
        &baseline_heads,
        Some(PROMPT_ACTOR),
        "prompt-answer",
        |doc| {
            replace_placeholder(
                doc,
                &cells,
                placeholder_index,
                prompt_cell_id,
                execution_id,
                &parts,
                answer.stopped,
            )
        },
    )
    .map_err(|error| format!("write answer cells: {error}"))?;
    commit_daemon_notebook_mutation(
        room,
        &mut doc,
        &baseline_heads,
        &rollback_snapshot,
        &rollback_actor,
        "prompt answer",
    )?;
    drop(doc);
    let _ = room.broadcasts.changed_tx.send(());
    Ok(parts.len())
}
