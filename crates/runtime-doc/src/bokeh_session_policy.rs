//! RuntimeStateDoc policy for `bokeh_sessions` records.
//!
//! Registered in `policy::RUNTIME_PEER_RECORD_ROOTS`, so local and hosted
//! runtime ingress apply it through the shared sync-scope validation.

use crate::policy::{
    runtime_state_policy_error, RecordRootPolicy, RuntimeStatePolicySnapshot,
    RuntimeStateWriteScope,
};
use crate::{
    BokehSessionContentRef, BokehSessionState, BokehSessionStatus, ExecutionState,
    RuntimeStateError, BOKEH_SESSION_MIME,
};

pub(crate) const RECORD_POLICY: RecordRootPolicy = RecordRootPolicy {
    root_key: "bokeh_sessions",
    validate: validate_runtime_peer_delta,
};

fn validate_runtime_peer_delta(
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
            let Some(execution) = after.state.executions.get(&after_session.execution_id) else {
                return Err(runtime_state_policy_error(
                    scope,
                    "bokeh_sessions",
                    &format!("new Bokeh session {session_id} must reference an accepted execution"),
                ));
            };
            if execution.cell_id.as_deref() != Some(after_session.cell_id.as_str()) {
                return Err(runtime_state_policy_error(
                    scope,
                    "bokeh_sessions",
                    &format!(
                        "new Bokeh session {session_id} must match its accepted execution cell"
                    ),
                ));
            }
            if !execution_has_bokeh_output(execution, &after_session.output_id) {
                return Err(runtime_state_policy_error(
                    scope,
                    "bokeh_sessions",
                    &format!(
                        "new Bokeh session {session_id} must reference its accepted Bokeh output"
                    ),
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

    let Some(checkpoint) = &session.checkpoint else {
        return Err(runtime_state_policy_error(
            scope,
            "bokeh_sessions",
            &format!("Bokeh session {session_id} has no checkpoint"),
        ));
    };
    validate_bokeh_content_ref(scope, session_id, &checkpoint.content_ref)?;
    let mut replay_revision = checkpoint.revision;

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

fn execution_has_bokeh_output(execution: &ExecutionState, output_id: &str) -> bool {
    execution.outputs.iter().any(|output| {
        output.get("output_id").and_then(serde_json::Value::as_str) == Some(output_id)
            && matches!(
                output
                    .get("output_type")
                    .and_then(serde_json::Value::as_str),
                Some("display_data" | "execute_result")
            )
            && output
                .get("data")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|data| data.contains_key(BOKEH_SESSION_MIME))
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{runtime_state_policy_snapshot, validate_runtime_state_sync_scope};
    use crate::{BokehSessionCheckpoint, BokehSessionPatchRef, RuntimeStateDoc};
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
        doc.create_execution_with_source_provenance("exec-1", "slider", 0, None, Some("cell-1"))
            .unwrap();
        doc
    }

    fn append_bokeh_output(doc: &mut RuntimeStateDoc, execution_id: &str, output_id: &str) {
        doc.append_output(
            execution_id,
            &json!({
                "output_type": "display_data",
                "output_id": output_id,
                "data": {
                    BOKEH_SESSION_MIME: {"inline": "{}"},
                    "text/plain": {"inline": "FloatSlider(value=4)"},
                },
            }),
        )
        .unwrap();
    }

    #[test]
    fn runtime_peer_policy_allows_bokeh_session_creation_and_revision_advance() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        append_bokeh_output(&mut after_doc, "exec-1", "output-1");
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
        append_bokeh_output(&mut after_doc, "exec-1", "output-1");
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
        append_bokeh_output(&mut before_doc, "exec-1", "output-1");
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
    fn runtime_peer_policy_rejects_bokeh_session_without_checkpoint() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        append_bokeh_output(&mut after_doc, "exec-1", "output-1");
        let mut session = bokeh_session("exec-1");
        session.checkpoint = None;
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("has no checkpoint"));
    }

    #[test]
    fn runtime_peer_policy_rejects_bokeh_session_for_another_output() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        append_bokeh_output(&mut after_doc, "exec-1", "other-output");
        after_doc
            .put_bokeh_session("session-1", &bokeh_session("exec-1"))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("accepted Bokeh output"));
    }

    #[test]
    fn runtime_peer_policy_rejects_bokeh_session_for_plain_output() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        after_doc
            .append_output(
                "exec-1",
                &json!({
                    "output_type": "display_data",
                    "output_id": "output-1",
                    "data": {"text/plain": {"inline": "not a Bokeh session"}},
                }),
            )
            .unwrap();
        after_doc
            .put_bokeh_session("session-1", &bokeh_session("exec-1"))
            .unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("accepted Bokeh output"));
    }

    #[test]
    fn runtime_peer_policy_rejects_bokeh_session_for_another_cell() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        append_bokeh_output(&mut after_doc, "exec-1", "output-1");
        let mut session = bokeh_session("exec-1");
        session.cell_id = "other-cell".to_string();
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("accepted execution cell"));
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
}
