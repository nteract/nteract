//! `NotebookRequest::RunPromptCell` handler.
//!
//! The daemon sends the cells above a prompt cell to the user's configured
//! agent CLI (headless, on the user's own login) and streams the reply into
//! the prompt's answer cell. The room runs one prompt at a time; the run's
//! progress is published as `RuntimeStateDoc.prompt_runs`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, PoisonError};
use std::time::Duration;

use automerge::AutomergeError;
use notebook_doc::{CellSnapshot, NotebookDoc};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Notify;
use tracing::warn;

use crate::notebook_sync_server::durability::commit_daemon_notebook_mutation;
use crate::notebook_sync_server::{ActivePromptRun, NotebookRoom};
use crate::prompt_agent::{
    agent_args, answered_prompt_id, full_mode_args, full_system_prompt, is_context_excluded,
    output_text, parse_stream_line, prompt_mode, single_code_block, AgentEvent, PromptMode,
    EXPLORE_SYSTEM_PROMPT,
};
use crate::protocol::NotebookResponse;
use crate::task_supervisor::spawn_best_effort;

const PROMPT_AGENT_ACTOR: &str = "runtimed:prompt-agent";
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
const MAX_STDERR_CHARS: usize = 2000;

/// How to start the agent CLI: the command, extra environment (the user's
/// shell overlay with merged PATH), and an empty daemon-owned working
/// directory so no project configuration is picked up.
pub(crate) struct AgentLaunch {
    pub command: String,
    pub env: HashMap<String, String>,
    pub cwd: PathBuf,
    /// `runt` binary that serves full mode's nteract MCP tools, if found.
    pub runt: Option<PathBuf>,
    pub socket_path: PathBuf,
}

/// `runt` next to the daemon binary (dev builds, app bundles), else this
/// channel's CLI (`runt` or `runt-nightly`) on PATH. Another channel's CLI is
/// never used: its MCP server may predate the notebook pin.
pub(crate) fn find_runt(path_env: &str) -> Option<PathBuf> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let sibling = std::env::current_exe()
        .ok()
        .map(|exe| exe.with_file_name(format!("runt{suffix}")));
    let cli = format!("{}{suffix}", runt_workspace::cli_command_name());
    sibling
        .into_iter()
        .chain(std::env::split_paths(path_env).map(|dir| dir.join(&cli)))
        .find(|candidate| candidate.is_file())
}

fn error(message: impl Into<String>) -> NotebookResponse {
    NotebookResponse::Error {
        error: message.into(),
    }
}

pub(crate) async fn handle(
    room: &Arc<NotebookRoom>,
    cell_id: String,
    launch: &AgentLaunch,
) -> NotebookResponse {
    if room.is_hosted() {
        return error(
            "Prompt cells run on the local daemon and are not available in hosted notebooks",
        );
    }

    let (cells, execution_ids, runtime) = {
        let doc = room.doc.read().await;
        let cells = doc.get_cells();
        let execution_ids: HashMap<String, String> = cells
            .iter()
            .filter_map(|cell| {
                doc.get_execution_id(&cell.id)
                    .map(|execution_id| (cell.id.clone(), execution_id))
            })
            .collect();
        (cells, execution_ids, doc.detect_runtime())
    };
    let Some(index) = cells.iter().position(|cell| cell.id == cell_id) else {
        return error(format!("Cell {cell_id} not found"));
    };
    let args = match prompt_mode(&cells[index]) {
        None => return error(format!("Cell {cell_id} is not a prompt cell")),
        Some(PromptMode::Explore) => agent_args(EXPLORE_SYSTEM_PROMPT),
        Some(PromptMode::Full) => {
            let Some(runt) = &launch.runt else {
                return error(
                    "Full mode needs the nteract `runt` CLI next to the daemon or on PATH",
                );
            };
            let notebook_id = room.id.to_string();
            full_mode_args(
                &full_system_prompt(&notebook_id, &cell_id),
                runt,
                &launch.socket_path,
                &notebook_id,
            )
        }
    };

    let input = agent_input(
        room,
        &cells[..index],
        &execution_ids,
        runtime.as_deref(),
        &cells[index].source,
    )
    .await;

    let cancel = Arc::new(Notify::new());
    let Some(claim) = claim_prompt_run(room, &cell_id, Arc::clone(&cancel)) else {
        return error("An agent is already answering a prompt in this notebook");
    };
    let child = match spawn_agent(launch, &args) {
        Ok(child) => child,
        Err(err) => {
            return error(format!(
                "Could not start the agent command `{}`: {err}",
                launch.command
            ));
        }
    };
    spawn_best_effort("prompt-agent", run_agent(claim, child, input, cancel));
    NotebookResponse::Ok {}
}

