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

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use notebook_protocol::protocol::{
    BlobUploadErrorKind, ExecutionIdRejectionReason, QueueEntry as ProtocolQueueEntry,
};
use runtime_doc::{QueueEntry as RuntimeQueueEntry, RuntimeLifecycle};
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
        let queued: Vec<RuntimeQueueEntry> = state_doc
            .get_queued_executions()
            .into_iter()
            .map(|(execution_id, _)| RuntimeQueueEntry { execution_id })
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

pub(crate) mod apply_bokeh_session_patch;
pub(crate) mod approve_project_environment;
pub(crate) mod approve_trust;
pub(crate) mod clone_notebook;
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
        NotebookRequest::ApplyBokehSessionPatch { .. } => "ApplyBokehSessionPatch",
        NotebookRequest::GetHistory { .. } => "GetHistory",
        NotebookRequest::Complete { .. } => "Complete",
        NotebookRequest::SaveNotebook { .. } => "SaveNotebook",
        NotebookRequest::CloneAsEphemeral { .. } => "CloneAsEphemeral",
        NotebookRequest::SyncEnvironment { .. } => "SyncEnvironment",
        NotebookRequest::ApproveTrust { .. } => "ApproveTrust",
        NotebookRequest::ApproveProjectEnvironment { .. } => "ApproveProjectEnvironment",
        NotebookRequest::GetDocBytes { .. } => "GetDocBytes",
        NotebookRequest::CreateBlobUpload { .. } => "CreateBlobUpload",
        NotebookRequest::CompleteBlobUpload { .. } => "CompleteBlobUpload",
        NotebookRequest::AbortBlobUpload { .. } => "AbortBlobUpload",
    }
}

fn execution_id_rejected(
    execution_id: impl Into<String>,
    reason: ExecutionIdRejectionReason,
) -> NotebookResponse {
    NotebookResponse::ExecutionIdRejected {
        execution_id: execution_id.into(),
        reason,
    }
}

fn validate_hosted_execution_id(execution_id: &str) -> Option<NotebookResponse> {
    if uuid::Uuid::parse_str(execution_id).is_err() {
        return Some(execution_id_rejected(
            execution_id,
            ExecutionIdRejectionReason::Malformed,
        ));
    }
    None
}

fn validate_hosted_run_all_execution_ids(
    requested_execution_ids: Option<&HashMap<String, String>>,
    existing_execution_ids: &HashSet<String>,
) -> Result<HashSet<String>, Box<NotebookResponse>> {
    let mut supplied = HashSet::new();
    if let Some(requested_execution_ids) = requested_execution_ids {
        for execution_id in requested_execution_ids.values() {
            if uuid::Uuid::parse_str(execution_id).is_err() {
                return Err(Box::new(execution_id_rejected(
                    execution_id,
                    ExecutionIdRejectionReason::Malformed,
                )));
            }
            if !supplied.insert(execution_id.clone()) {
                return Err(Box::new(execution_id_rejected(
                    execution_id,
                    ExecutionIdRejectionReason::DuplicateInRequest,
                )));
            }
            if existing_execution_ids.contains(execution_id) {
                return Err(Box::new(execution_id_rejected(
                    execution_id,
                    ExecutionIdRejectionReason::AlreadyExists,
                )));
            }
        }
    }
    Ok(supplied)
}

fn allocate_hosted_execution_id(allocated_execution_ids: &mut HashSet<String>) -> Option<String> {
    for _ in 0..16 {
        let execution_id = uuid::Uuid::new_v4().to_string();
        if allocated_execution_ids.insert(execution_id.clone()) {
            return Some(execution_id);
        }
    }
    None
}

fn forward_hosted_request(
    bridge: &crate::notebook_sync_server::HostedBridgeHandle,
    payload: serde_json::Value,
    operation: &str,
) -> Result<(), Box<NotebookResponse>> {
    serde_json::to_vec(&payload)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| bridge.forward_request(bytes))
        .map_err(|e| {
            Box::new(NotebookResponse::Error {
                error: format!("Failed to forward {operation} to hosted room: {e}"),
            })
        })
}

