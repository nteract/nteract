//! Prompt cells: recognizing prompt and answer cells, building the agent's
//! input from the cells above a prompt, the agent CLI arguments, and parsing
//! the CLI's `stream-json` output.
//!
//! A prompt cell is a raw cell carrying `metadata.nteract.prompt`. Its answer
//! is one markdown or code cell carrying
//! `metadata.nteract.prompt_response.prompt_cell_id`.

use std::path::Path;

use notebook_doc::CellSnapshot;
use serde_json::{json, Value};

use crate::blob_store::BlobStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptMode {
    Explore,
    Full,
}

const MAX_OUTPUT_CHARS: usize = 4000;

pub(crate) const EXPLORE_SYSTEM_PROMPT: &str = "You are an assistant inside a computational \
notebook. The user's message starts with the notebook cells above their question, wrapped in \
<notebook>, followed by the question itself. When the user asks for code, reply with exactly one \
fenced code block and nothing else, written for the notebook's runtime (the runtime attribute of \
<notebook>, Python when absent). Otherwise reply in concise Markdown.";

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

const FULL_MODE_TOOLS: &[&str] = &[
    "connect_notebook",
    "get_cell",
    "get_all_cells",
    "create_cell",
    "set_cell",
    "delete_cell",
    "move_cell",
    "execute_cell",
    "get_results",
    "interrupt_kernel",
];

pub(crate) fn full_system_prompt(notebook_id: &str, prompt_cell_id: &str) -> String {
    format!(
        "You are an assistant inside a computational notebook, with tools to read, create, \
edit, move, delete and run its cells. The user's message starts with the notebook cells above \
their question, wrapped in <notebook>, followed by the question itself. First call \
connect_notebook with notebook_id \"{notebook_id}\" and pass the returned notebook_handle to the \
other nteract tools. Only change cells above the prompt cell \"{prompt_cell_id}\"; never change \
the prompt cell or its answer. Finish with a short Markdown summary of what you changed."
    )
}

pub(crate) fn full_mode_args(
    system_prompt: &str,
    runt: &Path,
    socket_path: &Path,
    notebook_id: &str,
) -> Vec<String> {
    let mcp_config = json!({
        "mcpServers": {
            "nteract": {
                "command": runt,
                "args": ["mcp", "--no-show", "--socket", socket_path],
                "env": { "NTERACT_MCP_PIN_NOTEBOOK": notebook_id },
            }
        }
    });
    let allowed_tools: Vec<String> = FULL_MODE_TOOLS
        .iter()
        .map(|tool| format!("mcp__nteract__{tool}"))
        .collect();
    let mut args = agent_args(system_prompt);
    args.push("--mcp-config".to_string());
    args.push(mcp_config.to_string());
    args.push("--allowedTools".to_string());
    args.push(allowed_tools.join(","));
    args
}

pub(crate) fn prompt_mode(cell: &CellSnapshot) -> Option<PromptMode> {
    if cell.cell_type != "raw" {
        return None;
    }
    let prompt = cell.metadata.get("nteract")?.get("prompt")?;
    match prompt.get("mode").and_then(Value::as_str) {
        Some("full") => Some(PromptMode::Full),
        _ => Some(PromptMode::Explore),
    }
}

pub(crate) fn answered_prompt_id(cell: &CellSnapshot) -> Option<&str> {
    cell.metadata
        .get("nteract")?
        .get("prompt_response")?
        .get("prompt_cell_id")?
        .as_str()
}

