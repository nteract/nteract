use automerge::{ObjType, ReadDoc, Value, ROOT};

use crate::{ExecutionState, RuntimeState, RuntimeStateDoc, RuntimeStateError};

/// Validation for a RuntimeStateDoc root that holds extension records written
/// by runtime peers. Local and hosted ingress both reach these through
/// `validate_runtime_state_sync_scope`.
pub(crate) struct RecordRootPolicy {
    pub(crate) root_key: &'static str,
    pub(crate) validate: fn(
        &RuntimeStatePolicySnapshot,
        &RuntimeStatePolicySnapshot,
        RuntimeStateWriteScope,
    ) -> Result<(), RuntimeStateError>,
}

pub(crate) static RUNTIME_PEER_RECORD_ROOTS: &[RecordRootPolicy] =
    &[crate::bokeh_session_policy::RECORD_POLICY];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStateWriteScope {
    Viewer,
    Editor,
    RuntimePeer,
    Owner,
}

impl RuntimeStateWriteScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::RuntimePeer => "runtime_peer",
            Self::Owner => "owner",
        }
    }

    pub const fn allows_runtime_state_write(self) -> bool {
        matches!(self, Self::RuntimePeer)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeStatePolicySnapshot {
    pub(crate) state: RuntimeState,
    root_keys: Vec<String>,
    display_index: Option<Vec<DisplayIndexPolicySnapshot>>,
    local_environment_identity: Vec<Vec<(String, String)>>,
}

#[derive(Debug, Clone, PartialEq)]
struct DisplayIndexPolicySnapshot {
    display_id: String,
    entries: Vec<DisplayIndexEntryPolicySnapshot>,
}

#[derive(Debug, Clone, PartialEq)]
struct DisplayIndexEntryPolicySnapshot {
    key: String,
    value: String,
}

pub fn runtime_state_policy_snapshot(state_doc: &RuntimeStateDoc) -> RuntimeStatePolicySnapshot {
    RuntimeStatePolicySnapshot {
        state: state_doc.read_state(),
        root_keys: root_key_policy_snapshot(state_doc.doc()),
        display_index: display_index_policy_snapshot(state_doc.doc()),
        local_environment_identity: local_environment_identity_snapshot(state_doc.doc()),
    }
}

fn local_environment_identity_snapshot(doc: &automerge::AutoCommit) -> Vec<Vec<(String, String)>> {
    let mut result = Vec::new();
    let mut kernels = doc.get_all(ROOT, "kernel").unwrap_or_default();
    kernels.sort_by_key(|(_, id)| id.to_string());
    for (value, kernel) in kernels {
        result.push(vec![(value.to_string(), kernel.to_string())]);
        for field in ["environment_id", "environment_name", "python_version"] {
            let mut values: Vec<_> = doc
                .get_all(&kernel, field)
                .unwrap_or_default()
                .into_iter()
                .map(|(value, object)| (value.to_string(), object.to_string()))
                .collect();
            values.sort();
            result.push(values);
        }
    }
    result
}

fn root_key_policy_snapshot(doc: &automerge::AutoCommit) -> Vec<String> {
    let mut keys: Vec<String> = doc.keys(&ROOT).collect();
    keys.sort();
    keys
}

fn display_index_policy_snapshot(
    doc: &automerge::AutoCommit,
) -> Option<Vec<DisplayIndexPolicySnapshot>> {
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
                    entries.push(DisplayIndexEntryPolicySnapshot {
                        key: entry_key,
                        value: value_repr,
                    });
                }
            }
            Some((value, _)) => {
                entries.push(DisplayIndexEntryPolicySnapshot {
                    key: "<invalid-display-index-node>".to_string(),
                    value: value.to_string(),
                });
            }
            None => {
                entries.push(DisplayIndexEntryPolicySnapshot {
                    key: "<missing-display-index-node>".to_string(),
                    value: "<missing>".to_string(),
                });
            }
        }
        entries.sort_by(|a, b| a.key.cmp(&b.key));
        display_index.push(DisplayIndexPolicySnapshot {
            display_id,
            entries,
        });
    }
    display_index.sort_by(|a, b| a.display_id.cmp(&b.display_id));
    Some(display_index)
}

