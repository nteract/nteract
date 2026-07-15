//! Output formatting for MCP tool results.
//!
//! Converts notebook outputs to text for LLM consumption, with ANSI stripping
//! and MIME type priority. Matches the Python MCP server's formatting behavior.
//!
//! # Two channels, two audiences
//!
//! MCP tool results serve two audiences. Content blocks are the AGENT channel:
//! minimal tokens, maximal contextual understanding, navigable (pointers to
//! fetch more). `structuredContent` is the HUMAN RENDER contract consumed by
//! the MCP App renderer: complete and URL-rich, never token-optimized.
//! Everything in this module shapes the agent channel; the human contract
//! lives in `crate::structured`.

use regex::Regex;
use std::sync::LazyLock;

use rmcp::model::{Content, Role};
use runtimed_outputs::output_resolver::{content_ref_meta, CONTENT_PRIORITY};
use runtimed_outputs::resolved_output::{DataValue, Output};

/// Build a text `Content` block annotated `audience: [assistant]`.
///
/// Content blocks are the agent channel: minimal tokens, maximal contextual
/// understanding, navigable pointers to fetch more. `structuredContent` is the
/// human render contract (MCP App renderer): complete and URL-rich, never
/// token-optimized. Annotating agent-channel text with the assistant audience
/// lets renderers drop it from human views without guessing. Resource-link
/// content items stay unannotated — both audiences navigate by them.
pub fn assistant_text(text: impl Into<String>) -> Content {
    Content::text(text.into()).with_audience(vec![Role::Assistant])
}

/// ANSI escape code regex — matches color codes, cursor movement, OSC sequences.
#[allow(clippy::expect_used)] // Static regex, always valid
static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07|\x1b\(B").expect("valid ANSI regex")
});

/// MIME types to try for text output, in priority order.
/// Matches the `CONTENT_PRIORITY` order in `output_resolver.rs` with
/// `application/json` appended as a formatting-layer fallback.
const TEXT_MIME_PRIORITY: &[&str] = &[
    "text/llm+plain",
    "text/latex",
    "text/markdown",
    "text/plain",
    "application/json",
];

/// Maximum text size (bytes) before truncation in `best_text_from_data`.
/// Acts as a safety net for heavy types that don't have `text/llm+plain` synthesis.
const MAX_TEXT_BYTES: usize = 8 * 1024;

/// Strip ANSI escape codes from text.
pub fn strip_ansi(text: &str) -> String {
    ANSI_RE.replace_all(text, "").to_string()
}

/// Extract the best text representation from an output's data dictionary.
/// Returns None if no suitable text MIME type is found.
///
/// Text exceeding 8 KB is truncated with a size note appended.
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

