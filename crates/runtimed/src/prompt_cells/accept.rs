//! Accepting a run request for a prompt cell.
//!
//! Mirrors `queue_cell_if_current` for code cells, minus the kernel: under the
//! NotebookDoc write lock it deletes the previous answers (R12), creates the
//! `capability: "prompt"` execution, stamps the execution pointer on the
//! prompt cell (R2), inserts the streaming placeholder below the prompt and
//! commits. Dispatching to the agent happens later, in the coordinator.

use std::collections::BTreeSet;
use std::sync::Arc;

use super::cells::{answer_prompt_cell_id, is_prompt_cell, prompt_response_metadata};
use notebook_doc::{CellSnapshot, NotebookDoc};
use notebook_protocol::protocol::ExecutionIdRejectionReason;
use runtime_doc::CAPABILITY_PROMPT;
use tracing::{debug, warn};

use super::answer::{position_between, streaming_placeholders, PROMPT_ACTOR};
use crate::notebook_sync_server::durability::commit_daemon_notebook_mutation;
use crate::notebook_sync_server::NotebookRoom;
use crate::protocol::NotebookResponse;
use crate::requests::execute_cell::{
    execution_id_rejected, validate_requested_execution_id, EXECUTION_ID_GENERATION_ATTEMPTS,
};
use crate::requests::guarded;
use crate::requests::trim_runtime_executions_for_doc;

pub(crate) enum Accepted {
    Queued {
        execution_id: String,
        /// Executions of cells above the prompt that were queued or running.
        waiting_on: BTreeSet<String>,
    },
    AlreadyActive {
        execution_id: String,
    },
    Response(Box<NotebookResponse>),
}

fn response(response: NotebookResponse) -> Accepted {
    Accepted::Response(Box::new(response))
}

fn error(message: impl Into<String>) -> Accepted {
    response(NotebookResponse::Error {
        error: message.into(),
    })
}

fn is_active(room: &NotebookRoom, execution_id: &str) -> bool {
    room.state
        .read(|sd| {
            sd.get_execution(execution_id)
                .is_some_and(|exec| exec.is_active())
        })
        .unwrap_or(false)
}

/// The executions the prompt at `prompt_index` waits for: those of cells
/// above it that are still queued or running, so their outputs make it into
/// the context, and the run of every prompt above whose streaming placeholder
/// still exists (terminal but not finalized yet): the coordinator only counts
/// such a waiter as finished once the answer cells replaced the placeholder.
pub(super) fn waiting_on(
    room: &NotebookRoom,
    doc: &NotebookDoc,
    cells: &[CellSnapshot],
    prompt_index: usize,
) -> BTreeSet<String> {
    let above = &cells[..prompt_index];
    let mut waiting_on: BTreeSet<String> = above
        .iter()
        .filter_map(|cell| doc.get_execution_id(&cell.id))
        .filter(|eid| is_active(room, eid))
        .collect();
    waiting_on.extend(
        streaming_placeholders(cells)
            .into_iter()
            .filter(|(prompt_id, _)| above.iter().any(|cell| &cell.id == prompt_id))
            .map(|(_, execution_id)| execution_id),
    );
    waiting_on
}