pub fn validate_runtime_state_sync_scope(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    match scope {
        RuntimeStateWriteScope::RuntimePeer => {
            validate_runtime_peer_runtime_delta(before, after, scope)
        }
        RuntimeStateWriteScope::Viewer
        | RuntimeStateWriteScope::Editor
        | RuntimeStateWriteScope::Owner => {
            if before == after {
                Ok(())
            } else {
                Err(runtime_state_policy_error(
                    scope,
                    "runtime state",
                    "RuntimeStateDoc is runtime-peer only",
                ))
            }
        }
    }
}

fn validate_runtime_peer_runtime_delta(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    validate_runtime_peer_root_keys(before, after, scope)?;

    validate_runtime_peer_execution_delta(before, after, scope)?;
    validate_runtime_peer_queue_delta(before, after, scope)?;
    validate_runtime_peer_room_host_owned_delta(before, after, scope)?;
    validate_runtime_peer_comm_state_delta(before, after, scope)?;
    validate_runtime_peer_extension_records(before, after, scope)?;

    Ok(())
}

fn validate_runtime_peer_root_keys(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    let before_keys: std::collections::BTreeSet<_> = before.root_keys.iter().collect();
    let after_keys: std::collections::BTreeSet<_> = after.root_keys.iter().collect();

    if !before_keys.is_subset(&after_keys) {
        return Err(runtime_state_policy_error(
            scope,
            "schema",
            "raw RuntimeStateDoc root keys cannot be removed by a runtime peer",
        ));
    }

    if after_keys.difference(&before_keys).any(|key| {
        !RUNTIME_PEER_RECORD_ROOTS
            .iter()
            .any(|policy| policy.root_key == key.as_str())
    }) {
        return Err(runtime_state_policy_error(
            scope,
            "schema",
            "raw RuntimeStateDoc root keys are room-host/daemon-owned",
        ));
    }

    Ok(())
}

fn validate_runtime_peer_room_host_owned_delta(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    // Runtime peers own kernel-facing state: lifecycle/activity, output
    // routing, comm topology, and accepted execution progress. Room hosts and
    // local daemons still own deployment metadata and trust/environment facts.
    if before.local_environment_identity != after.local_environment_identity {
        return Err(runtime_state_policy_error(
            scope,
            "local environment identity",
            "room-host/daemon-owned",
        ));
    }
    if before.state.env != after.state.env {
        return Err(runtime_state_policy_error(
            scope,
            "env",
            "room-host/daemon-owned",
        ));
    }
    if before.state.trust != after.state.trust {
        return Err(runtime_state_policy_error(
            scope,
            "trust",
            "room-host/daemon-owned",
        ));
    }
    if before.state.runtime_state_doc_id != after.state.runtime_state_doc_id {
        return Err(runtime_state_policy_error(
            scope,
            "runtime_state_doc_id",
            "room-host/daemon-owned",
        ));
    }
    if before.state.last_saved != after.state.last_saved {
        return Err(runtime_state_policy_error(
            scope,
            "last_saved",
            "room-host/daemon-owned",
        ));
    }
    if before.state.file_checkpoint != after.state.file_checkpoint {
        return Err(runtime_state_policy_error(
            scope,
            "file_checkpoint",
            "room-host/daemon-owned",
        ));
    }
    if before.state.project_trust != after.state.project_trust {
        return Err(runtime_state_policy_error(
            scope,
            "project_trust",
            "room-host/daemon-owned",
        ));
    }
    if before.state.path != after.state.path {
        return Err(runtime_state_policy_error(
            scope,
            "path",
            "room-host/daemon-owned",
        ));
    }
    if before.state.project_context != after.state.project_context {
        return Err(runtime_state_policy_error(
            scope,
            "project_context",
            "room-host/daemon-owned",
        ));
    }
    if before.state.workstation != after.state.workstation {
        return Err(runtime_state_policy_error(
            scope,
            "workstation",
            "room-host/daemon-owned",
        ));
    }

    Ok(())
}

