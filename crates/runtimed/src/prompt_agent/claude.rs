//! Claude CLI backend: runs `claude -p --output-format stream-json` on the
//! user's own login and turns its stream into answer text.

use std::process::Stdio;

use futures::future::BoxFuture;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::backend::{CancelTokens, ModelBackend, PromptRequest};

const MAX_STDERR_CHARS: usize = 600;

/// Runs the configured agent command (for example `claude`).
pub(crate) struct ClaudeCliBackend {
    command: String,
    /// Arguments placed before the CLI flags. Empty in production; tests run
    /// `sh <script>` so no freshly written executable is ever exec'd (that
    /// races with sibling forks: ETXTBSY).
    leading_args: Vec<String>,
}

impl ClaudeCliBackend {
    pub fn new(command: String) -> Self {
        Self {
            command,
            leading_args: Vec::new(),
        }
    }

    #[cfg(test)]
    fn with_leading_args(mut self, args: Vec<String>) -> Self {
        self.leading_args = args;
        self
    }
}

/// CLI arguments for explore mode: the user's login, no tools, no settings,
/// no MCP servers, nothing persisted.
pub(crate) fn agent_args(system_prompt: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--tools",
        "",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--system-prompt",
    ]
    .map(String::from)
    .to_vec();
    args.push(system_prompt.to_string());
    args
}

/// One interesting line of the CLI's stream-json output.
#[derive(Debug, PartialEq)]
pub(crate) enum StreamLine {
    /// A new text content block started.
    TextBlockStart,
    /// Text delta.
    Text(String),
    /// The final `result` line.
    Result { is_error: bool, text: String },
}

