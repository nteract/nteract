//! `NotebookRequest::CancelExecution` handler.

use notebook_protocol::protocol::{
    ExecutionCancellationOutcome, RuntimeAgentRequest, RuntimeAgentResponse,
};
use runtime_doc::{QueueEntry, RuntimeStateHandle};

use crate::notebook_sync_server::{send_runtime_agent_query, NotebookRoom};
use crate::protocol::NotebookResponse;

fn response(
    execution_id: String,
    outcome: ExecutionCancellationOutcome,
    terminal_status: Option<String>,
) -> NotebookResponse {
    NotebookResponse::ExecutionCancellation {
        execution_id,
        outcome,
        terminal_status,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CoordinatorCancellationState {
    NotFound,
    AlreadyTerminal(String),
    Running,
    CancelledQueued,
    Unknown(String),
}

fn classify_and_cancel_queued_execution(
    state_handle: &RuntimeStateHandle,
    execution_id: &str,
) -> anyhow::Result<CoordinatorCancellationState> {
    state_handle
        .with_doc(|state| {
            let Some(execution) = state.get_execution(execution_id) else {
                return Ok(CoordinatorCancellationState::NotFound);
            };
            if let Some(success) = execution.success {
                return Ok(CoordinatorCancellationState::AlreadyTerminal(
                    if success { "done" } else { "error" }.to_string(),
                ));
            }
            match execution.status.as_str() {
                "done" | "error" | "cancelled" => {
                    return Ok(CoordinatorCancellationState::AlreadyTerminal(
                        execution.status,
                    ));
                }
                "running" => return Ok(CoordinatorCancellationState::Running),
                "queued" => {}
                other => return Ok(CoordinatorCancellationState::Unknown(other.to_string())),
            }
            let queue = state.read_state().queue;
            let queued: Vec<QueueEntry> = queue
                .queued
                .into_iter()
                .filter(|entry| entry.execution_id != execution_id)
                .collect();
            state.set_execution_cancelled(execution_id)?;
            state.set_queue(queue.executing.as_ref(), &queued)?;
            Ok(CoordinatorCancellationState::CancelledQueued)
        })
        .map_err(Into::into)
}

fn mirror_terminal_execution(
    state_handle: &RuntimeStateHandle,
    execution_id: &str,
    status: &str,
) -> anyhow::Result<()> {
    match status {
        "done" => state_handle
            .with_doc(|state| state.set_execution_done(execution_id, true))
            .map_err(Into::into),
        "error" => state_handle
            .with_doc(|state| state.set_execution_done(execution_id, false))
            .map_err(Into::into),
        "cancelled" => state_handle
            .with_doc(|state| state.set_execution_cancelled(execution_id))
            .map_err(Into::into),
        other => anyhow::bail!("runtime agent returned unknown terminal status {other:?}"),
    }
}

pub(crate) async fn handle(room: &NotebookRoom, execution_id: String) -> NotebookResponse {
    let (coordinator_state, has_runtime_agent) = {
        let agent_guard = room.runtime_agent_request_tx.lock().await;
        // Classify and, if still queued, terminalize the exact execution in
        // one RuntimeStateDoc critical section. This prevents a completion
        // that has already synced from being overwritten by a stale queued
        // snapshot. The request-channel guard also keeps agent replacement
        // from crossing this durability boundary.
        let state = match classify_and_cancel_queued_execution(&room.state, &execution_id) {
            Ok(state) => state,
            Err(error) => {
                return NotebookResponse::Error {
                    error: format!("Failed to classify execution cancellation: {error}"),
                };
            }
        };
        (state, agent_guard.is_some())
    };

    let was_queued = coordinator_state == CoordinatorCancellationState::CancelledQueued;
    match coordinator_state {
        CoordinatorCancellationState::NotFound => {
            return response(execution_id, ExecutionCancellationOutcome::NotFound, None);
        }
        CoordinatorCancellationState::AlreadyTerminal(status) => {
            return response(
                execution_id,
                ExecutionCancellationOutcome::AlreadyTerminal,
                Some(status),
            );
        }
        CoordinatorCancellationState::Unknown(status) => {
            return NotebookResponse::Error {
                error: format!("Execution {execution_id} has unknown status {status:?}"),
            };
        }
        CoordinatorCancellationState::Running | CoordinatorCancellationState::CancelledQueued => {}
    }

    if !has_runtime_agent {
        return if was_queued {
            response(
                execution_id,
                ExecutionCancellationOutcome::CancelledQueued,
                None,
            )
        } else {
            NotebookResponse::Error {
                error: format!(
                    "Execution {execution_id} is marked running but no runtime agent is connected"
                ),
            }
        };
    }

    match send_runtime_agent_query(
        room,
        RuntimeAgentRequest::CancelExecution {
            execution_id: execution_id.clone(),
        },
    )
    .await
    {
        Ok(RuntimeAgentResponse::ExecutionCancellation {
            execution_id,
            outcome,
            terminal_status,
        }) => {
            let mirrored_status = if outcome == ExecutionCancellationOutcome::Interrupted {
                // The agent made the exact current-execution decision and
                // interrupted it. Mirror the terminal error in the coordinator
                // so a preceding durable queued-cancel write cannot leave the
                // execution classified as never-run after a queue/start race.
                Some("error")
            } else if outcome == ExecutionCancellationOutcome::AlreadyTerminal {
                terminal_status.as_deref()
            } else {
                None
            };
            if let Some(status) = mirrored_status {
                if let Err(error) = mirror_terminal_execution(&room.state, &execution_id, status) {
                    return NotebookResponse::Error {
                        error: format!("Failed to preserve terminal execution state: {error}"),
                    };
                }
            }
            if was_queued
                && outcome == ExecutionCancellationOutcome::AlreadyTerminal
                && terminal_status.as_deref() == Some("cancelled")
            {
                response(
                    execution_id,
                    ExecutionCancellationOutcome::CancelledQueued,
                    None,
                )
            } else {
                response(execution_id, outcome, terminal_status)
            }
        }
        Ok(RuntimeAgentResponse::Error { error }) => NotebookResponse::Error { error },
        Ok(other) => NotebookResponse::Error {
            error: format!("Unexpected runtime-agent cancellation response: {other:?}"),
        },
        Err(error) => NotebookResponse::Error {
            error: format!("Runtime-agent cancellation failed: {error}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_doc::RuntimeStateDoc;

    #[test]
    fn queued_cancellation_is_terminal_before_agent_dispatch() {
        let (changed_tx, _) = tokio::sync::broadcast::channel(8);
        let state = RuntimeStateHandle::new(RuntimeStateDoc::new(), changed_tx);
        state
            .with_doc(|doc| {
                doc.create_execution_with_source("cancel", "print('no')", 0)?;
                doc.create_execution_with_source("other", "print('yes')", 1)?;
                doc.set_queue(
                    None,
                    &[
                        QueueEntry {
                            execution_id: "cancel".to_string(),
                        },
                        QueueEntry {
                            execution_id: "other".to_string(),
                        },
                    ],
                )?;
                Ok(())
            })
            .unwrap();

        assert_eq!(
            classify_and_cancel_queued_execution(&state, "cancel").unwrap(),
            CoordinatorCancellationState::CancelledQueued
        );

        let cancelled = state
            .read(|doc| doc.get_execution("cancel"))
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        let runtime = state.read(|doc| doc.read_state()).unwrap();
        assert_eq!(
            runtime
                .queue
                .queued
                .into_iter()
                .map(|entry| entry.execution_id)
                .collect::<Vec<_>>(),
            vec!["other"]
        );
    }

    #[test]
    fn completed_execution_is_never_reclassified_as_cancelled() {
        let (changed_tx, _) = tokio::sync::broadcast::channel(8);
        let state = RuntimeStateHandle::new(RuntimeStateDoc::new(), changed_tx);
        state
            .with_doc(|doc| {
                doc.create_execution_with_source("complete", "print('yes')", 0)?;
                doc.set_execution_done("complete", true)?;
                Ok(())
            })
            .unwrap();

        assert_eq!(
            classify_and_cancel_queued_execution(&state, "complete").unwrap(),
            CoordinatorCancellationState::AlreadyTerminal("done".to_string())
        );
        let execution = state
            .read(|doc| doc.get_execution("complete"))
            .unwrap()
            .unwrap();
        assert_eq!(execution.status, "done");
        assert_eq!(execution.success, Some(true));
    }

    #[test]
    fn terminal_agent_result_repairs_a_pre_cancelled_coordinator_record() {
        let (changed_tx, _) = tokio::sync::broadcast::channel(8);
        let state = RuntimeStateHandle::new(RuntimeStateDoc::new(), changed_tx);
        state
            .with_doc(|doc| {
                doc.create_execution_with_source("raced", "print('yes')", 0)?;
                doc.set_execution_cancelled("raced")?;
                Ok(())
            })
            .unwrap();

        mirror_terminal_execution(&state, "raced", "done").unwrap();

        let execution = state
            .read(|doc| doc.get_execution("raced"))
            .unwrap()
            .unwrap();
        assert_eq!(execution.status, "done");
        assert_eq!(execution.success, Some(true));
    }
}