fn validate_runtime_peer_execution_delta(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    for execution_id in after.state.executions.keys() {
        if !before.state.executions.contains_key(execution_id) {
            return Err(runtime_state_policy_error(
                scope,
                "executions",
                "execution intent must go through ExecuteCell or RunAllCells",
            ));
        }
    }
    for execution_id in before.state.executions.keys() {
        if !after.state.executions.contains_key(execution_id) {
            return Err(runtime_state_policy_error(
                scope,
                "executions",
                "accepted execution records cannot be removed by runtime-peer sync",
            ));
        }
    }

    for (execution_id, before_execution) in &before.state.executions {
        let Some(after_execution) = after.state.executions.get(execution_id) else {
            continue;
        };
        validate_runtime_peer_execution_update(
            scope,
            execution_id,
            before_execution,
            after_execution,
        )?;
    }

    Ok(())
}

fn validate_runtime_peer_execution_update(
    scope: RuntimeStateWriteScope,
    execution_id: &str,
    before: &ExecutionState,
    after: &ExecutionState,
) -> Result<(), RuntimeStateError> {
    let provenance_unchanged = before.source == after.source
        && before.cell_id == after.cell_id
        && before.seq == after.seq
        && before.submitted_by_actor_label == after.submitted_by_actor_label;
    if !provenance_unchanged {
        return Err(runtime_state_policy_error(
            scope,
            "executions",
            &format!("accepted execution provenance is coordinator-owned for {execution_id}"),
        ));
    }

    if !runtime_peer_status_transition_allowed(&before.status, &after.status) {
        return Err(runtime_state_policy_error(
            scope,
            "executions",
            &format!(
                "invalid runtime-peer status transition for {execution_id}: {} -> {}",
                before.status, after.status
            ),
        ));
    }

    if matches!(before.status.as_str(), "done" | "error")
        && before.status == after.status
        && (before.success != after.success || before.execution_count != after.execution_count)
    {
        return Err(runtime_state_policy_error(
            scope,
            "executions",
            &format!("terminal execution result metadata is immutable for {execution_id}"),
        ));
    }
    if matches!(before.status.as_str(), "done" | "error")
        && before.status == after.status
        && !runtime_peer_outputs_preserved_prefix(&before.outputs, &after.outputs)
    {
        return Err(runtime_state_policy_error(
            scope,
            "executions",
            &format!("terminal execution outputs permit only append or display data updates for {execution_id}"),
        ));
    }

    Ok(())
}

fn runtime_peer_outputs_preserved_prefix(
    before: &[serde_json::Value],
    after: &[serde_json::Value],
) -> bool {
    before.len() <= after.len()
        && before
            .iter()
            .zip(after.iter())
            .all(|(before_output, after_output)| {
                before_output == after_output
                    || runtime_peer_display_update_allowed(before_output, after_output)
            })
}

// IPython display handles remain live after the creating execution finishes.
// Permit only their payload/metadata to change, never output identity, type,
// display ID, ordering, execution result, or accepted-source provenance.
fn runtime_peer_display_update_allowed(
    before: &serde_json::Value,
    after: &serde_json::Value,
) -> bool {
    if !matches!(
        before.get("output_type").and_then(|v| v.as_str()),
        Some("display_data" | "execute_result")
    ) || before
        .pointer("/transient/display_id")
        .and_then(|v| v.as_str())
        .is_none_or(str::is_empty)
        || !after.get("data").is_some_and(|v| v.is_object())
        || !after.get("metadata").is_some_and(|v| v.is_object())
    {
        return false;
    }
    let (Some(mut before), Some(mut after)) =
        (before.as_object().cloned(), after.as_object().cloned())
    else {
        return false;
    };
    for key in ["data", "metadata"] {
        before.remove(key);
        after.remove(key);
    }
    before == after
}

fn runtime_peer_status_transition_allowed(before: &str, after: &str) -> bool {
    if before == after {
        // Same-status updates are permitted so accepted executions can receive
        // append-only output/display-index hydration without inventing a
        // second terminal transition. Terminal result fields are checked
        // separately above.
        return true;
    }

    matches!(
        (before, after),
        ("queued", "running")
            | ("queued", "done")
            | ("queued", "error")
            | ("queued", "cancelled")
            | ("running", "done")
            | ("running", "error")
    )
}

