use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{output_ids_for_execution, ExecutionState, RuntimeState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionTransition {
    pub execution_id: String,
    pub kind: ExecutionTransitionKind,
    pub execution_count: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionTransitionKind {
    Started,
    Done,
    Error,
}

/// Diff RuntimeStateDoc execution maps into lifecycle transitions.
///
/// Keep this behavior in parity with `packages/runtimed/src/runtime-state.ts`.
pub fn diff_executions(
    prev: &HashMap<String, ExecutionState>,
    curr: &HashMap<String, ExecutionState>,
) -> Vec<ExecutionTransition> {
    let mut transitions = Vec::new();

    for (execution_id, entry) in curr {
        let prev_entry = prev.get(execution_id);
        let prev_status = prev_entry.map(|entry| entry.status.as_str());
        let curr_status = entry.status.as_str();

        if prev_status == Some(curr_status) {
            if curr_status == "running"
                && entry.execution_count.is_some()
                && prev_entry.and_then(|entry| entry.execution_count).is_none()
            {
                transitions.push(transition(
                    execution_id,
                    entry,
                    ExecutionTransitionKind::Started,
                ));
            }
            continue;
        }

        match curr_status {
            "done" => transitions.push(transition(
                execution_id,
                entry,
                ExecutionTransitionKind::Done,
            )),
            "error" => transitions.push(transition(
                execution_id,
                entry,
                ExecutionTransitionKind::Error,
            )),
            "running" if prev_status != Some("done") && prev_status != Some("error") => {
                transitions.push(transition(
                    execution_id,
                    entry,
                    ExecutionTransitionKind::Started,
                ));
            }
            _ => {}
        }
    }

    transitions
}

fn transition(
    execution_id: &str,
    entry: &ExecutionState,
    kind: ExecutionTransitionKind,
) -> ExecutionTransition {
    ExecutionTransition {
        execution_id: execution_id.to_string(),
        kind,
        execution_count: entry.execution_count,
    }
}

/// Small execution snapshot used by session-level materialized views.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct ExecutionViewSnapshot {
    pub execution_count: Option<i64>,
    pub status: String,
    pub success: Option<bool>,
    pub output_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub submitted_by_actor_label: Option<String>,
}

/// Queue state projected in execution-id terms.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
pub struct QueueProjection {
    pub executing_execution_id: Option<String>,
    pub queued_execution_ids: Vec<String>,
    /// `None` means this projection was produced without a notebook adapter.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub notebook: Option<NotebookQueueProjection>,
}

/// Notebook-specific queue join layered on top of the core execution-id queue.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
pub struct NotebookQueueProjection {
    pub executing_cell_id: Option<String>,
    pub queued_cell_ids: Vec<String>,
}

/// Cross-document execution materialization changeset.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct ExecutionViewChangeset {
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub cell_pointer_changes: Vec<(String, Option<String>)>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub execution_upserts: Vec<(String, ExecutionViewSnapshot)>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub removed_execution_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub queue: Option<QueueProjection>,
}

impl ExecutionViewChangeset {
    pub fn is_empty(&self) -> bool {
        self.cell_pointer_changes.is_empty()
            && self.execution_upserts.is_empty()
            && self.removed_execution_ids.is_empty()
            && self.queue.is_none()
    }
}

#[derive(Default, Debug)]
pub struct ExecutionViewProjector {
    prev_cell_pointers: HashMap<String, Option<String>>,
    execution_to_cell: HashMap<String, String>,
    has_cell_adapter: bool,
    known_execution_ids: HashSet<String>,
    prev_execution_fingerprint: HashMap<String, String>,
    prev_queue: Option<QueueProjection>,
}

impl ExecutionViewProjector {
    pub fn reset(&mut self) {
        self.prev_cell_pointers.clear();
        self.execution_to_cell.clear();
        self.has_cell_adapter = false;
        self.known_execution_ids.clear();
        self.prev_execution_fingerprint.clear();
        self.prev_queue = None;
    }

    pub fn project_all<I>(
        &mut self,
        cell_pointers: I,
        state: &RuntimeState,
    ) -> ExecutionViewChangeset
    where
        I: IntoIterator<Item = (String, Option<String>)>,
    {
        let mut changeset = self.project_cell_pointers(cell_pointers);
        let runtime_changeset = self.project_runtime(state);
        changeset
            .execution_upserts
            .extend(runtime_changeset.execution_upserts);
        changeset
            .removed_execution_ids
            .extend(runtime_changeset.removed_execution_ids);
        changeset.queue = runtime_changeset.queue;
        changeset
    }