async fn handle_hosted_execute_cell(
    bridge: &crate::notebook_sync_server::HostedBridgeHandle,
    cell_id: &str,
    requested_execution_id: Option<&str>,
    guarded_observed_heads: Option<&[String]>,
) -> NotebookResponse {
    let execution_id = match requested_execution_id {
        Some(execution_id) => {
            if let Some(response) = validate_hosted_execution_id(execution_id) {
                return response;
            }
            execution_id.to_string()
        }
        None => uuid::Uuid::new_v4().to_string(),
    };
    let action = if guarded_observed_heads.is_some() {
        "execute_cell_guarded"
    } else {
        "execute_cell"
    };
    let mut payload = serde_json::json!({
        "action": action,
        "cell_id": cell_id,
        "execution_id": execution_id,
    });
    if let Some(observed_heads) = guarded_observed_heads {
        payload["observed_heads"] = serde_json::json!(observed_heads);
    }

    match forward_hosted_request(bridge, payload, "execute") {
        Ok(()) => NotebookResponse::CellQueued {
            cell_id: cell_id.to_string(),
            execution_id,
        },
        Err(response) => *response,
    }
}

async fn handle_hosted_run_all_cells(
    room: &Arc<NotebookRoom>,
    bridge: &crate::notebook_sync_server::HostedBridgeHandle,
    requested_execution_ids: Option<&HashMap<String, String>>,
    guarded_observed_heads: Option<&[String]>,
) -> NotebookResponse {
    let code_cell_ids: Vec<String> = {
        let doc = room.doc.read().await;
        doc.get_cells()
            .into_iter()
            .filter(|cell| cell.cell_type == "code")
            .map(|cell| cell.id)
            .collect()
    };

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
    let supplied = match validate_hosted_run_all_execution_ids(
        requested_execution_ids,
        &existing_execution_ids,
    ) {
        Ok(supplied) => supplied,
        Err(response) => return *response,
    };

    let mut allocated_execution_ids = existing_execution_ids;
    allocated_execution_ids.extend(supplied);
    let mut cell_execution_ids = HashMap::with_capacity(code_cell_ids.len());
    let mut queued = Vec::with_capacity(code_cell_ids.len());
    for cell_id in code_cell_ids {
        let execution_id = match requested_execution_ids.and_then(|ids| ids.get(&cell_id)) {
            Some(execution_id) => execution_id.clone(),
            None => match allocate_hosted_execution_id(&mut allocated_execution_ids) {
                Some(execution_id) => execution_id,
                None => {
                    return NotebookResponse::Error {
                        error: "failed to allocate unique execution_id".to_string(),
                    };
                }
            },
        };
        cell_execution_ids.insert(cell_id.clone(), execution_id.clone());
        queued.push(ProtocolQueueEntry {
            cell_id,
            execution_id,
        });
    }

    let action = if guarded_observed_heads.is_some() {
        "run_all_cells_guarded"
    } else {
        "run_all_cells"
    };
    let mut payload = serde_json::json!({
        "action": action,
        "cell_execution_ids": cell_execution_ids,
    });
    if let Some(observed_heads) = guarded_observed_heads {
        payload["observed_heads"] = serde_json::json!(observed_heads);
    }

    match forward_hosted_request(bridge, payload, "run_all_cells") {
        Ok(()) => {
            // The cloud room may skip already-active cells for idempotency, so
            // this list records the request sent across the bridge, not a receipt.
            NotebookResponse::AllCellsQueued { queued }
        }
        Err(response) => *response,
    }
}

fn handle_hosted_interrupt_execution(
    bridge: &crate::notebook_sync_server::HostedBridgeHandle,
) -> NotebookResponse {
    let payload = serde_json::json!({
        "action": "interrupt_execution",
    });
    match forward_hosted_request(bridge, payload, "interrupt") {
        // Best-effort: the room relays to the attached runtime peer and
        // rejects the frame if none is attached.
        Ok(()) => NotebookResponse::InterruptSent {},
        Err(response) => *response,
    }
}

fn handle_hosted_send_comm(
    bridge: &crate::notebook_sync_server::HostedBridgeHandle,
    message: &notebook_protocol::protocol::CommRequestMessage,
) -> NotebookResponse {
    let payload = serde_json::json!({
        "action": "send_comm",
        "message": message,
    });
    match forward_hosted_request(bridge, payload, "send_comm") {
        Ok(()) => NotebookResponse::Ok {},
        Err(response) => *response,
    }
}

