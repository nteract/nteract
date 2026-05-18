//! `NotebookRequest::RunAllCells` handler.

use std::collections::{HashMap, HashSet};

use runtime_doc::RuntimeLifecycle;
use tracing::warn;

use crate::notebook_sync_server::NotebookRoom;
use crate::protocol::{NotebookResponse, QueueEntry};
use crate::requests::guarded;
use crate::requests::trim_runtime_executions_for_doc;
use notebook_protocol::protocol::ExecutionIdRejectionReason;

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
) -> Result<HashSet<String>, NotebookResponse> {
    let mut supplied = HashSet::new();
    if let Some(requested_execution_ids) = requested_execution_ids {
        for execution_id in requested_execution_ids.values() {
            if uuid::Uuid::parse_str(execution_id).is_err() {
                return Err(execution_id_rejected(
                    execution_id.clone(),
                    ExecutionIdRejectionReason::Malformed,
                ));
            }
            if !supplied.insert(execution_id.clone()) {
                return Err(execution_id_rejected(
                    execution_id.clone(),
                    ExecutionIdRejectionReason::DuplicateInRequest,
                ));
            }
        }
    }

    for execution_id in &supplied {
        if existing_execution_ids.contains(execution_id) {
            return Err(execution_id_rejected(
                execution_id.clone(),
                ExecutionIdRejectionReason::AlreadyExists,
            ));
        }
    }

    Ok(supplied)
}

pub(crate) async fn handle(
    room: &NotebookRoom,
    cell_execution_ids: Option<HashMap<String, String>>,
) -> NotebookResponse {
    handle_inner(room, cell_execution_ids, None).await
}

pub(crate) async fn handle_guarded(
    room: &NotebookRoom,
    cell_execution_ids: Option<HashMap<String, String>>,
    observed_heads: Vec<String>,
) -> NotebookResponse {
    if let Err(rejection) = guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }
    handle_inner(room, cell_execution_ids, Some(observed_heads)).await
}

async fn handle_inner(
    room: &NotebookRoom,
    requested_execution_ids: Option<HashMap<String, String>>,
    observed_heads: Option<Vec<String>>,
) -> NotebookResponse {
    // Agent path — write all cells to RuntimeStateDoc queue
    {
        let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
        if has_runtime_agent {
            // Check if kernel is shut down.
            {
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
            }

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
                    Err(response) => return response,
                };

                // Pre-compute execution entries while holding the doc write
                // lock so guarded requests cannot be invalidated before the
                // cell→execution_id pointers are stamped.
                let mut queued = Vec::new();
                let mut entries: Vec<(String, String, String, u64)> = Vec::new();
                let mut allocated_execution_ids = existing_execution_ids;
                allocated_execution_ids.extend(supplied);
                for cell in &code_cells {
                    let execution_id = requested_execution_ids
                        .as_ref()
                        .and_then(|ids| ids.get(&cell.id).cloned())
                        .unwrap_or_else(|| loop {
                            let candidate = uuid::Uuid::new_v4().to_string();
                            if allocated_execution_ids.insert(candidate.clone()) {
                                break candidate;
                            }
                        });
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
                if let Err(e) = room.state.with_doc(|sd| {
                    for (execution_id, _, source, seq) in &entries {
                        sd.create_execution_with_source(execution_id, source, *seq)?;
                    }
                    Ok(())
                }) {
                    let rollback_ids: Vec<String> = entries
                        .iter()
                        .map(|(execution_id, _, _, _)| execution_id.clone())
                        .collect();
                    let _ = room.state.with_doc(|sd| {
                        sd.remove_executions(&rollback_ids)?;
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

                for (execution_id, cell_id, _, _) in &entries {
                    if let Err(e) = doc.set_execution_id(cell_id, Some(execution_id)) {
                        let rollback_ids: Vec<String> = entries
                            .iter()
                            .map(|(execution_id, _, _, _)| execution_id.clone())
                            .collect();
                        let _ = room.state.with_doc(|sd| {
                            sd.remove_executions(&rollback_ids)?;
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
                trim_runtime_executions_for_doc(room, &doc);
                let _ = room.broadcasts.changed_tx.send(());

                queued
            };

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
        let response = validate_requested_execution_ids(
            Some(&ids(&[("cell-1", "not-a-uuid")])),
            &HashSet::new(),
        )
        .expect_err("malformed client id should be rejected");
        assert!(matches!(
            response,
            NotebookResponse::ExecutionIdRejected {
                execution_id,
                reason: ExecutionIdRejectionReason::Malformed,
            } if execution_id == "not-a-uuid"
        ));
    }

    #[test]
    fn validate_requested_execution_ids_rejects_duplicate_ids_in_request() {
        let execution_id = uuid::Uuid::new_v4().to_string();
        let response = validate_requested_execution_ids(
            Some(&ids(&[
                ("cell-1", &execution_id),
                ("cell-2", &execution_id),
            ])),
            &HashSet::new(),
        )
        .expect_err("duplicate client id should be rejected");
        assert!(matches!(
            response,
            NotebookResponse::ExecutionIdRejected {
                execution_id: rejected,
                reason: ExecutionIdRejectionReason::DuplicateInRequest,
            } if rejected == execution_id
        ));
    }

    #[test]
    fn validate_requested_execution_ids_rejects_existing_id() {
        let execution_id = uuid::Uuid::new_v4().to_string();
        let existing = HashSet::from([execution_id.clone()]);
        let response =
            validate_requested_execution_ids(Some(&ids(&[("cell-1", &execution_id)])), &existing)
                .expect_err("existing client id should be rejected");
        assert!(matches!(
            response,
            NotebookResponse::ExecutionIdRejected {
                execution_id: rejected,
                reason: ExecutionIdRejectionReason::AlreadyExists,
            } if rejected == execution_id
        ));
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
