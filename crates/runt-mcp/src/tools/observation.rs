use std::time::Duration;

use notebook_sync::execution_watch::ExecutionTerminalReason;
use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::observation::{ChangeOutcome, ChangeRead, ObservationReader};
use crate::NteractMcp;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WaitForNotebookChangeParams {
    /// Attachment handle returned by connect_notebook or create_notebook.
    pub notebook_handle: String,
    /// Opaque cursor from a prior read or wait. Omit with no execution_id for an immediate baseline.
    pub after: Option<String>,
    /// Wait for this exact execution to finish, including trailing output, even if its cell is rerun.
    pub execution_id: Option<String>,
    /// Maximum wait in seconds. Default 25; must be between 0 and 50.
    pub timeout_secs: Option<f64>,
}

fn sync_error(error: Box<notebook_sync::SyncError>) -> McpError {
    McpError::internal_error(error.to_string(), None)
}

pub async fn wait_for_notebook_change(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let params: WaitForNotebookChangeParams = serde_json::from_value(serde_json::Value::Object(
        request.arguments.clone().unwrap_or_default(),
    ))
    .map_err(|error| McpError::invalid_params(error.to_string(), None))?;
    let seconds = params.timeout_secs.unwrap_or(25.0);
    if !seconds.is_finite() || !(0.0..=50.0).contains(&seconds) {
        return Err(McpError::invalid_params(
            "timeout_secs must be between 0 and 50",
            None,
        ));
    }
    let _permit = server.observation_waits.try_acquire().map_err(|_| {
        McpError::invalid_request(
            "At most eight notebook waits may be active on this connection",
            None,
        )
    })?;
    let Some((notebook_id, observer)) = server.observer_for_handle(&params.notebook_handle).await?
    else {
        return Ok(CallToolResult::structured(serde_json::json!({
            "outcome":"unavailable", "notebook_handle":params.notebook_handle,
            "message":"This notebook attachment is no longer available. Connect again and obtain a new handle."
        })));
    };
    run_wait(
        server,
        &params,
        &notebook_id,
        &observer,
        Duration::from_secs_f64(seconds),
    )
    .await
}