pub(crate) fn is_context_excluded(cell: &CellSnapshot) -> bool {
    cell.metadata
        .get("nteract")
        .and_then(|nteract| nteract.get("context_exclude"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(crate) async fn output_text(manifest: &Value, blob_store: &BlobStore) -> Option<String> {
    match manifest.get("output_type")?.as_str()? {
        "stream" => content_text(manifest.get("text")?, blob_store).await,
        "error" => Some(format!(
            "{}: {}",
            manifest.get("ename")?.as_str()?,
            manifest.get("evalue")?.as_str()?
        )),
        "display_data" | "execute_result" => {
            let data = manifest.get("data")?.as_object()?;
            if let Some(text) = match data.get("text/plain") {
                Some(content) => content_text(content, blob_store).await,
                None => None,
            } {
                return Some(text);
            }
            let mimes: Vec<&str> = data.keys().map(String::as_str).collect();
            Some(format!("[{} output]", mimes.join(", ")))
        }
        _ => None,
    }
}

async fn content_text(content: &Value, blob_store: &BlobStore) -> Option<String> {
    let text = match content.get("inline") {
        Some(inline) => inline.as_str()?.to_string(),
        None => {
            let bytes = blob_store
                .get(content.get("blob")?.as_str()?)
                .await
                .ok()??;
            String::from_utf8_lossy(&bytes).into_owned()
        }
    };
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return Some(text);
    }
    let truncated: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
    Some(format!("{truncated}\n[output truncated]"))
}

#[derive(Debug, PartialEq)]
pub(crate) enum AgentEvent {
    TextBlockStart,
    Text(String),
    Result { is_error: bool, text: String },
}

pub(crate) fn parse_stream_line(line: &str) -> Option<AgentEvent> {
    let message: Value = serde_json::from_str(line).ok()?;
    match message.get("type")?.as_str()? {
        "stream_event" => {
            let event = message.get("event")?;
            match event.get("type")?.as_str()? {
                "content_block_start" => {
                    let block_type = event.get("content_block")?.get("type")?.as_str()?;
                    (block_type == "text").then_some(AgentEvent::TextBlockStart)
                }
                "content_block_delta" => {
                    let delta = event.get("delta")?;
                    if delta.get("type")?.as_str()? != "text_delta" {
                        return None;
                    }
                    Some(AgentEvent::Text(delta.get("text")?.as_str()?.to_string()))
                }
                _ => None,
            }
        }
        "result" => Some(AgentEvent::Result {
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

pub(crate) fn single_code_block(text: &str) -> Option<&str> {
    let text = text.trim();
    let fence_len = text.bytes().take_while(|byte| *byte == b'`').count();
    if fence_len < 3 {
        return None;
    }
    let fence = &text[..fence_len];
    let (_info, body) = text[fence_len..].split_once('\n')?;
    let code = body.strip_suffix(fence)?;
    if code.contains(&format!("\n{fence}")) {
        return None;
    }
    Some(code.strip_suffix('\n').unwrap_or(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cell(id: &str, cell_type: &str, source: &str, metadata: Value) -> CellSnapshot {
        CellSnapshot {
            id: id.to_string(),
            cell_type: cell_type.to_string(),
            position: "80".to_string(),
            source: source.to_string(),
            execution_count: "null".to_string(),
            metadata,
            resolved_assets: Default::default(),
            attachments: Default::default(),
        }
    }

    #[test]
    fn raw_cell_with_prompt_marker_is_a_prompt() {
        let explore = cell("p", "raw", "q", json!({"nteract": {"prompt": {}}}));
        let full = cell(
            "p",
            "raw",
            "q",
            json!({"nteract": {"prompt": {"mode": "full"}}}),
        );

        assert_eq!(prompt_mode(&explore), Some(PromptMode::Explore));
        assert_eq!(prompt_mode(&full), Some(PromptMode::Full));
    }

    #[test]
    fn cells_without_the_marker_or_not_raw_are_not_prompts() {
        let plain_raw = cell("r", "raw", "q", json!({}));
        let marked_code = cell("c", "code", "q", json!({"nteract": {"prompt": {}}}));

        assert_eq!(prompt_mode(&plain_raw), None);
        assert_eq!(prompt_mode(&marked_code), None);
    }

    #[test]
    fn answer_cells_name_their_prompt() {
        let answer = cell(
            "a",
            "markdown",
            "hi",
            json!({"nteract": {"prompt_response": {"prompt_cell_id": "p"}}}),
        );

        assert_eq!(answered_prompt_id(&answer), Some("p"));
        assert_eq!(
            answered_prompt_id(&cell("m", "markdown", "", json!({}))),
            None
        );
    }

    #[test]
    fn context_exclude_flag_is_read_from_nteract_metadata() {
        let excluded = cell(
            "c",
            "code",
            "x",
            json!({"nteract": {"context_exclude": true}}),
        );

        assert!(is_context_excluded(&excluded));
        assert!(!is_context_excluded(&cell("c", "code", "x", json!({}))));
    }

    #[tokio::test]
    async fn output_text_reads_inline_and_blob_backed_text() {
        let tmp = tempfile::tempdir().unwrap();
        let blob_store = BlobStore::new(tmp.path().join("blobs"));
        let hash = blob_store
            .put(b"   a  b\n0  1  2", "text/plain")
            .await
            .unwrap();

        let stream =
            json!({"output_type": "stream", "name": "stdout", "text": {"inline": "hello\n"}});
        let error = json!({"output_type": "error", "ename": "ValueError", "evalue": "bad", "traceback": {"inline": "[]"}});
        let dataframe = json!({"output_type": "execute_result", "data": {
            "text/html": {"blob": "ignored", "size": 9000},
            "text/plain": {"blob": hash, "size": 15}
        }});
        let image = json!({"output_type": "display_data", "data": {"image/png": {"blob": "img", "size": 10}}});

        assert_eq!(
            output_text(&stream, &blob_store).await.as_deref(),
            Some("hello\n")
        );
        assert_eq!(
            output_text(&error, &blob_store).await.as_deref(),
            Some("ValueError: bad")
        );
        assert_eq!(
            output_text(&dataframe, &blob_store).await.as_deref(),
            Some("   a  b\n0  1  2")
        );
        assert_eq!(
            output_text(&image, &blob_store).await.as_deref(),
            Some("[image/png output]")
        );
    }

    #[test]
    fn parses_text_deltas_block_starts_and_results_from_recorded_stream() {
        let block_start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"s","parent_tool_use_id":null,"uuid":"u1"}"#;
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}},"session_id":"s","parent_tool_use_id":null,"uuid":"u2"}"#;
        let result = r#"{"duration_api_ms":2135,"stop_reason":"end_turn","session_id":"s","total_cost_usd":0.002,"type":"result","subtype":"success","is_error":false,"result":"pong"}"#;
        let error_result = r#"{"type":"result","subtype":"success","is_error":true,"result":"There's an issue with the selected model (definitely-not-a-model)."}"#;
        let tool_block_start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"x","input":{}}}}"#;

        assert_eq!(
            parse_stream_line(block_start),
            Some(AgentEvent::TextBlockStart)
        );
        assert_eq!(
            parse_stream_line(delta),
            Some(AgentEvent::Text("pong".to_string()))
        );
        assert_eq!(
            parse_stream_line(result),
            Some(AgentEvent::Result {
                is_error: false,
                text: "pong".to_string()
            })
        );
        assert_eq!(
            parse_stream_line(error_result),
            Some(AgentEvent::Result {
                is_error: true,
                text: "There's an issue with the selected model (definitely-not-a-model)."
                    .to_string()
            })
        );
        assert_eq!(parse_stream_line(tool_block_start), None);
        assert_eq!(
            parse_stream_line(r#"{"type":"system","subtype":"init"}"#),
            None
        );
        assert_eq!(parse_stream_line("not json"), None);
    }

    #[test]
    fn explore_args_keep_the_user_login_and_give_the_agent_no_tools() {
        let args = agent_args("system prompt");

        let pair = |flag: &str, value: &str| {
            args.windows(2)
                .any(|window| window[0] == flag && window[1] == value)
        };
        assert!(args.contains(&"-p".to_string()));
        assert!(pair("--output-format", "stream-json"));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        assert!(pair("--tools", ""));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(pair("--setting-sources", ""));
        assert!(pair("--system-prompt", "system prompt"));
        assert!(!args.contains(&"--bare".to_string()));
        assert!(!args.contains(&"--mcp-config".to_string()));
    }

    #[test]
    fn full_mode_args_pin_the_nteract_server_to_this_notebook() {
        let args = full_mode_args(
            "system prompt",
            Path::new("/opt/nteract/runt"),
            Path::new("/run/runtimed.sock"),
            "0b7c2a40-5f7e-4a11-9d8e-6b8f0c1d2e3f",
        );

        let value_after = |flag: &str| {
            let index = args.iter().position(|arg| arg == flag).unwrap();
            args[index + 1].clone()
        };
        let mcp_config: Value = serde_json::from_str(&value_after("--mcp-config")).unwrap();
        let server = &mcp_config["mcpServers"]["nteract"];
        assert_eq!(server["command"], "/opt/nteract/runt");
        assert_eq!(
            server["args"],
            json!(["mcp", "--no-show", "--socket", "/run/runtimed.sock"])
        );
        assert_eq!(
            server["env"]["NTERACT_MCP_PIN_NOTEBOOK"],
            "0b7c2a40-5f7e-4a11-9d8e-6b8f0c1d2e3f"
        );
        let allowed = value_after("--allowedTools");
        assert!(allowed.contains("mcp__nteract__set_cell"), "{allowed}");
        assert!(allowed.contains("mcp__nteract__execute_cell"), "{allowed}");
        assert!(!allowed.contains("run_all_cells"), "{allowed}");
        assert!(!allowed.contains("restart_kernel"), "{allowed}");
        assert_eq!(value_after("--tools"), "");
        assert!(args.contains(&"--strict-mcp-config".to_string()));
    }

    #[test]
    fn a_reply_that_is_exactly_one_fenced_block_is_code() {
        assert_eq!(
            single_code_block("```python\nx = 1\nprint(x)\n```"),
            Some("x = 1\nprint(x)")
        );
        assert_eq!(single_code_block("\n```\ny = 2\n```\n"), Some("y = 2"));
    }

    #[test]
    fn a_longer_fence_can_wrap_code_that_contains_backtick_fences() {
        assert_eq!(single_code_block("````python\nx = 1\n````"), Some("x = 1"));
        assert_eq!(
            single_code_block("````markdown\n```python\ny = 2\n```\n````"),
            Some("```python\ny = 2\n```")
        );
    }

    #[test]
    fn prose_or_several_blocks_stay_markdown() {
        assert_eq!(single_code_block("Use this:\n```python\nx = 1\n```"), None);
        assert_eq!(
            single_code_block("```python\na = 1\n```\nthen\n```python\nb = 2\n```"),
            None
        );
        assert_eq!(single_code_block("no fences here"), None);
    }
}