    pub fn project_cell_pointers<I>(&mut self, cell_pointers: I) -> ExecutionViewChangeset
    where
        I: IntoIterator<Item = (String, Option<String>)>,
    {
        self.has_cell_adapter = true;
        let current: HashMap<String, Option<String>> = cell_pointers.into_iter().collect();

        let mut cell_pointer_changes = Vec::new();
        for (cell_id, execution_id) in &current {
            let pointer_changed = self.prev_cell_pointers.get(cell_id) != Some(execution_id);
            // Skip None -> None for a newly observed cell; emit clears only
            // after we previously saw that cell.
            let real_transition =
                execution_id.is_some() || self.prev_cell_pointers.contains_key(cell_id);
            if pointer_changed && real_transition {
                cell_pointer_changes.push((cell_id.clone(), execution_id.clone()));
            }
        }

        for cell_id in self.prev_cell_pointers.keys() {
            if !current.contains_key(cell_id) {
                cell_pointer_changes.push((cell_id.clone(), None));
            }
        }

        cell_pointer_changes.sort_by(|a, b| a.0.cmp(&b.0));
        self.execution_to_cell = current
            .iter()
            .filter_map(|(cell_id, execution_id)| {
                execution_id
                    .as_ref()
                    .map(|execution_id| (execution_id.clone(), cell_id.clone()))
            })
            .collect();
        self.prev_cell_pointers = current;

        ExecutionViewChangeset {
            cell_pointer_changes,
            ..Default::default()
        }
    }

    pub fn project_runtime(&mut self, state: &RuntimeState) -> ExecutionViewChangeset {
        let mut next_ids = HashSet::new();
        let mut execution_upserts = Vec::new();

        let mut execution_ids: Vec<&String> = state.executions.keys().collect();
        execution_ids.sort();
        for execution_id in execution_ids {
            let Some(entry) = state.executions.get(execution_id) else {
                continue;
            };
            next_ids.insert(execution_id.clone());
            let fingerprint = execution_fingerprint(entry);
            if self.prev_execution_fingerprint.get(execution_id) == Some(&fingerprint) {
                continue;
            }
            self.prev_execution_fingerprint
                .insert(execution_id.clone(), fingerprint);
            execution_upserts.push((execution_id.clone(), execution_snapshot(entry)));
        }

        let mut removed_execution_ids: Vec<String> = self
            .known_execution_ids
            .iter()
            .filter(|execution_id| !next_ids.contains(*execution_id))
            .cloned()
            .collect();
        removed_execution_ids.sort();
        for execution_id in &removed_execution_ids {
            self.prev_execution_fingerprint.remove(execution_id);
        }
        self.known_execution_ids = next_ids;

        let next_queue = QueueProjection {
            executing_execution_id: state
                .queue
                .executing
                .as_ref()
                .map(|entry| entry.execution_id.clone()),
            queued_execution_ids: state
                .queue
                .queued
                .iter()
                .map(|entry| entry.execution_id.clone())
                .collect(),
            notebook: self
                .has_cell_adapter
                .then(|| notebook_queue_projection(state, &self.execution_to_cell)),
        };
        let queue = if self.prev_queue.as_ref() == Some(&next_queue) {
            None
        } else {
            self.prev_queue = Some(next_queue.clone());
            Some(next_queue)
        };

        ExecutionViewChangeset {
            execution_upserts,
            removed_execution_ids,
            queue,
            ..Default::default()
        }
    }
}

fn notebook_queue_projection(
    state: &RuntimeState,
    execution_to_cell: &HashMap<String, String>,
) -> NotebookQueueProjection {
    let executing_cell_id = state
        .queue
        .executing
        .as_ref()
        .and_then(|entry| execution_to_cell.get(&entry.execution_id).cloned());
    let queued_cell_ids = state
        .queue
        .queued
        .iter()
        .filter_map(|entry| execution_to_cell.get(&entry.execution_id).cloned())
        .collect();
    NotebookQueueProjection {
        executing_cell_id,
        queued_cell_ids,
    }
}

fn execution_snapshot(exec: &ExecutionState) -> ExecutionViewSnapshot {
    ExecutionViewSnapshot {
        execution_count: exec.execution_count,
        status: exec.status.clone(),
        success: exec.success,
        output_ids: output_ids_for_execution(exec),
        submitted_by_actor_label: exec.submitted_by_actor_label.clone(),
    }
}

