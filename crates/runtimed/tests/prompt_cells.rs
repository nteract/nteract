// Tests can use unwrap/expect freely - panics are acceptable in test code
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Process-level prompt cell tests: a real daemon, a real prompt agent
//! subprocess (`runtimed prompt-agent`) and `tests/fixtures/fake-claude.sh`
//! standing in for the `claude` CLI.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notebook_doc::CellSnapshot;
use notebook_sync::connect;
use runtimed::client::PoolClient;
use runtimed::daemon::{Daemon, DaemonConfig};
use runtimed::prompt_cells::{answer_execution_id, answer_is_streaming, answer_prompt_cell_id};
use runtimed::protocol::{NotebookRequest, NotebookResponse};
use tempfile::TempDir;
use tokio::time::sleep;

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const WAIT_TIMEOUT: Duration = Duration::from_secs(30);

fn test_config(temp_dir: &TempDir, settings: serde_json::Value) -> DaemonConfig {
    #[cfg(windows)]
    let socket_path = {
        let unique = temp_dir
            .path()
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        PathBuf::from(format!(r"\\.\pipe\runtimed-test-{}", unique))
    };
    #[cfg(not(windows))]
    let socket_path = temp_dir.path().join("test-runtimed.sock");

    let settings_path = temp_dir.path().join("settings.json");
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();

    DaemonConfig {
        socket_path,
        cache_dir: temp_dir.path().join("envs"),
        blob_store_dir: temp_dir.path().join("blobs"),
        execution_store_dir: temp_dir.path().join("executions"),
        notebook_docs_dir: temp_dir.path().join("notebook-docs"),
        trusted_packages_db_path: temp_dir.path().join("trusted-packages.sqlite"),
        notebook_registry_db_path: temp_dir.path().join("notebook-registry.sqlite"),
        uv_pool_size: 0,
        conda_pool_size: 0,
        max_age_secs: 3600,
        lock_dir: Some(temp_dir.path().to_path_buf()),
        room_eviction_delay_ms: Some(50),
        use_preferred_blob_port: false,
        settings_json_path: Some(settings_path),
        runtime_agent_exe: option_env!("CARGO_BIN_EXE_runtimed").map(PathBuf::from),
        ..Default::default()
    }
}

fn fake_claude() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-claude.sh")
        .to_string_lossy()
        .into_owned()
}

struct Harness {
    _temp: TempDir,
    pool: PoolClient,
    daemon: Arc<Daemon>,
    daemon_task: tokio::task::JoinHandle<()>,
    socket_path: PathBuf,
}

impl Harness {
    async fn start(prompt_cells: bool) -> Self {
        Self::start_with_command(prompt_cells, fake_claude()).await
    }

    async fn start_with_command(prompt_cells: bool, agent_command: String) -> Self {
        let temp = TempDir::new().unwrap();
        let config = test_config(
            &temp,
            serde_json::json!({
                "prompt_cells": prompt_cells,
                "prompt_agent_command": agent_command,
            }),
        );
        let socket_path = config.socket_path.clone();
        let daemon = Daemon::new_for_test(config).unwrap();
        let daemon_for_run = daemon.clone();
        let daemon_task = tokio::spawn(async move {
            daemon_for_run.run().await.ok();
        });
        let pool = PoolClient::new(socket_path.clone());
        let start = std::time::Instant::now();
        loop {
            if pool.ping().await.is_ok() {
                break;
            }
            assert!(start.elapsed() < READY_TIMEOUT, "daemon did not start");
            sleep(Duration::from_millis(50)).await;
        }
        Self {
            _temp: temp,
            pool,
            daemon,
            daemon_task,
            socket_path,
        }
    }

    async fn stop(self) {
        self.pool.shutdown().await.ok();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.daemon_task).await;
    }
}

struct Notebook {
    handle: notebook_sync::DocHandle,
    daemon: Arc<Daemon>,
    uuid: uuid::Uuid,
}

