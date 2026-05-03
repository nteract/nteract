use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExecutionTransition {
    pub execution_id: String,
    pub cell_id: String,
    pub kind: ExecutionTransitionKind,
    pub execution_count: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionTransitionKind {
    Started,
    Done,
    Error,
}

pub fn diff_executions(
    prev: &HashMap<String, runtime_doc::ExecutionState>,
    curr: &HashMap<String, runtime_doc::ExecutionState>,
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
    entry: &runtime_doc::ExecutionState,
    kind: ExecutionTransitionKind,
) -> ExecutionTransition {
    ExecutionTransition {
        execution_id: execution_id.to_string(),
        cell_id: entry.cell_id.clone(),
        kind,
        execution_count: entry.execution_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exec(status: &str, count: Option<i64>) -> runtime_doc::ExecutionState {
        runtime_doc::ExecutionState {
            cell_id: "cell-1".to_string(),
            status: status.to_string(),
            execution_count: count,
            success: None,
            outputs: vec![],
            source: None,
            seq: None,
        }
    }

    #[test]
    fn diffs_started_done_and_error_transitions() {
        let prev = HashMap::new();
        let curr = HashMap::from([("exec-1".to_string(), exec("running", Some(7)))]);

        assert_eq!(
            diff_executions(&prev, &curr),
            vec![ExecutionTransition {
                execution_id: "exec-1".to_string(),
                cell_id: "cell-1".to_string(),
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
}
