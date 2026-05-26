//! `NotebookRequest::ExecuteCell` handler.

use std::sync::Arc;

use automerge::ChangeHash;
use runtime_doc::RuntimeLifecycle;
use tracing::warn;

use crate::notebook_sync_server::{
    detect_room_runtime, format_source, formatter_actor, NotebookRoom,
};
use crate::protocol::NotebookResponse;
use crate::requests::guarded;
use crate::requests::publish_startup_queue_from_queued_executions;
use crate::requests::runtime_launch_in_progress;
use crate::requests::trim_runtime_executions_for_doc;
use crate::task_supervisor::spawn_best_effort;
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

fn validate_requested_execution_id(
    execution_id: &str,
    already_exists: bool,
) -> Result<(), ExecutionIdRejectionReason> {
    if uuid::Uuid::parse_str(execution_id).is_err() {
        return Err(ExecutionIdRejectionReason::Malformed);
    }
    if already_exists {
        return Err(ExecutionIdRejectionReason::AlreadyExists);
    }
    Ok(())
}

pub(crate) async fn handle_with_submitter(
    room: &Arc<NotebookRoom>,
    cell_id: String,
    execution_id: Option<String>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    handle_inner(room, cell_id, execution_id, None, submitter_actor_label).await
}

pub(crate) async fn handle_guarded_with_submitter(
    room: &Arc<NotebookRoom>,
    cell_id: String,
    execution_id: Option<String>,
    observed_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    if let Err(rejection) = guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }
    handle_inner(
        room,
        cell_id,
        execution_id,
        Some(observed_heads),
        submitter_actor_label,
    )
    .await
}

async fn handle_inner(
    room: &Arc<NotebookRoom>,
    cell_id: String,
    requested_execution_id: Option<String>,
    observed_heads: Option<Vec<String>>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    // Agent-backed kernel: write execution to RuntimeStateDoc queue. During
    // launch, queue in the doc before the agent connects so all clients observe
    // the same pending work. Once running, require a live sync connection.
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
            let (source, execution_id, format_heads) = match queue_cell_if_current(
                room,
                &cell_id,
                requested_execution_id.as_deref(),
                observed_heads.as_deref(),
                submitter_actor_label,
            )
            .await
            {
                QueueCellResult::Queued {
                    source,
                    execution_id,
                    format_heads,
                } => {
                    if queue_for_starting_kernel {
                        publish_startup_queue_from_queued_executions(room);
                    }
                    (source, execution_id, format_heads)
                }
                QueueCellResult::AlreadyActive { execution_id } => {
                    if queue_for_starting_kernel {
                        publish_startup_queue_from_queued_executions(room);
                    }
                    return NotebookResponse::CellQueued {
                        cell_id,
                        execution_id,
                    };
                }
                QueueCellResult::Response(response) => return *response,
            };

            let room_clone = Arc::clone(room);
            let cell_id_clone = cell_id.clone();
            let source_clone = source.clone();
            spawn_best_effort("cell-formatter", async move {
                if let Some(runtime) = detect_room_runtime(&room_clone).await {
                    if let Some(formatted) = format_source(&source_clone, &runtime).await {
                        let mut doc = room_clone.doc.write().await;
                        match doc.transact_at_heads_recovering(
                            &format_heads,
                            Some(&formatter_actor(&runtime)),
                            "format-transaction",
                            |doc| {
                                let changed = doc.update_source(&cell_id_clone, &formatted)?;
                                Ok(changed)
                            },
                        ) {
                            Ok(true) => {
                                let _ = room_clone.broadcasts.changed_tx.send(());
                            }
                            Ok(false) => {}
                            Err(e) => {
                                warn!("[format] transaction failed: {}", e);
                            }
                        }
                    }
                }
            });

            return NotebookResponse::CellQueued {
                cell_id,
                execution_id,
            };
        }
    }

    // No runtime agent available — kernel not running
    NotebookResponse::NoKernel {}
}

enum QueueCellResult {
    Queued {
        source: String,
        execution_id: String,
        format_heads: Vec<ChangeHash>,
    },
    AlreadyActive {
        execution_id: String,
    },
    Response(Box<NotebookResponse>),
}

