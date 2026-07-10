use automerge::{ObjType, ReadDoc, Value, ROOT};

use crate::{
    BokehSessionContentRef, BokehSessionState, BokehSessionStatus, ExecutionState, RuntimeState,
    RuntimeStateDoc, RuntimeStateError,
};

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
    state: RuntimeState,
    root_keys: Vec<String>,
    display_index: Option<Vec<DisplayIndexPolicySnapshot>>,
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
    }
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
    validate_runtime_peer_bokeh_session_delta(before, after, scope)?;

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

    if after_keys
        .difference(&before_keys)
        .any(|key| key.as_str() != "bokeh_sessions")
    {
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
            &format!("terminal execution outputs are append-only for {execution_id}"),
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
            .all(|(before_output, after_output)| before_output == after_output)
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

fn validate_runtime_peer_bokeh_session_delta(
    before: &RuntimeStatePolicySnapshot,
    after: &RuntimeStatePolicySnapshot,
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    for session_id in before.state.bokeh_sessions.keys() {
        if !after.state.bokeh_sessions.contains_key(session_id) {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!(
                    "Bokeh session records cannot be removed by runtime-peer sync: {session_id}"
                ),
            ));
        }
    }

    for (session_id, after_session) in &after.state.bokeh_sessions {
        validate_bokeh_session_replay(scope, session_id, after_session)?;

        let Some(before_session) = before.state.bokeh_sessions.get(session_id) else {
            if !after
                .state
                .executions
                .contains_key(&after_session.execution_id)
            {
                return Err(runtime_state_policy_error(
                    scope,
                    "bokeh_sessions",
                    &format!("new Bokeh session {session_id} must reference an accepted execution"),
                ));
            }
            if after_session.status != BokehSessionStatus::Connected {
                return Err(runtime_state_policy_error(
                    scope,
                    "bokeh_sessions",
                    &format!("new Bokeh session {session_id} must start connected"),
                ));
            }
            continue;
        };

        let provenance_unchanged = before_session.output_id == after_session.output_id
            && before_session.cell_id == after_session.cell_id
            && before_session.execution_id == after_session.execution_id
            && before_session.kernel_id == after_session.kernel_id
            && before_session.producer_name == after_session.producer_name
            && before_session.producer_version == after_session.producer_version
            && before_session.bokeh_version == after_session.bokeh_version
            && before_session.root_ids == after_session.root_ids;
        if !provenance_unchanged {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!("Bokeh session provenance is immutable for {session_id}"),
            ));
        }

        if !bokeh_session_status_transition_allowed(before_session.status, after_session.status) {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!(
                    "invalid Bokeh session status transition for {session_id}: {:?} -> {:?}",
                    before_session.status, after_session.status
                ),
            ));
        }

        if before_session.status == BokehSessionStatus::Closed && before_session != after_session {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!("closed Bokeh session is immutable: {session_id}"),
            ));
        }

        if after_session.head_revision < before_session.head_revision {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!("Bokeh session revision cannot move backward: {session_id}"),
            ));
        }

        let before_checkpoint_revision = before_session
            .checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.revision)
            .unwrap_or(0);
        let after_checkpoint_revision = after_session
            .checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.revision)
            .unwrap_or(0);
        if after_checkpoint_revision < before_checkpoint_revision {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!("Bokeh session checkpoint cannot move backward: {session_id}"),
            ));
        }
    }

    Ok(())
}

fn validate_bokeh_session_replay(
    scope: RuntimeStateWriteScope,
    session_id: &str,
    session: &BokehSessionState,
) -> Result<(), RuntimeStateError> {
    if session.output_id.is_empty()
        || session.cell_id.is_empty()
        || session.execution_id.is_empty()
        || session.kernel_id.is_empty()
        || session.producer_name.is_empty()
        || session.bokeh_version.is_empty()
        || session.root_ids.is_empty()
    {
        return Err(runtime_state_policy_error(
            scope,
            "bokeh_sessions",
            &format!("Bokeh session {session_id} has incomplete topology"),
        ));
    }

    let mut replay_revision = 0;
    if let Some(checkpoint) = &session.checkpoint {
        validate_bokeh_content_ref(scope, session_id, &checkpoint.content_ref)?;
        replay_revision = checkpoint.revision;
    }

    for patch in &session.patch_tail {
        validate_bokeh_content_ref(scope, session_id, &patch.content_ref)?;
        if patch.base_revision != replay_revision || patch.revision <= patch.base_revision {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!("Bokeh session {session_id} has a non-contiguous patch tail"),
            ));
        }
        replay_revision = patch.revision;
    }

    if replay_revision != session.head_revision {
        return Err(runtime_state_policy_error(
            scope,
            "bokeh_sessions",
            &format!(
                "Bokeh session {session_id} replay ends at {replay_revision}, expected {}",
                session.head_revision
            ),
        ));
    }

    Ok(())
}