/// Handle a NotebookRequest and return a NotebookResponse.
pub(crate) async fn handle_notebook_request(
    room: &Arc<NotebookRoom>,
    request: NotebookRequest,
    daemon: Arc<Daemon>,
    submitter_actor_label: Option<&str>,
) -> NotebookResponse {
    debug!(
        "[notebook-sync] Handling request: {}",
        request_label(&request)
    );

    // Hosted-bridged rooms have no local kernel authority: the cloud room
    // owns execution dispatch and RuntimeStateDoc. Execute requests are
    // forwarded across the bridge; kernel-lifecycle requests are rejected
    // with an actionable message instead of launching a local kernel that
    // would fight the cloud room over runtime state.
    if let Some(bridge) = daemon.hosted_bridge_for_room(room.id).await {
        match &request {
            NotebookRequest::ExecuteCell {
                cell_id,
                execution_id,
            } => {
                return handle_hosted_execute_cell(&bridge, cell_id, execution_id.as_deref(), None)
                    .await;
            }
            NotebookRequest::ExecuteCellGuarded {
                cell_id,
                execution_id,
                observed_heads,
            } => {
                return handle_hosted_execute_cell(
                    &bridge,
                    cell_id,
                    execution_id.as_deref(),
                    Some(observed_heads),
                )
                .await;
            }
            NotebookRequest::RunAllCells { cell_execution_ids } => {
                return handle_hosted_run_all_cells(
                    room,
                    &bridge,
                    cell_execution_ids.as_ref(),
                    None,
                )
                .await;
            }
            NotebookRequest::RunAllCellsGuarded {
                cell_execution_ids,
                observed_heads,
            } => {
                return handle_hosted_run_all_cells(
                    room,
                    &bridge,
                    cell_execution_ids.as_ref(),
                    Some(observed_heads),
                )
                .await;
            }
            NotebookRequest::InterruptExecution {} => {
                return handle_hosted_interrupt_execution(&bridge);
            }
            NotebookRequest::SendComm { message } => {
                return handle_hosted_send_comm(&bridge, message);
            }
            NotebookRequest::LaunchKernel { .. }
            | NotebookRequest::ShutdownKernel {}
            | NotebookRequest::SyncEnvironment { .. }
            | NotebookRequest::SaveNotebook { .. }
            | NotebookRequest::GetHistory { .. }
            | NotebookRequest::ApplyBokehSessionPatch { .. } => {
                return NotebookResponse::Error {
                    error: format!(
                        "{} is not supported on a daemon-bridged hosted notebook yet; \
                         the cloud room owns runtime and persistence",
                        request_label(&request)
                    ),
                };
            }
            // Document-local requests (doc bytes, blob upload, trust,
            // completion against no kernel, clone) keep their normal local
            // handling below.
            _ => {}
        }
    }

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
            let disable_auto_format = {
                let settings = daemon.settings.read().await;
                settings.get_all().disable_auto_format
            };
            execute_cell::handle_with_submitter(
                room,
                cell_id,
                execution_id,
                disable_auto_format,
                submitter_actor_label,
            )
            .await
        }

        NotebookRequest::ExecuteCellGuarded {
            cell_id,
            execution_id,
            observed_heads,
        } => {
            let disable_auto_format = {
                let settings = daemon.settings.read().await;
                settings.get_all().disable_auto_format
            };
            execute_cell::handle_guarded_with_submitter(
                room,
                cell_id,
                execution_id,
                observed_heads,
                disable_auto_format,
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

        NotebookRequest::ApplyBokehSessionPatch { request } => {
            apply_bokeh_session_patch::handle(room, *request).await
        }

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

        NotebookRequest::GetDocBytes {} => get_doc_bytes::handle(room).await,

        NotebookRequest::CreateBlobUpload { .. }
        | NotebookRequest::CompleteBlobUpload { .. }
        | NotebookRequest::AbortBlobUpload { .. } => NotebookResponse::BlobUploadError {
            reason: BlobUploadErrorKind::UnknownUpload,
        },
    }
}
