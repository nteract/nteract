//! Coordinator-side prompt cell logic.
//!
//! Prompt cells run on the prompt agent (a separate runtime-agent process
//! offering the `prompt` capability), not on the kernel. This module is the
//! daemon's half: `accept` writes the execution, pointer and a streaming
//! answer placeholder; `coordinator` is the per-room task that waits for cells
//! above (`machine` is the pure lifecycle of one run), builds the context
//! (`context`), dispatches the run to the agent and finalizes terminal runs
//! into answer cells (`answer`, split by `shape`). `cells` reads and writes
//! the prompt and answer cell metadata.
//!
//! The coordinator task starts lazily on the first prompt of a room and ends
//! when the room drops its sender on teardown. With the feature flag off
//! nothing here runs. NotebookDoc writes use the actor label
//! `runtimed:prompt`, so prompt edits are attributable.

mod accept;
mod answer;
mod cells;
mod context;
mod coordinator;
mod machine;
mod shape;
#[cfg(test)]
mod tests;

use cells::is_prompt_cell;
#[cfg(test)]
pub(crate) use cells::prompt_response_metadata;
pub use cells::{answer_execution_id, answer_is_streaming, answer_prompt_cell_id};

pub(crate) use context::EXPLORE_SYSTEM_PROMPT;
pub(crate) use coordinator::resolve_stale_placeholders;

use std::collections::BTreeSet;
use std::sync::Arc;

use futures::future::BoxFuture;
use runtime_doc::CAPABILITY_PROMPT;
use serde_json::json;
use tokio::sync::mpsc;
use tracing::debug;

use crate::daemon::Daemon;
use crate::notebook_sync_server::{ensure_prompt_agent, NotebookRoom};
use crate::protocol::NotebookResponse;

/// Starts (or reuses) the room's prompt agent. Injected so tests can run the
/// coordinator without a daemon.
pub(crate) type AgentEnsurer =
    Arc<dyn Fn(Arc<NotebookRoom>) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// Messages into the room's prompt coordinator task.
pub(crate) enum PromptCoordinatorMsg {
    /// A prompt run was accepted (execution, pointer and placeholder exist).
    Accepted {
        execution_id: String,
        prompt_cell_id: String,
        waiting_on: BTreeSet<String>,
    },
    /// Outcome of a dispatch task.
    Dispatched {
        execution_id: String,
        result: Result<(), String>,
    },
}

pub(crate) const PROMPT_CELLS_DISABLED: &str =
    "Prompt cells are disabled. Turn on \"Prompt cells\" in Settings → Feature flags.";

pub(crate) const PROMPT_CELLS_HOSTED: &str = "Prompt cells are not available in hosted rooms";

/// `ename` of the error output that a failed prompt run carries (R10).
pub(crate) const PROMPT_ERROR_ENAME: &str = "PromptError";

/// Output manifest for a failed prompt run, written by the coordinator, the
/// agent teardown and the prompt agent itself. Prompt error messages are
/// short, so every field is inline and no blob store is involved.
pub(crate) fn prompt_error_manifest(message: &str) -> serde_json::Value {
    json!({
        "output_type": "error",
        "output_id": uuid::Uuid::new_v4().to_string(),
        "ename": PROMPT_ERROR_ENAME,
        "evalue": message,
        "traceback": {"inline": "[]"},
    })
}

fn daemon_ensurer(daemon: Arc<Daemon>) -> AgentEnsurer {
    Arc::new(move |room| {
        let daemon = Arc::clone(&daemon);
        Box::pin(async move { ensure_prompt_agent(&room, &daemon).await })
    })
}

/// True when `cell_id` is a prompt cell.
pub(crate) async fn is_prompt(room: &NotebookRoom, cell_id: &str) -> bool {
    let doc = room.doc.read().await;
    doc.get_cell(cell_id)
        .is_some_and(|cell| is_prompt_cell(&cell))
}

/// `ExecuteCell` / `ExecuteCellGuarded` entry for prompt cells. Returns
/// `None` when `cell_id` is not a prompt cell (the caller continues with the
/// kernel path). Runs before the kernel gate: a prompt needs no kernel and no
/// trust approval, since it executes no notebook code. A guarded execute
/// (`observed_heads` given) still rejects a prompt cell whose source changed.
pub(crate) async fn route_execute(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    cell_id: &str,
    requested_execution_id: Option<&str>,
    observed_heads: Option<&[String]>,
    submitter_actor_label: Option<&str>,
) -> Option<NotebookResponse> {
    if !is_prompt(room, cell_id).await {
        return None;
    }
    let enabled = {
        let settings = daemon.settings.read().await;
        settings.get_all().prompt_cells
    };
    if !enabled {
        return Some(NotebookResponse::Error {
            error: PROMPT_CELLS_DISABLED.to_string(),
        });
    }
    Some(
        queue_prompt_cell(
            room,
            &daemon_ensurer(Arc::clone(daemon)),
            cell_id,
            requested_execution_id,
            observed_heads,
            submitter_actor_label,
        )
        .await,
    )
}

