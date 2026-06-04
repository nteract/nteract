use nteract_markdown_engine::{
    project_markdown, MeasurementConfidence, MeasurementPlan, NodeKind, ProjectedNode,
};
use std::sync::Mutex;

static LAST_OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[no_mangle]
pub extern "C" fn nteract_markdown_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn nteract_markdown_free(pointer: *mut u8, len: usize) {
    if !pointer.is_null() {
        drop(Vec::from_raw_parts(pointer, 0, len));
    }
}

#[no_mangle]
pub unsafe extern "C" fn nteract_markdown_project(pointer: *const u8, len: usize) -> usize {
    let bytes = std::slice::from_raw_parts(pointer, len);
    let json = match std::str::from_utf8(bytes) {
        Ok(source) => project_to_json(source),
        Err(error) => error_to_json(&format!("source was not valid UTF-8: {error}")),
    };
    let mut output = LAST_OUTPUT.lock().expect("wasm output lock poisoned");
    *output = json.into_bytes();
    output.len()
}

#[no_mangle]
pub extern "C" fn nteract_markdown_result_ptr() -> *const u8 {
    LAST_OUTPUT
        .lock()
        .expect("wasm output lock poisoned")
        .as_ptr()
}

#[no_mangle]
pub extern "C" fn nteract_markdown_result_len() -> usize {
    LAST_OUTPUT.lock().expect("wasm output lock poisoned").len()
}

pub fn project_to_json(source: &str) -> String {
    match project_markdown(source) {
        Ok(plan) => render_wasm_plan(source, &plan.blocks, &plan.measurement),
        Err(error) => error_to_json(&error.to_string()),
    }
}

fn error_to_json(message: &str) -> String {
    let mut output = String::from("{\"version\":1,\"engine\":\"rust-wasm\",\"error\":");
    push_json_string(&mut output, message);
    output.push_str(",\"measurement\":{\"estimatedHeight\":0,\"confidence\":\"low\",\"width\":0},\"blocks\":[],\"runs\":[],\"byteLength\":0,\"utf16Length\":0}");
    output
}

fn render_wasm_plan(
    source: &str,
    blocks: &[ProjectedNode],
    measurement: &MeasurementPlan,
) -> String {
    let position_index = PositionIndex::new(source);
    let mut output_blocks = Vec::new();
    let mut output_runs = Vec::new();

    for (block_index, block) in blocks.iter().enumerate() {
        let (wasm_block, mut runs) = collect_block(source, &position_index, block_index, block);
        output_blocks.push(wasm_block);
        output_runs.append(&mut runs);
    }

    let mut output = String::new();
    output.push_str("{\"version\":1,\"engine\":\"rust-wasm\",\"byteLength\":");
    output.push_str(&position_index.byte_len.to_string());
    output.push_str(",\"utf16Length\":");
    output.push_str(&position_index.utf16_len.to_string());
    output.push_str(",\"measurement\":{");
    output.push_str("\"estimatedHeight\":");
    output.push_str(&measurement.estimated_height.to_string());
    output.push_str(",\"confidence\":");
    push_json_string(&mut output, confidence_label(measurement.confidence));
    output.push_str(",\"width\":");
    output.push_str(&measurement.width.to_string());
    output.push('}');
    output.push_str(",\"blocks\":[");
    for (index, block) in output_blocks.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        block.push_json(&mut output);
    }
    output.push_str("],\"runs\":[");
    for (index, run) in output_runs.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        run.push_json(&mut output);
    }
    output.push_str("]}");
    output
}

