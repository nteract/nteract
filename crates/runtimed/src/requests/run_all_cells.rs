//! `NotebookRequest::RunAllCells` handler.

use std::collections::{HashMap, HashSet};

use runtime_doc::RuntimeLifecycle;
use tracing::warn;

use crate::notebook_sync_server::durability::commit_daemon_notebook_mutation;
use crate::notebook_sync_server::NotebookRoom;
use crate::protocol::{NotebookResponse, QueueEntry};
use crate::requests::guarded;
use crate::requests::publish_startup_queue_from_queued_executions;
use crate::requests::runtime_launch_in_progress;
use crate::requests::trim_runtime_executions_for_doc;
use notebook_protocol::protocol::ExecutionIdRejectionReason;

const EXECUTION_ID_GENERATION_ATTEMPTS: usize = 16;

fn execution_id_rejected(
    execution_id: impl Into<String>,
    reason: ExecutionIdRejectionReason,
) -> NotebookResponse {
    NotebookResponse::ExecutionIdRejected {
        execution_id: execution_id.into(),
        reason,
    }
}

fn validate_requested_execution_ids(
    requested_execution_ids: Option<&HashMap<String, String>>,
    existing_execution_ids: &HashSet<String>,
) -> Result<HashSet<String>, (String, ExecutionIdRejectionReason)> {
    let mut supplied = HashSet::new();
    if let Some(requested_execution_ids) = requested_execution_ids {
        for execution_id in requested_execution_ids.values() {
            if uuid::Uuid::parse_str(execution_id).is_err() {
                return Err((execution_id.clone(), ExecutionIdRejectionReason::Malformed));
            }
            if !supplied.insert(execution_id.clone()) {
                return Err((
                    execution_id.clone(),
                    ExecutionIdRejectionReason::DuplicateInRequest,
                ));
            }
        }
    }

    for execution_id in &supplied {
        if existing_execution_ids.contains(execution_id) {
            return Err((
                execution_id.clone(),
                ExecutionIdRejectionReason::AlreadyExists,
            ));
        }
    }

    Ok(supplied)
}

fn allocate_daemon_execution_id(allocated_execution_ids: &mut HashSet<String>) -> Option<String> {
    for _ in 0..EXECUTION_ID_GENERATION_ATTEMPTS {
        let candidate = uuid::Uuid::new_v4().to_string();
        if allocated_execution_ids.insert(candidate.clone()) {
            return Some(candidate);
        }
    }
    None
}

pub(crate) async fn handle_with_submitter(
    room: &NotebookRoom,
    cell_execution_ids: Option<HashMap<String, String>>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    handle_inner(room, cell_execution_ids, None, submitter_actor_label).await
}

pub(crate) async fn handle_guarded_with_submitter(
    room: &NotebookRoom,
    cell_execution_ids: Option<HashMap<String, String>>,
    observed_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    if let Err(rejection) = guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }
    handle_inner(
        room,
        cell_execution_ids,
        Some(observed_heads),
        submitter_actor_label,
    )
    .await
}

