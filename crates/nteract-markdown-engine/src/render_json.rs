use crate::{
    MarkdownAnchor, MarkdownPlan, MeasurementConfidence, NodeKind, PlanMode, ProjectedNode,
    TableAlign,
};

pub fn error_to_json(message: &str, engine_label: &str) -> String {
    let mut output = String::from("{\"version\":1,\"engine\":");
    push_json_string(&mut output, engine_label);
    output.push_str(",\"error\":");
    push_json_string(&mut output, message);
    output.push_str(",\"measurement\":{\"estimatedHeight\":0,\"confidence\":\"low\",\"width\":0},\"blocks\":[],\"runs\":[],\"byteLength\":0,\"utf16Length\":0}");
    output
}

pub fn render_plan_json(plan: &MarkdownPlan, source: &str, engine_label: &str) -> String {
    let position_index = PositionIndex::new(source);
    let mut output_blocks = Vec::new();
    let mut output_runs = Vec::new();

    for (block_index, block) in plan.blocks.iter().enumerate() {
        let (wasm_block, mut runs) = collect_block(source, &position_index, block_index, block);
        output_blocks.push(wasm_block);
        output_runs.append(&mut runs);
    }

    let output_anchors = plan
        .anchors
        .iter()
        .map(|anchor| JsonAnchor::new(&position_index, anchor))
        .collect::<Vec<_>>();

    let mut output = String::new();
    output.push_str("{\"version\":");
    output.push_str(&plan.version.to_string());
    // mode is mdx-only: a plain markdown plan omits the key so its JSON prefix
    // stays byte-identical to the version-1 schema. The mdx branch never fires
    // from wasm today (no islands FFI flag); it exists for when this serializer
    // is shared with the compiler.
    if plan.mode == PlanMode::Mdx {
        output.push_str(",\"mode\":");
        push_json_string(&mut output, plan_mode_label(plan.mode));
    }
    output.push_str(",\"engine\":");
    push_json_string(&mut output, engine_label);
    output.push_str(",\"byteLength\":");
    output.push_str(&position_index.byte_len.to_string());
    output.push_str(",\"utf16Length\":");
    output.push_str(&position_index.utf16_len.to_string());
    output.push_str(",\"measurement\":{");
    output.push_str("\"estimatedHeight\":");
    output.push_str(&plan.measurement.estimated_height.to_string());
    output.push_str(",\"confidence\":");
    push_json_string(&mut output, confidence_label(plan.measurement.confidence));
    output.push_str(",\"width\":");
    output.push_str(&plan.measurement.width.to_string());
    output.push('}');
    output.push_str(",\"anchors\":[");
    for (index, anchor) in output_anchors.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        anchor.push_json(&mut output);
    }
    output.push(']');
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

fn plan_mode_label(mode: PlanMode) -> &'static str {
    match mode {
        PlanMode::Markdown => "markdown",
        PlanMode::Mdx => "mdx",
    }
}