fn collect_block(
    source: &str,
    position_index: &PositionIndex,
    block_index: usize,
    block: &ProjectedNode,
) -> (WasmBlock, Vec<WasmRun>) {
    let mut context = RunContext {
        block_id: block.id.clone(),
        inline_index: 0,
        item_index: None,
        link_href: None,
        link_title: None,
        position_index,
        rendered_cursor: 0,
        runs: Vec::new(),
        syntax_spans: Vec::new(),
    };

    let mut kind = block_kind(block);
    let mut element = block_element(block);

    match block.kind {
        NodeKind::Heading => {
            collect_children(source, &mut context, &block.children, "heading-text");
            add_outer_syntax_spans(&mut context, block, "block-boundary");
        }
        NodeKind::Paragraph | NodeKind::Blockquote | NodeKind::TableCell => {
            collect_children(source, &mut context, &block.children, "text");
        }
        NodeKind::List => {
            for (item_index, item) in block.children.iter().enumerate() {
                let before = context.runs.len();
                context.item_index = Some(item_index);
                collect_children(source, &mut context, &item.children, "list-item");
                if let Some(first_run) = context.runs.get(before) {
                    context.syntax_spans.push(WasmSyntaxSpan::new(
                        position_index,
                        item.span.start,
                        first_run.source_span_byte[0],
                        Some(first_run.inline_id.clone()),
                        0,
                        "block-boundary",
                    ));
                }
            }
            context.item_index = None;
        }
        NodeKind::CodeBlock => collect_code_block(source, &mut context, block),
        NodeKind::MathBlock => {
            context.add_run(
                block.span.start,
                block.span.end,
                block.fallback.text.clone(),
                "math-source",
                None,
            );
        }
        NodeKind::Html => {
            let raw = block.fallback.copy_text.as_str();
            if let Some(fragment) = safe_inline_html(raw) {
                kind = "paragraph";
                element = "p";
                let run = context.add_run(
                    block.span.start + fragment.open_len,
                    block.span.start + fragment.close_start,
                    fragment.text.to_string(),
                    "html-fragment",
                    Some(raw.to_string()),
                );
                context.syntax_spans.push(WasmSyntaxSpan::new(
                    position_index,
                    block.span.start,
                    block.span.start + fragment.open_len,
                    Some(run.inline_id.clone()),
                    0,
                    "nearest-visible",
                ));
                context.syntax_spans.push(WasmSyntaxSpan::new(
                    position_index,
                    block.span.start + fragment.close_start,
                    block.span.end,
                    Some(run.inline_id.clone()),
                    run.rendered_text_utf16[1],
                    "nearest-visible",
                ));
            } else {
                context.add_run(
                    block.span.start,
                    block.span.end,
                    block.fallback.text.clone(),
                    "isolated-placeholder",
                    None,
                );
            }
        }
        _ => {
            if block.children.is_empty() && !block.fallback.text.is_empty() {
                context.add_run(
                    block.span.start,
                    block.span.end,
                    block.fallback.text.clone(),
                    "text",
                    None,
                );
            } else {
                collect_children(source, &mut context, &block.children, "text");
            }
        }
    }

    let wasm_block = WasmBlock {
        anchor_slug: block.attrs.anchor_slug.clone(),
        block_id: block.id.clone(),
        block_index,
        element,
        kind,
        measurement: WasmBlockMeasurement {
            basis: block.measurement.basis.clone(),
            confidence: confidence_label(block.measurement.confidence),
            estimated_height: block.measurement.estimated_height,
        },
        source_span_byte: [block.span.start, block.span.end],
        source_span_utf16: [
            position_index.byte_to_utf16(block.span.start),
            position_index.byte_to_utf16(block.span.end),
        ],
        syntax_spans: context.syntax_spans,
        text: block.fallback.text.clone(),
    };

    (wasm_block, context.runs)
}

fn collect_children(
    source: &str,
    context: &mut RunContext<'_>,
    children: &[ProjectedNode],
    semantic: &'static str,
) {
    let mut index = 0;
    while index < children.len() {
        if let Some(consumed) = collect_safe_html_triplet(source, context, &children[index..]) {
            index += consumed;
            continue;
        }

        collect_inline(source, context, &children[index], semantic);
        index += 1;
    }
}

