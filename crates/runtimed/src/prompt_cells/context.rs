//! Builds the model input for a prompt cell: the cells above it, their
//! outputs, and the prompt text.
//!
//! The result is the FULL user message sent to the model (`<notebook ...>`,
//! cells, outputs, `</notebook>`, blank line, prompt text). The prompt agent
//! passes it through verbatim.

use super::cells::{answer_prompt_cell_id, context_cell_indices, is_prompt_cell};
use runtimed_outputs::output_resolver::{resolve_cell_outputs_for_llm, ResolveCtx};
use runtimed_outputs::resolved_output::{DataValue, Output};

use crate::notebook_sync_server::NotebookRoom;

/// System prompt for "explore" mode: no tools, answer in Markdown, runnable
/// code in MyST `{code-cell}` fences. It describes the message built here
/// (the `<notebook>` envelope) and the cell marker that `shape_answer`
/// relies on, so it lives with the context builder.
pub(crate) const EXPLORE_SYSTEM_PROMPT: &str = "You are an assistant inside a computational \
notebook. The user's message starts with the notebook cells above their question, wrapped in \
<notebook>, followed by the question itself. Reply in concise Markdown. Code meant to be run in \
the notebook goes in a MyST code-cell fence, as in ```{code-cell} python, written for the \
notebook's runtime (the runtime attribute of <notebook>, Python when absent). Each such block \
becomes a runnable notebook cell. Code shown only as an example or explanation, and commands for \
other tools such as a shell, use a normal fence such as ```python or ```bash and stay in the \
text. When the user only asks for code, reply with just the code-cell block.";

/// Each output is cut to this many characters before it goes to the model.
const MAX_OUTPUT_CHARS: usize = 4000;

/// The cells (sources and outputs) in the context together stay under this
/// many characters; see [`cap_context`].
const MAX_CONTEXT_CHARS: usize = 200_000;

/// MIME types tried in order when summarising a display output as text.
const TEXT_MIMES: [&str; 3] = ["text/llm+plain", "text/plain", "text/markdown"];

/// One context cell, snapshotted under the document lock.
struct ContextCell {
    id: String,
    kind: String,
    source: String,
    execution_id: Option<String>,
}

pub(crate) async fn build_context(
    room: &NotebookRoom,
    prompt_cell_id: &str,
) -> Result<String, String> {
    // Snapshot everything the document owns under one read lock, release it,
    // then resolve outputs (blob reads) without holding it.
    let (cells, runtime, prompt_source) = {
        let doc = room.doc.read().await;
        let all = doc.get_cells();
        let prompt_index = all
            .iter()
            .position(|cell| cell.id == prompt_cell_id)
            .ok_or_else(|| "The prompt cell no longer exists".to_string())?;
        if !is_prompt_cell(&all[prompt_index]) {
            return Err("The cell is no longer a prompt cell".to_string());
        }
        let cells: Vec<ContextCell> = context_cell_indices(&all, prompt_index)
            .into_iter()
            .map(|index| {
                let cell = &all[index];
                let kind = if is_prompt_cell(cell) {
                    "prompt".to_string()
                } else if answer_prompt_cell_id(cell).is_some() {
                    "answer".to_string()
                } else {
                    cell.cell_type.clone()
                };
                ContextCell {
                    id: cell.id.clone(),
                    kind,
                    source: cell.source.clone(),
                    execution_id: doc.get_execution_id(&cell.id),
                }
            })
            .collect();
        (
            cells,
            doc.detect_runtime(),
            all[prompt_index].source.clone(),
        )
    };

    // One chunk per context cell: its tag plus its outputs.
    let mut chunks: Vec<String> = Vec::with_capacity(cells.len());
    for cell in &cells {
        let mut chunk = format!(
            "<cell id=\"{}\" type=\"{}\">\n{}\n</cell>\n",
            cell.id, cell.kind, cell.source
        );
        // A prompt cell's execution outputs are its own streamed answer (or a
        // PromptError). The answer reaches the model through its answer
        // cells; adding the output would repeat it or leak an error.
        let execution_id = cell.execution_id.as_ref().filter(|_| cell.kind != "prompt");
        if let Some(execution_id) = execution_id {
            let manifests = room
                .state
                .read(|state| state.get_outputs(execution_id))
                .unwrap_or_default();
            let outputs = resolve_cell_outputs_for_llm(
                &manifests,
                ResolveCtx {
                    blob_store_path: Some(room.blob_store.root()),
                    ..ResolveCtx::default()
                },
            )
            .await;
            for output in &outputs {
                if let Some(text) = output_text(output) {
                    chunk.push_str(&format!(
                        "<output cell=\"{}\">\n{text}\n</output>\n",
                        cell.id
                    ));
                }
            }
        }
        chunks.push(chunk);
    }
    let notebook = cap_context(chunks, MAX_CONTEXT_CHARS);
    let open_tag = match runtime.as_deref() {
        Some(runtime) => format!("<notebook runtime=\"{runtime}\">"),
        None => "<notebook>".to_string(),
    };
    Ok(format!(
        "{open_tag}\n{notebook}</notebook>\n\n{prompt_source}"
    ))
}