fn validate_runtime_peer_queue_delta(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    if before.state.queue == after.state.queue {
        return Ok(());
    }

    let mut seen = std::collections::BTreeSet::new();
    let entries = after
        .state
        .queue
        .executing
        .iter()
        .chain(after.state.queue.queued.iter());
    for entry in entries {
        if !seen.insert(entry.execution_id.as_str()) {
            return Err(runtime_state_policy_error(
                scope,
                "queue",
                "queue entries must not repeat an execution id",
            ));
        }

        // The coupled before/after check is intentional: `before` proves the
        // coordinator accepted the execution id, while `after` proves terminal
        // executions are not still present in queue projection.
        if !before.state.executions.contains_key(&entry.execution_id) {
            return Err(runtime_state_policy_error(
                scope,
                "queue",
                "queue entries must reference executions accepted through ExecuteCell or RunAllCells",
            ));
        };
        let Some(execution_after) = after.state.executions.get(&entry.execution_id) else {
            return Err(runtime_state_policy_error(
                scope,
                "queue",
                "queue entries must reference existing executions",
            ));
        };
        if matches!(
            execution_after.status.as_str(),
            "done" | "error" | "cancelled"
        ) {
            return Err(runtime_state_policy_error(
                scope,
                "queue",
                "terminal executions cannot be re-queued by runtime-peer sync",
            ));
        }
    }

    Ok(())
}

fn validate_runtime_peer_comm_state_delta(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    for (comm_id, after_comm) in &after.state.comms {
        if let Some(before_comm) = before.state.comms.get(comm_id) {
            if before_comm.state != after_comm.state {
                return Err(runtime_state_policy_error(
                    scope,
                    "comms",
                    &format!("comm state moved to CommsDoc for {comm_id}"),
                ));
            }
        } else if !after_comm
            .state
            .as_object()
            .is_some_and(|state| state.is_empty())
        {
            return Err(runtime_state_policy_error(
                scope,
                "comms",
                &format!("new RuntimeStateDoc comm state must be empty for {comm_id}"),
            ));
        }
    }

    Ok(())
}

fn validate_runtime_peer_extension_records(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    RUNTIME_PEER_RECORD_ROOTS
        .iter()
        .try_for_each(|policy| (policy.validate)(before, after, scope))
}