/// Truncate text to `MAX_TEXT_BYTES`, appending a size note if truncated.
fn truncate_text(s: &str) -> String {
    if s.len() <= MAX_TEXT_BYTES {
        return s.to_string();
    }
    // Find a char boundary at or before MAX_TEXT_BYTES
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
        "display_data" | "execute_result" => {
            if let Some(data) = &output.data {
                best_text_from_data(data)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Format all outputs as a single text string (double-newline separated).
pub fn format_outputs_text(outputs: &[Output]) -> String {
    outputs
        .iter()
        .filter_map(format_output_text)
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Convert outputs to separate Content items (one per output).
/// This gives MCP clients richer structure than a single concatenated string.
/// When outputs exist but have no text representation, appends a summary
/// so agents know execution produced output they can't see.
///
/// All text items are agent-channel content, annotated `audience: [assistant]`.
pub fn outputs_to_content_items(outputs: &[Output]) -> Vec<rmcp::model::Content> {
    let mut items: Vec<rmcp::model::Content> = Vec::new();
    let mut omitted_count = 0usize;
    let mut omitted_mimes: Vec<String> = Vec::new();

    for output in outputs {
        if let Some(text) = format_output_text(output) {
            items.push(assistant_text(text));
        } else if output.output_type == "display_data" || output.output_type == "execute_result" {
            omitted_count += 1;
            if let Some(data) = &output.data {
                let mimes: Vec<&str> = data
                    .keys()
                    .map(|k| k.as_str())
                    .filter(|k| !k.starts_with("text/llm"))
                    .collect();
                if !mimes.is_empty() {
                    omitted_mimes.push(mimes.join(", "));
                }
            }
        }
    }

    if omitted_count > 0 {
        let detail = if omitted_mimes.is_empty() {
            String::new()
        } else {
            format!(" ({})", omitted_mimes.join("; "))
        };
        items.push(assistant_text(format!(
            "[{omitted_count} output(s) with non-text content{detail} — visible in the notebook UI]"
        )));
    }

    items
}

/// Format compact output summary lines for list/read views.
///
/// These lines are intentionally small: they tell an agent that output exists,
/// what kind of output it is, and which MIME types are present without forcing
/// the full output body into context. A caller can still append the full
/// formatted output text after these summaries.
pub fn format_outputs_summary_lines(outputs: &[Output], preview_chars: usize) -> Vec<String> {
    outputs
        .iter()
        .enumerate()
        .map(|(index, output)| format_output_summary_line(index, output, preview_chars))
        .collect()
}

/// Format summary lines from manifest-aligned resolved outputs.
///
/// Emits the same lines as [`format_outputs_summary_lines`], plus at most one
/// [`rich_blob_note`] legibility line per output when its manifest carries
/// blob-stored rich MIMEs. `resolved_by_manifest` and `manifests` are the
/// parallel slices produced by `resolve_cell_outputs_for_llm_aligned`;
/// unresolved manifests (`None`) get no summary line, so `out[index]`
/// numbering matches the flattened output list used for content items.
pub fn format_outputs_summary_lines_aligned(
    resolved_by_manifest: &[Option<Output>],
    manifests: &[serde_json::Value],
    preview_chars: usize,
) -> Vec<String> {
    let mut lines = Vec::new();
    let mut index = 0usize;
    for (resolved, manifest) in resolved_by_manifest.iter().zip(manifests) {
        let Some(output) = resolved else { continue };
        lines.push(format_output_summary_line(index, output, preview_chars));
        if let Some(note) = rich_blob_note(manifest) {
            lines.push(note);
        }
        index += 1;
    }
    lines
}

/// Legibility line for an output manifest's blob-stored rich MIMEs.
///
/// Rich representations (arrow streams, html, images, viz specs — anything
/// stored as a blob and rendered as a blob URL on the human channel) never
/// arrive inline on the agent channel. This returns ONE compact line naming
/// them with sizes so the agent knows the human already sees a full render
/// and can fetch by URL only when it truly needs the bytes. The inline text
/// MIMEs in `CONTENT_PRIORITY` are skipped — those arrive as agent text.
///
/// Returns `None` when the output has no blob-stored rich MIME, so the line
/// appears at most once per output and only when it carries information.
pub fn rich_blob_note(manifest: &serde_json::Value) -> Option<String> {
    let data = manifest.get("data")?.as_object()?;
    let mut entries: Vec<(&str, u64)> = data
        .iter()
        .filter(|(mime, _)| !CONTENT_PRIORITY.contains(&mime.as_str()))
        .filter_map(|(mime, content_ref)| {
            let meta = content_ref_meta(content_ref);
            meta.blob_hash.map(|_| (mime.as_str(), meta.size))
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    entries.sort_unstable_by_key(|(mime, _)| *mime);
    let listed = entries
        .iter()
        .map(|(mime, size)| format!("{} {}", short_mime_label(mime), format_compact_size(*size)))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "Rendered for humans in the notebook; fetch by URL only if needed: {listed}"
    ))
}

/// Compact label for a MIME type in the legibility line.
///
/// `text/html` → `html`, `image/png` → `png`, `image/svg+xml` → `svg`,
/// `application/vnd.plotly.v1+json` → `plotly.v1`. Arrow stream MIMEs get a
/// fixed `apache-arrow` label because the generic subtype rule would keep
/// the unhelpful `nteract.arrow-stream-manifest` spelling.
fn short_mime_label(mime: &str) -> String {
    if mime == notebook_doc::mime::ARROW_STREAM_MANIFEST_MIME
        || mime == notebook_doc::mime::ARROW_STREAM_MIME
    {
        return "apache-arrow".to_string();
    }
    let subtype = mime.rsplit('/').next().unwrap_or(mime);
    let subtype = subtype.strip_prefix("vnd.").unwrap_or(subtype);
    let subtype = subtype.split('+').next().unwrap_or(subtype);
    subtype.to_string()
}

/// Format a byte count compactly: `512B`, `20KB`, `1.5MB`.
///
/// One decimal max; a trailing `.0` is dropped.
pub fn format_compact_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value < KB {
        format!("{bytes}B")
    } else if value < MB {
        format_scaled(value / KB, "KB")
    } else {
        format_scaled(value / MB, "MB")
    }
}

fn format_scaled(value: f64, unit: &str) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}{unit}")
    } else {
        format!("{rounded:.1}{unit}")
    }
}

