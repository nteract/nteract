//! RuntimeStateDoc policy for `bokeh_sessions` records.
//!
//! Registered in `policy::RUNTIME_PEER_RECORD_ROOTS`, so local and hosted
//! runtime ingress apply it through the shared sync-scope validation.

use crate::policy::{
    runtime_state_policy_error, RecordRootPolicy, RuntimeStatePolicySnapshot,
    RuntimeStateWriteScope,
};
use crate::{
    BokehSessionState, BokehSessionStatus, ExecutionState, RuntimeStateError, BOKEH_SESSION_MIME,
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
        validate_bokeh_session_record(scope, session_id, after_session)?;

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

        if after_session.epoch < before_session.epoch {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!("Bokeh session epoch cannot move backward: {session_id}"),
            ));
        }
        if after_session.epoch == before_session.epoch
            && (after_session.doc_heads != before_session.doc_heads
                || after_session.previous_heads != before_session.previous_heads)
        {
            return Err(runtime_state_policy_error(
                scope,
                "bokeh_sessions",
                &format!(
                    "Bokeh session document identity changes only with its epoch: {session_id}"
                ),
            ));
        }
    }

    Ok(())
}

fn validate_bokeh_session_record(
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
    let valid_heads = |heads: &[String]| {
        heads
            .iter()
            .all(|head| head.len() == 64 && head.chars().all(|c| c.is_ascii_hexdigit()))
    };
    if session.doc_heads.is_empty()
        || !valid_heads(&session.doc_heads)
        || !valid_heads(&session.previous_heads)
        || (session.epoch == 0) != session.previous_heads.is_empty()
    {
        return Err(runtime_state_policy_error(
            scope,
            "bokeh_sessions",
            &format!("Bokeh session {session_id} has an invalid document identity"),
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
    use crate::RuntimeStateDoc;
    use serde_json::json;

    fn heads(byte: char) -> Vec<String> {
        vec![byte.to_string().repeat(64)]
    }

    fn bokeh_session(execution_id: &str) -> BokehSessionState {
        BokehSessionState {
            output_id: "output-1".to_string(),
            cell_id: "cell-1".to_string(),
            execution_id: execution_id.to_string(),
            kernel_id: "kernel-1".to_string(),
            status: BokehSessionStatus::Connected,
            producer_name: "panel".to_string(),
            producer_version: "1.9.3".to_string(),
            bokeh_version: "3.9.1".to_string(),
            root_ids: vec!["p1001".to_string()],
            epoch: 0,
            doc_heads: heads('a'),
            previous_heads: Vec::new(),
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
    fn runtime_peer_policy_allows_bokeh_session_creation_and_epoch_advance() {
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
        session.epoch = 1;
        session.previous_heads = session.doc_heads.clone();
        session.doc_heads = heads('b');
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
    fn runtime_peer_policy_rejects_bokeh_epoch_rewind_and_identity_rewrite() {
        let mut before_doc = runtime_doc_with_accepted_execution();
        append_bokeh_output(&mut before_doc, "exec-1", "output-1");
        let mut session = bokeh_session("exec-1");
        session.epoch = 2;
        session.previous_heads = heads('c');
        before_doc.put_bokeh_session("session-1", &session).unwrap();
        let before = runtime_state_policy_snapshot(&before_doc);

        let mut rewound_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let mut rewound = session.clone();
        rewound.epoch = 1;
        rewound_doc
            .put_bokeh_session("session-1", &rewound)
            .unwrap();
        let error = validate_runtime_state_sync_scope(
            &before,
            &runtime_state_policy_snapshot(&rewound_doc),
            RuntimeStateWriteScope::RuntimePeer,
        )
        .unwrap_err();
        assert!(error.to_string().contains("epoch cannot move backward"));

        let mut rewritten_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        let mut rewritten = session;
        rewritten.doc_heads = heads('d');
        rewritten_doc
            .put_bokeh_session("session-1", &rewritten)
            .unwrap();
        let error = validate_runtime_state_sync_scope(
            &before,
            &runtime_state_policy_snapshot(&rewritten_doc),
            RuntimeStateWriteScope::RuntimePeer,
        )
        .unwrap_err();
        assert!(error.to_string().contains("changes only with its epoch"));
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
    fn runtime_peer_policy_rejects_bokeh_epoch_without_previous_heads() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        append_bokeh_output(&mut after_doc, "exec-1", "output-1");
        let mut session = bokeh_session("exec-1");
        session.epoch = 2;
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("invalid document identity"));
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
    fn runtime_peer_policy_rejects_bokeh_session_without_document_identity() {
        let before_doc = runtime_doc_with_accepted_execution();
        let before = runtime_state_policy_snapshot(&before_doc);
        let mut after_doc = RuntimeStateDoc::from_doc(before_doc.doc().clone());
        append_bokeh_output(&mut after_doc, "exec-1", "output-1");
        let mut session = bokeh_session("exec-1");
        session.doc_heads = Vec::new();
        after_doc.put_bokeh_session("session-1", &session).unwrap();
        let after = runtime_state_policy_snapshot(&after_doc);

        let error =
            validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
                .unwrap_err();
        assert!(error.to_string().contains("invalid document identity"));
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
