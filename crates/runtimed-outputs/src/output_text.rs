//! Text formatting for LLM-facing output consumers.
//!
//! Converts resolved notebook outputs to compact text using the same MIME
//! priority as LLM-selective resolution.

use regex::Regex;
use std::sync::LazyLock;

use crate::resolved_output::{DataValue, Output};

/// ANSI escape code regex: color codes, cursor movement, OSC sequences.
#[allow(clippy::expect_used)] // Static regex, always valid.
static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07|\x1b\(B").expect("valid ANSI regex")
});

/// MIME types to try for text output, in priority order.
const TEXT_MIME_PRIORITY: &[&str] = &[
    "text/llm+plain",
    "text/latex",
    "text/markdown",
    "text/plain",
    "application/json",
];

/// Safety-net text limit for formatting outputs that did not already receive
/// a purpose-built `text/llm+plain` summary.
const MAX_TEXT_BYTES: usize = 8 * 1024;

/// Strip ANSI escape codes from text.
pub fn strip_ansi(text: &str) -> String {
    ANSI_RE.replace_all(text, "").to_string()
}

/// Extract the best text representation from an output's data dictionary.
///
/// Text exceeding 8 KB is truncated with a size note appended. The LLM-specific
/// resolver should usually synthesize a smaller `text/llm+plain` first; this is
/// a final guard for direct formatter callers.
pub fn best_text_from_data(data: &std::collections::HashMap<String, DataValue>) -> Option<String> {
    for mime in TEXT_MIME_PRIORITY {
        if let Some(value) = data.get(*mime) {
            let text = match value {
                DataValue::Text(s) => Some(s.clone()),
                DataValue::Json(v) => Some(serde_json::to_string_pretty(v).unwrap_or_default()),
                DataValue::Binary(_) => None,
            };
            return text.map(|s| truncate_text(&s));
        }
    }
    None
}

fn truncate_text(s: &str) -> String {
    if s.len() <= MAX_TEXT_BYTES {
        return s.to_string();
    }

    let mut end = MAX_TEXT_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let total_kb = s.len() / 1024;
    format!("{}\n... [truncated, {} KB total]", &s[..end], total_kb)
}

/// Format a single output as text for LLM consumption.
pub fn format_output_text(output: &Output) -> Option<String> {
    match output.output_type.as_str() {
        "stream" => {
            let text = output.text.as_deref().unwrap_or("");
            let stripped = strip_ansi(text);
            if stripped.is_empty() {
                None
            } else {
                Some(stripped)
            }
        }
        "error" => {
            let mut parts = Vec::new();
            if let Some(ename) = &output.ename {
                let evalue = output.evalue.as_deref().unwrap_or("");
                parts.push(format!("{ename}: {evalue}"));
            }
            if let Some(traceback) = &output.traceback {
                let stripped: Vec<String> = traceback.iter().map(|t| strip_ansi(t)).collect();
                parts.push(stripped.join("\n"));
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        "display_data" | "execute_result" => output.data.as_ref().and_then(best_text_from_data),
        _ => None,
    }
}

/// Format all outputs as a single text string, double-newline separated.
pub fn format_outputs_text(outputs: &[Output]) -> String {
    outputs
        .iter()
        .filter_map(format_output_text)
        .collect::<Vec<_>>()
        .join("\n\n")
}