fn collect_safe_html_triplet(
    source: &str,
    context: &mut RunContext<'_>,
    children: &[ProjectedNode],
) -> Option<usize> {
    let [open, text, close, ..] = children else {
        return None;
    };
    if open.kind != NodeKind::Html || text.kind != NodeKind::Text || close.kind != NodeKind::Html {
        return None;
    }

    let tag = safe_open_html_tag(&open.fallback.copy_text)?;
    if !is_matching_close_tag(&close.fallback.copy_text, &tag) {
        return None;
    }

    let rendered_html = source
        .get(open.span.start..close.span.end)
        .unwrap_or("")
        .to_string();
    let run = context.add_run(
        text.span.start,
        text.span.end,
        text.fallback.text.clone(),
        "html-fragment",
        Some(rendered_html),
    );
    context.syntax_spans.push(WasmSyntaxSpan::new(
        context.position_index,
        open.span.start,
        open.span.end,
        Some(run.inline_id.clone()),
        0,
        "nearest-visible",
    ));
    context.syntax_spans.push(WasmSyntaxSpan::new(
        context.position_index,
        close.span.start,
        close.span.end,
        Some(run.inline_id.clone()),
        run.rendered_text_utf16[1],
        "nearest-visible",
    ));
    Some(3)
}

fn collect_inline(
    source: &str,
    context: &mut RunContext<'_>,
    node: &ProjectedNode,
    semantic: &'static str,
) {
    match node.kind {
        NodeKind::Text => {
            context.add_run(
                node.span.start,
                node.span.end,
                node.fallback.text.clone(),
                semantic,
                None,
            );
        }
        NodeKind::Strong => {
            collect_children(source, context, &node.children, "strong");
            add_outer_syntax_spans(context, node, "nearest-visible");
        }
        NodeKind::Emphasis | NodeKind::Delete => {
            collect_children(source, context, &node.children, semantic);
            add_outer_syntax_spans(context, node, "nearest-visible");
        }
        NodeKind::Link => {
            let previous_href = context.link_href.take();
            let previous_title = context.link_title.take();
            context.link_href = node.attrs.url.clone();
            context.link_title = node.attrs.title.clone();
            collect_children(source, context, &node.children, "link-label");
            add_outer_syntax_spans(context, node, "nearest-visible");
            context.link_href = previous_href;
            context.link_title = previous_title;
        }
        NodeKind::InlineCode => collect_delimited_inline(source, context, node, "inline-code"),
        NodeKind::InlineMath => collect_delimited_inline(source, context, node, "math-source"),
        NodeKind::Html => {
            let raw = node.fallback.copy_text.as_str();
            if let Some(fragment) = safe_inline_html(raw) {
                let run = context.add_run(
                    node.span.start + fragment.open_len,
                    node.span.start + fragment.close_start,
                    fragment.text.to_string(),
                    "html-fragment",
                    Some(raw.to_string()),
                );
                context.syntax_spans.push(WasmSyntaxSpan::new(
                    context.position_index,
                    node.span.start,
                    node.span.start + fragment.open_len,
                    Some(run.inline_id.clone()),
                    0,
                    "nearest-visible",
                ));
                context.syntax_spans.push(WasmSyntaxSpan::new(
                    context.position_index,
                    node.span.start + fragment.close_start,
                    node.span.end,
                    Some(run.inline_id.clone()),
                    run.rendered_text_utf16[1],
                    "nearest-visible",
                ));
            } else {
                context.add_run(
                    node.span.start,
                    node.span.end,
                    node.fallback.text.clone(),
                    "isolated-placeholder",
                    None,
                );
            }
        }
        NodeKind::Break => {
            context.add_run(
                node.span.start,
                node.span.end,
                "\n".to_string(),
                "text",
                None,
            );
        }
        NodeKind::Image => {
            context.add_run(
                node.span.start,
                node.span.end,
                node.attrs.alt.clone().unwrap_or_default(),
                "text",
                None,
            );
        }
        _ => collect_children(source, context, &node.children, semantic),
    }
}