pub(crate) async fn accept_prompt_cell(
    room: &Arc<NotebookRoom>,
    cell_id: &str,
    requested_execution_id: Option<&str>,
    observed_heads: Option<&[String]>,
    submitter_actor_label: Option<&str>,
) -> Accepted {
    if let Some(execution_id) = requested_execution_id {
        if let Err(reason) = validate_requested_execution_id(execution_id, false) {
            return response(execution_id_rejected(execution_id, reason));
        }
    }

    let mut doc = room.doc.write().await;
    if let Some(observed_heads) = observed_heads {
        if let Err(rejection) = guarded::validate_execute_cell(&mut doc, cell_id, observed_heads) {
            return response(rejection.into_response());
        }
    }

    let cells = doc.get_cells();
    let Some(prompt_index) = cells.iter().position(|cell| cell.id == cell_id) else {
        return error(format!("Cell not found in document: {cell_id}"));
    };
    let prompt = &cells[prompt_index];
    if !is_prompt_cell(prompt) {
        return error(format!("Cell is not a prompt cell: {cell_id}"));
    }

    let current_execution_id = doc.get_execution_id(cell_id);
    if let Some(eid) = current_execution_id.as_ref() {
        if is_active(room, eid) {
            if requested_execution_id.is_some() {
                return error(format!("Cell already has an active execution: {eid}"));
            }
            return Accepted::AlreadyActive {
                execution_id: eid.clone(),
            };
        }
    }

    let waiting_on = waiting_on(room, &doc, &cells, prompt_index);

    let rollback_actor = doc.get_actor_id();
    let rollback_snapshot = doc.save();
    let baseline_heads = doc.get_heads();

    let mut execution_id = requested_execution_id
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut retries = 0usize;
    let seq = room
        .next_queue_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    loop {
        let created = room.state.with_doc(|sd| {
            if sd.get_execution(&execution_id).is_some() {
                return Ok(false);
            }
            sd.create_execution_with_capability(
                &execution_id,
                &prompt.source,
                seq,
                submitter_actor_label,
                Some(cell_id),
                CAPABILITY_PROMPT,
            )
        });
        match created {
            Ok(true) => break,
            Ok(false) if requested_execution_id.is_none() => {
                retries += 1;
                if retries >= EXECUTION_ID_GENERATION_ATTEMPTS {
                    return error("failed to allocate unique execution_id");
                }
                execution_id = uuid::Uuid::new_v4().to_string();
            }
            Ok(false) => {
                return response(execution_id_rejected(
                    execution_id,
                    ExecutionIdRejectionReason::AlreadyExists,
                ));
            }
            Err(e) => {
                remove_execution(room, &execution_id);
                warn!("[prompt-cells] Failed to create execution {execution_id}: {e}");
                return error(format!("failed to queue execution: {e}"));
            }
        }
    }

    // Re-run deletes every earlier answer of this prompt, edited or not (R12).
    let old_answers: Vec<String> = cells
        .iter()
        .filter(|cell| answer_prompt_cell_id(cell).as_deref() == Some(cell_id))
        .map(|cell| cell.id.clone())
        .collect();
    let next_position = cells[prompt_index + 1..]
        .iter()
        .find(|cell| !old_answers.contains(&cell.id))
        .map(|cell| cell.position.as_str());
    let placeholder_position = position_between(&prompt.position, next_position);
    let placeholder_id = uuid::Uuid::new_v4().to_string();
    let metadata = prompt_response_metadata(cell_id, &execution_id, 0, true, false);

    let written = doc.transact_at_heads_recovering(
        &baseline_heads,
        Some(PROMPT_ACTOR),
        "prompt-accept",
        |doc| {
            for answer_id in &old_answers {
                doc.delete_cell(answer_id)?;
            }
            doc.set_execution_id(cell_id, Some(&execution_id))?;
            doc.add_cell_full(
                &placeholder_id,
                "markdown",
                &placeholder_position,
                "",
                "null",
                &metadata,
            )
        },
    );
    if let Err(e) = written {
        remove_execution(room, &execution_id);
        warn!("[prompt-cells] Failed to write accept for {cell_id}: {e}");
        return error(format!("failed to queue prompt: {e}"));
    }
    if let Err(error_message) = commit_daemon_notebook_mutation(
        room,
        &mut doc,
        &baseline_heads,
        &rollback_snapshot,
        &rollback_actor,
        "execute prompt cell",
    ) {
        remove_execution(room, &execution_id);
        return error(error_message);
    }
    if let Some(previous) = current_execution_id.as_deref() {
        room.persistence
            .remember_previous_visible_execution(cell_id, previous);
    }
    trim_runtime_executions_for_doc(room, &doc);
    drop(doc);
    let _ = room.broadcasts.changed_tx.send(());
    debug!(
        "[prompt-cells] Accepted prompt {cell_id} as {execution_id} (waiting on {})",
        waiting_on.len()
    );
    Accepted::Queued {
        execution_id,
        waiting_on,
    }
}

fn remove_execution(room: &NotebookRoom, execution_id: &str) {
    let id = execution_id.to_string();
    let _ = room.state.with_doc(|sd| {
        sd.remove_executions(&[id])?;
        Ok(())
    });
}
