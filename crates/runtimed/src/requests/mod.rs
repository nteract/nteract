//! Per-request handler modules for the notebook sync server.
//!
//! `handle_notebook_request` dispatches to these handlers
//! based on the `NotebookRequest` variant. Each module owns one variant's logic
//! so the dispatcher stays a thin match and each handler can be read in
//! isolation.
//!
//! Handlers accept references to the per-room state (`NotebookRoom`) and shared
//! daemon state (`Arc<Daemon>`) as parameters. They return `NotebookResponse`.
//! Shared helpers used by multiple handlers live in `helpers.rs`.
//!
//! This is a behavior-preserving split of the old 2k-line match statement —
//! lock scoping, log lines, error strings, and response variants are untouched.

use std::collections::HashSet;
use std::sync::Arc;

use notebook_protocol::protocol::BlobUploadErrorKind;
use nteract_identity::ConnectionScope;
use runtime_doc::{QueueEntry, RuntimeLifecycle};
use tracing::{debug, warn};

use crate::daemon::Daemon;
use crate::notebook_sync_server::NotebookRoom;
use crate::protocol::{NotebookRequest, NotebookResponse};

/// Maximum execution entries retained in the RuntimeStateDoc.
///
/// Retention is coordinated here, where both NotebookDoc cell pointers and
/// RuntimeStateDoc queue/execution status are visible. Runtime-agent-only
/// trimming cannot know which terminal executions are still referenced by
/// document models.
pub(crate) const MAX_EXECUTION_ENTRIES: usize = 64;

pub(crate) fn runtime_launch_in_progress(lifecycle: &RuntimeLifecycle) -> bool {
    matches!(
        lifecycle,
        RuntimeLifecycle::Resolving
            | RuntimeLifecycle::PreparingEnv
            | RuntimeLifecycle::Launching
            | RuntimeLifecycle::Connecting
    )
}

pub(crate) fn publish_startup_queue_from_queued_executions(room: &NotebookRoom) {
    if let Err(e) = room.state.with_doc(|state_doc| {
        let queued: Vec<QueueEntry> = state_doc
            .get_queued_executions()
            .into_iter()
            .map(|(execution_id, _)| QueueEntry { execution_id })
            .collect();
        state_doc.set_queue(None, &queued)?;
        Ok(())
    }) {
        warn!(
            "[notebook-sync] Failed to publish startup queue projection: {}",
            e
        );
    }
}

pub(crate) mod approve_project_environment;
pub(crate) mod approve_trust;
pub(crate) mod clone_notebook;
pub(crate) mod comments;
pub(crate) mod complete;
pub(crate) mod execute_cell;
pub(crate) mod get_doc_bytes;
pub(crate) mod get_history;
pub(crate) mod guarded;
pub(crate) mod interrupt_execution;
pub(crate) mod launch_kernel;
pub(crate) mod run_all_cells;
pub(crate) mod save_notebook;
pub(crate) mod send_comm;
pub(crate) mod shutdown_kernel;
pub(crate) mod sync_environment;

pub(crate) fn trim_runtime_executions_for_doc(
    room: &NotebookRoom,
    doc: &notebook_doc::NotebookDoc,
) {
    let mut preserve_execution_ids = HashSet::new();
    for cell in doc.get_cells() {
        if let Some(execution_id) = doc.get_execution_id(&cell.id) {
            preserve_execution_ids.insert(execution_id);
        }
        if let Some(previous_execution_id) = room.persistence.previous_visible_execution(&cell.id) {
            preserve_execution_ids.insert(previous_execution_id);
        }
    }

    if let Err(e) = room.state.with_doc(|state_doc| {
        match state_doc.trim_executions_preserving(
            MAX_EXECUTION_ENTRIES,
            &preserve_execution_ids,
        ) {
            Ok(trimmed) if trimmed > 0 => {
                if let Err(rebuild_err) = state_doc.rebuild_from_save() {
                    warn!(
                        "[notebook-sync] Trimmed {} executions but failed to compact RuntimeStateDoc: {}",
                        trimmed, rebuild_err
                    );
                } else {
                    debug!(
                        "[notebook-sync] Trimmed {} RuntimeStateDoc executions",
                        trimmed
                    );
                }
            }
            Ok(_) => {}
            Err(trim_err) => {
                warn!(
                    "[notebook-sync] Failed to trim RuntimeStateDoc executions: {}",
                    trim_err
                );
            }
        }
        Ok(())
    }) {
        warn!(
            "[notebook-sync] Failed to access RuntimeStateDoc for execution trimming: {}",
            e
        );
    }
}