fn collect_delimited_inline(
    source: &str,
    context: &mut RunContext<'_>,
    node: &ProjectedNode,
    semantic: &'static str,
) {
    let source_slice = source.get(node.span.start..node.span.end).unwrap_or("");
    let [start, end] = inner_delimited_span(source_slice)
        .map(|[start, end]| [node.span.start + start, node.span.start + end])
        .unwrap_or([node.span.start, node.span.end]);
    let run = context.add_run(start, end, node.fallback.text.clone(), semantic, None);
    context.syntax_spans.push(WasmSyntaxSpan::new(
        context.position_index,
        node.span.start,
        start,
        Some(run.inline_id.clone()),
        0,
        "nearest-visible",
    ));
    context.syntax_spans.push(WasmSyntaxSpan::new(
        context.position_index,
        end,
        node.span.end,
        Some(run.inline_id.clone()),
        run.rendered_text_utf16[1],
        "nearest-visible",
    ));
}

fn collect_code_block(source: &str, context: &mut RunContext<'_>, node: &ProjectedNode) {
    let raw = source.get(node.span.start..node.span.end).unwrap_or("");
    let content_start = raw.find('\n').map(|index| index + 1).unwrap_or(raw.len());
    let close_start = raw
        .rfind('\n')
        .filter(|index| {
            *index >= content_start && raw[*index + 1..].trim_start().starts_with("```")
        })
        .unwrap_or(raw.len());
    let content_end = if raw.as_bytes().get(close_start.wrapping_sub(1)) == Some(&b'\n') {
        close_start - 1
    } else {
        close_start
    };
    let run = context.add_run(
        node.span.start + content_start,
        node.span.start + content_end,
        node.fallback.text.clone(),
        "code-block",
        None,
    );
    context.syntax_spans.push(WasmSyntaxSpan::new(
        context.position_index,
        node.span.start,
        node.span.start + content_start,
        Some(run.inline_id.clone()),
        0,
        "block-boundary",
    ));
    if close_start < raw.len() {
        context.syntax_spans.push(WasmSyntaxSpan::new(
            context.position_index,
            node.span.start + close_start,
            node.span.end,
            Some(run.inline_id.clone()),
            run.rendered_text_utf16[1],
            "block-boundary",
        ));
    }
}

fn add_outer_syntax_spans(
    context: &mut RunContext<'_>,
    node: &ProjectedNode,
    fallback: &'static str,
) {
    let Some(first) = context.runs.iter().find(|run| {
        run.source_span_byte[0] >= node.span.start && run.source_span_byte[1] <= node.span.end
    }) else {
        return;
    };
    let Some(last) = context.runs.iter().rev().find(|run| {
        run.source_span_byte[0] >= node.span.start && run.source_span_byte[1] <= node.span.end
    }) else {
        return;
    };

    context.syntax_spans.push(WasmSyntaxSpan::new(
        context.position_index,
        node.span.start,
        first.source_span_byte[0],
        Some(first.inline_id.clone()),
        0,
        fallback,
    ));
    context.syntax_spans.push(WasmSyntaxSpan::new(
        context.position_index,
        last.source_span_byte[1],
        node.span.end,
        Some(last.inline_id.clone()),
        last.rendered_text_utf16[1],
        fallback,
    ));
}

fn inner_delimited_span(raw: &str) -> Option<[usize; 2]> {
    let first = raw.chars().next()?;
    let last = raw.rfind(first)?;
    let open = raw.find(first)? + first.len_utf8();
    if last < open {
        return None;
    }
    Some([open, last])
}

fn block_kind(block: &ProjectedNode) -> &'static str {
    match block.kind {
        NodeKind::Heading => "heading",
        NodeKind::List => "list",
        NodeKind::CodeBlock => "code",
        NodeKind::Html | NodeKind::Mdx => "isolated",
        NodeKind::MathBlock => "math",
        NodeKind::Table => "table",
        _ => "paragraph",
    }
}

fn block_element(block: &ProjectedNode) -> &'static str {
    match block.kind {
        NodeKind::Heading => match block.attrs.depth.unwrap_or(1) {
            1 => "h1",
            _ => "h2",
        },
        NodeKind::Paragraph | NodeKind::TableCell => "p",
        NodeKind::List => "ul",
        NodeKind::CodeBlock => "pre",
        _ => "div",
    }
}