/// The room's single prompt-run slot plus its `prompt_runs` marker. Dropping
/// the claim frees both, whether the run finished, was aborted, or panicked.
struct PromptRunClaim {
    room: Arc<NotebookRoom>,
    cell_id: String,
}

fn claim_prompt_run(
    room: &Arc<NotebookRoom>,
    cell_id: &str,
    cancel: Arc<Notify>,
) -> Option<PromptRunClaim> {
    {
        let mut active = room
            .active_prompt_run
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if active.is_some() {
            return None;
        }
        *active = Some(ActivePromptRun {
            cell_id: cell_id.to_string(),
            cancel,
        });
    }
    let started_at = chrono::Utc::now().to_rfc3339();
    if let Err(err) = room
        .state
        .with_doc(|state| state.set_prompt_run(cell_id, &started_at))
    {
        warn!("[prompt-agent] Failed to publish prompt run for {cell_id}: {err}");
    }
    Some(PromptRunClaim {
        room: Arc::clone(room),
        cell_id: cell_id.to_string(),
    })
}

impl Drop for PromptRunClaim {
    fn drop(&mut self) {
        if let Err(err) = self
            .room
            .state
            .with_doc(|state| state.clear_prompt_run(&self.cell_id))
        {
            warn!(
                "[prompt-agent] Failed to clear prompt run for {}: {err}",
                self.cell_id
            );
        }
        *self
            .room
            .active_prompt_run
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
    }
}

async fn agent_input(
    room: &NotebookRoom,
    cells_above: &[CellSnapshot],
    execution_ids: &HashMap<String, String>,
    runtime: Option<&str>,
    prompt: &str,
) -> String {
    let mut notebook = String::new();
    for cell in cells_above.iter().filter(|cell| !is_context_excluded(cell)) {
        let kind = if prompt_mode(cell).is_some() {
            "prompt"
        } else if answered_prompt_id(cell).is_some() {
            "answer"
        } else {
            cell.cell_type.as_str()
        };
        notebook.push_str(&format!(
            "<cell id=\"{}\" type=\"{kind}\">\n{}\n</cell>\n",
            cell.id, cell.source
        ));
        let Some(execution_id) = execution_ids.get(&cell.id) else {
            continue;
        };
        let manifests = room
            .state
            .read(|state| state.get_outputs(execution_id))
            .unwrap_or_default();
        for manifest in &manifests {
            if let Some(text) = output_text(manifest, &room.blob_store).await {
                notebook.push_str(&format!(
                    "<output cell=\"{}\">\n{text}\n</output>\n",
                    cell.id
                ));
            }
        }
    }
    let open_tag = match runtime {
        Some(runtime) => format!("<notebook runtime=\"{runtime}\">"),
        None => "<notebook>".to_string(),
    };
    format!("{open_tag}\n{notebook}</notebook>\n\n{prompt}")
}

