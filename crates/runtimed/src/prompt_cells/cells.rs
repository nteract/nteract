//! Prompt and answer cell metadata, and the cells that form a prompt's
//! context.
//!
//! A prompt cell is a raw cell whose metadata carries `nteract.prompt` (an
//! object). Its answers are ordinary markdown/code cells carrying
//! `nteract.prompt_response = { prompt_cell_id, execution_id, part,
//! streaming?, stopped? }`. Everything here is pure (no I/O). The frontend
//! mirrors the readers in `src/lib/prompt-cells.ts`.

use notebook_doc::CellSnapshot;
use serde_json::{json, Value};

fn nteract_meta<'a>(cell: &'a CellSnapshot, key: &str) -> Option<&'a Value> {
    cell.metadata.get("nteract")?.get(key)
}

fn prompt_response(cell: &CellSnapshot) -> Option<&Value> {
    nteract_meta(cell, "prompt_response").filter(|value| value.is_object())
}

/// True for a raw cell with an object at `metadata.nteract.prompt`.
pub fn is_prompt_cell(cell: &CellSnapshot) -> bool {
    cell.cell_type == "raw" && nteract_meta(cell, "prompt").is_some_and(|prompt| prompt.is_object())
}

/// The prompt cell an answer cell belongs to (`prompt_response.prompt_cell_id`).
pub fn answer_prompt_cell_id(cell: &CellSnapshot) -> Option<String> {
    prompt_response(cell)?
        .get("prompt_cell_id")?
        .as_str()
        .map(str::to_string)
}

/// The execution that produced an answer cell (`prompt_response.execution_id`).
pub fn answer_execution_id(cell: &CellSnapshot) -> Option<String> {
    prompt_response(cell)?
        .get("execution_id")?
        .as_str()
        .map(str::to_string)
}