fn confidence_label(confidence: MeasurementConfidence) -> &'static str {
    match confidence {
        MeasurementConfidence::High => "high",
        MeasurementConfidence::Medium => "medium",
        MeasurementConfidence::Low => "low",
    }
}

struct PositionIndex {
    byte_to_utf16: Vec<usize>,
    byte_len: usize,
    utf16_len: usize,
}

impl PositionIndex {
    fn new(source: &str) -> Self {
        let byte_len = source.len();
        let mut byte_to_utf16 = vec![0; byte_len + 1];
        let mut utf16 = 0;

        for (byte, character) in source.char_indices() {
            let next_byte = byte + character.len_utf8();
            for item in byte_to_utf16.iter_mut().take(next_byte + 1).skip(byte) {
                *item = utf16;
            }
            utf16 += character.len_utf16();
            byte_to_utf16[next_byte] = utf16;
        }

        Self {
            byte_to_utf16,
            byte_len,
            utf16_len: source.encode_utf16().count(),
        }
    }

    fn byte_to_utf16(&self, byte: usize) -> usize {
        self.byte_to_utf16
            .get(byte.min(self.byte_len))
            .copied()
            .unwrap_or(self.utf16_len)
    }
}

struct RunContext<'a> {
    block_id: String,
    inline_index: usize,
    item_index: Option<usize>,
    link_href: Option<String>,
    link_title: Option<String>,
    position_index: &'a PositionIndex,
    rendered_cursor: usize,
    runs: Vec<WasmRun>,
    syntax_spans: Vec<WasmSyntaxSpan>,
}

impl RunContext<'_> {
    fn add_run(
        &mut self,
        source_start: usize,
        source_end: usize,
        rendered_text: String,
        semantic: &'static str,
        rendered_html: Option<String>,
    ) -> WasmRun {
        let inline_id = format!("{}:inline:{}", self.block_id, self.inline_index);
        self.inline_index += 1;
        let rendered_start = self.rendered_cursor;
        self.rendered_cursor += rendered_text.encode_utf16().count();
        let run = WasmRun {
            block_id: self.block_id.clone(),
            inline_id,
            item_index: self.item_index,
            link_href: self.link_href.clone(),
            link_title: self.link_title.clone(),
            rendered_html,
            rendered_text,
            rendered_text_utf16: [rendered_start, self.rendered_cursor],
            semantic,
            source_span_byte: [source_start, source_end],
            source_span_utf16: [
                self.position_index.byte_to_utf16(source_start),
                self.position_index.byte_to_utf16(source_end),
            ],
        };
        self.runs.push(run.clone());
        run
    }
}

#[derive(Clone)]
struct WasmRun {
    block_id: String,
    inline_id: String,
    item_index: Option<usize>,
    link_href: Option<String>,
    link_title: Option<String>,
    rendered_html: Option<String>,
    rendered_text: String,
    rendered_text_utf16: [usize; 2],
    semantic: &'static str,
    source_span_byte: [usize; 2],
    source_span_utf16: [usize; 2],
}

impl WasmRun {
    fn push_json(&self, output: &mut String) {
        output.push('{');
        push_json_key_string(output, "blockId", &self.block_id);
        output.push(',');
        push_json_key_string(output, "inlineId", &self.inline_id);
        output.push(',');
        output.push_str("\"listItemIndex\":");
        push_json_option_usize(output, self.item_index);
        output.push(',');
        if let Some(href) = &self.link_href {
            push_json_key_string(output, "href", href);
            output.push(',');
        }
        if let Some(title) = &self.link_title {
            push_json_key_string(output, "title", title);
            output.push(',');
        }
        if let Some(html) = &self.rendered_html {
            push_json_key_string(output, "renderedHtml", html);
            output.push(',');
        }
        push_json_key_string(output, "renderedText", &self.rendered_text);
        output.push(',');
        push_json_key_span(output, "renderedTextUtf16", self.rendered_text_utf16);
        output.push(',');
        push_json_key_string(output, "semantic", self.semantic);
        output.push(',');
        push_json_key_span(output, "sourceSpanByte", self.source_span_byte);
        output.push(',');
        push_json_key_span(output, "sourceSpanUtf16", self.source_span_utf16);
        output.push('}');
    }
}