fn spawn_agent(launch: &AgentLaunch, args: &[String]) -> std::io::Result<Child> {
    std::fs::create_dir_all(&launch.cwd)?;
    let mut command = Command::new(&launch.command);
    command
        .args(args)
        .envs(&launch.env)
        .current_dir(&launch.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command.spawn()
}

async fn run_agent(claim: PromptRunClaim, mut child: Child, input: String, cancel: Arc<Notify>) {
    let room = Arc::clone(&claim.room);
    let process_group = AgentProcessGroup(child.id());
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(err) = stdin.write_all(input.as_bytes()).await {
            warn!("[prompt-agent] Failed to send the prompt to the agent: {err}");
        }
    }
    let stderr = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text).await;
            text
        })
    });

    let mut answer = AnswerWriter {
        room: Arc::clone(&room),
        prompt_cell_id: claim.cell_id.clone(),
        cell_id: None,
        written: String::new(),
        pending: String::new(),
    };
    let mut result = None;
    let mut cancelled = false;
    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        let mut flush = tokio::time::interval(FLUSH_INTERVAL);
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => match parse_stream_line(&line) {
                        Some(AgentEvent::TextBlockStart) if !answer.is_empty() => answer.push("\n\n"),
                        Some(AgentEvent::Text(text)) => answer.push(&text),
                        Some(AgentEvent::Result { is_error, text }) => result = Some((is_error, text)),
                        _ => {}
                    },
                    Ok(None) | Err(_) => break,
                },
                _ = flush.tick() => answer.flush().await,
                _ = cancel.notified() => {
                    signal_agent(&mut child, cancelled);
                    cancelled = true;
                }
            }
        }
    }

    let succeeded = child.wait().await.is_ok_and(|status| status.success());
    drop(process_group);
    let stderr = match stderr {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    match result {
        Some((true, text)) => answer.push_note(&format!("**Agent error:** {text}")),
        Some((false, text)) if answer.is_empty() => answer.push(&text),
        None if !cancelled && !succeeded => {
            answer.push_note(&format!("**Agent error:** {}", stderr_tail(&stderr)))
        }
        _ => {}
    }
    answer.flush().await;
    answer.finish().await;
}

fn stderr_tail(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() {
        return "the agent command exited without a reply".to_string();
    }
    let skip = stderr.chars().count().saturating_sub(MAX_STDERR_CHARS);
    stderr.chars().skip(skip).collect()
}

/// First Stop interrupts the agent's process group so it can end its turn;
/// a later Stop kills the group.
#[cfg(unix)]
fn signal_agent(child: &mut Child, force: bool) {
    if let Some(pid) = child.id() {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        let signal = if force {
            Signal::SIGKILL
        } else {
            Signal::SIGINT
        };
        let _ = killpg(Pid::from_raw(pid as i32), signal);
    }
}

#[cfg(not(unix))]
fn signal_agent(child: &mut Child, _force: bool) {
    let _ = child.start_kill();
}

/// Kills whatever is left of the agent's process group (for example an MCP
/// server it started) when the run ends or the daemon drops the task.
struct AgentProcessGroup(Option<u32>);

impl Drop for AgentProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            use nix::sys::signal::{killpg, Signal};
            use nix::unistd::Pid;
            let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
        }
    }
}

struct AnswerWriter {
    room: Arc<NotebookRoom>,
    prompt_cell_id: String,
    cell_id: Option<String>,
    written: String,
    pending: String,
}

impl AnswerWriter {
    fn is_empty(&self) -> bool {
        self.written.is_empty() && self.pending.is_empty()
    }

    fn push(&mut self, text: &str) {
        self.pending.push_str(text);
    }

    fn push_note(&mut self, note: &str) {
        if !self.is_empty() {
            self.push("\n\n");
        }
        self.push(note);
    }