fn format_output_summary_line(index: usize, output: &Output, preview_chars: usize) -> String {
    let label = match output.output_type.as_str() {
        "stream" => {
            let name = output.name.as_deref().unwrap_or("stream");
            format!("stream({name})")
        }
        "error" => "error".to_string(),
        "display_data" | "execute_result" => {
            let mimes = output
                .data
                .as_ref()
                .map(|data| {
                    let mut keys: Vec<&str> = data.keys().map(String::as_str).collect();
                    keys.sort_unstable();
                    keys.join(", ")
                })
                .filter(|mimes| !mimes.is_empty());
            match mimes {
                Some(mimes) => format!("{}({mimes})", output.output_type),
                None => output.output_type.clone(),
            }
        }
        other => other.to_string(),
    };

    let preview = format_output_text(output)
        .map(|text| collapse_and_truncate(&text, preview_chars))
        .filter(|text| !text.is_empty())
        .map(|text| format!(" \"{text}\""))
        .unwrap_or_default();

    format!("out[{index}]: {label}{preview}")
}

fn collapse_and_truncate(text: &str, preview_chars: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let char_count = collapsed.chars().count();
    if char_count <= preview_chars {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(preview_chars).collect();
    let remaining = char_count - preview_chars;
    format!("{truncated}…[+{remaining} chars]")
}

/// Width of the visual divider in assistant-facing cell summaries.
const CELL_SUMMARY_DIVIDER: &str =
    "────────────────────────────────────────────────────────────────────";

/// Upper bound for one rendered output body inside a cell summary.
///
/// Output resolvers already cap large payloads, but summaries often include
/// many cells, so keep each output bounded independently.
const MAX_CELL_SUMMARY_OUTPUT_CHARS: usize = 2_400;

/// Format an assistant-friendly cell summary block.
///
/// The block intentionally avoids numeric cell positions. Agents should copy
/// `cell_id` values and use `after_cell_id` for ordering mutations.
#[derive(Debug, Clone, Copy, Default)]
pub struct CellSummaryContext<'a> {
    pub execution_count: Option<&'a str>,
    pub status: Option<&'a str>,
    pub execution_id: Option<&'a str>,
}