/// True while the answer is still being produced (`prompt_response.streaming`).
pub fn answer_is_streaming(cell: &CellSnapshot) -> bool {
    prompt_response(cell)
        .and_then(|response| response.get("streaming"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Full cell metadata for an answer cell:
/// `{"nteract":{"prompt_response":{prompt_cell_id, execution_id, part, streaming?, stopped?}}}`.
/// `streaming` (the placeholder of a run in progress) and `stopped` (the
/// user stopped the run; the answer is partial) are only written when true.
pub fn prompt_response_metadata(
    prompt_cell_id: &str,
    execution_id: &str,
    part: usize,
    streaming: bool,
    stopped: bool,
) -> Value {
    let mut response = json!({
        "prompt_cell_id": prompt_cell_id,
        "execution_id": execution_id,
        "part": part,
    });
    if streaming {
        response["streaming"] = Value::Bool(true);
    }
    if stopped {
        response["stopped"] = Value::Bool(true);
    }
    json!({ "nteract": { "prompt_response": response } })
}

/// Indices of the cells that form the context of the prompt at
/// `prompt_index`: every cell above it, in order, except cells marked
/// `metadata.nteract.context_exclude == true`. Out-of-range index yields all
/// non-excluded cells.
pub fn context_cell_indices(cells: &[CellSnapshot], prompt_index: usize) -> Vec<usize> {
    let end = prompt_index.min(cells.len());
    (0..end)
        .filter(|&index| {
            let cell = &cells[index];
            let excluded = nteract_meta(cell, "context_exclude")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // A streaming answer placeholder is empty and is replaced by the
            // finished answer cells, so it is never context.
            !excluded && !answer_is_streaming(cell)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    // --- recognition ---

    #[test]
    fn context_skips_streaming_answer_placeholders() {
        let cells = vec![
            cell("a", "code", "x = 1", json!({})),
            cell(
                "p1-answer",
                "markdown",
                "",
                prompt_response_metadata("p0", "e0", 0, true, false),
            ),
            cell(
                "p1-final",
                "markdown",
                "done",
                prompt_response_metadata("p0", "e0", 0, false, false),
            ),
            cell("p", "raw", "ask", json!({"nteract": {"prompt": {}}})),
        ];
        assert_eq!(context_cell_indices(&cells, 3), vec![0, 2]);
    }

    #[test]
    fn raw_cell_with_prompt_object_is_a_prompt() {
        assert!(is_prompt_cell(&cell(
            "p",
            "raw",
            "q",
            json!({"nteract": {"prompt": {}}})
        )));
        // Extra keys (a future mode) are still a prompt.
        assert!(is_prompt_cell(&cell(
            "p",
            "raw",
            "q",
            json!({"nteract": {"prompt": {"mode": "x"}}})
        )));
    }

    #[test]
    fn other_cells_are_not_prompts() {
        assert!(!is_prompt_cell(&cell("c", "raw", "q", json!({}))));
        assert!(!is_prompt_cell(&cell(
            "c",
            "raw",
            "q",
            json!({"nteract": {}})
        )));
        assert!(!is_prompt_cell(&cell(
            "c",
            "raw",
            "q",
            json!({"nteract": {"prompt": true}})
        )));
        assert!(!is_prompt_cell(&cell(
            "c",
            "code",
            "q",
            json!({"nteract": {"prompt": {}}})
        )));
        assert!(!is_prompt_cell(&cell(
            "c",
            "markdown",
            "q",
            json!({"nteract": {"prompt": {}}})
        )));
    }

    #[test]
    fn answer_accessors_read_prompt_response() {
        let answer = cell(
            "a",
            "markdown",
            "",
            prompt_response_metadata("p1", "e1", 2, true, false),
        );
        assert_eq!(answer_prompt_cell_id(&answer).as_deref(), Some("p1"));
        assert_eq!(answer_execution_id(&answer).as_deref(), Some("e1"));
        assert!(answer_is_streaming(&answer));

        let done = cell(
            "a",
            "code",
            "",
            prompt_response_metadata("p1", "e1", 0, false, false),
        );
        assert!(!answer_is_streaming(&done));
        assert_eq!(answer_prompt_cell_id(&done).as_deref(), Some("p1"));

        let plain = cell("c", "code", "", json!({}));
        assert_eq!(answer_prompt_cell_id(&plain), None);
        assert_eq!(answer_execution_id(&plain), None);
        assert!(!answer_is_streaming(&plain));
    }

    #[test]
    fn prompt_response_metadata_shape() {
        assert_eq!(
            prompt_response_metadata("p", "e", 3, false, false),
            json!({"nteract": {"prompt_response": {
                "prompt_cell_id": "p", "execution_id": "e", "part": 3
            }}})
        );
        assert_eq!(
            prompt_response_metadata("p", "e", 0, true, false),
            json!({"nteract": {"prompt_response": {
                "prompt_cell_id": "p", "execution_id": "e", "part": 0, "streaming": true
            }}})
        );
        assert_eq!(
            prompt_response_metadata("p", "e", 1, false, true),
            json!({"nteract": {"prompt_response": {
                "prompt_cell_id": "p", "execution_id": "e", "part": 1, "stopped": true
            }}})
        );
    }

    // --- context selection ---

    #[test]
    fn context_is_every_cell_above_except_excluded() {
        let cells = vec![
            cell("a", "markdown", "intro", json!({})),
            cell(
                "b",
                "code",
                "secret",
                json!({"nteract": {"context_exclude": true}}),
            ),
            cell(
                "c",
                "code",
                "x = 1",
                json!({"nteract": {"context_exclude": false}}),
            ),
            cell("p", "raw", "ask", json!({"nteract": {"prompt": {}}})),
            cell("d", "code", "below", json!({})),
        ];
        assert_eq!(context_cell_indices(&cells, 3), vec![0, 2]);
        assert_eq!(context_cell_indices(&cells, 0), Vec::<usize>::new());
        // Out of range clamps instead of panicking.
        assert_eq!(context_cell_indices(&cells, 99), vec![0, 2, 3, 4]);
    }
}