fn collect_block(
    source: &str,
    position_index: &PositionIndex,
    block_index: usize,
    block: &ProjectedNode,
) -> (JsonBlock, Vec<JsonRun>) {
    let mut context = RunContext {
        block_id: block.id.clone(),
        inline_index: 0,
        item_checked: None,
        item_depth: None,
        item_index: None,
        item_ordered: None,
        item_path: Vec::new(),
        image_alt: None,
        image_src: None,
        image_title: None,
        link_href: None,
        link_title: None,
        position_index,
        rendered_cursor: 0,
        runs: Vec::new(),
        syntax_spans: Vec::new(),
        table_cell_align: None,
        table_cell_header: None,
        table_cell_index: None,
        table_row_index: None,
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
        NodeKind::List => collect_list(source, &mut context, block, 0),
        NodeKind::Table => collect_table(source, &mut context, block),
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
                context.syntax_spans.push(JsonSyntaxSpan::new(
                    position_index,
                    block.span.start,
                    block.span.start + fragment.open_len,
                    Some(run.inline_id.clone()),
                    0,
                    "nearest-visible",
                ));
                context.syntax_spans.push(JsonSyntaxSpan::new(
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

    let wasm_block = JsonBlock {
        anchor_slug: block.attrs.anchor_slug.clone(),
        block_id: block.id.clone(),
        block_index,
        code_lang: block.attrs.lang.clone(),
        code_meta: block.attrs.meta.clone(),
        element,
        kind,
        ordered: block.attrs.ordered,
        measurement: JsonBlockMeasurement {
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

fn collect_table(source: &str, context: &mut RunContext<'_>, block: &ProjectedNode) {
    for (row_index, row) in block.children.iter().enumerate() {
        if row.kind != NodeKind::TableRow {
            continue;
        }

        for (cell_index, cell) in row.children.iter().enumerate() {
            if cell.kind != NodeKind::TableCell {
                continue;
            }

            context.table_row_index = Some(row_index);
            context.table_cell_index = Some(cell_index);
            context.table_cell_header = Some(row_index == 0);
            context.table_cell_align = block
                .attrs
                .align
                .get(cell_index)
                .copied()
                .map(table_align_label);
            collect_children(source, context, &cell.children, "table-cell");
        }
    }

    context.table_row_index = None;
    context.table_cell_index = None;
    context.table_cell_header = None;
    context.table_cell_align = None;
}

fn collect_list(source: &str, context: &mut RunContext<'_>, list: &ProjectedNode, depth: usize) {
    for (item_index, item) in list.children.iter().enumerate() {
        if item.kind != NodeKind::ListItem {
            collect_inline(source, context, item, "list-item");
            continue;
        }

        let previous_checked = context.item_checked;
        let previous_depth = context.item_depth;
        let previous_index = context.item_index;
        let previous_ordered = context.item_ordered;
        let previous_path_len = context.item_path.len();
        let before = context.runs.len();

        context.item_checked = item.attrs.checked;
        context.item_depth = Some(depth);
        context.item_index = Some(item_index);
        context.item_ordered = list.attrs.ordered;
        context.item_path.push(item_index);
        collect_children(source, context, &item.children, "list-item");

        if let Some(first_run) = context.runs.get(before) {
            context.syntax_spans.push(JsonSyntaxSpan::new(
                context.position_index,
                item.span.start,
                first_run.source_span_byte[0],
                Some(first_run.inline_id.clone()),
                0,
                "block-boundary",
            ));
        }

        context.item_path.truncate(previous_path_len);
        context.item_checked = previous_checked;
        context.item_depth = previous_depth;
        context.item_index = previous_index;
        context.item_ordered = previous_ordered;
    }
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
    context.syntax_spans.push(JsonSyntaxSpan::new(
        context.position_index,
        open.span.start,
        open.span.end,
        Some(run.inline_id.clone()),
        0,
        "nearest-visible",
    ));
    context.syntax_spans.push(JsonSyntaxSpan::new(
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
        NodeKind::Emphasis => {
            collect_children(source, context, &node.children, "emphasis");
            add_outer_syntax_spans(context, node, "nearest-visible");
        }
        NodeKind::Delete => {
            collect_children(source, context, &node.children, "delete");
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
                context.syntax_spans.push(JsonSyntaxSpan::new(
                    context.position_index,
                    node.span.start,
                    node.span.start + fragment.open_len,
                    Some(run.inline_id.clone()),
                    0,
                    "nearest-visible",
                ));
                context.syntax_spans.push(JsonSyntaxSpan::new(
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
            let previous_src = context.image_src.take();
            let previous_alt = context.image_alt.take();
            let previous_title = context.image_title.take();
            context.image_src = node.attrs.url.clone();
            context.image_alt = node.attrs.alt.clone();
            context.image_title = node.attrs.title.clone();
            let run = context.add_run(
                node.span.start,
                node.span.end,
                node.attrs.alt.clone().unwrap_or_default(),
                "image",
                None,
            );
            context.syntax_spans.push(JsonSyntaxSpan::new(
                context.position_index,
                node.span.start,
                node.span.end,
                Some(run.inline_id.clone()),
                run.rendered_text_utf16[1],
                "nearest-visible",
            ));
            context.image_src = previous_src;
            context.image_alt = previous_alt;
            context.image_title = previous_title;
        }
        NodeKind::List => collect_list(source, context, node, context.item_path.len()),
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
    context.syntax_spans.push(JsonSyntaxSpan::new(
        context.position_index,
        node.span.start,
        start,
        Some(run.inline_id.clone()),
        0,
        "nearest-visible",
    ));
    context.syntax_spans.push(JsonSyntaxSpan::new(
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
    let content_start = raw.find('\n').map(|index| index + 1).unwrap_or(0);
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
    context.syntax_spans.push(JsonSyntaxSpan::new(
        context.position_index,
        node.span.start,
        node.span.start + content_start,
        Some(run.inline_id.clone()),
        0,
        "block-boundary",
    ));
    if close_start < raw.len() {
        context.syntax_spans.push(JsonSyntaxSpan::new(
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

    context.syntax_spans.push(JsonSyntaxSpan::new(
        context.position_index,
        node.span.start,
        first.source_span_byte[0],
        Some(first.inline_id.clone()),
        0,
        fallback,
    ));
    context.syntax_spans.push(JsonSyntaxSpan::new(
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
    let open = raw
        .chars()
        .take_while(|character| *character == first)
        .map(char::len_utf8)
        .sum::<usize>();
    let close_len = raw
        .chars()
        .rev()
        .take_while(|character| *character == first)
        .map(char::len_utf8)
        .sum::<usize>();
    let close = raw.len().checked_sub(close_len)?;
    if close < open {
        return None;
    }
    Some([open, close])
}

fn block_kind(block: &ProjectedNode) -> &'static str {
    match block.kind {
        NodeKind::Heading => "heading",
        NodeKind::List => "list",
        NodeKind::Blockquote => "blockquote",
        NodeKind::CodeBlock => "code",
        NodeKind::Html | NodeKind::Mdx => "isolated",
        NodeKind::Island => "island",
        NodeKind::MathBlock => "math",
        NodeKind::ThematicBreak => "thematic-break",
        NodeKind::Table => "table",
        _ => "paragraph",
    }
}

fn block_element(block: &ProjectedNode) -> &'static str {
    match block.kind {
        NodeKind::Heading => match block.attrs.depth.unwrap_or(1) {
            1 => "h1",
            2 => "h2",
            3 => "h3",
            4 => "h4",
            5 => "h5",
            _ => "h6",
        },
        NodeKind::Paragraph | NodeKind::TableCell => "p",
        NodeKind::List => {
            if block.attrs.ordered == Some(true) {
                "ol"
            } else {
                "ul"
            }
        }
        NodeKind::CodeBlock => "pre",
        NodeKind::ThematicBreak => "hr",
        NodeKind::Island => "div",
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
    image_alt: Option<String>,
    image_src: Option<String>,
    image_title: Option<String>,
    inline_index: usize,
    item_checked: Option<bool>,
    item_depth: Option<usize>,
    item_index: Option<usize>,
    item_ordered: Option<bool>,
    item_path: Vec<usize>,
    link_href: Option<String>,
    link_title: Option<String>,
    position_index: &'a PositionIndex,
    rendered_cursor: usize,
    runs: Vec<JsonRun>,
    syntax_spans: Vec<JsonSyntaxSpan>,
    table_cell_align: Option<&'static str>,
    table_cell_header: Option<bool>,
    table_cell_index: Option<usize>,
    table_row_index: Option<usize>,
}

impl RunContext<'_> {
    fn add_run(
        &mut self,
        source_start: usize,
        source_end: usize,
        rendered_text: String,
        semantic: &'static str,
        rendered_html: Option<String>,
    ) -> JsonRun {
        let inline_id = format!("{}:inline:{}", self.block_id, self.inline_index);
        self.inline_index += 1;
        let rendered_start = self.rendered_cursor;
        self.rendered_cursor += rendered_text.encode_utf16().count();
        let run = JsonRun {
            block_id: self.block_id.clone(),
            image_alt: self.image_alt.clone(),
            image_src: self.image_src.clone(),
            image_title: self.image_title.clone(),
            inline_id,
            item_checked: self.item_checked,
            item_depth: self.item_depth,
            item_index: self.item_index,
            item_ordered: self.item_ordered,
            item_path: if self.item_path.is_empty() {
                None
            } else {
                Some(
                    self.item_path
                        .iter()
                        .map(usize::to_string)
                        .collect::<Vec<_>>()
                        .join("."),
                )
            },
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
            table_cell_align: self.table_cell_align,
            table_cell_header: self.table_cell_header,
            table_cell_index: self.table_cell_index,
            table_row_index: self.table_row_index,
        };
        self.runs.push(run.clone());
        run
    }
}

#[derive(Clone)]
struct JsonRun {
    block_id: String,
    image_alt: Option<String>,
    image_src: Option<String>,
    image_title: Option<String>,
    inline_id: String,
    item_checked: Option<bool>,
    item_depth: Option<usize>,
    item_index: Option<usize>,
    item_ordered: Option<bool>,
    item_path: Option<String>,
    link_href: Option<String>,
    link_title: Option<String>,
    rendered_html: Option<String>,
    rendered_text: String,
    rendered_text_utf16: [usize; 2],
    semantic: &'static str,
    source_span_byte: [usize; 2],
    source_span_utf16: [usize; 2],
    table_cell_align: Option<&'static str>,
    table_cell_header: Option<bool>,
    table_cell_index: Option<usize>,
    table_row_index: Option<usize>,
}

impl JsonRun {
    fn push_json(&self, output: &mut String) {
        output.push('{');
        push_json_key_string(output, "blockId", &self.block_id);
        output.push(',');
        if let Some(src) = &self.image_src {
            push_json_key_string(output, "imageSrc", src);
            output.push(',');
        }
        if let Some(alt) = &self.image_alt {
            push_json_key_string(output, "imageAlt", alt);
            output.push(',');
        }
        if let Some(title) = &self.image_title {
            push_json_key_string(output, "imageTitle", title);
            output.push(',');
        }
        push_json_key_string(output, "inlineId", &self.inline_id);
        output.push(',');
        output.push_str("\"listItemIndex\":");
        push_json_option_usize(output, self.item_index);
        output.push(',');
        if let Some(depth) = self.item_depth {
            output.push_str("\"listItemDepth\":");
            output.push_str(&depth.to_string());
            output.push(',');
        }
        if let Some(ordered) = self.item_ordered {
            output.push_str("\"listItemOrdered\":");
            output.push_str(if ordered { "true" } else { "false" });
            output.push(',');
        }
        if let Some(path) = &self.item_path {
            push_json_key_string(output, "listItemPath", path);
            output.push(',');
        }
        if let Some(href) = &self.link_href {
            push_json_key_string(output, "href", href);
            output.push(',');
        }
        if let Some(title) = &self.link_title {
            push_json_key_string(output, "title", title);
            output.push(',');
        }
        if let Some(checked) = self.item_checked {
            output.push_str("\"listItemChecked\":");
            output.push_str(if checked { "true" } else { "false" });
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
        if let Some(row_index) = self.table_row_index {
            output.push(',');
            output.push_str("\"tableRowIndex\":");
            output.push_str(&row_index.to_string());
        }
        if let Some(cell_index) = self.table_cell_index {
            output.push(',');
            output.push_str("\"tableCellIndex\":");
            output.push_str(&cell_index.to_string());
        }
        if let Some(header) = self.table_cell_header {
            output.push(',');
            output.push_str("\"tableCellHeader\":");
            output.push_str(if header { "true" } else { "false" });
        }
        if let Some(align) = self.table_cell_align {
            output.push(',');
            push_json_key_string(output, "tableCellAlign", align);
        }
        output.push('}');
    }
}

fn table_align_label(align: TableAlign) -> &'static str {
    match align {
        TableAlign::None => "none",
        TableAlign::Left => "left",
        TableAlign::Right => "right",
        TableAlign::Center => "center",
    }
}

struct JsonBlock {
    anchor_slug: Option<String>,
    block_id: String,
    block_index: usize,
    code_lang: Option<String>,
    code_meta: Option<String>,
    element: &'static str,
    kind: &'static str,
    ordered: Option<bool>,
    measurement: JsonBlockMeasurement,
    source_span_byte: [usize; 2],
    source_span_utf16: [usize; 2],
    syntax_spans: Vec<JsonSyntaxSpan>,
    text: String,
}

struct JsonBlockMeasurement {
    basis: String,
    confidence: &'static str,
    estimated_height: usize,
}

struct JsonAnchor {
    anchor_id: String,
    block_id: String,
    level: u8,
    slug: String,
    source_span_byte: [usize; 2],
    source_span_utf16: [usize; 2],
    title: String,
}

impl JsonAnchor {
    fn new(position_index: &PositionIndex, anchor: &MarkdownAnchor) -> Self {
        Self {
            anchor_id: anchor.id.clone(),
            block_id: anchor.block_id.clone(),
            level: anchor.level,
            slug: anchor.slug.clone(),
            source_span_byte: [anchor.span.start, anchor.span.end],
            source_span_utf16: [
                position_index.byte_to_utf16(anchor.span.start),
                position_index.byte_to_utf16(anchor.span.end),
            ],
            title: anchor.title.clone(),
        }
    }

    fn push_json(&self, output: &mut String) {
        output.push('{');
        push_json_key_string(output, "anchorId", &self.anchor_id);
        output.push(',');
        push_json_key_string(output, "blockId", &self.block_id);
        output.push(',');
        output.push_str("\"level\":");
        output.push_str(&self.level.to_string());
        output.push(',');
        push_json_key_string(output, "slug", &self.slug);
        output.push(',');
        push_json_key_span(output, "sourceSpanByte", self.source_span_byte);
        output.push(',');
        push_json_key_span(output, "sourceSpanUtf16", self.source_span_utf16);
        output.push(',');
        push_json_key_string(output, "title", &self.title);
        output.push('}');
    }
}

impl JsonBlock {
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
        if let Some(code_lang) = &self.code_lang {
            push_json_key_string(output, "codeLanguage", code_lang);
            output.push(',');
        }
        if let Some(code_meta) = &self.code_meta {
            push_json_key_string(output, "codeMeta", code_meta);
            output.push(',');
        }
        push_json_key_string(output, "element", self.element);
        output.push(',');
        push_json_key_string(output, "kind", self.kind);
        output.push(',');
        if let Some(ordered) = self.ordered {
            output.push_str("\"ordered\":");
            output.push_str(if ordered { "true" } else { "false" });
            output.push(',');
        }
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

struct JsonSyntaxSpan {
    fallback: &'static str,
    inline_id: Option<String>,
    rendered_text_offset: usize,
    source_span_byte: [usize; 2],
    source_span_utf16: [usize; 2],
}

impl JsonSyntaxSpan {
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

    fn project_to_json(source: &str) -> String {
        match crate::project_markdown(source) {
            Ok(plan) => render_plan_json(&plan, source, "rust-wasm"),
            Err(error) => error_to_json(&error.to_string(), "rust-wasm"),
        }
    }

    #[test]
    fn emits_constant_schema_version_without_markdown_mode() {
        let json = project_to_json("# hi");

        assert!(json.starts_with("{\"version\":1,\"engine\":\"rust-wasm\""));
        assert!(json.contains("\"version\":1"));
        assert!(!json.contains("\"mode\""));
    }

    #[test]
    fn projects_markdown_rs_output_for_wasm() {
        let json = project_to_json("# Café 🚀 &copy;\n\n<i>wow</i>");

        assert!(json.starts_with("{\"version\":1,\"engine\":\"rust-wasm\""));
        assert!(json.contains("\"engine\":\"rust-wasm\""));
        assert!(json.contains("\"measurement\":{\"estimatedHeight\":"));
        assert!(json.contains("Café 🚀 ©"));
        assert!(json.contains("\"semantic\":\"html-fragment\""));
        assert!(json.contains("\"renderedHtml\":\"<i>wow</i>\""));
    }

    #[test]
    fn projects_open_fence_as_code_block() {
        let json = project_to_json("```ts live\nconst plan = wasm.project(source);");

        assert!(json.contains("\"kind\":\"code\""));
        assert!(json.contains("\"codeLanguage\":\"ts\""));
        assert!(json.contains("\"codeMeta\":\"live\""));
        assert!(json.contains("\"semantic\":\"code-block\""));
        assert!(json.contains("wasm.project"));
    }

    #[test]
    fn isolates_active_html() {
        let json = project_to_json("<iframe src=\"https://example.com\"></iframe>");

        assert!(json.contains("\"kind\":\"isolated\""));
        assert!(json.contains("\"semantic\":\"isolated-placeholder\""));
    }

    #[test]
    fn projects_host_renderable_block_semantics() {
        let json = project_to_json(
            "### Third\n\n1. ordered\n2. list\n\n- [x] done\n- [ ] todo\n\n> quote\n\n*em* ~~gone~~ $x^2$\n\n$$\n\\int_0^1 x dx\n$$\n\n---",
        );

        assert!(json.contains("\"element\":\"h3\""));
        assert!(json.contains("\"element\":\"ol\""));
        assert!(json.contains("\"ordered\":true"));
        assert!(json.contains("\"listItemChecked\":true"));
        assert!(json.contains("\"listItemChecked\":false"));
        assert!(json.contains("\"kind\":\"blockquote\""));
        assert!(json.contains("\"semantic\":\"emphasis\""));
        assert!(json.contains("\"semantic\":\"delete\""));
        assert!(json.contains("\"semantic\":\"math-source\""));
        assert!(json.contains("\"renderedText\":\"x^2\""));
        assert!(json.contains("\"renderedText\":\"\\\\int_0^1 x dx\""));
        assert!(!json.contains("\"renderedText\":\"$x^2$\""));
        assert!(json.contains("\"kind\":\"math\""));
        assert!(json.contains("\"kind\":\"thematic-break\""));
        assert!(json.contains("\"element\":\"hr\""));
    }

    #[test]
    fn projects_bare_tex_environments_as_display_math() {
        let json = project_to_json(
            "\\begin{align}\na^2 + b^2 &= c^2 \\\\\n\\sin^2(\\theta) + \\cos^2(\\theta) &= 1\n\\end{align}\n\n\\begin{equation*}\nx = y\n\\end{equation*}",
        );

        assert_eq!(json.matches("\"kind\":\"math\"").count(), 2);
        assert!(json.contains("\"semantic\":\"math-source\""));
        assert!(json.contains("\"renderedText\":\"\\\\begin{align}"));
        assert!(json.contains("\\\\end{align}"));
        assert!(json.contains("\"renderedText\":\"\\\\begin{equation*}"));
        assert!(json.contains("\\\\end{equation*}"));
    }

    #[test]
    fn projects_display_bracket_tex_delimiters() {
        // #3834: a standalone `\[...\]` block routes to the math renderer with
        // the bracket delimiters stripped from the rendered text. Inline
        // `\(...\)` is intentionally out of scope — see issue #3834.
        let display = project_to_json("\\[\nx = y\nz = w\n\\]");
        assert_eq!(display.matches("\"kind\":\"math\"").count(), 1);
        assert!(display.contains("\"semantic\":\"math-source\""));
        // Display math text is the inner LaTeX; the newlines are JSON-escaped.
        assert!(display.contains("\"renderedText\":\"x = y\\nz = w\""));
        // The bracket delimiters are stripped from the rendered text.
        assert!(!display.contains("\\\\["));
        assert!(!display.contains("\\\\]"));
    }

    #[test]
    fn projects_table_rows_cells_and_alignment() {
        let json = project_to_json("| metric | value |\n| --- | ---: |\n| rows | 128 |\n");

        assert!(json.contains("\"kind\":\"table\""));
        assert!(json.contains("\"tableRowIndex\":0"));
        assert!(json.contains("\"tableRowIndex\":1"));
        assert!(json.contains("\"tableCellIndex\":1"));
        assert!(json.contains("\"tableCellHeader\":true"));
        assert!(json.contains("\"tableCellHeader\":false"));
        assert!(json.contains("\"tableCellAlign\":\"right\""));
        assert!(json.contains("\"renderedText\":\"128\""));
    }

    #[test]
    fn projects_task_list_state_for_host_checkboxes() {
        let json = project_to_json("- [x] done\n- [ ] waiting\n- regular\n");

        assert!(json.contains("\"kind\":\"list\""));
        assert!(json.contains("\"semantic\":\"list-item\""));
        assert!(json.contains("\"renderedText\":\"done\""));
        assert!(json.contains("\"listItemChecked\":true"));
        assert!(json.contains("\"renderedText\":\"waiting\""));
        assert!(json.contains("\"listItemChecked\":false"));
        assert!(json.contains("\"renderedText\":\"regular\""));
    }

    #[test]
    fn projects_nested_list_paths_for_host_rendering() {
        let json = project_to_json("- parent\n  - [ ] child\n    1. grandchild\n");

        assert!(json.contains("\"renderedText\":\"parent\""));
        assert!(json.contains("\"listItemPath\":\"0\""));
        assert!(json.contains("\"renderedText\":\"child\""));
        assert!(json.contains("\"listItemDepth\":1"));
        assert!(json.contains("\"listItemPath\":\"0.0\""));
        assert!(json.contains("\"listItemChecked\":false"));
        assert!(json.contains("\"renderedText\":\"grandchild\""));
        assert!(json.contains("\"listItemDepth\":2"));
        assert!(json.contains("\"listItemOrdered\":true"));
        assert!(json.contains("\"listItemPath\":\"0.0.0\""));
    }

    #[test]
    fn projects_multi_character_delimiter_source_spans() {
        let json = project_to_json("``code`` and $$x$$");

        assert!(json.contains("\"renderedText\":\"code\""));
        assert!(json.contains("\"semantic\":\"inline-code\""));
        assert!(json.contains("\"sourceSpanByte\":[2,6]"));
        assert!(json.contains("\"sourceSpanUtf16\":[2,6]"));
        assert!(json.contains("\"renderedText\":\"x\""));
        assert!(json.contains("\"semantic\":\"math-source\""));
        assert!(json.contains("\"sourceSpanByte\":[15,16]"));
        assert!(json.contains("\"sourceSpanUtf16\":[15,16]"));
    }

    #[test]
    fn projects_single_line_indented_code_block_source_span() {
        let json = project_to_json("    code");

        assert!(json.contains("\"kind\":\"code\""));
        assert!(json.contains("\"renderedText\":\"code\""));
        assert!(json.contains("\"semantic\":\"code-block\""));
        assert!(!json.contains("\"sourceSpanByte\":[8,8]"));
    }

    #[test]
    fn projects_image_metadata_for_host_renderer() {
        let json = project_to_json("![Plot alt](attachment:plot.png \"Daily plot\")\n");

        assert!(json.contains("\"semantic\":\"image\""));
        assert!(json.contains("\"imageSrc\":\"attachment:plot.png\""));
        assert!(json.contains("\"imageAlt\":\"Plot alt\""));
        assert!(json.contains("\"imageTitle\":\"Daily plot\""));
        assert!(json.contains("\"renderedText\":\"Plot alt\""));
    }
}
