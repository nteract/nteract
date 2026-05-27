use std::collections::HashMap;

use automerge::{sync, ObjType, ReadDoc, Value, ROOT};
use nteract_identity::ConnectionScope;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use notebook_doc::diff::extract_change_actors;
use notebook_protocol::connection::NotebookFrameType;
use runtime_doc::{CommDocEntry, RuntimeState, RuntimeStateError};

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

#[derive(Debug, Clone, PartialEq)]
struct RuntimeStatePolicySnapshot {
    state: RuntimeState,
    display_index: Option<Vec<(String, Vec<(String, String)>)>>,
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
            let state_before = runtime_state_policy_snapshot(state_doc);
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
                    let state_after = runtime_state_policy_snapshot(&preview);
                    validate_runtime_state_sync_scope(
                        &state_before,
                        &state_after,
                        connection_identity.scope(),
                    )?;
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

fn runtime_state_policy_snapshot(
    state_doc: &runtime_doc::RuntimeStateDoc,
) -> RuntimeStatePolicySnapshot {
    RuntimeStatePolicySnapshot {
        state: state_doc.read_state(),
        display_index: display_index_policy_snapshot(state_doc.doc()),
    }
}

fn display_index_policy_snapshot(
    doc: &automerge::AutoCommit,
) -> Option<Vec<(String, Vec<(String, String)>)>> {
    let Some((Value::Object(ObjType::Map), display_index_obj)) =
        doc.get(&ROOT, "display_index").ok().flatten()
    else {
        return None;
    };

    let mut display_index = Vec::new();
    for display_id in doc.keys(&display_index_obj) {
        let mut entries = Vec::new();
        match doc
            .get(&display_index_obj, display_id.as_str())
            .ok()
            .flatten()
        {
            Some((Value::Object(ObjType::Map), entries_obj)) => {
                for entry_key in doc.keys(&entries_obj) {
                    let value_repr = doc
                        .get(&entries_obj, entry_key.as_str())
                        .ok()
                        .flatten()
                        .map(|(value, _)| value.to_string())
                        .unwrap_or_else(|| "<missing>".to_string());
                    entries.push((entry_key, value_repr));
                }
            }
            Some((value, _)) => {
                entries.push((
                    "<invalid-display-index-node>".to_string(),
                    value.to_string(),
                ));
            }
            None => {
                entries.push((
                    "<missing-display-index-node>".to_string(),
                    "<missing>".to_string(),
                ));
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        display_index.push((display_id, entries));
    }
    display_index.sort_by(|a, b| a.0.cmp(&b.0));
    Some(display_index)
}

fn validate_runtime_state_sync_scope(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: ConnectionScope,
) -> Result<(), RuntimeStateError> {
    match scope {
        ConnectionScope::RuntimePeer => Ok(()),
        ConnectionScope::Editor | ConnectionScope::Owner => {
            validate_comm_state_only_runtime_delta(before, after, scope)
        }
        ConnectionScope::Viewer => {
            if before == after {
                Ok(())
            } else {
                Err(runtime_state_policy_error(
                    scope,
                    "runtime state",
                    "viewer connections are read-only",
                ))
            }
        }
    }
}

fn validate_comm_state_only_runtime_delta(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: ConnectionScope,
) -> Result<(), RuntimeStateError> {
    if before.state.kernel != after.state.kernel {
        return Err(runtime_state_policy_error(scope, "kernel", "daemon-owned"));
    }
    if before.state.executions != after.state.executions {
        return Err(runtime_state_policy_error(
            scope,
            "executions",
            "execution intent must go through ExecuteCell or RunAllCells",
        ));
    }
    if before.state.queue != after.state.queue {
        return Err(runtime_state_policy_error(scope, "queue", "daemon-owned"));
    }
    if before.state.env != after.state.env {
        return Err(runtime_state_policy_error(scope, "env", "daemon-owned"));
    }
    if before.state.trust != after.state.trust {
        return Err(runtime_state_policy_error(scope, "trust", "daemon-owned"));
    }
    if before.state.last_saved != after.state.last_saved {
        return Err(runtime_state_policy_error(
            scope,
            "last_saved",
            "daemon-owned",
        ));
    }
    if before.state.path != after.state.path {
        return Err(runtime_state_policy_error(scope, "path", "daemon-owned"));
    }
    if before.state.project_context != after.state.project_context {
        return Err(runtime_state_policy_error(
            scope,
            "project_context",
            "daemon-owned",
        ));
    }
    if before.display_index != after.display_index {
        return Err(runtime_state_policy_error(
            scope,
            "display_index",
            "output routing is daemon-owned",
        ));
    }

    if before.state.comms.len() != after.state.comms.len() {
        return Err(runtime_state_policy_error(
            scope,
            "comms",
            "only existing comm state properties are writable",
        ));
    }

    for (comm_id, before_comm) in &before.state.comms {
        let Some(after_comm) = after.state.comms.get(comm_id) else {
            return Err(runtime_state_policy_error(
                scope,
                "comms",
                "comm entries cannot be removed by editor sync",
            ));
        };
        validate_comm_metadata_unchanged(scope, comm_id, before_comm, after_comm)?;
    }

    Ok(())
}

fn validate_comm_metadata_unchanged(
    scope: ConnectionScope,
    comm_id: &str,
    before: &CommDocEntry,
    after: &CommDocEntry,
) -> Result<(), RuntimeStateError> {
    let metadata_unchanged = before.target_name == after.target_name
        && before.model_module == after.model_module
        && before.model_name == after.model_name
        && before.outputs == after.outputs
        && before.seq == after.seq
        && before.capture_msg_id == after.capture_msg_id;

    if metadata_unchanged {
        Ok(())
    } else {
        Err(runtime_state_policy_error(
            scope,
            "comms",
            &format!("comm metadata is daemon/runtime-owned for {comm_id}"),
        ))
    }
}

fn runtime_state_policy_error(
    scope: ConnectionScope,
    field: &str,
    reason: &str,
) -> RuntimeStateError {
    RuntimeStateError::UnauthorizedActor(format!(
        "scope {} cannot write RuntimeStateDoc {field}: {reason}",
        scope.as_str()
    ))
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

#[cfg(test)]
mod tests {
    use super::*;
    use nteract_identity::ConnectionScope;
    use runtime_doc::RuntimeStateDoc;
    use serde_json::json;

    #[test]
    fn editor_runtime_state_policy_rejects_execution_creation() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .create_execution_with_source("exec-forged", "print('oops')", 0)
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err = validate_runtime_state_sync_scope(&before, &after, ConnectionScope::Editor)
            .unwrap_err();

        assert!(
            err.to_string().contains("executions"),
            "error should identify execution writes: {err}"
        );
    }

    #[test]
    fn owner_runtime_state_policy_allows_existing_comm_state_update() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .put_comm(
                "comm-1",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &json!({ "value": 1, "label": "before" }),
                0,
            )
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .set_comm_state_property("comm-1", "value", &json!(2))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        validate_runtime_state_sync_scope(&before, &after, ConnectionScope::Owner).unwrap();
    }

    #[test]
    fn owner_runtime_state_policy_rejects_comm_creation() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .put_comm(
                "comm-forged",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &json!({ "value": 1 }),
                0,
            )
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, ConnectionScope::Owner).unwrap_err();

        assert!(
            err.to_string().contains("comms"),
            "error should identify comm topology writes: {err}"
        );
    }

    #[test]
    fn owner_runtime_state_policy_rejects_display_index_changes() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc.add_display_index_entry("display-1", "exec-1", "out-1");
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, ConnectionScope::Owner).unwrap_err();

        assert!(
            err.to_string().contains("display_index"),
            "error should identify display index writes: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_allows_execution_creation() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .create_execution_with_source("exec-runtime", "print('runtime')", 0)
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        validate_runtime_state_sync_scope(&before, &after, ConnectionScope::RuntimePeer).unwrap();
    }
}
