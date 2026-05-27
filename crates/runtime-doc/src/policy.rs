use automerge::{ObjType, ReadDoc, Value, ROOT};

use crate::{CommDocEntry, RuntimeState, RuntimeStateDoc, RuntimeStateError};

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
        matches!(self, Self::Editor | Self::RuntimePeer | Self::Owner)
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
        // Runtime peers are daemon-equivalent writers for RuntimeStateDoc.
        // Hosted/cloud auth must grant this scope explicitly; it must not be
        // derived from human editor/owner roles.
        RuntimeStateWriteScope::RuntimePeer => Ok(()),
        RuntimeStateWriteScope::Editor | RuntimeStateWriteScope::Owner => {
            validate_comm_state_only_runtime_delta(before, after, scope)
        }
        RuntimeStateWriteScope::Viewer => {
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
    scope: RuntimeStateWriteScope,
) -> Result<(), RuntimeStateError> {
    if before.root_keys != after.root_keys {
        return Err(runtime_state_policy_error(
            scope,
            "schema",
            "raw RuntimeStateDoc root keys are daemon/runtime-owned",
        ));
    }
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
    for comm_id in after.state.comms.keys() {
        if !before.state.comms.contains_key(comm_id) {
            return Err(runtime_state_policy_error(
                scope,
                "comms",
                "comm entries cannot be created by editor sync",
            ));
        }
    }

    let mut expected_state = before.state.clone();
    for (comm_id, after_comm) in &after.state.comms {
        if let Some(expected_comm) = expected_state.comms.get_mut(comm_id) {
            expected_comm.state = after_comm.state.clone();
        }
    }
    if expected_state != after.state {
        return Err(runtime_state_policy_error(
            scope,
            "runtime state",
            "only comm state property mutations are allowed",
        ));
    }

    Ok(())
}

fn validate_comm_metadata_unchanged(
    scope: RuntimeStateWriteScope,
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

        validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Owner).unwrap();
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

        let err = validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::Owner)
            .unwrap_err();

        assert!(
            err.to_string().contains("display_index"),
            "error should identify display index writes: {err}"
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
            err.to_string().contains("schema"),
            "error should identify raw schema writes: {err}"
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
            err.to_string().contains("viewer connections are read-only"),
            "error should identify viewer read-only policy: {err}"
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

        validate_runtime_state_sync_scope(&before, &after, RuntimeStateWriteScope::RuntimePeer)
            .unwrap();
    }
}