/// Short label for a request variant, used in telemetry logs.
///
/// Returns a static string — no allocation — suitable for structured logging
/// fields.  Intentionally avoids `Debug` formatting because some variants
/// carry large payloads (doc bytes, comm messages) that would bloat log lines.
pub(crate) fn request_label(req: &NotebookRequest) -> &'static str {
    match req {
        NotebookRequest::LaunchKernel { .. } => "LaunchKernel",
        NotebookRequest::ExecuteCell { .. } => "ExecuteCell",
        NotebookRequest::ExecuteCellGuarded { .. } => "ExecuteCellGuarded",
        NotebookRequest::InterruptExecution { .. } => "InterruptExecution",
        NotebookRequest::ShutdownKernel { .. } => "ShutdownKernel",
        NotebookRequest::RunAllCells { .. } => "RunAllCells",
        NotebookRequest::RunAllCellsGuarded { .. } => "RunAllCellsGuarded",
        NotebookRequest::SendComm { .. } => "SendComm",
        NotebookRequest::GetHistory { .. } => "GetHistory",
        NotebookRequest::Complete { .. } => "Complete",
        NotebookRequest::SaveNotebook { .. } => "SaveNotebook",
        NotebookRequest::CloneAsEphemeral { .. } => "CloneAsEphemeral",
        NotebookRequest::SyncEnvironment { .. } => "SyncEnvironment",
        NotebookRequest::ApproveTrust { .. } => "ApproveTrust",
        NotebookRequest::ApproveProjectEnvironment { .. } => "ApproveProjectEnvironment",
        NotebookRequest::ResolveCommentThread { .. } => "ResolveCommentThread",
        NotebookRequest::ReopenCommentThread { .. } => "ReopenCommentThread",
        NotebookRequest::GetDocBytes { .. } => "GetDocBytes",
        NotebookRequest::CreateBlobUpload { .. } => "CreateBlobUpload",
        NotebookRequest::CompleteBlobUpload { .. } => "CompleteBlobUpload",
        NotebookRequest::AbortBlobUpload { .. } => "AbortBlobUpload",
    }
}

/// Handle a NotebookRequest and return a NotebookResponse.
pub(crate) async fn handle_notebook_request(
    room: &Arc<NotebookRoom>,
    request: NotebookRequest,
    daemon: Arc<Daemon>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    debug!(
        "[notebook-sync] Handling request: {}",
        request_label(&request)
    );

    match request {
        NotebookRequest::LaunchKernel {
            kernel_type,
            env_source,
            notebook_path,
        } => launch_kernel::handle(room, &daemon, kernel_type, env_source, notebook_path).await,

        NotebookRequest::ExecuteCell {
            cell_id,
            execution_id,
        } => {
            execute_cell::handle_with_submitter(room, cell_id, execution_id, submitter_actor_label)
                .await
        }

        NotebookRequest::ExecuteCellGuarded {
            cell_id,
            execution_id,
            observed_heads,
        } => {
            execute_cell::handle_guarded_with_submitter(
                room,
                cell_id,
                execution_id,
                observed_heads,
                submitter_actor_label,
            )
            .await
        }

        NotebookRequest::InterruptExecution {} => interrupt_execution::handle(room).await,

        NotebookRequest::ShutdownKernel {} => shutdown_kernel::handle(room).await,

        NotebookRequest::RunAllCells { cell_execution_ids } => {
            run_all_cells::handle_with_submitter(room, cell_execution_ids, submitter_actor_label)
                .await
        }

        NotebookRequest::RunAllCellsGuarded {
            cell_execution_ids,
            observed_heads,
        } => {
            run_all_cells::handle_guarded_with_submitter(
                room,
                cell_execution_ids,
                observed_heads,
                submitter_actor_label,
            )
            .await
        }

        NotebookRequest::SendComm { message } => send_comm::handle(room, message).await,

        NotebookRequest::GetHistory { pattern, n, unique } => {
            get_history::handle(room, pattern, n, unique).await
        }

        NotebookRequest::Complete { code, cursor_pos } => {
            complete::handle(room, code, cursor_pos).await
        }

        NotebookRequest::SaveNotebook { format_cells, path } => {
            save_notebook::handle(room, &daemon, format_cells, path).await
        }

        NotebookRequest::CloneAsEphemeral { source_notebook_id } => {
            clone_notebook::handle(&daemon, source_notebook_id).await
        }

        NotebookRequest::SyncEnvironment { guard } => sync_environment::handle(room, guard).await,

        NotebookRequest::ApproveTrust { observed_heads } => {
            approve_trust::handle(room, observed_heads).await
        }

        NotebookRequest::ApproveProjectEnvironment { project_file_path } => {
            approve_project_environment::handle(room, project_file_path).await
        }

        NotebookRequest::ResolveCommentThread { thread_id } => {
            comments::resolve_thread(room, thread_id, submitter_actor_label, submitter_scope).await
        }

        NotebookRequest::ReopenCommentThread { thread_id } => {
            comments::reopen_thread(room, thread_id, submitter_actor_label, submitter_scope).await
        }

        NotebookRequest::GetDocBytes {} => get_doc_bytes::handle(room).await,

        NotebookRequest::CreateBlobUpload { .. }
        | NotebookRequest::CompleteBlobUpload { .. }
        | NotebookRequest::AbortBlobUpload { .. } => NotebookResponse::BlobUploadError {
            reason: BlobUploadErrorKind::UnknownUpload,
        },
    }
}