    async fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.pending);
        let answer_cell_id = self.cell_id.clone();
        let prompt_cell_id = self.prompt_cell_id.clone();
        let written = mutate_notebook(&self.room, "prompt-answer", |doc| match answer_cell_id {
            Some(id) => {
                doc.append_source(&id, &text)?;
                Ok(id)
            }
            None => start_answer(doc, &prompt_cell_id, &text),
        })
        .await;
        match written {
            Ok(id) => {
                self.cell_id = Some(id);
                self.written.push_str(&text);
            }
            Err(err) => warn!("[prompt-agent] Failed to write the answer: {err}"),
        }
    }

    async fn finish(&self) {
        let (Some(id), Some(code)) = (&self.cell_id, single_code_block(&self.written)) else {
            return;
        };
        let result = mutate_notebook(&self.room, "prompt-answer-code", |doc| {
            doc.set_cell_type(id, "code")?;
            doc.update_source(id, code)?;
            Ok(())
        })
        .await;
        if let Err(err) = result {
            warn!("[prompt-agent] Failed to turn the answer into a code cell: {err}");
        }
    }
}

fn start_answer(
    doc: &mut NotebookDoc,
    prompt_cell_id: &str,
    text: &str,
) -> Result<String, AutomergeError> {
    let existing = doc
        .get_cells()
        .into_iter()
        .find(|cell| answered_prompt_id(cell) == Some(prompt_cell_id));
    if let Some(answer) = existing {
        if answer.cell_type != "markdown" {
            doc.set_cell_type(&answer.id, "markdown")?;
        }
        doc.set_execution_id(&answer.id, None)?;
        doc.update_source(&answer.id, text)?;
        return Ok(answer.id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    doc.add_cell_after(&id, "markdown", Some(prompt_cell_id))?;
    doc.update_source(&id, text)?;
    doc.update_cell_metadata_at(
        &id,
        &["nteract", "prompt_response"],
        serde_json::json!({ "prompt_cell_id": prompt_cell_id }),
    )?;
    Ok(id)
}

async fn mutate_notebook<T>(
    room: &NotebookRoom,
    operation: &str,
    mutation: impl FnOnce(&mut NotebookDoc) -> Result<T, AutomergeError>,
) -> Result<T, String> {
    let value = {
        let mut doc = room.doc.write().await;
        let rollback_actor = doc.get_actor_id();
        let rollback_snapshot = doc.save();
        let baseline_heads = doc.get_heads();
        let value = doc
            .transact_at_heads_recovering(
                &baseline_heads,
                Some(PROMPT_AGENT_ACTOR),
                operation,
                mutation,
            )
            .map_err(|err| err.to_string())?;
        commit_daemon_notebook_mutation(
            room,
            &mut doc,
            &baseline_heads,
            &rollback_snapshot,
            &rollback_actor,
            operation,
        )?;
        value
    };
    let _ = room.broadcasts.changed_tx.send(());
    Ok(value)
}

#[cfg(all(test, unix))]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::PoisonError;
    use std::time::Duration;

    use notebook_doc::CellSnapshot;
    use serde_json::{json, Value};

    use super::*;
    use crate::blob_store::BlobStore;
    use crate::prompt_agent::answered_prompt_id;
    use crate::requests::cancel_prompt_cell;

    fn test_room() -> (Arc<NotebookRoom>, tempfile::TempDir) {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        (room, tmp)
    }

    async fn add_cell(
        room: &NotebookRoom,
        id: &str,
        cell_type: &str,
        source: &str,
        metadata: Value,
    ) {
        let mut doc = room.doc.write().await;
        let last = doc.get_cell_ids().last().cloned();
        doc.add_cell_after(id, cell_type, last.as_deref()).unwrap();
        doc.update_source(id, source).unwrap();
        doc.set_cell_metadata(id, &metadata).unwrap();
    }

    async fn add_prompt(room: &NotebookRoom, id: &str, source: &str) {
        add_cell(room, id, "raw", source, json!({"nteract": {"prompt": {}}})).await;
    }

    fn fake_agent(dir: &Path, script: &str) -> PathBuf {
        let record = dir.join(format!("fake-agent-{}", uuid::Uuid::new_v4()));
        std::fs::write(format!("{}.sh", record.display()), script).unwrap();
        record
    }

    fn emit(line: Value) -> String {
        format!("printf '%s\\n' '{line}'\n")
    }

    fn text(delta: &str) -> String {
        emit(json!({"type": "stream_event", "event": {
            "type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": delta}
        }}))
    }

    fn result(is_error: bool, text: &str) -> String {
        emit(json!({"type": "result", "subtype": "success", "is_error": is_error, "result": text}))
    }

    fn agent_input(agent: &Path) -> String {
        std::fs::read_to_string(format!("{}.stdin", agent.display())).unwrap()
    }

    fn run_is_active(room: &NotebookRoom) -> bool {
        room.active_prompt_run
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    fn prompt_is_running(room: &NotebookRoom, cell_id: &str) -> bool {
        room.state
            .read(|sd| sd.read_state().prompt_runs.contains_key(cell_id))
            .unwrap()
    }

    async fn wait_until_idle(room: &NotebookRoom) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while run_is_active(room) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("prompt run should finish");
    }

    async fn answers(room: &NotebookRoom, prompt_id: &str) -> Vec<CellSnapshot> {
        room.doc
            .read()
            .await
            .get_cells()
            .into_iter()
            .filter(|cell| answered_prompt_id(cell) == Some(prompt_id))
            .collect()
    }

    fn launch(agent: &Path) -> AgentLaunch {
        AgentLaunch {
            command: concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-agent.sh")
                .to_string(),
            env: HashMap::from([
                (
                    "FAKE_AGENT_SCRIPT".to_string(),
                    format!("{}.sh", agent.display()),
                ),
                ("FAKE_AGENT_RECORD".to_string(), agent.display().to_string()),
            ]),
            cwd: std::env::temp_dir().join(format!("prompt-agent-test-{}", uuid::Uuid::new_v4())),
            runt: Some(PathBuf::from("/opt/nteract/runt")),
            socket_path: PathBuf::from("/run/runtimed.sock"),
        }
    }

    async fn run(room: &Arc<NotebookRoom>, cell_id: &str, agent: &Path) -> NotebookResponse {
        handle(room, cell_id.to_string(), &launch(agent)).await
    }

    fn agent_args_used(agent: &Path) -> Vec<String> {
        std::fs::read_to_string(format!("{}.args", agent.display()))
            .unwrap()
            .lines()
            .map(String::from)
            .collect()
    }

    #[tokio::test]
    async fn streams_the_reply_into_a_markdown_answer_below_the_prompt() {
        let (room, tmp) = test_room();
        add_cell(&room, "intro", "markdown", "# Data", json!({})).await;
        add_prompt(&room, "prompt", "Say hello").await;
        add_cell(&room, "below", "code", "x = 1", json!({})).await;
        let agent = fake_agent(
            tmp.path(),
            &format!(
                "{}sleep 0.3\n{}{}",
                text("Hello "),
                text("world"),
                result(false, "Hello world")
            ),
        );

        assert!(matches!(
            run(&room, "prompt", &agent).await,
            NotebookResponse::Ok {}
        ));
        assert!(prompt_is_running(&room, "prompt"));
        wait_until_idle(&room).await;

        let cells = room.doc.read().await.get_cells();
        let ids: Vec<&str> = cells.iter().map(|cell| cell.id.as_str()).collect();
        assert_eq!(ids.len(), 4);
        assert_eq!(&ids[..2], ["intro", "prompt"]);
        assert_eq!(ids[3], "below");
        let answer = &cells[2];
        assert_eq!(answer.cell_type, "markdown");
        assert_eq!(answer.source, "Hello world");
        assert_eq!(answered_prompt_id(answer), Some("prompt"));
        assert!(!prompt_is_running(&room, "prompt"));
    }

    #[tokio::test]
    async fn a_reply_that_is_one_code_block_becomes_a_code_answer() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Print one").await;
        let agent = fake_agent(tmp.path(), &text("```python\nprint(1)\n```"));

        run(&room, "prompt", &agent).await;
        wait_until_idle(&room).await;

        let answer = answers(&room, "prompt").await.remove(0);
        assert_eq!(answer.cell_type, "code");
        assert_eq!(answer.source, "print(1)");
    }

    #[tokio::test]
    async fn rerunning_replaces_the_existing_answer_in_place() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Answer me").await;
        run(
            &room,
            "prompt",
            &fake_agent(tmp.path(), &text("```python\nold()\n```")),
        )
        .await;
        wait_until_idle(&room).await;
        let first = answers(&room, "prompt").await.remove(0);
        room.doc
            .write()
            .await
            .set_execution_id(&first.id, Some("exec-old"))
            .unwrap();

        run(
            &room,
            "prompt",
            &fake_agent(tmp.path(), &text("A fresh answer")),
        )
        .await;
        wait_until_idle(&room).await;

        let answers = answers(&room, "prompt").await;
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].id, first.id);
        assert_eq!(answers[0].cell_type, "markdown");
        assert_eq!(answers[0].source, "A fresh answer");
        assert_eq!(room.doc.read().await.get_execution_id(&first.id), None);
    }

    #[tokio::test]
    async fn sends_included_cells_above_with_outputs_and_the_prompt_last() {
        let (room, tmp) = test_room();
        add_cell(&room, "intro", "markdown", "# Intro", json!({})).await;
        add_cell(
            &room,
            "secret",
            "code",
            "secret = 1",
            json!({"nteract": {"context_exclude": true}}),
        )
        .await;
        add_cell(&room, "calc", "code", "x = 41 + 1\nprint(x)", json!({})).await;
        room.state
            .with_doc(|sd| {
                sd.create_execution("exec-calc")?;
                sd.append_output(
                    "exec-calc",
                    &json!({"output_type": "stream", "output_id": "o1", "name": "stdout", "text": {"inline": "42\n"}}),
                )?;
                Ok(())
            })
            .unwrap();
        room.doc
            .write()
            .await
            .set_execution_id("calc", Some("exec-calc"))
            .unwrap();
        add_prompt(&room, "prompt", "What is x?").await;
        add_cell(&room, "below", "code", "below = 1", json!({})).await;
        let agent = fake_agent(tmp.path(), &text("42"));

        run(&room, "prompt", &agent).await;
        wait_until_idle(&room).await;

        let input = agent_input(&agent);
        assert!(input.contains("# Intro"), "{input}");
        assert!(input.contains("x = 41 + 1"), "{input}");
        assert!(input.contains("42\n"), "{input}");
        assert!(input.trim_end().ends_with("What is x?"), "{input}");
        assert!(!input.contains("secret = 1"), "{input}");
        assert!(!input.contains("below = 1"), "{input}");
    }

    #[tokio::test]
    async fn rejects_a_cell_that_is_not_a_prompt() {
        let (room, tmp) = test_room();
        add_cell(&room, "code", "code", "x = 1", json!({})).await;

        let response = run(&room, "code", &fake_agent(tmp.path(), "")).await;

        assert!(
            matches!(response, NotebookResponse::Error { .. }),
            "{response:?}"
        );
        assert!(!run_is_active(&room));
    }

    #[tokio::test]
    async fn rejects_a_second_run_while_one_is_in_progress() {
        let (room, tmp) = test_room();
        add_prompt(&room, "first", "One").await;
        add_prompt(&room, "second", "Two").await;
        let slow = fake_agent(tmp.path(), "sleep 30");

        assert!(matches!(
            run(&room, "first", &slow).await,
            NotebookResponse::Ok {}
        ));
        let response = run(&room, "second", &fake_agent(tmp.path(), "")).await;

        assert!(
            matches!(response, NotebookResponse::Error { .. }),
            "{response:?}"
        );
        assert!(!prompt_is_running(&room, "second"));
        cancel_prompt_cell::handle(&room, "first");
        wait_until_idle(&room).await;
    }

    #[tokio::test]
    async fn cancel_stops_the_agent_and_keeps_the_partial_answer() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Take your time").await;
        let agent = fake_agent(tmp.path(), &format!("{}sleep 30", text("partial")));

        run(&room, "prompt", &agent).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while answers(&room, "prompt").await.is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("partial answer should stream before cancel");

        assert!(matches!(
            cancel_prompt_cell::handle(&room, "prompt"),
            NotebookResponse::Ok {}
        ));
        wait_until_idle(&room).await;

        assert_eq!(answers(&room, "prompt").await[0].source, "partial");
        assert!(!prompt_is_running(&room, "prompt"));
    }

    #[tokio::test]
    async fn an_agent_error_is_written_into_the_answer() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Hi").await;
        let agent = fake_agent(
            tmp.path(),
            &format!(
                "{}exit 1",
                result(true, "Not logged in · Please run /login")
            ),
        );

        run(&room, "prompt", &agent).await;
        wait_until_idle(&room).await;

        let answer = answers(&room, "prompt").await.remove(0);
        assert!(
            answer.source.contains("Not logged in · Please run /login"),
            "{}",
            answer.source
        );
    }

    #[tokio::test]
    async fn a_missing_agent_command_is_an_error_and_frees_the_slot() {
        let (room, _tmp) = test_room();
        add_prompt(&room, "prompt", "Hi").await;

        let missing = AgentLaunch {
            command: "/nonexistent/agent-cli".to_string(),
            ..launch(Path::new("/nonexistent/record"))
        };
        let response = handle(&room, "prompt".to_string(), &missing).await;

        match response {
            NotebookResponse::Error { error } => {
                assert!(error.contains("/nonexistent/agent-cli"), "{error}")
            }
            other => panic!("expected an error, got {other:?}"),
        }
        assert!(!run_is_active(&room));
        assert!(!prompt_is_running(&room, "prompt"));
    }

    #[tokio::test]
    async fn full_mode_gives_the_agent_an_nteract_server_pinned_to_this_notebook() {
        let (room, tmp) = test_room();
        add_cell(
            &room,
            "prompt",
            "raw",
            "Fix the cell above",
            json!({"nteract": {"prompt": {"mode": "full"}}}),
        )
        .await;
        let agent = fake_agent(tmp.path(), &text("Done."));

        assert!(matches!(
            run(&room, "prompt", &agent).await,
            NotebookResponse::Ok {}
        ));
        wait_until_idle(&room).await;

        let args = agent_args_used(&agent);
        let mcp_config = &args[args.iter().position(|arg| arg == "--mcp-config").unwrap() + 1];
        assert!(mcp_config.contains(&room.id.to_string()), "{mcp_config}");
        assert!(mcp_config.contains("/opt/nteract/runt"), "{mcp_config}");
    }

    #[tokio::test]
    async fn full_mode_without_runt_is_an_error() {
        let (room, tmp) = test_room();
        add_cell(
            &room,
            "prompt",
            "raw",
            "Fix it",
            json!({"nteract": {"prompt": {"mode": "full"}}}),
        )
        .await;
        let agent = fake_agent(tmp.path(), &text("Done."));
        let without_runt = AgentLaunch {
            runt: None,
            ..launch(&agent)
        };

        let response = handle(&room, "prompt".to_string(), &without_runt).await;

        assert!(
            matches!(response, NotebookResponse::Error { .. }),
            "{response:?}"
        );
        assert!(!run_is_active(&room));
    }

    #[tokio::test]
    async fn explore_mode_starts_the_agent_without_mcp_servers() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Explain").await;
        let agent = fake_agent(tmp.path(), &text("Sure."));

        run(&room, "prompt", &agent).await;
        wait_until_idle(&room).await;

        assert!(!agent_args_used(&agent).contains(&"--mcp-config".to_string()));
    }

    #[test]
    fn find_runt_searches_the_path_for_this_channels_cli() {
        let dir = tempfile::tempdir().unwrap();
        let runt = dir.path().join(runt_workspace::cli_command_name());
        std::fs::write(&runt, "").unwrap();

        assert_eq!(find_runt(dir.path().to_str().unwrap()), Some(runt));
        assert_eq!(find_runt("/nonexistent-prompt-agent-dir"), None);
    }

    #[test]
    fn find_runt_does_not_borrow_another_channels_cli() {
        if runt_workspace::cli_command_name() == "runt" {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("runt"), "").unwrap();

        assert_eq!(find_runt(dir.path().to_str().unwrap()), None);
    }

    #[tokio::test]
    async fn dropping_a_claimed_run_frees_the_slot_and_the_running_marker() {
        let (room, _tmp) = test_room();

        let claim = claim_prompt_run(&room, "prompt", Arc::new(Notify::new())).expect("free slot");
        assert!(run_is_active(&room));
        assert!(prompt_is_running(&room, "prompt"));
        assert!(claim_prompt_run(&room, "other", Arc::new(Notify::new())).is_none());

        drop(claim);

        assert!(!run_is_active(&room));
        assert!(!prompt_is_running(&room, "prompt"));
    }

    #[tokio::test]
    async fn a_second_stop_kills_an_agent_that_ignores_interrupts() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Take your time").await;
        let agent = fake_agent(
            tmp.path(),
            &format!("trap '' INT\n{}sleep 30", text("partial")),
        );

        run(&room, "prompt", &agent).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while answers(&room, "prompt").await.is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("partial answer should stream before cancel");
        cancel_prompt_cell::handle(&room, "prompt");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(run_is_active(&room), "the agent ignores SIGINT");

        cancel_prompt_cell::handle(&room, "prompt");
        wait_until_idle(&room).await;
    }

    #[tokio::test]
    async fn a_background_process_left_by_the_agent_does_not_keep_the_run_open() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Hi").await;
        let agent = fake_agent(
            tmp.path(),
            &format!("{}sleep 30 > /dev/null &", text("done")),
        );

        run(&room, "prompt", &agent).await;
        wait_until_idle(&room).await;

        assert_eq!(answers(&room, "prompt").await[0].source, "done");
    }

    #[tokio::test]
    async fn tells_the_agent_which_runtime_the_notebook_uses() {
        let (room, tmp) = test_room();
        room.doc
            .write()
            .await
            .set_metadata_snapshot(&notebook_doc::metadata::NotebookMetadataSnapshot {
                kernelspec: Some(notebook_doc::metadata::KernelspecSnapshot {
                    name: "deno".to_string(),
                    display_name: "Deno".to_string(),
                    language: Some("typescript".to_string()),
                    extras: Default::default(),
                }),
                ..Default::default()
            })
            .unwrap();
        add_prompt(&room, "prompt", "Fetch a URL").await;
        let agent = fake_agent(tmp.path(), &text("ok"));

        run(&room, "prompt", &agent).await;
        wait_until_idle(&room).await;

        assert!(
            agent_input(&agent).starts_with("<notebook runtime=\"deno\">"),
            "{}",
            agent_input(&agent)
        );
    }

    #[tokio::test]
    async fn hosted_rooms_do_not_run_prompts() {
        let (room, tmp) = test_room();
        add_prompt(&room, "prompt", "Hi").await;
        room.mark_hosted();

        let response = run(&room, "prompt", &fake_agent(tmp.path(), &text("no"))).await;

        assert!(
            matches!(response, NotebookResponse::Error { .. }),
            "{response:?}"
        );
        assert!(!run_is_active(&room));
    }
}