async fn handle_inner(
    room: &NotebookRoom,
    requested_execution_ids: Option<HashMap<String, String>>,
    observed_heads: Option<Vec<String>>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    // RuntimeStateDoc is the source of truth for visible queued work. During
    // kernel launch we can queue before the agent connects; once running, a
    // live agent sync connection is required.
    {
        let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
        let lifecycle = room
            .state
            .read(|sd| sd.read_state().kernel.lifecycle)
            .unwrap_or(RuntimeLifecycle::NotStarted);
        if matches!(
            lifecycle,
            RuntimeLifecycle::Shutdown | RuntimeLifecycle::Error
        ) {
            return NotebookResponse::NoKernel {};
        }
        let queue_for_starting_kernel =
            !has_runtime_agent && runtime_launch_in_progress(&lifecycle);

        if has_runtime_agent || queue_for_starting_kernel {
            let queued = {
                let mut doc = room.doc.write().await;
                if let Some(observed_heads) = observed_heads.as_deref() {
                    if let Err(rejection) = guarded::validate_run_all(&mut doc, observed_heads) {
                        return rejection.into_response();
                    }
                }

                let cells = doc.get_cells();
                let code_cells: Vec<_> = cells
                    .iter()
                    .filter(|cell| cell.cell_type == "code")
                    .cloned()
                    .collect();

                let existing_execution_ids = room
                    .state
                    .read(|sd| {
                        sd.read_state()
                            .executions
                            .keys()
                            .cloned()
                            .collect::<HashSet<_>>()
                    })
                    .unwrap_or_default();
                let supplied = match validate_requested_execution_ids(
                    requested_execution_ids.as_ref(),
                    &existing_execution_ids,
                ) {
                    Ok(supplied) => supplied,
                    Err((execution_id, reason)) => {
                        return execution_id_rejected(execution_id, reason);
                    }
                };

                let rollback_actor = doc.get_actor_id();
                let rollback_snapshot = doc.save();
                let baseline_heads = doc.get_heads();

                // Pre-compute execution entries while holding the doc write
                // lock so guarded requests cannot be invalidated before the
                // cell→execution_id pointers are stamped.
                let mut queued = Vec::new();
                let mut entries: Vec<(String, String, String, u64)> = Vec::new();
                let mut allocated_execution_ids = existing_execution_ids;
                allocated_execution_ids.extend(supplied);
                for cell in &code_cells {
                    let execution_id = match requested_execution_ids
                        .as_ref()
                        .and_then(|ids| ids.get(&cell.id).cloned())
                    {
                        Some(execution_id) => execution_id,
                        None => match allocate_daemon_execution_id(&mut allocated_execution_ids) {
                            Some(execution_id) => execution_id,
                            None => {
                                return NotebookResponse::Error {
                                    error: "failed to allocate unique execution_id".to_string(),
                                };
                            }
                        },
                    };
                    let seq = room
                        .next_queue_seq
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    entries.push((
                        execution_id.clone(),
                        cell.id.clone(),
                        cell.source.clone(),
                        seq,
                    ));
                    queued.push(QueueEntry {
                        cell_id: cell.id.clone(),
                        execution_id,
                    });
                }

                // Write RuntimeStateDoc entries first; on failure bail
                // before stamping NotebookDoc so cell→execution_id pointers
                // cannot dangle. Any single failure aborts the whole batch.
                let mut created_execution_ids = Vec::new();
                match room.state.with_doc(|sd| {
                    for (execution_id, cell_id, source, seq) in &entries {
                        if sd.create_execution_with_source_provenance(
                            execution_id,
                            source,
                            *seq,
                            submitter_actor_label,
                            Some(cell_id),
                        )? {
                            created_execution_ids.push(execution_id.clone());
                        } else {
                            return Ok(Some(execution_id.clone()));
                        }
                    }
                    Ok(None)
                }) {
                    Ok(None) => {}
                    Ok(Some(execution_id)) => {
                        let _ = room.state.with_doc(|sd| {
                            sd.remove_executions(&created_execution_ids)?;
                            Ok(())
                        });
                        return execution_id_rejected(
                            execution_id,
                            ExecutionIdRejectionReason::AlreadyExists,
                        );
                    }
                    Err(e) => {
                        let _ = room.state.with_doc(|sd| {
                            sd.remove_executions(&created_execution_ids)?;
                            Ok(())
                        });
                        warn!(
                            "[notebook-sync] Failed to create_execution_with_source: {}",
                            e
                        );
                        return NotebookResponse::Error {
                            error: format!("failed to queue execution: {e}"),
                        };
                    }
                }

                let previous_execution_ids: Vec<(String, String)> = entries
                    .iter()
                    .filter_map(|(_, cell_id, _, _)| {
                        doc.get_execution_id(cell_id)
                            .map(|previous| (cell_id.clone(), previous))
                    })
                    .collect();
                for (execution_id, cell_id, _, _) in &entries {
                    if let Err(e) = doc.set_execution_id(cell_id, Some(execution_id)) {
                        let _ = room.state.with_doc(|sd| {
                            sd.remove_executions(&created_execution_ids)?;
                            Ok(())
                        });
                        warn!(
                            "[notebook-sync] Failed to stamp execution_id {} on cell {}: {}",
                            execution_id, cell_id, e
                        );
                        return NotebookResponse::Error {
                            error: format!("failed to stamp execution pointer: {e}"),
                        };
                    }
                }
                if let Err(error) = commit_daemon_notebook_mutation(
                    room,
                    &mut doc,
                    &baseline_heads,
                    &rollback_snapshot,
                    &rollback_actor,
                    "run all cells",
                ) {
                    let _ = room.state.with_doc(|state| {
                        state.remove_executions(&created_execution_ids)?;
                        Ok(())
                    });
                    return NotebookResponse::Error { error };
                }
                for (cell_id, previous_execution_id) in previous_execution_ids {
                    room.persistence
                        .remember_previous_visible_execution(&cell_id, &previous_execution_id);
                }
                trim_runtime_executions_for_doc(room, &doc);
                let _ = room.broadcasts.changed_tx.send(());

                queued
            };

            if queue_for_starting_kernel {
                publish_startup_queue_from_queued_executions(room);
            }
            return NotebookResponse::AllCellsQueued { queued };
        }
    }

    // No runtime agent available — kernel not running
    NotebookResponse::NoKernel {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(cell_id, execution_id)| ((*cell_id).to_string(), (*execution_id).to_string()))
            .collect()
    }

    #[test]
    fn validate_requested_execution_ids_rejects_malformed_uuid() {
        let rejection = validate_requested_execution_ids(
            Some(&ids(&[("cell-1", "not-a-uuid")])),
            &HashSet::new(),
        )
        .expect_err("malformed client id should be rejected");
        assert_eq!(
            rejection,
            (
                "not-a-uuid".to_string(),
                ExecutionIdRejectionReason::Malformed
            )
        );
    }

    #[test]
    fn validate_requested_execution_ids_rejects_duplicate_ids_in_request() {
        let execution_id = uuid::Uuid::new_v4().to_string();
        let rejection = validate_requested_execution_ids(
            Some(&ids(&[
                ("cell-1", &execution_id),
                ("cell-2", &execution_id),
            ])),
            &HashSet::new(),
        )
        .expect_err("duplicate client id should be rejected");
        assert_eq!(
            rejection,
            (
                execution_id.clone(),
                ExecutionIdRejectionReason::DuplicateInRequest
            )
        );
    }

    #[test]
    fn validate_requested_execution_ids_rejects_existing_id() {
        let execution_id = uuid::Uuid::new_v4().to_string();
        let existing = HashSet::from([execution_id.clone()]);
        let rejection =
            validate_requested_execution_ids(Some(&ids(&[("cell-1", &execution_id)])), &existing)
                .expect_err("existing client id should be rejected");
        assert_eq!(
            rejection,
            (
                execution_id.clone(),
                ExecutionIdRejectionReason::AlreadyExists
            )
        );
    }

    #[test]
    fn validate_requested_execution_ids_accepts_unique_new_ids() {
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        let supplied = validate_requested_execution_ids(
            Some(&ids(&[("cell-1", &first), ("cell-2", &second)])),
            &HashSet::new(),
        )
        .expect("fresh unique ids should be accepted");
        assert_eq!(supplied, HashSet::from([first, second]));
    }
}
