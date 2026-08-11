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

fn durably_cancel_queued_execution(
    state_handle: &RuntimeStateHandle,
    execution_id: &str,
) -> anyhow::Result<()> {
    state_handle
        .with_doc(|state| {
            let queue = state.read_state().queue;
            let queued: Vec<QueueEntry> = queue
                .queued
                .into_iter()
                .filter(|entry| entry.execution_id != execution_id)
                .collect();
            state.set_execution_cancelled(execution_id)?;
            state.set_queue(queue.executing.as_ref(), &queued)?;
            Ok(())
        })
        .map_err(Into::into)
}

fn record_interrupted_execution(state_handle: &RuntimeStateHandle, execution_id: &str) {
    let _ = state_handle.with_doc(|state| {
        state.set_execution_done(execution_id, false)?;
        Ok(())
    });
}

pub(crate) async fn handle(room: &NotebookRoom, execution_id: String) -> NotebookResponse {
    let status = room
        .state
        .read(|state| state.get_execution(&execution_id).map(|entry| entry.status))
        .ok()
        .flatten();

    match status.as_deref() {
        None => {
            return response(execution_id, ExecutionCancellationOutcome::NotFound, None);
        }
        Some("done" | "error" | "cancelled") => {
            return response(
                execution_id,
                ExecutionCancellationOutcome::AlreadyTerminal,
                status,
            );
        }
        Some("queued" | "running") => {}
        Some(other) => {
            return NotebookResponse::Error {
                error: format!("Execution {execution_id} has unknown status {other:?}"),
            };
        }
    }

    let was_queued = status.as_deref() == Some("queued");
    let has_runtime_agent = {
        let agent_guard = room.runtime_agent_request_tx.lock().await;
        if was_queued {
            // Make the exact queue removal durable before dispatching to the
            // attached agent. If that agent is lagging or crashes, a fresh
            // agent can only observe the terminal record and cannot admit it.
            if let Err(error) = durably_cancel_queued_execution(&room.state, &execution_id) {
                return NotebookResponse::Error {
                    error: format!("Failed to cancel queued execution: {error}"),
                };
            }
        }
        agent_guard.is_some()
    };

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
            if outcome == ExecutionCancellationOutcome::Interrupted {
                // The agent made the exact current-execution decision and
                // interrupted it. Mirror the terminal error in the coordinator
                // so a preceding durable queued-cancel write cannot leave the
                // execution classified as never-run after a queue/start race.
                record_interrupted_execution(&room.state, &execution_id);
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

        durably_cancel_queued_execution(&state, "cancel").unwrap();

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
}