/// Join the per-cell chunks, dropping the earliest ones first while the total
/// exceeds `max_chars`. Dropped cells are replaced by one
/// `<!-- N earlier cells omitted -->` line.
fn cap_context(chunks: Vec<String>, max_chars: usize) -> String {
    let mut total: usize = chunks.iter().map(|chunk| chunk.chars().count()).sum();
    let mut start = 0;
    while total > max_chars && start < chunks.len() {
        total -= chunks[start].chars().count();
        start += 1;
    }
    let mut notebook = String::new();
    if start > 0 {
        notebook.push_str(&format!("<!-- {start} earlier cells omitted -->\n"));
    }
    for chunk in &chunks[start..] {
        notebook.push_str(chunk);
    }
    notebook
}

/// Text form of one resolved output, capped at [`MAX_OUTPUT_CHARS`].
fn output_text(output: &Output) -> Option<String> {
    let text = match output.output_type.as_str() {
        "stream" => output.text.clone()?,
        "error" => format!(
            "{}: {}",
            output.ename.as_deref().unwrap_or("Error"),
            output.evalue.as_deref().unwrap_or("")
        ),
        _ => {
            let data = output.data.as_ref()?;
            let text = TEXT_MIMES.iter().find_map(|mime| match data.get(*mime) {
                Some(DataValue::Text(text)) => Some(text.clone()),
                _ => None,
            });
            match text {
                Some(text) => text,
                None => {
                    let mut mimes: Vec<&str> = data.keys().map(String::as_str).collect();
                    mimes.sort_unstable();
                    format!("[{} output]", mimes.join(", "))
                }
            }
        }
    };
    Some(truncate(text))
}

fn truncate(text: String) -> String {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return text;
    }
    let cut: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{cut}\n[output truncated]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn output_text_prefers_llm_then_plain_and_describes_binary() {
        let mut data = HashMap::new();
        data.insert("text/plain".to_string(), DataValue::Text("plain".into()));
        data.insert("text/llm+plain".to_string(), DataValue::Text("llm".into()));
        assert_eq!(
            output_text(&Output::display_data(data)).as_deref(),
            Some("llm")
        );

        let mut data = HashMap::new();
        data.insert("text/plain".to_string(), DataValue::Text("plain".into()));
        assert_eq!(
            output_text(&Output::display_data(data)).as_deref(),
            Some("plain")
        );

        let mut data = HashMap::new();
        data.insert("image/png".to_string(), DataValue::Binary(vec![1]));
        assert_eq!(
            output_text(&Output::display_data(data)).as_deref(),
            Some("[image/png output]")
        );
    }

    #[test]
    fn cap_context_keeps_everything_under_the_limit() {
        let chunks = vec!["aaa\n".to_string(), "bbb\n".to_string()];
        assert_eq!(cap_context(chunks, 100), "aaa\nbbb\n");
    }

    #[test]
    fn cap_context_drops_the_earliest_cells_first_and_says_so() {
        let chunks = vec![
            "1111\n".to_string(),
            "2222\n".to_string(),
            "3333\n".to_string(),
        ];
        // 15 chars in total; 10 allowed: only the first cell goes.
        assert_eq!(
            cap_context(chunks.clone(), 10),
            "<!-- 1 earlier cells omitted -->\n2222\n3333\n"
        );
        assert_eq!(
            cap_context(chunks.clone(), 5),
            "<!-- 2 earlier cells omitted -->\n3333\n"
        );
        // Nothing fits: every cell is omitted.
        assert_eq!(cap_context(chunks, 1), "<!-- 3 earlier cells omitted -->\n");
    }

    #[test]
    fn output_text_formats_streams_and_errors_and_truncates() {
        assert_eq!(
            output_text(&Output::stream("stdout", "hi\n")).as_deref(),
            Some("hi\n")
        );
        assert_eq!(
            output_text(&Output::error("ValueError", "bad", vec![])).as_deref(),
            Some("ValueError: bad")
        );
        let long = "x".repeat(MAX_OUTPUT_CHARS + 10);
        let text = output_text(&Output::stream("stdout", &long)).unwrap();
        assert!(text.ends_with("\n[output truncated]"));
        assert_eq!(
            text.chars().count(),
            MAX_OUTPUT_CHARS + "\n[output truncated]".len()
        );
    }
}