pub fn format_cell_summary(
    cell_id: &str,
    cell_type: &str,
    source: &str,
    context: CellSummaryContext<'_>,
    preview_chars: usize,
    outputs: &[Output],
) -> String {
    let mut header_parts = vec![format!("⏺ ━━━ cell {cell_id}"), format!("({cell_type})")];
    if let Some(st) = context.status {
        if !st.is_empty() {
            header_parts.push(format!("{} {st}", status_icon(st)));
        }
    }
    if let Some(ec) = context.execution_count {
        if !ec.is_empty() && cell_type == "code" {
            header_parts.push(format!("[{ec}]"));
        }
    }
    if let Some(eid) = context.execution_id {
        if !eid.is_empty() && cell_type == "code" {
            header_parts.push(format!("exec={eid}"));
        }
    }
    header_parts.push("━━━".to_string());

    let mut sections = vec![header_parts.join(" "), String::new(), "  In:".to_string()];
    let source_preview = truncate_chars(source.trim_end(), preview_chars);
    if source_preview.is_empty() {
        sections.push("      (empty)".to_string());
    } else {
        sections.push(indent_block(&source_preview, "      "));
    }

    for output in outputs {
        let Some(output_section) = format_summary_output(output) else {
            continue;
        };
        sections.push(String::new());
        sections.push(format!("  {CELL_SUMMARY_DIVIDER}"));
        sections.push(String::new());
        sections.push(output_section);
    }

    sections.join("\n")
}

fn format_summary_output(output: &Output) -> Option<String> {
    let label = output_summary_label(output);
    let text = format_output_text(output).unwrap_or_else(|| non_text_output_summary(output));
    let text = truncate_chars(text.trim_end(), MAX_CELL_SUMMARY_OUTPUT_CHARS);
    if text.is_empty() {
        return None;
    }

    Some(format!(
        "  Out [{label}]:\n{}",
        indent_block(&text, "      ")
    ))
}

fn output_summary_label(output: &Output) -> String {
    match output.output_type.as_str() {
        "stream" => output.name.as_deref().unwrap_or("stream").to_string(),
        "error" => "error".to_string(),
        "display_data" | "execute_result" => output
            .data
            .as_ref()
            .and_then(best_output_mime)
            .unwrap_or(output.output_type.as_str())
            .to_string(),
        other => other.to_string(),
    }
}

fn best_output_mime(data: &std::collections::HashMap<String, DataValue>) -> Option<&str> {
    for mime in TEXT_MIME_PRIORITY {
        if data.contains_key(*mime) {
            return Some(*mime);
        }
    }
    data.keys().map(String::as_str).min()
}

fn non_text_output_summary(output: &Output) -> String {
    let Some(data) = &output.data else {
        return String::new();
    };
    let mut mimes: Vec<&str> = data.keys().map(String::as_str).collect();
    mimes.sort_unstable();
    if mimes.is_empty() {
        String::new()
    } else {
        format!("[non-text output: {}]", mimes.join(", "))
    }
}