async fn queue_cell_if_current(
    room: &Arc<NotebookRoom>,
    cell_id: &str,
    requested_execution_id: Option<&str>,
    observed_heads: Option<&[String]>,
    submitter_actor_label: Option<&str>,
) -> QueueCellResult {
    if let Some(execution_id) = requested_execution_id {
        if let Err(reason) = validate_requested_execution_id(execution_id, false) {
            return QueueCellResult::Response(Box::new(execution_id_rejected(
                execution_id,
                reason,
            )));
        }
    }

    let mut doc = room.doc.write().await;
    if let Some(observed_heads) = observed_heads {
        if let Err(rejection) = guarded::validate_execute_cell(&mut doc, cell_id, observed_heads) {
            return QueueCellResult::Response(Box::new(rejection.into_response()));
        }
    }

    let cell = match doc.get_cell(cell_id) {
        Some(c) => c,
        None => {
            let cells = doc.get_cells();
            let cell_ids: Vec<&str> = cells.iter().map(|c| c.id.as_str()).collect();
            warn!(
                "[notebook-sync] ExecuteCell: cell {} not found in document \
                 (doc has {} cells: {:?})",
                cell_id,
                cells.len(),
                cell_ids,
            );
            return QueueCellResult::Response(Box::new(NotebookResponse::Error {
                error: format!("Cell not found in document: {}", cell_id),
            }));
        }
    };

    if cell.cell_type != "code" {
        return QueueCellResult::Response(Box::new(NotebookResponse::Error {
            error: format!(
                "Cannot execute non-code cell: {} (type: {})",
                cell_id, cell.cell_type
            ),
        }));
    }

    let current_execution_id = doc.get_execution_id(cell_id);
    if let Some(eid) = current_execution_id.as_ref() {
        let is_active = room
            .state
            .read(|sd| {
                sd.get_execution(eid)
                    .is_some_and(|exec| exec.status == "queued" || exec.status == "running")
            })
            .unwrap_or(false);
        if is_active {
            if requested_execution_id.is_some() {
                return QueueCellResult::Response(Box::new(NotebookResponse::Error {
                    error: format!("Cell already has an active execution: {}", eid),
                }));
            }
            return QueueCellResult::AlreadyActive {
                execution_id: eid.clone(),
            };
        }
    }

    let mut execution_id = requested_execution_id
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut generated_retries = 0usize;
    let seq = room
        .next_queue_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    loop {
        match room.state.with_doc(|sd| {
            if sd.get_execution(&execution_id).is_some() {
                return Ok(false);
            }
            sd.create_execution_with_source_provenance(
                &execution_id,
                &cell.source,
                seq,
                submitter_actor_label,
                Some(cell_id),
            )
        }) {
            Ok(true) => break,
            Ok(false) if requested_execution_id.is_none() => {
                generated_retries += 1;
                if generated_retries >= EXECUTION_ID_GENERATION_ATTEMPTS {
                    return QueueCellResult::Response(Box::new(NotebookResponse::Error {
                        error: "failed to allocate unique execution_id".to_string(),
                    }));
                }
                execution_id = uuid::Uuid::new_v4().to_string();
            }
            Ok(false) => {
                return QueueCellResult::Response(Box::new(execution_id_rejected(
                    execution_id,
                    ExecutionIdRejectionReason::AlreadyExists,
                )));
            }
            Err(e) => {
                let rollback_id = execution_id.clone();
                let _ = room.state.with_doc(|sd| {
                    sd.remove_executions(&[rollback_id])?;
                    Ok(())
                });
                warn!(
                    "[notebook-sync] Failed to create_execution_with_source for {}: {}",
                    execution_id, e
                );
                return QueueCellResult::Response(Box::new(NotebookResponse::Error {
                    error: format!("failed to queue execution: {e}"),
                }));
            }
        }
    }

    let source = cell.source;
    if let Err(e) = doc.set_execution_id(cell_id, Some(&execution_id)) {
        let rollback_id = execution_id.clone();
        let _ = room.state.with_doc(|sd| {
            sd.remove_executions(&[rollback_id])?;
            Ok(())
        });
        warn!(
            "[notebook-sync] Failed to stamp execution_id {} on cell {}: {}",
            execution_id, cell_id, e
        );
        return QueueCellResult::Response(Box::new(NotebookResponse::Error {
            error: format!("failed to stamp execution pointer: {e}"),
        }));
    }
    if let Some(previous_execution_id) = current_execution_id.as_deref() {
        room.persistence
            .remember_previous_visible_execution(cell_id, previous_execution_id);
    }
    trim_runtime_executions_for_doc(room, &doc);
    let format_heads = doc.get_heads();
    let _ = room.broadcasts.changed_tx.send(());

    QueueCellResult::Queued {
        source,
        execution_id,
        format_heads,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_requested_execution_id_rejects_malformed_uuid() {
        assert_eq!(
            validate_requested_execution_id("not-a-uuid", false),
            Err(ExecutionIdRejectionReason::Malformed)
        );
    }

    #[test]
    fn validate_requested_execution_id_rejects_existing_uuid() {
        let execution_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            validate_requested_execution_id(&execution_id, true),
            Err(ExecutionIdRejectionReason::AlreadyExists)
        );
    }

    #[test]
    fn validate_requested_execution_id_accepts_new_uuid() {
        let execution_id = uuid::Uuid::new_v4().to_string();
        validate_requested_execution_id(&execution_id, false)
            .expect("fresh uuid should be accepted");
    }
}