/// A notebook with `code-1` ("x = 1") and a prompt cell `prompt-1`.
async fn open_notebook(harness: &Harness) -> Notebook {
    let result = connect::connect_create(
        harness.socket_path.clone(),
        connect::CreateNotebookSpec {
            actor_label: "test".to_string(),
            ..connect::CreateNotebookSpec::new("python")
        },
    )
    .await
    .expect("connect");
    result
        .handle
        .await_session_ready_timeout(READY_TIMEOUT)
        .await
        .expect("session ready");
    let handle = result.handle;

    // Replace the daemon's starter cell with our own cells.
    wait_for(|| !handle.get_cells().is_empty(), "starter cell").await;
    for cell in handle.get_cells() {
        handle.delete_cell(&cell.id).unwrap();
    }
    handle
        .add_cell_with_source("code-1", "code", None, "x = 1")
        .unwrap();
    add_prompt(&handle, "prompt-1", "code-1", "Explain x");
    handle.confirm_sync().await.unwrap();

    let uuid = uuid::Uuid::parse_str(&result.info.notebook_id).unwrap();
    Notebook {
        handle,
        daemon: Arc::clone(&harness.daemon),
        uuid,
    }
}

fn add_prompt(handle: &notebook_sync::DocHandle, id: &str, after: &str, text: &str) {
    handle
        .add_cell_with_source(id, "raw", Some(after), text)
        .unwrap();
    handle
        .set_cell_metadata(id, &serde_json::json!({"nteract": {"prompt": {}}}))
        .unwrap();
}