struct WasmBlock {
    anchor_slug: Option<String>,
    block_id: String,
    block_index: usize,
    element: &'static str,
    kind: &'static str,
    measurement: WasmBlockMeasurement,
    source_span_byte: [usize; 2],
    source_span_utf16: [usize; 2],
    syntax_spans: Vec<WasmSyntaxSpan>,
    text: String,
}

struct WasmBlockMeasurement {
    basis: String,
    confidence: &'static str,
    estimated_height: usize,
}

impl WasmBlock {
    fn push_json(&self, output: &mut String) {
        output.push('{');
        push_json_key_string(output, "blockId", &self.block_id);
        output.push(',');
        if let Some(anchor_slug) = &self.anchor_slug {
            push_json_key_string(output, "anchorSlug", anchor_slug);
            output.push(',');
        }
        output.push_str("\"blockIndex\":");
        output.push_str(&self.block_index.to_string());
        output.push(',');
        push_json_key_string(output, "element", self.element);
        output.push(',');
        push_json_key_string(output, "kind", self.kind);
        output.push(',');
        output.push_str("\"measurement\":{");
        output.push_str("\"estimatedHeight\":");
        output.push_str(&self.measurement.estimated_height.to_string());
        output.push_str(",\"confidence\":");
        push_json_string(output, self.measurement.confidence);
        output.push_str(",\"basis\":");
        push_json_string(output, &self.measurement.basis);
        output.push_str("},");
        push_json_key_span(output, "sourceSpanByte", self.source_span_byte);
        output.push(',');
        push_json_key_span(output, "sourceSpanUtf16", self.source_span_utf16);
        output.push(',');
        output.push_str("\"syntaxSpans\":[");
        for (index, span) in self.syntax_spans.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            span.push_json(output);
        }
        output.push_str("],");
        push_json_key_string(output, "text", &self.text);
        output.push('}');
    }
}

struct WasmSyntaxSpan {
    fallback: &'static str,
    inline_id: Option<String>,
    rendered_text_offset: usize,
    source_span_byte: [usize; 2],
    source_span_utf16: [usize; 2],
}

impl WasmSyntaxSpan {
    fn new(
        position_index: &PositionIndex,
        source_start: usize,
        source_end: usize,
        inline_id: Option<String>,
        rendered_text_offset: usize,
        fallback: &'static str,
    ) -> Self {
        Self {
            fallback,
            inline_id,
            rendered_text_offset,
            source_span_byte: [source_start, source_end],
            source_span_utf16: [
                position_index.byte_to_utf16(source_start),
                position_index.byte_to_utf16(source_end),
            ],
        }
    }

    fn push_json(&self, output: &mut String) {
        output.push('{');
        push_json_key_string(output, "fallback", self.fallback);
        output.push(',');
        output.push_str("\"inlineId\":");
        if let Some(inline_id) = &self.inline_id {
            push_json_string(output, inline_id);
        } else {
            output.push_str("null");
        }
        output.push(',');
        output.push_str("\"renderedTextOffset\":");
        output.push_str(&self.rendered_text_offset.to_string());
        output.push(',');
        push_json_key_span(output, "sourceSpanByte", self.source_span_byte);
        output.push(',');
        push_json_key_span(output, "sourceSpanUtf16", self.source_span_utf16);
        output.push('}');
    }
}

struct SafeInlineHtml<'a> {
    open_len: usize,
    close_start: usize,
    text: &'a str,
}

