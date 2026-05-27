use std::collections::HashMap;

use automerge::sync;
use nteract_identity::ConnectionScope;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use notebook_doc::diff::extract_change_actors;
use notebook_protocol::connection::NotebookFrameType;
use runtime_doc::{
    runtime_state_policy_snapshot, validate_runtime_state_sync_scope, RuntimeStateWriteScope,
};

use super::peer_writer::PeerWriter;
use super::{NotebookRoom, RoomConnectionIdentity};

type PersistedExecutionRecords = HashMap<String, runtimed_client::execution_store::ExecutionRecord>;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct RuntimeFileSaveFingerprint {
    executions: Vec<RuntimeExecutionSaveFingerprint>,
}

#[derive(Debug, Clone, PartialEq)]
struct RuntimeExecutionSaveFingerprint {
    execution_id: String,
    phase: RuntimeExecutionSavePhase,
    execution_count: Option<i64>,
    seq: Option<u64>,
    outputs: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeExecutionSavePhase {
    InFlightEmpty,
    TerminalEmpty,
    HasOutputs,
    Other,
}

pub(super) fn runtime_file_save_fingerprint(
    state_doc: &runtime_doc::RuntimeStateDoc,
) -> RuntimeFileSaveFingerprint {
    let mut executions = state_doc
        .read_state()
        .executions
        .into_iter()
        .map(|(execution_id, exec)| {
            let phase = if !exec.outputs.is_empty() {
                RuntimeExecutionSavePhase::HasOutputs
            } else if exec.status == "queued" || exec.status == "running" {
                RuntimeExecutionSavePhase::InFlightEmpty
            } else if exec.status == "done" || exec.status == "error" {
                RuntimeExecutionSavePhase::TerminalEmpty
            } else {
                RuntimeExecutionSavePhase::Other
            };
            RuntimeExecutionSaveFingerprint {
                execution_id,
                phase,
                execution_count: exec.execution_count,
                seq: exec.seq,
                outputs: exec.outputs,
            }
        })
        .collect::<Vec<_>>();
    executions.sort_by(|a, b| a.execution_id.cmp(&b.execution_id));
    RuntimeFileSaveFingerprint { executions }
}

pub(super) async fn handle_runtime_state_frame(
    room: &NotebookRoom,
    state_peer_state: &mut sync::State,
    writer: &PeerWriter,
    payload: &[u8],
    store: &runtimed_client::execution_store::ExecutionStore,
    persisted_records: &mut PersistedExecutionRecords,
    connection_identity: &RoomConnectionIdentity,
) -> anyhow::Result<bool> {
    let message =
        sync::Message::decode(payload).map_err(|e| anyhow::anyhow!("decode state sync: {}", e))?;
    let mut runtime_file_dirty = false;

    let reply_encoded = room.state.with_doc(|state_doc| {
        let before = runtime_file_save_fingerprint(state_doc);
        if !message.changes.is_empty() {
            // v1: clone-preview validator. Replace with sync_message_new_changes
            // once nteract/automerge ships Patch 1.
            let heads_before = state_doc.get_heads();
            let write_scope = runtime_state_write_scope(connection_identity.scope());
            let mut preview = runtime_doc::RuntimeStateDoc::from_doc(state_doc.doc().clone());
            let mut preview_peer_state = state_peer_state.clone();
            match preview.receive_sync_message_with_changes_recovering(
                &mut preview_peer_state,
                message.clone(),
                "state-auth-preview",
            ) {
                Ok(true) => {
                    let actors = extract_change_actors(preview.doc_mut(), &heads_before);
                    connection_identity
                        .validate_actor_labels(actors.iter().map(std::string::String::as_str))
                        .map_err(|error| {
                            runtime_doc::RuntimeStateError::UnauthorizedActor(error.to_string())
                        })?;
                    let state_before = runtime_state_policy_snapshot(state_doc);
                    let state_after = runtime_state_policy_snapshot(&preview);
                    validate_runtime_state_sync_scope(&state_before, &state_after, write_scope)?;
                    // `with_doc` holds the RuntimeStateDoc lock for the whole
                    // preview/apply sequence, so the validated message and peer
                    // state cannot diverge through another writer before apply.
                }
                Ok(false) => {}
                Err(e) => {
                    warn!("[notebook-sync] state auth preview failed: {}", e);
                    return Err(e.into());
                }
            }
        }
        let had_changes = match state_doc.receive_sync_message_with_changes_recovering(
            state_peer_state,
            message,
            "state-receive-sync",
        ) {
            Ok(changed) => changed,
            Err(e) => {
                warn!("[notebook-sync] state receive_sync_message error: {}", e);
                return Err(e.into());
            }
        };

        // If the client sent changes, notification is automatic via the
        // heads comparison in RuntimeStateDoc::with_doc.
        if had_changes && runtime_file_save_fingerprint(state_doc) != before {
            runtime_file_dirty = true;
        }

        generate_runtime_state_sync_message(state_doc, state_peer_state, "state-sync-reply")
    })?;

    if let Some(encoded) = reply_encoded {
        writer.send_frame(NotebookFrameType::RuntimeStateSync, encoded)?;
    }
    if runtime_file_dirty {
        let _ = room.broadcasts.file_dirty_tx.send(());
    }

    persist_terminal_execution_records(room, store, persisted_records).await;
    Ok(true)
}

pub(super) async fn forward_runtime_state_broadcast(
    room: &NotebookRoom,
    peer_id: &str,
    state_peer_state: &mut sync::State,
    writer: &PeerWriter,
    result: Result<(), broadcast::error::RecvError>,
) -> anyhow::Result<bool> {
    match result {
        Ok(()) => {
            send_runtime_state_sync_update(room, state_peer_state, writer, "state-broadcast")?;
        }
        Err(broadcast::error::RecvError::Lagged(n)) => {
            debug!(
                "[notebook-sync] Peer {} lagged {} runtime state updates",
                peer_id, n
            );
            send_runtime_state_sync_update(
                room,
                state_peer_state,
                writer,
                "state-broadcast-lagged",
            )?;
        }
        Err(broadcast::error::RecvError::Closed) => {
            // State change channel closed — room is being evicted.
            return Ok(false);
        }
    }
    Ok(true)
}

fn send_runtime_state_sync_update(
    room: &NotebookRoom,
    state_peer_state: &mut sync::State,
    writer: &PeerWriter,
    label: &str,
) -> anyhow::Result<()> {
    let encoded = room.state.with_doc(|state_doc| {
        generate_runtime_state_sync_message(state_doc, state_peer_state, label)
    })?;
    if let Some(encoded) = encoded {
        writer.send_frame(NotebookFrameType::RuntimeStateSync, encoded)?;
    }
    Ok(())
}

fn runtime_state_write_scope(scope: ConnectionScope) -> RuntimeStateWriteScope {
    match scope {
        ConnectionScope::Viewer => RuntimeStateWriteScope::Viewer,
        ConnectionScope::Editor => RuntimeStateWriteScope::Editor,
        ConnectionScope::RuntimePeer => RuntimeStateWriteScope::RuntimePeer,
        ConnectionScope::Owner => RuntimeStateWriteScope::Owner,
    }
}

fn generate_runtime_state_sync_message(
    state_doc: &mut runtime_doc::RuntimeStateDoc,
    state_peer_state: &mut sync::State,
    label: &str,
) -> Result<Option<Vec<u8>>, runtime_doc::RuntimeStateError> {
    match state_doc.generate_sync_message_recovering(state_peer_state, label) {
        Ok(message) => Ok(message.map(|msg| msg.encode())),
        Err(e) => {
            warn!(
                "[notebook-sync] runtime state sync generation failed: {}",
                e
            );
            Err(e.into())
        }
    }
}

pub(super) async fn persist_terminal_execution_records(
    room: &NotebookRoom,
    store: &runtimed_client::execution_store::ExecutionStore,
    persisted_records: &mut PersistedExecutionRecords,
) {
    let notebook_path = room
        .file_binding
        .path()
        .await
        .map(|p| p.to_string_lossy().to_string());
    let context_id = notebook_execution_context_id(room, notebook_path.as_deref());
    let records = room
        .state
        .read(|sd| {
            sd.read_state()
                .executions
                .into_iter()
                .filter_map(|(execution_id, exec)| {
                    if !matches!(exec.status.as_str(), "done" | "error") {
                        return None;
                    }
                    Some(
                        runtimed_client::execution_store::ExecutionRecord::from_execution_state(
                            &execution_id,
                            "notebook",
                            context_id.clone(),
                            notebook_path.clone(),
                            &exec,
                        ),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for record in records {
        if persisted_records
            .get(&record.execution_id)
            .is_some_and(|existing| existing.payload_matches(&record))
        {
            continue;
        }
        if let Err(e) = store.write_record(record.clone()).await {
            warn!(
                "[execution-store] Failed to persist execution record: {}",
                e
            );
        } else {
            persisted_records.insert(record.execution_id.clone(), record);
        }
    }
}

pub(crate) fn notebook_execution_context_id(
    room: &NotebookRoom,
    notebook_path: Option<&str>,
) -> String {
    notebook_path
        .map(str::to_string)
        .unwrap_or_else(|| room.id.to_string())
}