pub(crate) fn runtime_state_policy_error(
    scope: RuntimeStateWriteScope,
    field: &str,
    reason: &str,
) -> RuntimeStateError {
    RuntimeStateError::UnauthorizedActor(format!(
        "scope {} cannot write RuntimeStateDoc {field}: {reason}",
        scope.as_str()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        FileSourceIssue, KernelActivity, ProjectContext, QueueEntry, RuntimeLifecycle,
        WorkstationAttachmentState,
    };
    use automerge::transaction::Transactable;
    use serde_json::json;

    #[test]
    fn editor_runtime_state_policy_rejects_execution_creation() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .create_execution_with_source("exec-forged", "print('oops')", 0)
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Editor)
                .unwrap_err();

        assert!(
            err.to_string()
                .contains("RuntimeStateDoc is runtime-peer only"),
            "error should identify RuntimeStateDoc ownership policy: {err}"
        );
    }

    #[test]
    fn owner_runtime_state_policy_rejects_existing_comm_state_update() {
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

        let err = validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Owner)
            .unwrap_err();

        assert!(
            err.to_string().contains("runtime state"),
            "error should identify document-level rejection: {err}"
        );
    }

    #[test]
    fn runtime_peer_runtime_state_policy_rejects_comm_state_update() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .put_comm(
                "comm-1",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &json!({}),
                0,
            )
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .set_comm_state_property("comm-1", "value", &json!(2))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("CommsDoc"),
            "error should point comm state to CommsDoc: {err}"
        );
    }

    #[test]
    fn runtime_peer_runtime_state_policy_allows_empty_comm_topology_creation() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .put_comm(
                "comm-1",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &json!({}),
                0,
            )
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
            .unwrap();
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

        let err = validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Owner)
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("RuntimeStateDoc is runtime-peer only"),
            "error should identify RuntimeStateDoc ownership policy: {err}"
        );
    }

    #[test]
    fn owner_runtime_state_policy_rejects_display_index_changes() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc.add_display_index_entry("display-1", "exec-1", "out-1");
        let after = runtime_state_policy_snapshot(&after_doc);

        let err = validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Owner)
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("RuntimeStateDoc is runtime-peer only"),
            "error should identify RuntimeStateDoc ownership policy: {err}"
        );
    }

    #[test]
    fn owner_runtime_state_policy_rejects_identity_rewrites() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .set_runtime_state_doc_id(Some("runtime:nb-1"))
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .set_runtime_state_doc_id(Some("runtime:nb-2"))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err = validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Owner)
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("RuntimeStateDoc is runtime-peer only"),
            "error should identify RuntimeStateDoc ownership policy: {err}"
        );
    }

    #[test]
    fn owner_runtime_state_policy_rejects_hidden_root_keys() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .doc_mut()
            .put(ROOT, "future_root_key", "hidden")
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err = validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Owner)
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("RuntimeStateDoc is runtime-peer only"),
            "error should identify RuntimeStateDoc ownership policy: {err}"
        );
    }

    #[test]
    fn runtime_peer_may_add_only_registered_record_roots() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        for policy in RUNTIME_PEER_RECORD_ROOTS {
            let mut after_doc = RuntimeStateDoc::new();
            after_doc
                .doc_mut()
                .put_object(ROOT, policy.root_key, ObjType::Map)
                .unwrap();
            let after = runtime_state_policy_snapshot(&after_doc);
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap();
        }

        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .doc_mut()
            .put_object(ROOT, "future_records", ObjType::Map)
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);
        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(err
            .to_string()
            .contains("root keys are room-host/daemon-owned"));
    }

    #[test]
    fn viewer_runtime_state_policy_rejects_comm_state_update() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .put_comm(
                "comm-1",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &json!({ "value": 1 }),
                0,
            )
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .set_comm_state_property("comm-1", "value", &json!(2))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Viewer)
                .unwrap_err();

        assert!(
            err.to_string()
                .contains("RuntimeStateDoc is runtime-peer only"),
            "error should identify RuntimeStateDoc ownership policy: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_rejects_execution_creation() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .create_execution_with_source("exec-runtime", "print('runtime')", 0)
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("executions"),
            "error should identify execution intent writes: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_allows_existing_execution_progress_and_output() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .create_execution_with_source("exec-accepted", "print('accepted')", 0)
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc.set_execution_running("exec-accepted").unwrap();
        after_doc.set_execution_count("exec-accepted", 7).unwrap();
        after_doc
            .append_output(
                "exec-accepted",
                &json!({
                    "output_type": "stream",
                    "output_id": "out-stdout-1",
                    "name": "stdout",
                    "text": "accepted\n"
                }),
            )
            .unwrap();
        after_doc.set_execution_done("exec-accepted", true).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
            .unwrap();
    }

    #[test]
    fn runtime_peer_policy_allows_queued_execution_cancellation() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .create_execution_with_source("exec-accepted", "print('accepted')", 0)
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc.set_execution_cancelled("exec-accepted").unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
            .unwrap();
    }

    #[test]
    fn runtime_peer_policy_allows_kernel_comm_and_display_state() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        after_doc
            .put_comm(
                "comm-1",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &json!({}),
                0,
            )
            .unwrap();
        after_doc.add_display_index_entry("display-1", "exec-accepted", "out-1");
        let after = runtime_state_policy_snapshot(&after_doc);

        validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
            .unwrap();
    }

    #[test]
    fn runtime_peer_cannot_replace_kernel_parent_of_daemon_identity() {
        let before_doc = RuntimeStateDoc::new();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc.doc_mut().put(ROOT, "kernel", 42).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);
        assert!(validate_runtime_state_sync_scope(
            &before,
            &after,
            RuntimeStateWriteScope::RuntimePeer
        )
        .is_err());
    }

    #[test]
    fn runtime_peer_cannot_hide_local_identity_writes_with_non_string_values() {
        let before_doc = RuntimeStateDoc::new();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let kernel = match after_doc.doc().get(ROOT, "kernel").unwrap().unwrap() {
            (Value::Object(ObjType::Map), id) => id,
            other => panic!("expected kernel map, got {other:?}"),
        };
        after_doc
            .doc_mut()
            .put(&kernel, "environment_id", 42)
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);
        assert!(validate_runtime_state_sync_scope(
            &before,
            &after,
            RuntimeStateWriteScope::RuntimePeer
        )
        .is_err());
    }

    #[test]
    fn runtime_peer_cannot_rewrite_local_environment_identity() {
        for field in ["environment_id", "environment_name", "python_version"] {
            let before_doc = RuntimeStateDoc::new();
            let before = runtime_state_policy_snapshot(&before_doc);
            let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
            let kernel = match after_doc.doc().get(ROOT, "kernel").unwrap().unwrap() {
                (Value::Object(ObjType::Map), id) => id,
                other => panic!("expected kernel map, got {other:?}"),
            };
            after_doc.doc_mut().put(&kernel, field, "forged").unwrap();
            let after = runtime_state_policy_snapshot(&after_doc);
            assert!(
                validate_runtime_state_sync_scope(
                    &before,
                    &after,
                    RuntimeStateWriteScope::RuntimePeer
                )
                .is_err(),
                "runtime peers must not author daemon-owned {field}"
            );
        }
    }

    #[test]
    fn runtime_peer_policy_rejects_room_host_owned_state() {
        assert_runtime_peer_rejects_field(
            |doc| doc.set_env_sync(false, &["numpy".to_string()], &[], false, false),
            "env",
        );
        assert_runtime_peer_rejects_field(|doc| doc.set_trust("trusted", false), "trust");
        assert_runtime_peer_rejects_field(
            |doc| doc.set_last_saved(Some("2026-05-27T00:00:00Z")),
            "last_saved",
        );
        assert_runtime_peer_rejects_field(|doc| doc.set_path(Some("/tmp/notebook.ipynb")), "path");
        assert_runtime_peer_rejects_field(
            |doc| {
                doc.set_project_context(&ProjectContext::NotFound {
                    observed_at: "2026-05-27T00:00:00Z".to_string(),
                })
            },
            "project_context",
        );
        assert_runtime_peer_rejects_field(
            |doc| doc.set_workstation_attachment(Some(&workstation_attachment())),
            "schema",
        );

        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .set_workstation_attachment(Some(&workstation_attachment()))
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let mut next = workstation_attachment();
        next.status = "disconnected".to_string();
        next.status_message = Some("compute disconnected: runtime peer left".to_string());
        after_doc.set_workstation_attachment(Some(&next)).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("workstation"),
            "error should identify workstation writes: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_rejects_file_checkpoint_changes() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .set_file_checkpoint(&["head-1".to_string()], 1)
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .set_file_source_issue(Some(&FileSourceIssue::Degraded {
                reason: "forged journal failure".to_string(),
            }))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("file_checkpoint"),
            "error should identify daemon-owned file checkpoint writes: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_rejects_project_trust_changes() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .set_project_trust(&crate::ProjectTrustRuntimeState {
                status: "untrusted".to_string(),
                needs_approval: true,
                ..Default::default()
            })
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .set_project_trust(&crate::ProjectTrustRuntimeState {
                status: "trusted".to_string(),
                ..Default::default()
            })
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("project_trust"),
            "error should identify daemon-owned project trust writes: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_rejects_terminal_result_rewrite() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .create_execution_with_source("exec-accepted", "print('accepted')", 0)
            .unwrap();
        before_doc.set_execution_running("exec-accepted").unwrap();
        before_doc.set_execution_count("exec-accepted", 7).unwrap();
        before_doc
            .set_execution_done("exec-accepted", true)
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let executions = match after_doc.doc().get(ROOT, "executions").unwrap().unwrap() {
            (Value::Object(ObjType::Map), id) => id,
            other => panic!("expected executions map, got {other:?}"),
        };
        let entry = match after_doc
            .doc()
            .get(&executions, "exec-accepted")
            .unwrap()
            .unwrap()
        {
            (Value::Object(ObjType::Map), id) => id,
            other => panic!("expected execution map, got {other:?}"),
        };
        after_doc.doc_mut().put(&entry, "success", false).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("terminal execution result"),
            "error should identify terminal result rewrites: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_allows_terminal_output_append() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .create_execution_with_source("exec-accepted", "print('accepted')", 0)
            .unwrap();
        before_doc.set_execution_running("exec-accepted").unwrap();
        before_doc
            .append_output(
                "exec-accepted",
                &test_stream_output("out-before", "before\n"),
            )
            .unwrap();
        before_doc
            .set_execution_done("exec-accepted", true)
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .append_output("exec-accepted", &test_stream_output("out-after", "after\n"))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
            .unwrap();
    }

    #[test]
    fn runtime_peer_policy_allows_only_payload_changes_for_terminal_displays() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("accepted", "display(value)", 0)
            .unwrap();
        doc.set_execution_running("accepted").unwrap();
        let output = serde_json::json!({"output_id": "stable", "output_type": "display_data", "transient": {"display_id": "handle"}, "data": {"text/plain": {"inline": "old"}}, "metadata": {}});
        doc.append_output("accepted", &output).unwrap();
        doc.set_execution_done("accepted", true).unwrap();
        let before = runtime_state_policy_snapshot(&doc);
        for (field, value, allowed) in [
            (
                "data",
                serde_json::json!({"text/html": {"inline": "<b>new</b>"}}),
                true,
            ),
            ("metadata", serde_json::json!({"expanded": true}), true),
            (
                "transient",
                serde_json::json!({"display_id": "other"}),
                false,
            ),
            ("output_type", serde_json::json!("stream"), false),
            ("output_id", serde_json::json!("other"), false),
            ("data", serde_json::json!("invalid"), false),
        ] {
            let mut after_doc = RuntimeStateDoc::from_doc(doc.doc().clone());
            let mut changed = output.clone();
            changed[field] = value;
            after_doc
                .replace_output("accepted", "stable", &changed)
                .unwrap();
            let after = runtime_state_policy_snapshot(&after_doc);
            assert_eq!(
                validate_runtime_state_sync_scope(
                    &before,
                    &after,
                    RuntimeStateWriteScope::RuntimePeer
                )
                .is_ok(),
                allowed,
                "field {field}"
            );
            assert!(validate_runtime_state_sync_scope(
                &before,
                &after,
                RuntimeStateWriteScope::Editor
            )
            .is_err());
            assert!(validate_runtime_state_sync_scope(
                &before,
                &after,
                RuntimeStateWriteScope::Viewer
            )
            .is_err());
        }
    }

    #[test]
    fn runtime_peer_policy_rejects_terminal_output_rewrite() {
        let mut before_doc = RuntimeStateDoc::new();
        before_doc
            .create_execution_with_source("exec-accepted", "print('accepted')", 0)
            .unwrap();
        before_doc.set_execution_running("exec-accepted").unwrap();
        before_doc
            .append_output(
                "exec-accepted",
                &test_stream_output("out-before", "before\n"),
            )
            .unwrap();
        before_doc
            .set_execution_done("exec-accepted", true)
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .append_output(
                "exec-accepted",
                &test_stream_output("out-before", "rewritten\n"),
            )
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("terminal execution outputs"),
            "error should identify terminal output rewrites: {err}"
        );
    }

    #[test]
    fn runtime_peer_policy_rejects_queue_entry_for_unaccepted_execution() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .set_queue(
                None,
                &[QueueEntry {
                    execution_id: "exec-forged".to_string(),
                }],
            )
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains("queue"),
            "error should identify queue writes: {err}"
        );
    }

    fn assert_runtime_peer_rejects_field<F>(mut mutate: F, field: &str)
    where
        F: FnMut(&mut RuntimeStateDoc) -> Result<(), RuntimeStateError>,
    {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        mutate(&mut after_doc).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let err =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();

        assert!(
            err.to_string().contains(field),
            "error should identify {field} writes: {err}"
        );
    }

    fn test_stream_output(output_id: &str, text: &str) -> serde_json::Value {
        json!({
            "output_type": "stream",
            "output_id": output_id,
            "name": "stdout",
            "text": text
        })
    }

    fn workstation_attachment() -> WorkstationAttachmentState {
        WorkstationAttachmentState {
            workstation_id: "ws-lab2".to_string(),
            display_name: "Lab 2".to_string(),
            provider: "local_daemon".to_string(),
            default_environment_label: "Current Python".to_string(),
            environment_policy: "current_python".to_string(),
            status: "ready".to_string(),
            status_message: None,
            cpu_count: Some(8),
            memory_bytes: None,
            accelerators: None,
            working_directory: None,
            updated_at: Some("2026-06-07T21:00:00Z".to_string()),
            runtime_session_id: Some("job-runtime".to_string()),
        }
    }
}