fn indent_block(text: &str, indent: &str) -> String {
    text.lines()
        .map(|line| format!("{indent}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let max_chars = max_chars.max(1);
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    let remaining = char_count - max_chars;
    format!("{truncated}…[+{remaining} chars]")
}

fn status_icon(status: &str) -> &'static str {
    match status {
        "idle" | "done" => "✓",
        "error" => "✗",
        "running" => "◐",
        "queued" => "⧗",
        "cancelled" => "⊘",
        "never_run" => "○",
        _ => "?",
    }
}

/// Format a cell header line (matches Python _format_header).
///
/// Example: ━━━ cell-abc12345 (code) ✓ idle [3] exec=exec-7f3a2b ━━━
pub fn format_cell_header(
    cell_id: &str,
    cell_type: &str,
    execution_count: Option<&str>,
    status: Option<&str>,
    execution_id: Option<&str>,
) -> String {
    let mut parts = vec![format!("━━━ {cell_id}")];

    parts.push(format!("({cell_type})"));

    if let Some(st) = status {
        if !st.is_empty() {
            parts.push(format!("{} {st}", status_icon(st)));
        }
    }

    if let Some(ec) = execution_count {
        if !ec.is_empty() {
            parts.push(format!("[{ec}]"));
        }
    }

    if let Some(eid) = execution_id {
        if !eid.is_empty() {
            parts.push(format!("exec={eid}"));
        }
    }

    parts.push("━━━".to_string());
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtimed_outputs::resolved_output::{DataValue, Output};
    use std::collections::HashMap;

    fn data(pairs: &[(&str, DataValue)]) -> HashMap<String, DataValue> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("\x1b[1;32mbold green\x1b[0m"), "bold green");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn strip_ansi_removes_osc_sequence() {
        // OSC: ESC ] ... BEL — used for window titles, hyperlinks. Must not
        // leak through to the LLM as cruft.
        assert_eq!(strip_ansi("\x1b]0;title\x07after"), "after");
    }

    #[test]
    fn best_text_picks_highest_priority_mime() {
        // `text/llm+plain` is synthesized by repr-llm and is the preferred
        // representation for LLM consumption — must beat text/plain even
        // when both are present.
        let d = data(&[
            ("text/plain", DataValue::Text("fallback".into())),
            ("text/llm+plain", DataValue::Text("llm-optimized".into())),
        ]);
        assert_eq!(best_text_from_data(&d).as_deref(), Some("llm-optimized"));
    }

    #[test]
    fn best_text_falls_back_to_application_json() {
        let d = data(&[(
            "application/json",
            DataValue::Json(serde_json::json!({"a": 1})),
        )]);
        let Some(text) = best_text_from_data(&d) else {
            panic!("json should render");
        };
        assert!(text.contains("\"a\""));
        assert!(text.contains('1'));
    }

    #[test]
    fn best_text_ignores_binary_only_data() {
        let d = data(&[("image/png", DataValue::Binary(vec![0x89, 0x50]))]);
        assert_eq!(best_text_from_data(&d), None);
    }

    #[test]
    fn best_text_truncates_oversize_payloads() {
        // Safety net for heavy types with no text/llm+plain synthesis.
        // Truncation must include the size hint so the LLM sees that
        // content was dropped.
        let big = "a".repeat(16 * 1024);
        let d = data(&[("text/plain", DataValue::Text(big))]);
        let Some(text) = best_text_from_data(&d) else {
            panic!("should return truncated");
        };
        assert!(text.contains("[truncated"));
        assert!(text.contains("16 KB total"));
    }

    #[test]
    fn truncate_text_respects_char_boundaries() {
        // 4-byte characters (e.g. emoji) right at the boundary must not
        // cut mid-codepoint and produce invalid UTF-8.
        let emoji = "🚀".repeat(3000); // 4 bytes each = 12 KB
        let d = data(&[("text/plain", DataValue::Text(emoji))]);
        let Some(text) = best_text_from_data(&d) else {
            panic!("should return truncated");
        };
        assert!(text.contains("[truncated"));
        // If we cut mid-codepoint, the format! would have panicked already.
    }

    #[test]
    fn format_stream_output_strips_ansi() {
        let o = Output::stream("stdout", "\x1b[31merror\x1b[0m in the output");
        assert_eq!(
            format_output_text(&o).as_deref(),
            Some("error in the output")
        );
    }

    #[test]
    fn format_empty_stream_output_is_none() {
        let o = Output::stream("stdout", "");
        assert_eq!(format_output_text(&o), None);
    }

    #[test]
    fn format_error_output_joins_ename_evalue_and_traceback() {
        let o = Output::error(
            "NameError",
            "name 'x' is not defined",
            vec![
                "\x1b[31mTraceback (most recent call last):\x1b[0m".into(),
                "  File \"<stdin>\", line 1, in <module>".into(),
            ],
        );
        let Some(text) = format_output_text(&o) else {
            panic!("error output should format");
        };
        assert!(text.contains("NameError: name 'x' is not defined"));
        assert!(text.contains("Traceback"));
        // ANSI codes in traceback must be stripped too.
        assert!(!text.contains('\x1b'));
    }

    #[test]
    fn format_unknown_output_type_is_none() {
        let o = Output {
            output_type: "weird-future-type".into(),
            ..Output::stream("stdout", "")
        };
        assert_eq!(format_output_text(&o), None);
    }

    #[test]
    fn format_outputs_text_joins_with_blank_line() {
        let outputs = vec![
            Output::stream("stdout", "first"),
            Output::stream("stdout", "second"),
        ];
        assert_eq!(format_outputs_text(&outputs), "first\n\nsecond");
    }

    #[test]
    fn outputs_to_content_items_summarizes_image_only() {
        // A bare image output has no text rep; the agent needs to know
        // something was produced, hence the "[N output(s) with non-text
        // content]" footer.
        let outputs = vec![Output::display_data(data(&[(
            "image/png",
            DataValue::Binary(vec![0; 10]),
        )]))];
        let items = outputs_to_content_items(&outputs);
        assert_eq!(items.len(), 1);
        let rendered = format!("{:?}", items[0]);
        assert!(rendered.contains("1 output"));
        assert!(rendered.contains("image/png"));
    }

    #[test]
    fn outputs_to_content_items_excludes_llm_mimes_from_summary() {
        // `text/llm+plain` is an LLM synthesis artifact — if it exists we'd
        // already have rendered the output as text, so we should never be
        // in the omitted branch. But if we were, the summary should not
        // leak the llm+plain mime type to the agent.
        let outputs = vec![Output::display_data(data(&[
            ("image/png", DataValue::Binary(vec![0; 10])),
            ("text/llm+plain", DataValue::Text("hidden".into())),
        ]))];
        let items = outputs_to_content_items(&outputs);
        // Rendered as text via text/llm+plain — no omitted footer.
        assert_eq!(items.len(), 1);
        let rendered = format!("{:?}", items[0]);
        assert!(rendered.contains("hidden"));
    }

    fn manifest(entries: &[(&str, serde_json::Value)]) -> serde_json::Value {
        let data: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .map(|(mime, content_ref)| (mime.to_string(), content_ref.clone()))
            .collect();
        serde_json::json!({ "output_type": "display_data", "data": data })
    }

    fn blob_ref(size: u64) -> serde_json::Value {
        serde_json::json!({ "blob": "sha256:abc", "size": size })
    }

    fn inline_ref(text: &str) -> serde_json::Value {
        serde_json::json!({ "inline": text })
    }

    // ── agent-channel audience annotations ──────────────────────

    #[test]
    fn assistant_text_sets_assistant_audience() {
        let item = assistant_text("hello");
        assert_eq!(item.audience(), Some(&vec![Role::Assistant]));
        assert_eq!(item.as_text().expect("text content").text, "hello");
    }

    #[test]
    fn outputs_to_content_items_annotates_every_text_item_for_assistant() {
        // Both resolved output text and the omitted-content footer are
        // agent-channel items; renderers may drop them from human views.
        let outputs = vec![
            Output::stream("stdout", "hello"),
            Output::display_data(data(&[("image/png", DataValue::Binary(vec![0; 10]))])),
        ];
        let items = outputs_to_content_items(&outputs);
        assert_eq!(items.len(), 2);
        for item in &items {
            assert_eq!(item.audience(), Some(&vec![Role::Assistant]));
        }
    }

    // ── compact byte sizes ──────────────────────────────────────

    #[test]
    fn format_compact_size_scales_b_kb_mb() {
        assert_eq!(format_compact_size(0), "0B");
        assert_eq!(format_compact_size(512), "512B");
        assert_eq!(format_compact_size(20 * 1024), "20KB");
        assert_eq!(format_compact_size(500 * 1024), "500KB");
        // One decimal max; kept only when it carries information.
        assert_eq!(format_compact_size(84_480), "82.5KB");
        assert_eq!(format_compact_size(1024 * 1024), "1MB");
        assert_eq!(format_compact_size(1024 * 1024 + 512 * 1024), "1.5MB");
    }

    // ── legibility line for blob-stored rich MIMEs ──────────────

    #[test]
    fn rich_blob_note_lists_blob_mimes_with_sizes() {
        let m = manifest(&[
            ("text/plain", inline_ref("df")),
            ("text/html", blob_ref(20 * 1024)),
            ("image/png", blob_ref(84_480)),
            (
                notebook_doc::mime::ARROW_STREAM_MANIFEST_MIME,
                blob_ref(500 * 1024),
            ),
        ]);
        let note = rich_blob_note(&m).expect("rich blobs present");
        assert_eq!(
            note,
            "Rendered for humans in the notebook; fetch by URL only if needed: \
             apache-arrow 500KB, png 82.5KB, html 20KB"
        );
    }

    #[test]
    fn rich_blob_note_skips_content_priority_text_mimes() {
        // The CONTENT_PRIORITY text MIMEs arrive inline on the agent channel
        // even when blob-stored, so the note must not point at them.
        let m = manifest(&[
            ("text/llm+plain", blob_ref(1024)),
            ("text/latex", blob_ref(1024)),
            ("text/markdown", blob_ref(5 * 1024)),
            ("text/plain", blob_ref(100 * 1024)),
        ]);
        assert_eq!(rich_blob_note(&m), None);
    }

    #[test]
    fn rich_blob_note_ignores_inline_rich_mimes() {
        // Inline payloads have no blob URL to fetch; nothing to point at.
        let m = manifest(&[("application/json", inline_ref("{\"a\":1}"))]);
        assert_eq!(rich_blob_note(&m), None);

        let stream = serde_json::json!({
            "output_type": "stream",
            "name": "stdout",
            "text": { "inline": "hi" },
        });
        assert_eq!(rich_blob_note(&stream), None);
    }

    #[test]
    fn aligned_summary_appends_note_at_most_once_per_output() {
        let manifests = vec![
            manifest(&[
                ("text/html", blob_ref(20 * 1024)),
                ("image/png", blob_ref(2 * 1024)),
            ]),
            serde_json::json!({
                "output_type": "stream",
                "name": "stdout",
                "text": { "inline": "hi" },
            }),
        ];
        let resolved = vec![
            Some(Output::display_data(data(&[(
                "text/plain",
                DataValue::Text("chart".into()),
            )]))),
            Some(Output::stream("stdout", "hi")),
        ];

        let lines = format_outputs_summary_lines_aligned(&resolved, &manifests, 20);
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("out[0]: display_data"));
        assert_eq!(
            lines[1],
            "Rendered for humans in the notebook; fetch by URL only if needed: \
             png 2KB, html 20KB"
        );
        assert!(lines[2].starts_with("out[1]: stream(stdout)"));
        // Two rich blobs on one output still produce exactly one line.
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("Rendered for humans"))
                .count(),
            1
        );
    }

    #[test]
    fn aligned_summary_skips_unresolved_manifests_and_keeps_numbering() {
        let manifests = vec![
            manifest(&[("image/png", blob_ref(1024))]),
            serde_json::json!({
                "output_type": "stream",
                "name": "stdout",
                "text": { "inline": "hi" },
            }),
        ];
        let resolved = vec![None, Some(Output::stream("stdout", "hi"))];

        let lines = format_outputs_summary_lines_aligned(&resolved, &manifests, 20);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("out[0]: stream(stdout)"));
        // The unresolved manifest contributes neither a summary nor a note.
        assert!(!lines[0].contains("Rendered for humans"));
    }

    #[test]
    fn output_summary_lines_include_kind_mimes_and_preview() {
        let outputs = vec![
            Output::stream("stdout", "hello\nworld\n"),
            Output::display_data(data(&[(
                "text/html",
                DataValue::Text("<div>chart</div>".into()),
            )])),
        ];

        let lines = format_outputs_summary_lines(&outputs, 20);
        assert_eq!(lines[0], "out[0]: stream(stdout) \"hello world\"");
        assert_eq!(lines[1], "out[1]: display_data(text/html)");
    }

    #[test]
    fn output_summary_lines_truncate_preview() {
        let outputs = vec![Output::stream("stdout", &"a ".repeat(40))];

        let lines = format_outputs_summary_lines(&outputs, 12);
        assert!(lines[0].contains("…[+"));
        assert!(lines[0].contains("chars]"));
    }

    #[test]
    fn format_cell_summary_truncates_long_source() {
        let summary = format_cell_summary(
            "cell-abc",
            "code",
            "import numpy as np\nimport pandas as pd",
            CellSummaryContext {
                execution_count: Some("5"),
                status: Some("idle"),
                execution_id: Some("exec-123"),
            },
            15,
            &[],
        );
        assert!(summary.starts_with("⏺ ━━━ cell cell-abc (code) ✓ idle [5] exec=exec-123"));
        assert!(summary.contains("\n  In:\n"));
        assert!(summary.contains("…[+"));
        assert!(summary.contains(" chars]"));
    }

    #[test]
    fn format_cell_summary_skips_exec_for_markdown() {
        // Markdown cells don't have execution counts; the exec= field
        // must not appear even if a value was threaded through.
        let summary = format_cell_summary(
            "cell-md",
            "markdown",
            "# Hello",
            CellSummaryContext {
                execution_count: Some("1"),
                status: None,
                execution_id: Some("exec-md"),
            },
            50,
            &[],
        );
        assert!(!summary.contains("exec="));
        assert!(summary.contains("# Hello"));
    }

    #[test]
    fn format_cell_summary_preserves_multiline_source() {
        let summary = format_cell_summary(
            "cell-x",
            "code",
            "x = 1\n\n\n  y   =    2",
            CellSummaryContext::default(),
            100,
            &[],
        );
        assert!(summary.contains("      x = 1"));
        assert!(summary.contains("        y   =    2"));
    }

    #[test]
    fn format_cell_summary_renders_text_output_blocks() {
        let outputs = vec![Output::display_data(data(&[(
            "text/llm+plain",
            DataValue::Text("HuggingFace Dataset: 2,000 rows × 12 features".into()),
        )]))];

        let summary = format_cell_summary(
            "73fe9d2b-b4ab-4d39-ba90-fec52a1c3360",
            "code",
            "ds_slice",
            CellSummaryContext {
                execution_count: None,
                status: Some("done"),
                execution_id: None,
            },
            120,
            &outputs,
        );

        assert!(summary.contains("⏺ ━━━ cell 73fe9d2b-b4ab-4d39-ba90-fec52a1c3360 (code) ✓ done"));
        assert!(summary.contains("  In:\n      ds_slice"));
        assert!(summary.contains("  Out [text/llm+plain]:"));
        assert!(summary.contains("      HuggingFace Dataset: 2,000 rows × 12 features"));
    }

    #[test]
    fn format_cell_header_chooses_icon_by_status() {
        let idle = format_cell_header("cell-a", "code", Some("3"), Some("idle"), None);
        assert!(idle.contains("✓ idle"));
        assert!(idle.contains("[3]"));

        let err = format_cell_header("cell-b", "code", None, Some("error"), None);
        assert!(err.contains("✗ error"));

        let running = format_cell_header("cell-c", "code", None, Some("running"), None);
        assert!(running.contains("◐ running"));

        let queued = format_cell_header("cell-d", "code", None, Some("queued"), None);
        assert!(queued.contains("⧗ queued"));

        let never_run = format_cell_header("cell-z", "code", None, Some("never_run"), None);
        assert!(never_run.contains("○ never_run"));

        let unknown = format_cell_header("cell-e", "code", None, Some("bogus"), None);
        assert!(unknown.contains("? bogus"));
    }

    #[test]
    fn format_cell_header_includes_execution_id() {
        let header = format_cell_header(
            "cell-a",
            "code",
            Some("3"),
            Some("done"),
            Some("exec-7f3a2b"),
        );
        assert!(header.contains("exec=exec-7f3a2b"));
        assert!(header.contains("[3]"));
        assert!(header.contains("✓ done"));

        // None execution_id should not add exec= field
        let header_no_eid = format_cell_header("cell-b", "code", Some("1"), Some("done"), None);
        assert!(!header_no_eid.contains("exec="));
    }
}