fn execution_fingerprint(exec: &ExecutionState) -> String {
    let output_ids = output_ids_for_execution(exec);
    format!(
        "{}|{}|{}|{}|{}",
        exec.execution_count
            .map(|count| count.to_string())
            .unwrap_or_default(),
        exec.status,
        exec.success
            .map(|success| success.to_string())
            .unwrap_or_default(),
        output_ids.join(","),
        exec.submitted_by_actor_label.as_deref().unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{QueueEntry, RuntimeState};
    use serde_json::json;

    fn exec(status: &str, count: Option<i64>) -> ExecutionState {
        ExecutionState {
            status: status.to_string(),
            execution_count: count,
            success: None,
            outputs: vec![],
            source: None,
            cell_id: None,
            seq: None,
            submitted_by_actor_label: None,
        }
    }

    fn exec_with_outputs(
        status: &str,
        count: Option<i64>,
        success: Option<bool>,
        output_ids: &[&str],
    ) -> ExecutionState {
        ExecutionState {
            status: status.to_string(),
            execution_count: count,
            success,
            outputs: output_ids
                .iter()
                .map(|output_id| json!({ "output_id": output_id }))
                .collect(),
            source: None,
            cell_id: None,
            seq: None,
            submitted_by_actor_label: None,
        }
    }

    fn pointers(values: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        values
            .iter()
            .map(|(cell_id, execution_id)| {
                (
                    (*cell_id).to_string(),
                    execution_id.map(ToString::to_string),
                )
            })
            .collect()
    }

    #[test]
    fn diffs_started_done_and_error_transitions() {
        let prev = HashMap::new();
        let curr = HashMap::from([("exec-1".to_string(), exec("running", Some(7)))]);

        assert_eq!(
            diff_executions(&prev, &curr),
            vec![ExecutionTransition {
                execution_id: "exec-1".to_string(),
                kind: ExecutionTransitionKind::Started,
                execution_count: Some(7),
            }]
        );

        let prev = curr;
        let curr = HashMap::from([("exec-1".to_string(), exec("done", Some(7)))]);
        assert_eq!(
            diff_executions(&prev, &curr)[0].kind,
            ExecutionTransitionKind::Done
        );

        let prev = HashMap::from([("exec-2".to_string(), exec("queued", None))]);
        let curr = HashMap::from([("exec-2".to_string(), exec("error", None))]);
        assert_eq!(
            diff_executions(&prev, &curr)[0].kind,
            ExecutionTransitionKind::Error
        );
    }

    #[test]
    fn running_count_arrival_reemits_started() {
        let prev = HashMap::from([("exec-1".to_string(), exec("running", None))]);
        let curr = HashMap::from([("exec-1".to_string(), exec("running", Some(3)))]);

        let transitions = diff_executions(&prev, &curr);
        assert_eq!(transitions.len(), 1);
        assert_eq!(transitions[0].kind, ExecutionTransitionKind::Started);
        assert_eq!(transitions[0].execution_count, Some(3));
    }

    #[test]
    fn execution_view_projects_notebook_queue_join() {
        let cell_pointers = pointers(&[("cell-1", Some("exec-1")), ("cell-2", Some("exec-2"))]);
        let mut state = RuntimeState::default();
        state
            .executions
            .insert("exec-1".to_string(), exec("queued", None));
        state
            .executions
            .insert("exec-2".to_string(), exec("queued", None));
        state.queue.executing = Some(QueueEntry {
            execution_id: "exec-1".to_string(),
        });
        state.queue.queued = vec![QueueEntry {
            execution_id: "exec-2".to_string(),
        }];

        let mut projector = ExecutionViewProjector::default();
        let changeset = projector.project_all(cell_pointers, &state);

        assert_eq!(
            changeset.cell_pointer_changes,
            vec![
                ("cell-1".to_string(), Some("exec-1".to_string())),
                ("cell-2".to_string(), Some("exec-2".to_string())),
            ]
        );
        assert_eq!(
            changeset.queue,
            Some(QueueProjection {
                executing_execution_id: Some("exec-1".to_string()),
                queued_execution_ids: vec!["exec-2".to_string()],
                notebook: Some(NotebookQueueProjection {
                    executing_cell_id: Some("cell-1".to_string()),
                    queued_cell_ids: vec!["cell-2".to_string()],
                }),
            })
        );
    }

    #[test]
    fn execution_view_core_queue_stays_document_agnostic_without_adapter() {
        let mut state = RuntimeState::default();
        state.queue.executing = Some(QueueEntry {
            execution_id: "exec-1".to_string(),
        });
        state.queue.queued = vec![QueueEntry {
            execution_id: "exec-2".to_string(),
        }];

        let mut projector = ExecutionViewProjector::default();
        let changeset = projector.project_runtime(&state);

        assert_eq!(
            changeset.queue,
            Some(QueueProjection {
                executing_execution_id: Some("exec-1".to_string()),
                queued_execution_ids: vec!["exec-2".to_string()],
                notebook: None,
            })
        );
    }

    #[test]
    fn execution_view_runtime_projection_catches_same_length_output_replacement() {
        let cell_pointers = pointers(&[("cell-1", Some("exec-1"))]);
        let mut first = RuntimeState::default();
        first.executions.insert(
            "exec-1".to_string(),
            exec_with_outputs("running", Some(1), None, &["old"]),
        );
        let mut second = first.clone();
        second.executions.get_mut("exec-1").unwrap().outputs = vec![json!({"output_id": "new"})];

        let mut projector = ExecutionViewProjector::default();
        projector.project_all(cell_pointers, &first);
        let changeset = projector.project_runtime(&second);

        assert_eq!(changeset.execution_upserts.len(), 1);
        assert_eq!(changeset.execution_upserts[0].0, "exec-1");
        assert_eq!(changeset.execution_upserts[0].1.output_ids, vec!["new"]);
    }

    #[test]
    fn execution_view_projects_submitter_actor_label() {
        let cell_pointers = pointers(&[("cell-1", Some("exec-1"))]);
        let mut state = RuntimeState::default();
        let mut exec = exec("queued", None);
        exec.submitted_by_actor_label = Some("local:kyle/agent:codex:s1".to_string());
        state.executions.insert("exec-1".to_string(), exec);

        let mut projector = ExecutionViewProjector::default();
        let changeset = projector.project_all(cell_pointers, &state);

        assert_eq!(changeset.execution_upserts.len(), 1);
        assert_eq!(
            changeset.execution_upserts[0]
                .1
                .submitted_by_actor_label
                .as_deref(),
            Some("local:kyle/agent:codex:s1")
        );
    }

    #[test]
    fn execution_view_runtime_projection_reports_trimmed_executions() {
        let cell_pointers = pointers(&[("cell-1", Some("exec-1"))]);
        let mut first = RuntimeState::default();
        first.executions.insert(
            "exec-1".to_string(),
            exec_with_outputs("done", Some(1), Some(true), &["out-1"]),
        );

        let mut projector = ExecutionViewProjector::default();
        projector.project_all(cell_pointers, &first);
        let changeset = projector.project_runtime(&RuntimeState::default());

        assert!(changeset.execution_upserts.is_empty());
        assert_eq!(changeset.removed_execution_ids, vec!["exec-1"]);
    }

    #[test]
    fn execution_view_projector_is_idempotent_without_state_changes() {
        let cell_pointers = pointers(&[("cell-1", Some("exec-1"))]);
        let mut state = RuntimeState::default();
        state.executions.insert(
            "exec-1".to_string(),
            exec_with_outputs("done", Some(1), Some(true), &["out-1"]),
        );
        state.queue.executing = Some(QueueEntry {
            execution_id: "exec-1".to_string(),
        });

        let mut projector = ExecutionViewProjector::default();
        assert!(!projector
            .project_all(cell_pointers.clone(), &state)
            .is_empty());
        assert!(projector.project_all(cell_pointers, &state).is_empty());
    }

    #[test]
    fn execution_view_separates_cell_pointer_and_runtime_ticks() {
        let cell_pointers = pointers(&[("cell-1", Some("exec-1"))]);
        let mut state = RuntimeState::default();
        state.executions.insert(
            "exec-1".to_string(),
            exec_with_outputs("running", Some(1), None, &["out-1"]),
        );

        let mut projector = ExecutionViewProjector::default();
        let pointer_changeset = projector.project_cell_pointers(cell_pointers);
        assert_eq!(
            pointer_changeset.cell_pointer_changes,
            vec![("cell-1".to_string(), Some("exec-1".to_string()))]
        );
        assert!(pointer_changeset.execution_upserts.is_empty());
        assert!(pointer_changeset.queue.is_none());

        let runtime_changeset = projector.project_runtime(&state);
        assert!(runtime_changeset.cell_pointer_changes.is_empty());
        assert_eq!(runtime_changeset.execution_upserts.len(), 1);
        assert_eq!(runtime_changeset.execution_upserts[0].0, "exec-1");

        let empty_changeset = projector.project_runtime(&state);
        assert!(empty_changeset.is_empty());
    }

    #[test]
    fn execution_view_projects_cell_pointer_clear() {
        let mut projector = ExecutionViewProjector::default();
        projector.project_cell_pointers(pointers(&[("cell-1", Some("exec-1"))]));

        let changeset = projector.project_cell_pointers(pointers(&[("cell-1", None)]));

        assert_eq!(
            changeset.cell_pointer_changes,
            vec![("cell-1".to_string(), None)]
        );
    }
}