/// Parse one stream-json line. Everything the backend does not need (system
/// init, rate limits, whole `assistant` messages, tool blocks) yields `None`.
pub(crate) fn parse_stream_line(line: &str) -> Option<StreamLine> {
    let message: Value = serde_json::from_str(line).ok()?;
    match message.get("type")?.as_str()? {
        "stream_event" => {
            let event = message.get("event")?;
            match event.get("type")?.as_str()? {
                "content_block_start" => {
                    let block_type = event.get("content_block")?.get("type")?.as_str()?;
                    (block_type == "text").then_some(StreamLine::TextBlockStart)
                }
                "content_block_delta" => {
                    let delta = event.get("delta")?;
                    if delta.get("type")?.as_str()? != "text_delta" {
                        return None;
                    }
                    Some(StreamLine::Text(delta.get("text")?.as_str()?.to_string()))
                }
                _ => None,
            }
        }
        "result" => Some(StreamLine::Result {
            is_error: message
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            text: message
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        _ => None,
    }
}

fn stderr_tail(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() {
        return "the agent command exited without a reply".to_string();
    }
    let skip = stderr.chars().count().saturating_sub(MAX_STDERR_CHARS);
    stderr.chars().skip(skip).collect()
}

fn spawn_agent(command: &str, args: &[String]) -> std::io::Result<Child> {
    let mut cmd = Command::new(command);
    // A neutral working directory: the CLI reads `CLAUDE.md` and project
    // settings from its cwd, and the daemon's cwd is arbitrary. The user's
    // own login (home config) still applies.
    cmd.args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    // The CLI runs in its own process group, so killing the agent's group does
    // not reach it. Linux can have the kernel SIGKILL it when the agent dies;
    // elsewhere `kill_on_drop` and the group kill below are the only protection.
    #[cfg(target_os = "linux")]
    {
        let agent_pid = std::process::id() as libc::pid_t;
        // SAFETY: the hook runs between fork and exec and only calls
        // async-signal-safe functions (prctl, getppid, _exit).
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                // The agent may have died before the signal was armed.
                if libc::getppid() != agent_pid {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
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
/// server it started) when the run ends or the run future is dropped.
struct AgentProcessGroup(#[cfg_attr(not(unix), expect(dead_code))] Option<u32>);

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

impl ModelBackend for ClaudeCliBackend {
    fn run(
        &self,
        req: PromptRequest,
        deltas: mpsc::Sender<String>,
        cancel: CancelTokens,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let mut args = self.leading_args.clone();
            args.extend(agent_args(&req.system));
            let mut child = spawn_agent(&self.command, &args).map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "Agent command `{}` was not found. Install it, or set the agent \
                         command in Settings.",
                        self.command
                    )
                } else {
                    format!("Could not start agent command `{}`: {err}", self.command)
                }
            })?;
            debug!(
                "[prompt-agent] Spawned {} pid={:?} input_bytes={}",
                self.command,
                child.id(),
                req.input.len()
            );
            let _group = AgentProcessGroup(child.id());

            // Write the prompt off the read loop: a large input must not
            // deadlock against the CLI filling its stdout pipe.
            if let Some(mut stdin) = child.stdin.take() {
                let input = req.input;
                tokio::spawn(async move {
                    if let Err(err) = stdin.write_all(input.as_bytes()).await {
                        warn!("[prompt-agent] Failed to send the prompt to the agent: {err}");
                    }
                });
            }
            let stderr = child.stderr.take().map(|mut stderr| {
                tokio::spawn(async move {
                    let mut text = String::new();
                    let _ = stderr.read_to_string(&mut text).await;
                    text
                })
            });

            let mut result: Option<(bool, String)> = None;
            let mut emitted_text = false;
            let mut interrupted = false;
            let mut killed = false;
            if let Some(stdout) = child.stdout.take() {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    tokio::select! {
                        line = lines.next_line() => match line {
                            Ok(Some(line)) => match parse_stream_line(&line) {
                                Some(StreamLine::TextBlockStart) if emitted_text => {
                                    if deltas.send("\n\n".into()).await.is_err() {
                                        return Ok(());
                                    }
                                }
                                Some(StreamLine::Text(delta)) => {
                                    emitted_text = true;
                                    if deltas.send(delta).await.is_err() {
                                        return Ok(());
                                    }
                                }
                                Some(StreamLine::Result { is_error, text }) => {
                                    result = Some((is_error, text));
                                }
                                _ => {}
                            },
                            Ok(None) | Err(_) => break,
                        },
                        _ = cancel.interrupt.cancelled(), if !interrupted => {
                            interrupted = true;
                            signal_agent(&mut child, false);
                        }
                        _ = cancel.kill.cancelled(), if !killed => {
                            killed = true;
                            signal_agent(&mut child, true);
                        }
                    }
                }
            }

            // stdout can close (or break) while the CLI keeps running, so
            // Stop must still reach it here.
            let exit = loop {
                tokio::select! {
                    exit = child.wait() => break exit,
                    _ = cancel.interrupt.cancelled(), if !interrupted => {
                        interrupted = true;
                        signal_agent(&mut child, false);
                    }
                    _ = cancel.kill.cancelled(), if !killed => {
                        killed = true;
                        signal_agent(&mut child, true);
                    }
                }
            };
            let succeeded = exit.is_ok_and(|status| status.success());
            let stderr = match stderr {
                Some(task) => task.await.unwrap_or_default(),
                None => String::new(),
            };
            let stopped = cancel.stop_requested();

            match result {
                _ if stopped => Ok(()),
                Some((true, message)) if message.is_empty() => Err(stderr_tail(&stderr)),
                Some((true, message)) => Err(message),
                Some((false, answer)) => {
                    if !emitted_text && !answer.is_empty() {
                        let _ = deltas.send(answer).await;
                    }
                    Ok(())
                }
                None if !succeeded => Err(stderr_tail(&stderr)),
                None => Ok(()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    const SAMPLE: &str = include_str!("testdata/claude-stream-sample.jsonl");

    #[test]
    fn parses_the_recorded_cli_transcript() {
        let parsed: Vec<StreamLine> = SAMPLE.lines().filter_map(parse_stream_line).collect();
        assert_eq!(
            parsed,
            vec![
                StreamLine::TextBlockStart,
                StreamLine::Text("Hello **world**".to_string()),
                StreamLine::Result {
                    is_error: false,
                    text: "Hello **world**".to_string()
                },
            ]
        );
    }

    #[test]
    fn parses_errors_and_ignores_noise() {
        let error_result = r#"{"type":"result","subtype":"success","is_error":true,"result":"There's an issue with the selected model."}"#;
        let tool_block = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"x","input":{}}}}"#;
        let thinking = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}}"#;
        assert_eq!(
            parse_stream_line(error_result),
            Some(StreamLine::Result {
                is_error: true,
                text: "There's an issue with the selected model.".to_string()
            })
        );
        assert_eq!(parse_stream_line(tool_block), None);
        assert_eq!(parse_stream_line(thinking), None);
        assert_eq!(parse_stream_line(r#"{"type":"system"}"#), None);
        assert_eq!(parse_stream_line("not json"), None);
        assert_eq!(parse_stream_line(""), None);
    }

    #[test]
    fn args_give_the_cli_no_tools_and_the_users_login() {
        let args = agent_args("sys");
        let pair = |flag: &str, value: &str| args.windows(2).any(|w| w[0] == flag && w[1] == value);
        assert!(args.contains(&"-p".to_string()));
        assert!(pair("--output-format", "stream-json"));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        assert!(pair("--tools", ""));
        assert!(pair("--setting-sources", ""));
        assert!(pair("--system-prompt", "sys"));
        assert!(!args.contains(&"--bare".to_string()));
    }

    // -- process-level tests with a fake CLI --------------------------------

    fn emit(line: serde_json::Value) -> String {
        format!("printf '%s\\n' '{line}'\n")
    }

    fn text(delta: &str) -> String {
        emit(serde_json::json!({"type": "stream_event", "event": {
            "type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": delta}
        }}))
    }

    fn result(is_error: bool, text: &str) -> String {
        emit(
            serde_json::json!({"type": "result", "subtype": "success", "is_error": is_error, "result": text}),
        )
    }

    struct Harness {
        _dir: tempfile::TempDir,
        record: PathBuf,
        backend: ClaudeCliBackend,
    }

    /// A fake CLI: `sh <wrapper>` records the flags and stdin, then runs
    /// `script`.
    fn harness(script: &str) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record");
        let wrapper_path = dir.path().join("agent.sh");
        std::fs::write(
            &wrapper_path,
            format!(
                "printf '%s\\n' \"$@\" > '{rec}.args'\ncat > '{rec}.stdin'\n{script}",
                rec = record.display(),
            ),
        )
        .unwrap();
        Harness {
            backend: ClaudeCliBackend::new("sh".into())
                .with_leading_args(vec![wrapper_path.display().to_string()]),
            record,
            _dir: dir,
        }
    }

    fn request() -> PromptRequest {
        PromptRequest {
            system: "sys prompt".into(),
            input: "<notebook>\n</notebook>\n\nhello?".into(),
        }
    }

    /// Run to the end: the text deltas and how the run ended.
    async fn run_to_end(h: &Harness) -> (Vec<String>, Result<(), String>) {
        let (tx, mut rx) = mpsc::channel(16);
        let result = h.backend.run(request(), tx, CancelTokens::default()).await;
        let mut deltas = Vec::new();
        while let Some(delta) = rx.recv().await {
            deltas.push(delta);
        }
        (deltas, result)
    }

    /// Start a run whose script prints "partial" and then hangs; returns its
    /// delta receiver, cancel tokens and task.
    async fn start_hanging(
        script: &str,
    ) -> (
        mpsc::Receiver<String>,
        CancelTokens,
        tokio::task::JoinHandle<Result<(), String>>,
    ) {
        let h = harness(script);
        let (tx, mut rx) = mpsc::channel(16);
        let cancel = CancelTokens::default();
        let run = tokio::spawn({
            let cancel = cancel.clone();
            async move { h.backend.run(request(), tx, cancel).await }
        });
        assert_eq!(rx.recv().await.as_deref(), Some("partial"));
        (rx, cancel, run)
    }

    /// After Stop the run ends cleanly (partial text stays with the runner).
    async fn assert_ends_cleanly(
        mut rx: mpsc::Receiver<String>,
        run: tokio::task::JoinHandle<Result<(), String>>,
    ) {
        tokio::time::timeout(Duration::from_secs(10), run)
            .await
            .expect("the agent should end")
            .unwrap()
            .unwrap();
        assert_eq!(rx.recv().await, None);
    }

    #[tokio::test]
    async fn streams_the_recorded_transcript_and_passes_input_on_stdin() {
        let mut script = String::new();
        for line in SAMPLE.lines() {
            script.push_str(&format!(
                "printf '%s\\n' '{}'\n",
                line.replace('\'', "'\\''")
            ));
        }
        let h = harness(&script);
        assert_eq!(
            run_to_end(&h).await,
            (vec!["Hello **world**".to_string()], Ok(()))
        );
        let stdin = std::fs::read_to_string(format!("{}.stdin", h.record.display())).unwrap();
        assert_eq!(stdin, "<notebook>\n</notebook>\n\nhello?");
        let args = std::fs::read_to_string(format!("{}.args", h.record.display())).unwrap();
        assert!(args.contains("stream-json"));
        assert!(args.contains("sys prompt"));
    }

    #[tokio::test]
    async fn separates_text_blocks_with_a_blank_line() {
        let block = emit(serde_json::json!({"type": "stream_event", "event": {
            "type": "content_block_start", "index": 1,
            "content_block": {"type": "text", "text": ""}}}));
        let h = harness(&format!("{}{}{}", text("one"), block, text("two")));
        assert_eq!(
            run_to_end(&h).await,
            (vec!["one".into(), "\n\n".into(), "two".into()], Ok(()))
        );
    }

    #[tokio::test]
    async fn a_result_with_no_streamed_text_becomes_the_text() {
        let h = harness(&result(false, "final answer"));
        assert_eq!(
            run_to_end(&h).await,
            (vec!["final answer".to_string()], Ok(()))
        );
    }

    #[tokio::test]
    async fn failures_carry_the_result_text_or_the_stderr_tail() {
        for (script, expected) in [
            (result(true, "Not logged in"), "Not logged in"),
            (
                "echo 'boom: auth expired' >&2\nexit 3\n".to_string(),
                "boom: auth expired",
            ),
            (
                "exit 1\n".to_string(),
                "the agent command exited without a reply",
            ),
        ] {
            let (deltas, result) = run_to_end(&harness(&script)).await;
            assert!(deltas.is_empty());
            assert_eq!(result, Err(expected.to_string()));
        }
    }

    #[tokio::test]
    async fn a_missing_command_is_a_spawn_error_with_advice() {
        let backend = ClaudeCliBackend::new("/definitely/not/a/command".into());
        let (tx, _rx) = mpsc::channel(16);
        let message = backend
            .run(request(), tx, CancelTokens::default())
            .await
            .unwrap_err();
        assert!(message.contains("/definitely/not/a/command"), "{message}");
        assert!(message.contains("Settings"), "{message}");
    }

    #[tokio::test]
    async fn interrupt_signals_the_process_group_and_keeps_the_partial_text() {
        let (rx, cancel, run) = start_hanging(&format!("{}sleep 30\n", text("partial"))).await;
        cancel.interrupt.cancel();
        assert_ends_cleanly(rx, run).await;
    }

    #[tokio::test]
    async fn a_second_stop_kills_an_agent_that_ignores_interrupts() {
        let (mut rx, cancel, run) =
            start_hanging(&format!("trap '' INT\n{}sleep 30\n", text("partial"))).await;
        cancel.interrupt.cancel();
        // The agent ignores SIGINT, so the run stays open.
        assert!(
            tokio::time::timeout(Duration::from_millis(400), rx.recv())
                .await
                .is_err(),
            "agent should survive SIGINT"
        );
        cancel.kill.cancel();
        assert_ends_cleanly(rx, run).await;
    }

    #[tokio::test]
    async fn stop_still_kills_an_agent_that_closed_stdout() {
        let (rx, cancel, run) = start_hanging(&format!(
            "trap '' INT\n{}exec >&-\nsleep 30\n",
            text("partial")
        ))
        .await;
        cancel.interrupt.cancel();
        cancel.kill.cancel();
        assert_ends_cleanly(rx, run).await;
    }

    #[tokio::test]
    async fn a_background_process_left_by_the_agent_does_not_keep_the_run_open() {
        let h = harness(&format!("{}sleep 30 > /dev/null 2>&1 &\n", text("done")));
        // The orphan must not keep the run open once the agent itself exits.
        let run = tokio::time::timeout(Duration::from_secs(10), run_to_end(&h))
            .await
            .expect("run should end");
        assert_eq!(run, (vec!["done".to_string()], Ok(())));
    }
}