fn safe_inline_html(raw: &str) -> Option<SafeInlineHtml<'_>> {
    let open_end = raw.find('>')? + 1;
    let close_start = raw.rfind("</")?;
    let close_end = raw.rfind('>')? + 1;
    if close_start < open_end || close_end != raw.len() {
        return None;
    }

    let tag = raw[1..open_end - 1]
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let close_tag = raw[close_start + 2..close_end - 1].trim();
    if !tag.eq_ignore_ascii_case(close_tag) || !is_safe_inline_tag(tag) {
        return None;
    }

    let attributes = raw[1 + tag.len()..open_end - 1].trim();
    if !safe_inline_attributes(attributes) {
        return None;
    }

    Some(SafeInlineHtml {
        open_len: open_end,
        close_start,
        text: &raw[open_end..close_start],
    })
}

fn safe_open_html_tag(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if !raw.starts_with('<') || raw.starts_with("</") || !raw.ends_with('>') {
        return None;
    }

    let inner = raw[1..raw.len() - 1].trim();
    if inner.is_empty() || inner.ends_with('/') {
        return None;
    }

    let tag = inner
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    if tag.is_empty() || !is_safe_inline_tag(tag) {
        return None;
    }

    let attributes = inner[tag.len()..].trim();
    if !safe_inline_attributes(attributes) {
        return None;
    }

    Some(tag.to_ascii_lowercase())
}

fn is_matching_close_tag(raw: &str, tag: &str) -> bool {
    let raw = raw.trim();
    raw.len() == tag.len() + 3
        && raw.starts_with("</")
        && raw.ends_with('>')
        && raw[2..raw.len() - 1].trim().eq_ignore_ascii_case(tag)
}

fn is_safe_inline_tag(tag: &str) -> bool {
    matches!(
        tag.to_ascii_lowercase().as_str(),
        "b" | "em" | "i" | "kbd" | "mark" | "s" | "small" | "span" | "strong" | "sub" | "sup" | "u"
    )
}

fn safe_inline_attributes(attributes: &str) -> bool {
    if attributes.is_empty() {
        return true;
    }

    attributes.split_whitespace().all(|attribute| {
        let Some((name, value)) = attribute.split_once('=') else {
            return false;
        };
        let allowed_name = name == "class" || name == "title" || name.starts_with("data-");
        allowed_name
            && value.starts_with('"')
            && value.ends_with('"')
            && !value.contains('<')
            && !value.contains('>')
    })
}

fn push_json_key_string(output: &mut String, key: &str, value: &str) {
    push_json_string(output, key);
    output.push(':');
    push_json_string(output, value);
}

fn push_json_key_span(output: &mut String, key: &str, span: [usize; 2]) {
    push_json_string(output, key);
    output.push_str(":[");
    output.push_str(&span[0].to_string());
    output.push(',');
    output.push_str(&span[1].to_string());
    output.push(']');
}

fn push_json_option_usize(output: &mut String, value: Option<usize>) {
    if let Some(value) = value {
        output.push_str(&value.to_string());
    } else {
        output.push_str("null");
    }
}

fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            character if character.is_control() => {
                output.push_str("\\u");
                output.push_str(&format!("{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_markdown_rs_output_for_wasm() {
        let json = project_to_json("# Café 🚀 &copy;\n\n<i>wow</i>");

        assert!(json.contains("\"engine\":\"rust-wasm\""));
        assert!(json.contains("\"measurement\":{\"estimatedHeight\":"));
        assert!(json.contains("Café 🚀 ©"));
        assert!(json.contains("\"semantic\":\"html-fragment\""));
        assert!(json.contains("\"renderedHtml\":\"<i>wow</i>\""));
    }

    #[test]
    fn projects_open_fence_as_code_block() {
        let json = project_to_json("```ts\nconst plan = wasm.project(source);");

        assert!(json.contains("\"kind\":\"code\""));
        assert!(json.contains("\"semantic\":\"code-block\""));
        assert!(json.contains("wasm.project"));
    }

    #[test]
    fn isolates_active_html() {
        let json = project_to_json("<iframe src=\"https://example.com\"></iframe>");

        assert!(json.contains("\"kind\":\"isolated\""));
        assert!(json.contains("\"semantic\":\"isolated-placeholder\""));
    }
}