async fn run_wait(
    server: &NteractMcp,
    params: &WaitForNotebookChangeParams,
    notebook_id: &str,
    observer: &ObservationReader,
    timeout: Duration,
) -> Result<CallToolResult, McpError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let initial = observer.read(params.after.as_deref()).map_err(sync_error)?;
    if matches!(
        initial.outcome,
        ChangeOutcome::Unavailable | ChangeOutcome::ResyncRequired
    ) || (params.after.is_none() && params.execution_id.is_none())
    {
        return Ok(change_result(params, notebook_id, initial, None));
    }
    let Some(execution_id) = params.execution_id.as_deref() else {
        let change = observer
            .wait(params.after.as_deref().unwrap_or(&initial.cursor), timeout)
            .await
            .map_err(sync_error)?;
        return Ok(change_result(params, notebook_id, change, None));
    };
    let mut watcher = observer
        .execution_watcher(execution_id)
        .map_err(sync_error)?;
    let terminal = async {
        while let Some(progress) = watcher.next().await {
            if progress.terminal {
                return Some(progress);
            }
        }
        None
    };
    let unavailable = async {
        let mut cursor = initial.cursor.clone();
        loop {
            let changed = observer
                .wait(&cursor, Duration::from_secs(50))
                .await
                .map_err(sync_error)?;
            if changed.outcome == ChangeOutcome::Unavailable {
                return Ok::<_, McpError>(changed);
            }
            cursor = changed.cursor;
        }
    };
    let progress = tokio::select! {
        result = tokio::time::timeout_at(deadline, terminal) => result.ok().flatten(),
        unavailable = unavailable => return Ok(change_result(params, notebook_id, unavailable?, None)),
    };
    let mut latest = observer
        .read(Some(params.after.as_deref().unwrap_or(&initial.cursor)))
        .map_err(sync_error)?;
    if matches!(
        latest.outcome,
        ChangeOutcome::Unavailable | ChangeOutcome::ResyncRequired
    ) {
        return Ok(change_result(params, notebook_id, latest, None));
    }
    let Some(progress) = progress else {
        latest.outcome = ChangeOutcome::TimedOut;
        return Ok(change_result(params, notebook_id, latest, None));
    };
    if !matches!(
        progress.terminal_reason,
        Some(
            ExecutionTerminalReason::Done
                | ExecutionTerminalReason::Error
                | ExecutionTerminalReason::Cancelled
                | ExecutionTerminalReason::Interrupted
        )
    ) {
        let reason = progress
            .terminal_reason
            .as_ref()
            .map(ExecutionTerminalReason::as_str)
            .unwrap_or("execution_unavailable");
        return Ok(change_result_details(
            params,
            notebook_id,
            latest,
            None,
            Some(reason),
        ));
    }
    let Some(exec) = latest.snapshot.runtime.executions.get(execution_id) else {
        latest.outcome = ChangeOutcome::ResyncRequired;
        return Ok(change_result(params, notebook_id, latest, None));
    };
    let cell = exec
        .cell_id
        .as_deref()
        .and_then(|id| latest.snapshot.notebook.get_cell(id))
        .cloned()
        .map(|mut cell| {
            // Notebook source can already belong to a later edit or rerun.
            cell.source = exec.source.clone().unwrap_or_default();
            cell
        });
    let mapping = exec
        .cell_id
        .as_ref()
        .map(|id| std::collections::HashMap::from([(execution_id.to_owned(), id.clone())]));
    let source_available = exec.source.is_some();
    let rendered = super::execution::render_execution_result(
        server,
        execution_id,
        exec,
        Some(&latest.snapshot.runtime.comms),
        cell,
        mapping,
        false,
    );
    let mut rendered = match tokio::time::timeout_at(deadline, rendered).await {
        Ok(result) => result?,
        Err(_) => {
            let mut latest = observer
                .read(Some(params.after.as_deref().unwrap_or(&initial.cursor)))
                .map_err(sync_error)?;
            if !matches!(
                latest.outcome,
                ChangeOutcome::Unavailable | ChangeOutcome::ResyncRequired
            ) {
                latest.outcome = ChangeOutcome::TimedOut;
            }
            return Ok(change_result(params, notebook_id, latest, None));
        }
    };
    if !source_available {
        if let Some(cell) = rendered
            .structured_content
            .as_mut()
            .and_then(|data| data.get_mut("cell"))
            .and_then(serde_json::Value::as_object_mut)
        {
            cell.remove("source");
            cell.insert(
                "execution_source_available".into(),
                serde_json::json!(false),
            );
        }
        rendered.content.push(crate::formatting::assistant_text(
            "The executed source was not recorded.",
        ));
    }
    // Rendering may await blob resolution. Do not return a successful attachment
    // result after its owning session was released during that work.
    if observer.read(None).map_err(sync_error)?.outcome == ChangeOutcome::Unavailable {
        latest.outcome = ChangeOutcome::Unavailable;
        return Ok(change_result(params, notebook_id, latest, None));
    }
    Ok(change_result(params, notebook_id, latest, Some(rendered)))
}

fn change_result(
    params: &WaitForNotebookChangeParams,
    notebook_id: &str,
    change: ChangeRead,
    execution: Option<CallToolResult>,
) -> CallToolResult {
    change_result_details(params, notebook_id, change, execution, None)
}

