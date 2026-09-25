//! `NotebookRequest::CancelPromptCell` handler.

use std::sync::PoisonError;

use crate::notebook_sync_server::NotebookRoom;
use crate::protocol::NotebookResponse;

pub(crate) fn handle(room: &NotebookRoom, cell_id: &str) -> NotebookResponse {
    let active = room
        .active_prompt_run
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some(run) = active.as_ref().filter(|run| run.cell_id == cell_id) {
        run.cancel.notify_one();
    }
    NotebookResponse::Ok {}
}