/// Accept a run request for a prompt cell and hand it to the coordinator.
pub(crate) async fn queue_prompt_cell(
    room: &Arc<NotebookRoom>,
    ensurer: &AgentEnsurer,
    cell_id: &str,
    requested_execution_id: Option<&str>,
    observed_heads: Option<&[String]>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    match accept::accept_prompt_cell(
        room,
        cell_id,
        requested_execution_id,
        observed_heads,
        submitter_actor_label,
    )
    .await
    {
        accept::Accepted::Queued {
            execution_id,
            waiting_on,
        } => {
            send_to_coordinator(
                room,
                ensurer,
                PromptCoordinatorMsg::Accepted {
                    execution_id: execution_id.clone(),
                    prompt_cell_id: cell_id.to_string(),
                    waiting_on,
                },
            );
            NotebookResponse::CellQueued {
                cell_id: cell_id.to_string(),
                execution_id,
            }
        }
        accept::Accepted::AlreadyActive { execution_id } => {
            let _ = ensure_coordinator(room, ensurer);
            NotebookResponse::CellQueued {
                cell_id: cell_id.to_string(),
                execution_id,
            }
        }
        accept::Accepted::Response(response) => *response,
    }
}

/// The room's coordinator sender, starting the task when there is none (first
/// prompt, after room teardown cleared it, or after the task died).
pub(crate) fn ensure_coordinator(
    room: &Arc<NotebookRoom>,
    ensurer: &AgentEnsurer,
) -> mpsc::UnboundedSender<PromptCoordinatorMsg> {
    let mut slot = room
        .prompt_coordinator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(tx) = slot.as_ref() {
        if !tx.is_closed() {
            return tx.clone();
        }
    }
    let (tx, rx) = mpsc::unbounded_channel();
    *slot = Some(tx.clone());
    coordinator::spawn(Arc::clone(room), Arc::clone(ensurer), rx, tx.downgrade());
    tx
}

fn send_to_coordinator(
    room: &Arc<NotebookRoom>,
    ensurer: &AgentEnsurer,
    msg: PromptCoordinatorMsg,
) {
    let tx = ensure_coordinator(room, ensurer);
    if let Err(mpsc::error::SendError(msg)) = tx.send(msg) {
        // The task died between the check and the send: start a new one.
        let tx = ensure_coordinator(room, ensurer);
        let _ = tx.send(msg);
    }
}

/// Stop a prompt cell's execution by recording one more Stop on it. Stop is
/// document state and always names its execution, so a late Stop can never
/// reach another prompt. Terminal executions are left alone.
///
/// Each phase has one writer of the status that leaves `queued`. Before
/// dispatch (no `context_blob`) that is the daemon, so this cancels the
/// execution here. After dispatch it is the prompt agent: it cancels a
/// stopped execution it has not claimed, and interrupts (first Stop) or
/// kills (second Stop) the one it runs. Either way the coordinator finalizes
/// the run once it is terminal.
pub(crate) async fn interrupt_prompt(room: &Arc<NotebookRoom>, cell_id: &str) -> NotebookResponse {
    let execution_id = room.doc.read().await.get_execution_id(cell_id);
    let Some(execution_id) = execution_id else {
        return NotebookResponse::InterruptSent {};
    };
    let result = room.state.with_doc(|sd| {
        let Some(execution) = sd.get_execution(&execution_id) else {
            return Ok(());
        };
        if execution.capability.as_deref() != Some(CAPABILITY_PROMPT) || execution.is_terminal() {
            return Ok(());
        }
        let stops = sd.request_execution_stop(&execution_id)?;
        if execution.status == "queued" && execution.context_blob.is_none() {
            sd.set_execution_cancelled(&execution_id)?;
        }
        debug!(
            "[prompt-cells] Stop {stops} for {execution_id} (was {})",
            execution.status
        );
        Ok(())
    });
    match result {
        Ok(()) => NotebookResponse::InterruptSent {},
        Err(error) => NotebookResponse::Error {
            error: format!("Could not stop the prompt: {error}"),
        },
    }
}