async fn wait_for<F: FnMut() -> bool>(mut condition: F, what: &str) {
    let start = std::time::Instant::now();
    while start.elapsed() < WAIT_TIMEOUT {
        if condition() {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn wait_for_async<F, Fut>(mut condition: F, what: &str)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let start = std::time::Instant::now();
    while start.elapsed() < WAIT_TIMEOUT {
        if condition().await {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

impl Notebook {
    async fn execute(&self, cell_id: &str) -> NotebookResponse {
        self.handle.confirm_sync().await.unwrap();
        let heads = self.handle.current_heads_hex().unwrap();
        self.handle
            .send_request_after_heads(
                NotebookRequest::ExecuteCell {
                    cell_id: cell_id.to_string(),
                    execution_id: None,
                },
                heads,
            )
            .await
            .unwrap()
    }

    async fn run_prompt(&self, cell_id: &str) -> String {
        match self.execute(cell_id).await {
            NotebookResponse::CellQueued { execution_id, .. } => execution_id,
            other => panic!("expected CellQueued, got {other:?}"),
        }
    }

    async fn stop(&self, cell_id: &str) {
        let response = self
            .handle
            .send_request(NotebookRequest::InterruptExecution {
                cell_id: Some(cell_id.to_string()),
            })
            .await
            .unwrap();
        assert!(
            matches!(response, NotebookResponse::InterruptSent {}),
            "{response:?}"
        );
    }

    async fn cells(&self) -> Vec<CellSnapshot> {
        let room = self.daemon.test_get_room(self.uuid).await.expect("room");
        let cells = room.doc.read().await.get_cells();
        cells
    }

    async fn runtime_state(&self) -> runtime_doc::RuntimeState {
        let room = self.daemon.test_get_room(self.uuid).await.expect("room");
        room.state.read(|sd| sd.read_state()).unwrap()
    }

    async fn outputs(&self, eid: &str) -> Vec<serde_json::Value> {
        let room = self.daemon.test_get_room(self.uuid).await.expect("room");
        room.state.read(|sd| sd.get_outputs(eid)).unwrap()
    }

    async fn answers_of(&self, prompt_cell_id: &str) -> Vec<CellSnapshot> {
        self.cells()
            .await
            .into_iter()
            .filter(|cell| answer_prompt_cell_id(cell).as_deref() == Some(prompt_cell_id))
            .collect()
    }

    /// Wait until the prompt has finished answers (no streaming placeholder).
    async fn wait_for_answers(&self, prompt_cell_id: &str, eid: &str) -> Vec<CellSnapshot> {
        self.wait_for_answers_within(prompt_cell_id, eid, WAIT_TIMEOUT)
            .await
    }

    async fn wait_for_answers_within(
        &self,
        prompt_cell_id: &str,
        eid: &str,
        timeout: Duration,
    ) -> Vec<CellSnapshot> {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            let answers = self.answers_of(prompt_cell_id).await;
            if !answers.is_empty()
                && answers.iter().all(|cell| {
                    !answer_is_streaming(cell) && answer_execution_id(cell).as_deref() == Some(eid)
                })
            {
                return answers;
            }
            sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "answers of {prompt_cell_id} did not appear: {:?} outputs={:?}",
            self.cells().await,
            self.outputs(eid).await
        );
    }

    async fn execution(&self, eid: &str) -> runtime_doc::ExecutionState {
        self.runtime_state()
            .await
            .executions
            .get(eid)
            .cloned()
            .expect("execution")
    }

    async fn assert_kernel_untouched(&self) {
        let room = self.daemon.test_get_room(self.uuid).await.expect("room");
        assert!(
            room.runtime_agent_request_tx.lock().await.is_none(),
            "no kernel agent may be launched for a prompt"
        );
        assert!(room.runtime_agent_handle.lock().await.is_none());
        let state = self.runtime_state().await;
        assert!(state.queue.executing.is_none());
        assert!(
            state.queue.queued.is_empty(),
            "kernel queue must stay empty"
        );
    }
}

#[tokio::test]
async fn prompt_cell_answer_flow_rerun_and_stop() {
    let harness = Harness::start(true).await;
    let notebook = open_notebook(&harness).await;

    // ── Run: answer cells appear, split into markdown / code / markdown ──
    let first = notebook.run_prompt("prompt-1").await;
    let answers = notebook.wait_for_answers("prompt-1", &first).await;
    assert_eq!(answers.len(), 3, "{answers:?}");
    assert_eq!(
        answers
            .iter()
            .map(|c| c.cell_type.as_str())
            .collect::<Vec<_>>(),
        ["markdown", "code", "markdown"]
    );
    assert_eq!(answers[0].source, "Here is code:");
    assert_eq!(answers[1].source, "print(42)");
    assert_eq!(answers[2].source, "Done.");
    for (index, cell) in answers.iter().enumerate() {
        let response = &cell.metadata["nteract"]["prompt_response"];
        assert_eq!(response["prompt_cell_id"], "prompt-1");
        assert_eq!(response["execution_id"], first.as_str());
        assert_eq!(response["part"], index);
        assert!(response.get("streaming").is_none());
        assert!(response.get("stopped").is_none());
    }
    // Answers sit directly below the prompt.
    let ids: Vec<String> = notebook.cells().await.into_iter().map(|c| c.id).collect();
    assert_eq!(&ids[..2], ["code-1", "prompt-1"]);
    assert_eq!(ids.len(), 5);

    // The execution ran under the prompt capability with a stored context.
    wait_for_async(
        || async { notebook.execution(&first).await.status == "done" },
        "prompt execution done",
    )
    .await;
    let execution = notebook.execution(&first).await;
    assert_eq!(execution.capability.as_deref(), Some("prompt"));
    assert_eq!(execution.success, Some(true));
    assert_eq!(execution.cell_id.as_deref(), Some("prompt-1"));
    assert!(execution.context_blob.is_some());
    notebook.assert_kernel_untouched().await;

    // ── Re-run: old answers are deleted, new ones created ───────────────
    let old_ids: Vec<String> = answers.iter().map(|c| c.id.clone()).collect();
    let second = notebook.run_prompt("prompt-1").await;
    assert_ne!(first, second);
    let new_answers = notebook.wait_for_answers("prompt-1", &second).await;
    assert_eq!(new_answers.len(), 3);
    let ids: Vec<String> = notebook.cells().await.into_iter().map(|c| c.id).collect();
    for old in &old_ids {
        assert!(!ids.contains(old), "old answer {old} must be deleted");
    }
    assert_eq!(ids.len(), 5);
    notebook.assert_kernel_untouched().await;

    // ── Stop mid-stream: partial text is kept, marked stopped ───────────
    add_prompt(
        &notebook.handle,
        "prompt-2",
        "prompt-1",
        "SLOWMODE tell me more",
    );
    // `prompt-2` sits between prompt-1 and its answers; answers stay with
    // prompt-1 by metadata, not position.
    let third = notebook.run_prompt("prompt-2").await;
    wait_for_async(
        || async {
            notebook
                .outputs(&third)
                .await
                .iter()
                .any(|output| output.to_string().contains("print(42)"))
        },
        "partial output",
    )
    .await;
    notebook.stop("prompt-2").await;

    let stopped = notebook.wait_for_answers("prompt-2", &third).await;
    assert!(
        stopped.iter().any(|c| c.source.contains("print(42)")),
        "partial text kept: {stopped:?}"
    );
    for cell in &stopped {
        assert_eq!(
            cell.metadata["nteract"]["prompt_response"]["stopped"], true,
            "{cell:?}"
        );
    }
    wait_for_async(
        || async {
            let status = notebook.execution(&third).await.status;
            status == "error" || status == "done"
        },
        "stopped execution terminal",
    )
    .await;
    // Re-running prompt-1 did not touch prompt-2's answers and vice versa.
    assert_eq!(notebook.answers_of("prompt-1").await.len(), 3);
    notebook.assert_kernel_untouched().await;

    harness.stop().await;
}

/// Stop is state on the execution: the first Stop interrupts the CLI, which
/// ignores it here; the second one kills it. The partial text is kept. A
/// Stop on a prompt queued behind the running one cancels it at once.
#[tokio::test]
async fn a_second_stop_kills_a_prompt_that_ignores_the_interrupt() {
    let harness = Harness::start(true).await;
    let notebook = open_notebook(&harness).await;
    add_prompt(&notebook.handle, "prompt-2", "prompt-1", "IGNOREINT go on");
    let eid = notebook.run_prompt("prompt-2").await;
    wait_for_async(
        || async {
            notebook
                .outputs(&eid)
                .await
                .iter()
                .any(|output| output.to_string().contains("print(42)"))
        },
        "partial output",
    )
    .await;

    // `prompt-1` sits above the running prompt, so it is dispatched at once
    // and queues behind it in the agent. Stopping it cancels it while
    // `prompt-2` keeps running, and its placeholder goes away.
    let queued = notebook.run_prompt("prompt-1").await;
    wait_for_async(
        || async { notebook.execution(&queued).await.context_blob.is_some() },
        "prompt-1 dispatched",
    )
    .await;
    notebook.stop("prompt-1").await;
    wait_for_async(
        || async { notebook.execution(&queued).await.status == "cancelled" },
        "queued prompt cancelled",
    )
    .await;
    assert_eq!(notebook.execution(&eid).await.status, "running");
    wait_for_async(
        || async { notebook.answers_of("prompt-1").await.is_empty() },
        "cancelled placeholder removed",
    )
    .await;

    notebook.stop("prompt-2").await;
    sleep(Duration::from_secs(1)).await;
    let execution = notebook.execution(&eid).await;
    assert_eq!(execution.status, "running", "SIGINT is ignored");
    assert_eq!(execution.stop_requested, 1);

    notebook.stop("prompt-2").await;
    let stopped = notebook.wait_for_answers("prompt-2", &eid).await;
    assert!(
        stopped.iter().any(|c| c.source.contains("print(42)")),
        "partial text kept: {stopped:?}"
    );
    for cell in &stopped {
        assert_eq!(cell.metadata["nteract"]["prompt_response"]["stopped"], true);
    }
    let execution = notebook.execution(&eid).await;
    assert_eq!(execution.stop_requested, 2);
    assert_eq!(execution.status, "error");
    notebook.assert_kernel_untouched().await;
    harness.stop().await;
}

#[tokio::test]
async fn a_long_answer_streams_through_the_blob_store_and_becomes_cells() {
    let harness = Harness::start(true).await;
    let notebook = open_notebook(&harness).await;
    add_prompt(
        &notebook.handle,
        "prompt-2",
        "prompt-1",
        "LONGANSWER explain",
    );

    let eid = notebook.run_prompt("prompt-2").await;
    let answers = notebook.wait_for_answers("prompt-2", &eid).await;
    let text: String = answers.iter().map(|c| c.source.as_str()).collect();
    for i in 1..=40 {
        assert!(
            text.contains(&format!("Line {i} of a long answer")),
            "line {i}"
        );
    }
    // The streamed output kept only a blob reference in the RuntimeStateDoc.
    let outputs = notebook.outputs(&eid).await;
    let markdown = &outputs[0]["data"]["text/markdown"];
    assert!(markdown.get("inline").is_none(), "{markdown}");
    assert!(markdown["blob"].is_string(), "{markdown}");
    harness.stop().await;
}

#[tokio::test]
async fn prompt_cells_flag_off_rejects_the_run_and_changes_nothing() {
    let harness = Harness::start(false).await;
    let notebook = open_notebook(&harness).await;
    let before = notebook.cells().await.len();

    match notebook.execute("prompt-1").await {
        NotebookResponse::Error { error } => {
            assert!(error.contains("Prompt cells are disabled"), "{error}")
        }
        other => panic!("expected an error, got {other:?}"),
    }
    assert_eq!(notebook.cells().await.len(), before);
    assert!(notebook.runtime_state().await.executions.is_empty());
    notebook.assert_kernel_untouched().await;
    harness.stop().await;
}

/// End-to-end run against the real Claude CLI on the developer's own login.
///
/// Ignored by default because it needs `claude` on PATH, a login, and costs a
/// request. Run with:
/// `cargo test -p runtimed --test prompt_cells real_claude -- --ignored --nocapture`
/// (`NTERACT_PROMPT_E2E_CLAUDE_COMMAND` overrides the command).
#[tokio::test]
#[ignore = "needs the real `claude` CLI and a login"]
async fn real_claude_answers_a_prompt_cell() {
    let command =
        std::env::var("NTERACT_PROMPT_E2E_CLAUDE_COMMAND").unwrap_or_else(|_| "claude".into());
    let harness = Harness::start_with_command(true, command).await;
    let notebook = open_notebook(&harness).await;
    add_prompt(
        &notebook.handle,
        "prompt-real",
        "prompt-1",
        "Write a code cell that prints the value of x from the cell above.",
    );

    let eid = notebook.run_prompt("prompt-real").await;
    let answers = notebook
        .wait_for_answers_within("prompt-real", &eid, Duration::from_secs(180))
        .await;
    for cell in &answers {
        println!("[{}] {}", cell.cell_type, cell.source);
    }

    let execution = notebook.execution(&eid).await;
    assert_eq!(execution.status, "done", "{execution:?}");
    assert_eq!(execution.capability.as_deref(), Some("prompt"));
    assert!(execution.context_blob.is_some());
    let code: Vec<&CellSnapshot> = answers.iter().filter(|c| c.cell_type == "code").collect();
    assert!(
        code.iter()
            .any(|c| c.source.contains("print") && c.source.contains('x')),
        "expected a code answer printing x: {answers:?}"
    );
    notebook.assert_kernel_untouched().await;
    harness.stop().await;
}