fn change_result_details(
    params: &WaitForNotebookChangeParams,
    notebook_id: &str,
    change: ChangeRead,
    execution: Option<CallToolResult>,
    kernel_reason: Option<&str>,
) -> CallToolResult {
    let outcome = if kernel_reason.is_some() {
        "unavailable".into()
    } else if execution.is_some() {
        "completed".into()
    } else {
        serde_json::to_value(change.outcome).unwrap_or_default()
    };
    let payload = serde_json::json!({
        "outcome":outcome, "notebook_handle":params.notebook_handle, "notebook_id":notebook_id,
        "cursor":change.cursor, "changes":change.changes,
        "execution_id":params.execution_id,
        "execution_status":params.execution_id.as_ref().and_then(|id| change.snapshot.runtime.executions.get(id)).map(|execution| &execution.status),
        "execution":execution.as_ref().and_then(|result| result.structured_content.as_ref()),
        "reason":kernel_reason,
        "message":kernel_reason.map(|_| "The kernel stopped before this execution produced a settled result. The notebook attachment is still available; inspect its cells or use restart_kernel before executing again."),
        "attachment_available":change.outcome != ChangeOutcome::Unavailable,
    });
    let mut content = vec![crate::formatting::assistant_text(payload.to_string())];
    if let Some(execution) = execution {
        content.extend(execution.content);
    }
    if change.outcome != ChangeOutcome::Unavailable {
        content.push(ContentBlock::resource_link(
            crate::resources::attachment_cells_resource_link(&params.notebook_handle),
        ));
    }
    let mut result = CallToolResult::success(content);
    result.structured_content = Some(payload);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observation::tests::{edited, fixture};
    use serde_json::json;

    fn server() -> NteractMcp {
        NteractMcp::new("unused.sock".into(), None, None)
    }
    fn params() -> WaitForNotebookChangeParams {
        WaitForNotebookChangeParams {
            notebook_handle: "attachment".into(),
            after: None,
            execution_id: None,
            timeout_secs: None,
        }
    }

    #[tokio::test]
    async fn baseline_then_edit_returns_a_compact_change_and_attachment_link() {
        let fixture = fixture();
        let observer = fixture.owner.reader();
        let mut params = params();
        let baseline = run_wait(&server(), &params, "notebook", &observer, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(
            baseline.structured_content.as_ref().unwrap()["outcome"],
            "baseline"
        );
        params.after = Some(
            baseline.structured_content.unwrap()["cursor"]
                .as_str()
                .unwrap()
                .into(),
        );
        fixture
            .notebook
            .send_replace(edited("secret notebook content"));
        let changed = run_wait(&server(), &params, "notebook", &observer, Duration::ZERO)
            .await
            .unwrap();
        let data = changed.structured_content.unwrap();
        assert_eq!(data["outcome"], "changed");
        assert!(!data.to_string().contains("secret notebook content"));
        assert!(serde_json::to_string(&changed.content)
            .unwrap()
            .contains("nteract://sessions/attachment/cells"));
    }

    #[tokio::test]
    async fn execution_wait_follows_requested_run_through_rerun_and_trailing_output() {
        let fixture = fixture();
        fixture.notebook.send_replace(edited("print('new run')"));
        fixture.notebook.send_modify(|view| {
            std::sync::Arc::make_mut(&mut view.execution_pointers)
                .insert("cell-1".into(), "new-run".into());
        });
        fixture.runtime.send_modify(|state| {
            state.executions.insert("old-run".into(), serde_json::from_value(json!({"cell_id":"cell-1","source":"print('old run')","status":"running","outputs":[]})).unwrap());
            state.executions.insert("new-run".into(), serde_json::from_value(json!({"cell_id":"cell-1","status":"done","outputs":[]})).unwrap());
        });
        let observer = fixture.owner.reader();
        let mut params = params();
        params.execution_id = Some("old-run".into());
        let publisher = fixture.runtime.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            publisher.send_modify(|state| {
                let execution = state.executions.get_mut("old-run").unwrap();
                execution.status = "done".into();
                execution.outputs.push(
                    json!({"output_type":"stream","name":"stdout","text":{"inline":"first"}}),
                );
            });
            tokio::time::sleep(Duration::from_millis(20)).await;
            publisher.send_modify(|state| {
                state.executions.get_mut("old-run").unwrap().outputs.push(
                    json!({"output_type":"stream","name":"stdout","text":{"inline":"trailing"}}),
                )
            });
        });
        let result = run_wait(
            &server(),
            &params,
            "notebook",
            &observer,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(
            result.structured_content.as_ref().unwrap()["outcome"],
            "completed"
        );
        assert_eq!(
            result.structured_content.as_ref().unwrap()["execution_id"],
            "old-run"
        );
        let text = serde_json::to_string(&result.content).unwrap();
        assert!(text.contains("trailing"));
        assert!(!text.contains("print('new run')"));
    }

    #[tokio::test]
    async fn unrelated_completion_does_not_finish_wait_and_release_is_unavailable() {
        let fixture = fixture();
        let observer = fixture.owner.reader();
        let mut params = params();
        params.execution_id = Some("pending-run".into());
        fixture.runtime.send_modify(|state| {
            state.executions.insert(
                "other-run".into(),
                serde_json::from_value(json!({"status":"done","outputs":[]})).unwrap(),
            );
        });
        let result = run_wait(
            &server(),
            &params,
            "notebook",
            &observer,
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        assert_eq!(result.structured_content.unwrap()["outcome"], "timed_out");
        drop(fixture.owner);
        let result = run_wait(
            &server(),
            &params,
            "notebook",
            &observer,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(result.structured_content.unwrap()["outcome"], "unavailable");
    }

    #[tokio::test]
    async fn bounded_waits_reject_invalid_parameters_and_saturation() {
        let server = server();
        for seconds in [-1.0, 51.0] {
            let request = CallToolRequestParams::new("wait_for_notebook_change").with_arguments(
                json!({"notebook_handle":"missing","timeout_secs":seconds})
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            assert!(wait_for_notebook_change(&server, &request).await.is_err());
        }
        let request = CallToolRequestParams::new("wait_for_notebook_change").with_arguments(
            json!({"notebook_handle":"missing"})
                .as_object()
                .unwrap()
                .clone(),
        );
        let permits = server.observation_waits.acquire_many(8).await.unwrap();
        assert!(wait_for_notebook_change(&server, &request).await.is_err());
        drop(permits);
        assert_eq!(
            wait_for_notebook_change(&server, &request)
                .await
                .unwrap()
                .structured_content
                .unwrap()["outcome"],
            "unavailable"
        );
    }

    #[tokio::test]
    async fn interrupted_execution_completes_without_losing_the_attachment() {
        let fixture = fixture();
        fixture.runtime.send_modify(|state| {
            state.executions.insert(
                "interrupted".into(),
                serde_json::from_value(json!({"status":"error","outputs":[]})).unwrap(),
            );
        });
        let mut params = params();
        params.execution_id = Some("interrupted".into());
        let result = run_wait(
            &server(),
            &params,
            "notebook",
            &fixture.owner.reader(),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let payload = result.structured_content.unwrap();
        assert_eq!(payload["outcome"], "completed");
        assert_eq!(payload["execution_status"], "error");
        assert_eq!(payload["attachment_available"], true);
        assert!(serde_json::to_string(&result.content)
            .unwrap()
            .contains("nteract://sessions/attachment/cells"));
    }

    #[tokio::test]
    async fn kernel_failure_retains_notebook_context_and_explains_recovery() {
        let fixture = fixture();
        fixture.runtime.send_modify(|state| {
            state.kernel.lifecycle = runtime_doc::RuntimeLifecycle::Error;
            state.executions.insert(
                "pending".into(),
                serde_json::from_value(json!({"status":"running","outputs":[]})).unwrap(),
            );
        });
        let mut params = params();
        params.execution_id = Some("pending".into());
        let result = run_wait(
            &server(),
            &params,
            "notebook",
            &fixture.owner.reader(),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let payload = result.structured_content.unwrap();
        assert_eq!(payload["outcome"], "unavailable");
        assert_eq!(payload["reason"], "kernel_failed");
        assert_eq!(payload["attachment_available"], true);
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("restart_kernel"));
        assert!(serde_json::to_string(&result.content)
            .unwrap()
            .contains("nteract://sessions/attachment/cells"));
    }

    #[tokio::test]
    async fn missing_execution_source_is_explicit_and_never_uses_a_later_edit() {
        let fixture = fixture();
        fixture.notebook.send_replace(edited("a later edit"));
        fixture.runtime.send_modify(|state| { state.executions.insert("old".into(), serde_json::from_value(json!({"cell_id":"cell-1","status":"done","outputs":[{"output_type":"display_data","data":{"text/plain":{"inline":"old output"}}}]})).unwrap()); });
        let mut params = params();
        params.execution_id = Some("old".into());
        let result = run_wait(
            &server(),
            &params,
            "notebook",
            &fixture.owner.reader(),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let cell = &result.structured_content.as_ref().unwrap()["execution"]["cell"];
        assert_eq!(cell["execution_source_available"], false);
        assert!(cell.get("source").is_none());
        assert!(!serde_json::to_string(&result.content)
            .unwrap()
            .contains("a later edit"));
    }

    #[tokio::test]
    async fn output_resolution_shares_the_wait_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted, mut connected) = tokio::sync::oneshot::channel();
        let stall = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            let _ = accepted.send(());
            std::future::pending::<()>().await;
        });
        let fixture = fixture();
        fixture.runtime.send_modify(|state| { state.executions.insert("blob".into(), serde_json::from_value(json!({"status":"done","outputs":[{"output_type":"display_data","data":{"text/plain":{"blob":"unreachable-output","size":10}}}]})).unwrap()); });
        let mut params = params();
        params.execution_id = Some("blob".into());
        let server = NteractMcp::new(
            "unused.sock".into(),
            Some(format!("http://{address}")),
            None,
        );
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            run_wait(
                &server,
                &params,
                "notebook",
                &fixture.owner.reader(),
                Duration::from_millis(200),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            connected.try_recv().is_ok(),
            "fixture must reach the stalled blob server"
        );
        assert_eq!(result.structured_content.unwrap()["outcome"], "timed_out");
        stall.abort();
    }
}