fn validate_bokeh_content_ref(
    scope: RuntimeStateWriteScope,
    session_id: &str,
    content_ref: &BokehSessionContentRef,
) -> Result<(), RuntimeStateError> {
    if content_ref.blob.is_empty() || content_ref.media_type.is_empty() {
        return Err(runtime_state_policy_error(
            scope,
            "bokeh_sessions",
            &format!("Bokeh session {session_id} has an invalid content reference"),
        ));
    }
    Ok(())
}

fn bokeh_session_status_transition_allowed(
    before: BokehSessionStatus,
    after: BokehSessionStatus,
) -> bool {
    before == after
        || matches!(
            (before, after),
            (
                BokehSessionStatus::Connected,
                BokehSessionStatus::Disconnected
            ) | (BokehSessionStatus::Connected, BokehSessionStatus::Closed)
                | (BokehSessionStatus::Connected, BokehSessionStatus::Error)
                | (BokehSessionStatus::Disconnected, BokehSessionStatus::Closed)
                | (BokehSessionStatus::Error, BokehSessionStatus::Closed)
        )
}

fn runtime_state_policy_error(
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
        BokehSessionCheckpoint, BokehSessionPatchRef, KernelActivity, ProjectContext, QueueEntry,
        RuntimeLifecycle, WorkstationAttachmentState,
    };
    use automerge::transaction::Transactable;
    use serde_json::json;

    fn bokeh_content_ref(blob: &str) -> BokehSessionContentRef {
        BokehSessionContentRef {
            blob: blob.to_string(),
            size: 128,
            media_type: "application/vnd.nteract.bokeh-state.v1+json".to_string(),
        }
    }

    fn bokeh_session(execution_id: &str) -> BokehSessionState {
        BokehSessionState {
            output_id: "output-1".to_string(),
            cell_id: "cell-1".to_string(),
            execution_id: execution_id.to_string(),
            kernel_id: "kernel-1".to_string(),
            status: BokehSessionStatus::Connected,
            head_revision: 0,
            producer_name: "panel".to_string(),
            producer_version: "1.9.3".to_string(),
            bokeh_version: "3.9.1".to_string(),
            root_ids: vec!["p1001".to_string()],
            checkpoint: Some(BokehSessionCheckpoint {
                revision: 0,
                content_ref: bokeh_content_ref("checkpoint-0"),
            }),
            patch_tail: Vec::new(),
        }
    }

    fn runtime_doc_with_accepted_execution() -> RuntimeStateDoc {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("exec-1", "slider", 0)
            .unwrap();
        doc
    }

    #[test]
    fn runtime_peer_policy_allows_bokeh_session_creation_and_revision_advance() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let mut session = bokeh_session("exec-1");
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let created = runtime_state_policy_snapshot(&after_doc);
        validate_runtime_state_sync_scope(&before, &created, RuntimeStateWriteScope::RuntimePeer)
            .unwrap();

        let before_update = created;
        session.head_revision = 1;
        session.patch_tail.push(BokehSessionPatchRef {
            base_revision: 0,
            revision: 1,
            content_ref: bokeh_content_ref("patch-1"),
        });
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let after_update = runtime_state_policy_snapshot(&after_doc);
        validate_runtime_state_sync_scope(
            &before_update,
            &after_update,
            RuntimeStateWriteScope::RuntimePeer,
        )
        .unwrap();
    }

    #[test]
    fn runtime_peer_policy_rejects_bokeh_session_for_unaccepted_execution() {
        let before = runtime_state_policy_snapshot(&RuntimeStateDoc::new());
        let mut after_doc = RuntimeStateDoc::new();
        after_doc
            .put_bokeh_session("session-forged", &bokeh_session("exec-forged"))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("accepted execution"));
    }

    #[test]
    fn runtime_peer_policy_rejects_non_contiguous_bokeh_replay() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let mut session = bokeh_session("exec-1");
        session.head_revision = 2;
        session.patch_tail.push(BokehSessionPatchRef {
            base_revision: 1,
            revision: 2,
            content_ref: bokeh_content_ref("patch-2"),
        });
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("non-contiguous"));
    }

    #[test]
    fn runtime_peer_policy_rejects_bokeh_session_provenance_rewrite() {
        let mut before_doc = runtime_doc_with_accepted_execution();
        before_doc
            .put_bokeh_session("session-1", &bokeh_session("exec-1"))
            .unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let mut session = bokeh_session("exec-1");
        session.output_id = "other-output".to_string();
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("provenance is immutable"));
    }

    #[test]
    fn editor_policy_rejects_bokeh_session_creation() {
        let mut before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        before_doc
            .put_bokeh_session("session-1", &bokeh_session("exec-1"))
            .unwrap();
        let after = runtime_state_policy_snapshot(&before_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Editor)
                .unwrap_err();
        assert!(error
            .to_string()
            .contains("RuntimeStateDoc is runtime-peer only"));
    }

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
