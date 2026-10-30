use crate::{validate_spans, Attributes, Block, CodecError, Marks, Result, Span};

#[derive(Clone, Debug)]
enum Inline {
    Text(String, Marks),
    Embed(Block),
}

#[derive(Clone, Debug)]
struct Node {
    kind: String,
    attrs: Attributes,
    children: Vec<usize>,
    inline: Vec<Inline>,
}

impl Node {
    fn new(kind: &str, attrs: Attributes) -> Self {
        Self {
            kind: kind.into(),
            attrs,
            children: Vec::new(),
            inline: Vec::new(),
        }
    }

    fn inline_content(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "paragraph" | "heading" | "code-block" | "table-cell" | "table-header"
        )
    }
}

/// Export the rich-text span projection as canonical Markdown.
///
/// Markdown does not encode every editor state. Unsupported shapes return an
/// error rather than dropping their contents or attributes. List numbering
/// begins at one because the span contract does not carry a list start value.
/// Table rows are padded to their widest row, matching the Pages projection.
pub fn spans_to_markdown(spans: &[Span]) -> Result<String> {
    validate_spans(spans)?;
    let nodes = decode(spans)?;
    let markdown = render_children(&nodes, &nodes[0].children)?;
    // Opaque source is an intentionally uninterpreted interchange payload.
    // Its metadata stays on the native block rather than in Markdown.
    if nodes[0].children.len() == 1 && nodes[nodes[0].children[0]].kind == "pages-opaque" {
        return Ok(markdown);
    }
    // This explicit export boundary may reject native states that Markdown
    // cannot express. It never mutates the source document and is not part of
    // Wordgard's keystroke or Automerge reconciliation paths.
    let reimported = crate::markdown_to_spans(&markdown, &crate::ImportOptions::default())?;
    let imported_nodes = decode(&reimported)?;
    if semantic_node(&nodes, 0) != semantic_node(&imported_nodes, 0) {
        return Err(CodecError(
            "Markdown cannot preserve this native rich-text structure and marks".into(),
        ));
    }
    Ok(markdown)
}

// Compare actual rich semantics, not marker placement or span fragmentation.
// The only structural normalization is explicitly documented table padding.
fn semantic_node(nodes: &[Node], id: usize) -> serde_json::Value {
    use serde_json::{json, Value};
    let node = &nodes[id];
    let mut attrs = node.attrs.clone();
    if matches!(node.kind.as_str(), "table-cell" | "table-header")
        && attrs.get("align") == Some(&Value::Null)
    {
        attrs.remove("align");
    }
    let mut children: Vec<Value> = node
        .children
        .iter()
        .map(|id| semantic_node(nodes, *id))
        .collect();
    if node.kind == "table" {
        let width = node
            .children
            .iter()
            .map(|id| nodes[*id].children.len())
            .max()
            .unwrap_or(0);
        let head = node.children.first().map(|id| &nodes[*id]);
        for (row_index, row) in children.iter_mut().enumerate() {
            if let Some(cells) = row.get_mut("children").and_then(Value::as_array_mut) {
                while cells.len() < width {
                    let mut cell_attrs = Attributes::new();
                    if let Some(align) = head
                        .and_then(|head| head.children.get(cells.len()))
                        .and_then(|id| nodes[*id].attrs.get("align"))
                        .filter(|v| !v.is_null())
                    {
                        cell_attrs.insert("align".into(), align.clone());
                    }
                    cells.push(json!({"kind":if row_index == 0 { "table-header" } else { "table-cell" }, "attrs":cell_attrs, "children":[], "inline":[]}));
                }
            }
        }
    }
    let mut inline = Vec::<Value>::new();
    for part in &node.inline {
        match part {
            Inline::Text(text, marks) if !text.is_empty() => {
                let mut marks = marks.clone();
                if let Some(link) = marks
                    .get("link")
                    .and_then(Value::as_str)
                    .and_then(|value| serde_json::from_str::<Value>(value).ok())
                {
                    marks.insert("link".into(), link);
                }
                let marks = json!(marks);
                if let Some(previous) = inline
                    .last_mut()
                    .filter(|previous| previous.get("marks") == Some(&marks))
                {
                    if let Some(value) = previous.get_mut("text") {
                        if let Some(previous_text) = value.as_str() {
                            *value = json!(format!("{previous_text}{text}"));
                            continue;
                        }
                    }
                }
                inline.push(json!({"text":text,"marks":marks}));
            }
            Inline::Text(_, _) => {}
            Inline::Embed(block) => {
                let mut attrs = block.attrs.clone();
                if block.kind == "image" {
                    attrs.insert(
                        "alt".into(),
                        json!(attrs.get("alt").and_then(Value::as_str).unwrap_or("")),
                    );
                    attrs.entry("title".into()).or_insert(Value::Null);
                }
                inline.push(json!({"embed":block.kind,"attrs":attrs}));
            }
        }
    }
    json!({"kind":node.kind,"attrs":attrs,"children":children,"inline":inline})
}

fn append(nodes: &mut Vec<Node>, parent: usize, node: Node) -> usize {
    let id = nodes.len();
    nodes.push(node);
    nodes[parent].children.push(id);
    id
}

fn text_target(nodes: &mut Vec<Node>, stack: &mut Vec<usize>) -> usize {
    let parent = *stack.last().unwrap_or(&0);
    if nodes[parent].inline_content() {
        parent
    } else {
        let id = append(nodes, parent, Node::new("paragraph", Attributes::new()));
        stack.push(id);
        id
    }
}

fn decode(spans: &[Span]) -> Result<Vec<Node>> {
    let mut nodes = vec![Node::new("root", Attributes::new())];
    let mut stack = Vec::<usize>::new();
    for span in spans {
        match span {
            Span::Text { value, marks } => {
                let id = text_target(&mut nodes, &mut stack);
                if let Some(Inline::Text(previous, previous_marks)) = nodes[id].inline.last_mut() {
                    if previous_marks == marks {
                        previous.push_str(value);
                        continue;
                    }
                }
                nodes[id]
                    .inline
                    .push(Inline::Text(value.clone(), marks.clone()));
            }
            Span::Block { value } if value.is_embed => {
                let id = text_target(&mut nodes, &mut stack);
                if !stack
                    .iter()
                    .map(|id| &nodes[*id].kind)
                    .eq(value.parents.iter())
                {
                    return Err(CodecError(
                        "Inline embed parents do not match the surrounding structure".into(),
                    ));
                }
                nodes[id].inline.push(Inline::Embed(value.clone()));
            }
            Span::Block { value } => {
                let common = stack
                    .iter()
                    .zip(&value.parents)
                    .take_while(|(id, kind)| nodes[**id].kind == **kind)
                    .count();
                stack.truncate(common);
                for kind in &value.parents[common..] {
                    let parent = *stack.last().unwrap_or(&0);
                    if nodes[parent].inline_content() {
                        return Err(CodecError(
                            "A rich-text block cannot be nested inside inline content".into(),
                        ));
                    }
                    let id = append(&mut nodes, parent, Node::new(kind, Attributes::new()));
                    stack.push(id);
                }
                let parent = *stack.last().unwrap_or(&0);
                if nodes[parent].inline_content() {
                    return Err(CodecError(
                        "A rich-text block cannot be nested inside inline content".into(),
                    ));
                }
                let id = append(
                    &mut nodes,
                    parent,
                    Node::new(&value.kind, value.attrs.clone()),
                );
                if value.kind != "pages-opaque" {
                    stack.push(id);
                }
            }
        }
    }
    Ok(nodes)
}

fn render_children(nodes: &[Node], children: &[usize]) -> Result<String> {
    let mut parts = Vec::new();
    let mut ordered_index = 0;
    let mut previous_kind = "";
    for id in children {
        let node = &nodes[*id];
        if node.kind == "ordered-list-item" {
            ordered_index = if previous_kind == "ordered-list-item" {
                ordered_index + 1
            } else {
                1
            };
        }
        parts.push(render_node(nodes, *id, ordered_index)?);
        previous_kind = &node.kind;
    }
    Ok(parts.join("\n\n"))
}

fn string_attr<'a>(node: &'a Node, key: &str) -> &'a str {
    node.attrs
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
}

fn render_node(nodes: &[Node], id: usize, ordered_index: usize) -> Result<String> {
    let node = &nodes[id];
    match node.kind.as_str() {
        "paragraph" => render_inline(&node.inline, false),
        "heading" => {
            let level = node
                .attrs
                .get("level")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(1);
            Ok(format!(
                "{} {}",
                "#".repeat(level as usize),
                render_inline(&node.inline, false)?
            ))
        }
        "blockquote" => {
            let content = render_children(nodes, &node.children)?;
            Ok(content
                .split('\n')
                .map(|line| {
                    if line.is_empty() {
                        ">".into()
                    } else {
                        format!("> {line}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "unordered-list-item" | "ordered-list-item" | "task-list-item" => {
            let content = render_children(nodes, &node.children)?;
            let marker = match node.kind.as_str() {
                "ordered-list-item" => format!("{ordered_index}. "),
                "task-list-item" => {
                    if node
                        .attrs
                        .get("checked")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                    {
                        "- [x] ".into()
                    } else {
                        "- [ ] ".into()
                    }
                }
                _ => "* ".into(),
            };
            // The checkbox is paragraph content; list indentation is two spaces.
            let indent = " ".repeat(if node.kind == "task-list-item" {
                2
            } else {
                marker.len()
            });
            // A structural-only item still needs its own marker line. In a
            // task item, putting the nested list beside `[ ]` would make that
            // list marker ordinary paragraph text instead of a child list.
            let structural_first = node
                .children
                .first()
                .is_some_and(|id| nodes[*id].kind != "paragraph");
            let mut lines = content.split('\n');
            let mut result = if structural_first {
                marker.trim_end().to_owned()
            } else {
                format!("{marker}{}", lines.next().unwrap_or(""))
            };
            for line in lines {
                result.push('\n');
                if !line.is_empty() {
                    result.push_str(&indent);
                    result.push_str(line);
                }
            }
            Ok(result)
        }
        "code-block" => {
            let mut content = String::new();
            for part in &node.inline {
                match part {
                    Inline::Text(value, marks) if marks.is_empty() => content.push_str(value),
                    _ => {
                        return Err(CodecError(
                            "Code blocks cannot export inline marks or embeds".into(),
                        ))
                    }
                }
            }
            let params = string_attr(node, "params");
            if params.contains(['\n', '\r']) {
                return Err(CodecError(
                    "Code block language cannot contain a newline".into(),
                ));
            }
            let delimiter = if params.contains('`') { '~' } else { '`' };
            let fence = delimiter
                .to_string()
                .repeat(max_run(&content, delimiter).saturating_add(1).max(3));
            Ok(format!("{fence}{params}\n{content}\n{fence}"))
        }
        "table" => render_table(nodes, node),
        "pages-opaque" => Ok(string_attr(node, "source").to_owned()),
        other => Err(CodecError(format!(
            "Cannot export {other} as Markdown at this position"
        ))),
    }
}

fn render_table(nodes: &[Node], table: &Node) -> Result<String> {
    if table.children.is_empty() {
        return Err(CodecError("A table needs at least one row".into()));
    }
    let width = table
        .children
        .iter()
        .map(|row| nodes[*row].children.len())
        .max()
        .unwrap_or(0);
    if width == 0 {
        return Err(CodecError("A table needs at least one cell".into()));
    }
    let mut rows = Vec::new();
    let mut alignment = Vec::new();
    for (row_index, row_id) in table.children.iter().enumerate() {
        let row = &nodes[*row_id];
        if row.kind != "table-row" {
            return Err(CodecError("A table can contain only rows".into()));
        }
        let mut cells = Vec::new();
        for cell_id in &row.children {
            let cell = &nodes[*cell_id];
            let expected = if row_index == 0 {
                "table-header"
            } else {
                "table-cell"
            };
            if cell.kind != expected {
                return Err(CodecError(
                    "Markdown tables require one header row followed by body cells".into(),
                ));
            }
            cells.push(render_inline(&cell.inline, true)?.replace('|', "\\|"));
            if row_index == 0 {
                alignment.push(match string_attr(cell, "align") {
                    "left" => ":---",
                    "center" => ":---:",
                    "right" => "---:",
                    _ => "---",
                });
            } else {
                let column = cells.len() - 1;
                let head = &nodes[nodes[table.children[0]]
                    .children
                    .get(column)
                    .copied()
                    .unwrap_or(*cell_id)];
                if string_attr(head, "align") != string_attr(cell, "align") {
                    return Err(CodecError(
                        "Markdown tables cannot encode different alignment within a column".into(),
                    ));
                }
            }
        }
        while cells.len() < width {
            cells.push(String::new());
        }
        rows.push(format!("| {} |", cells.join(" | ")));
    }
    while alignment.len() < width {
        alignment.push("---");
    }
    rows.insert(1, format!("| {} |", alignment.join(" | ")));
    Ok(rows.join("\n"))
}

fn max_run(value: &str, delimiter: char) -> usize {
    value
        .chars()
        .fold((0, 0), |(max, run), ch| {
            let run = if ch == delimiter { run + 1 } else { 0 };
            (max.max(run), run)
        })
        .0
}

fn escape_text(value: &str, table: bool) -> String {
    let mut output = String::new();
    let mut line_start = true;
    for ch in value.chars() {
        if ch == '\n' {
            output.push_str(if table { "<br>" } else { "\n" });
            line_start = true;
            continue;
        }
        if matches!(ch, ' ' | '\t') && (line_start || ch == '\t') {
            output.push_str(if ch == ' ' { "&#32;" } else { "&#9;" });
            continue;
        }
        // Dollar entities also avoid the conservative import profile's math gate.
        if ch == '$' {
            output.push_str("&#36;");
            line_start = false;
            continue;
        }
        // Protect syntax in text, including constructs recognized by GFM.
        if ch.is_ascii_punctuation() && !(table && ch == '|') {
            output.push('\\');
        }
        output.push(ch);
        line_start = false;
    }
    // Markdown trims trailing whitespace; entities retain it without changing
    // the native text or inventing a hard break.
    let trailing = output.len() - output.trim_end_matches(' ').len();
    output.truncate(output.len() - trailing);
    for _ in 0..trailing {
        output.push_str("&#32;");
    }
    output
}

fn destination(value: &str) -> String {
    format!(
        "<{}>",
        value
            .replace('\\', "\\\\")
            .replace('<', "\\<")
            .replace('>', "\\>")
    )
}

fn title_suffix(value: Option<&serde_json::Value>) -> String {
    match value.and_then(serde_json::Value::as_str) {
        Some(value) => format!(
            " \"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "&#10;")
                .replace('\r', "&#13;")
        ),
        None => String::new(),
    }
}

#[derive(PartialEq, Clone)]
struct Mark {
    open: String,
    close: String,
    /// Markdown delimiters must not open or close beside whitespace. HTML tags
    /// such as `<mark>` keep boundary whitespace as ordinary text.
    delimiter: bool,
}

impl Mark {
    fn delimiter(open: &str, close: String) -> Self {
        Self {
            open: open.into(),
            close,
            delimiter: true,
        }
    }
}

/// Markdown projections for a text run's marks, outermost first. Registry
/// order is the nesting order; inline code is written innermost by
/// `render_inline` because a code span cannot contain other syntax.
fn marks_for(marks: &Marks) -> Result<Vec<Mark>> {
    let mut result = Vec::new();
    for spec in crate::marks::mark_specs()? {
        let Some(value) = marks.get(&spec.name) else {
            continue;
        };
        match spec.name.as_str() {
            "link" => {
                let link: serde_json::Value =
                    serde_json::from_str(value.as_str().unwrap_or_default())
                        .map_err(|error| CodecError(error.to_string()))?;
                let href = link
                    .get("href")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| CodecError("A link needs href".into()))?;
                result.push(Mark::delimiter(
                    "[",
                    format!(
                        "]({}{})",
                        destination(href),
                        title_suffix(link.get("title"))
                    ),
                ));
            }
            "em" => result.push(Mark::delimiter("*", "*".into())),
            "strong" => result.push(Mark::delimiter("**", "**".into())),
            "highlight" => {
                let color = value
                    .as_str()
                    .ok_or_else(|| CodecError("Invalid rich highlight".into()))?;
                result.push(Mark {
                    open: format!("<mark data-color=\"{color}\">"),
                    close: "</mark>".into(),
                    delimiter: false,
                });
            }
            "code" => {}
            name => {
                return Err(CodecError(format!(
                    "No Markdown projection for mark {name}"
                )))
            }
        }
    }
    Ok(result)
}

fn ordered_marks(marks: &Marks, active: &[Mark]) -> Result<Vec<Mark>> {
    let available = marks_for(marks)?;
    // Retain a surrounding mark when a nested mark begins. A fixed global
    // order would turn `*italic **bold** italic*` into three independent em
    // runs and make its interior spaces look like invalid boundary spaces.
    let mut result: Vec<_> = active
        .iter()
        .filter(|mark| available.contains(mark))
        .cloned()
        .collect();
    for mark in available {
        if !result.contains(&mark) {
            result.push(mark);
        }
    }
    Ok(result)
}

/// The marks a transition closes, innermost first, and how many leading
/// `desired` marks stay open. HTML tags are flat tokens rather than nested
/// delimiters: a tag that ends closes in place, without closing and reopening
/// the delimiters opened inside it. Otherwise marks close in stack order.
fn changes<'a>(active: &'a [Mark], desired: &[Mark]) -> (Vec<&'a Mark>, usize) {
    let ended = |mark: &Mark| !mark.delimiter && !desired.contains(mark);
    let kept: Vec<&Mark> = active.iter().filter(|mark| !ended(mark)).collect();
    let common = kept
        .iter()
        .zip(desired)
        .take_while(|(a, b)| **a == *b)
        .count();
    let closed = active
        .iter()
        .rev()
        .filter(|mark| ended(mark) || kept[common..].iter().any(|kept| std::ptr::eq(*kept, *mark)))
        .collect();
    (closed, common)
}

fn transition(output: &mut String, active: &mut Vec<Mark>, desired: &[Mark]) {
    let (closed, common) = changes(active, desired);
    for mark in closed {
        output.push_str(&mark.close);
    }
    for mark in &desired[common..] {
        output.push_str(&mark.open);
    }
    *active = desired.to_vec();
}

fn render_inline(parts: &[Inline], table: bool) -> Result<String> {
    let mut output = String::new();
    let mut active = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        match part {
            Inline::Text(value, marks) => {
                if value.is_empty() {
                    continue;
                }
                let desired = ordered_marks(marks, &active)?;
                let (_, common_before) = changes(&active, &desired);
                let next_marks = match parts[index + 1..]
                    .iter()
                    .find(|part| !matches!(part, Inline::Text(value, _) if value.is_empty()))
                {
                    Some(Inline::Text(_, marks)) => ordered_marks(marks, &desired)?,
                    _ => Vec::new(),
                };
                let (closed_after, _) = changes(&desired, &next_marks);
                // Delimiters cannot open or close beside whitespace. HTML tags can.
                if (value.starts_with(char::is_whitespace)
                    && desired[common_before..].iter().any(|mark| mark.delimiter))
                    || (value.ends_with(char::is_whitespace)
                        && closed_after.iter().any(|mark| mark.delimiter))
                {
                    return Err(CodecError(
                        "Markdown cannot preserve marks on boundary whitespace".into(),
                    ));
                }
                transition(&mut output, &mut active, &desired);
                if marks.contains_key("code") {
                    if value.contains(['\n', '\r']) {
                        return Err(CodecError(
                            "Markdown code spans cannot preserve newlines".into(),
                        ));
                    }
                    let fence = "`".repeat(max_run(value, '`') + 1);
                    let pad = (value.starts_with(['`', ' ']) || value.ends_with(['`', ' ']))
                        && !value.chars().all(|ch| ch == ' ');
                    output.push_str(&fence);
                    if pad {
                        output.push(' ');
                    }
                    output.push_str(value);
                    if pad {
                        output.push(' ');
                    }
                    output.push_str(&fence);
                } else {
                    output.push_str(&escape_text(value, table));
                }
            }
            Inline::Embed(block) => {
                transition(&mut output, &mut active, &[]);
                match block.kind.as_str() {
                    "hard-break" => output.push_str(if table { "<br>" } else { "\\\n" }),
                    "image" => {
                        let src = block
                            .attrs
                            .get("src")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        let alt = block
                            .attrs
                            .get("alt")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        output.push_str(&format!(
                            "![{}]({}{})",
                            escape_text(alt, table),
                            destination(src),
                            title_suffix(block.attrs.get("title"))
                        ));
                    }
                    _ => return Err(CodecError("Unsupported inline embed".into())),
                }
            }
        }
    }
    transition(&mut output, &mut active, &[]);
    Ok(output)
}

// Test fixture construction and assertions should fail immediately on malformed data.
#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spans(value: serde_json::Value) -> Vec<Span> {
        serde_json::from_value(value).expect("test spans")
    }

    #[test]
    fn escapes_prose_without_interpreting_it_as_markdown() {
        let value =
            spans(json!([{ "type": "text", "value": "# literal *word* [x]", "marks": {} }]));
        assert_eq!(
            spans_to_markdown(&value).expect("export"),
            "\\# literal \\*word\\* \\[x\\]"
        );
    }

    #[test]
    fn adjacent_equal_marks_are_one_run() {
        let value = spans(json!([
            { "type": "text", "value": "a", "marks": {"strong":true} },
            { "type": "text", "value": "b", "marks": {"strong":true} }
        ]));
        assert_eq!(spans_to_markdown(&value).expect("export"), "**ab**");
    }

    #[test]
    fn opaque_source_is_unchanged() {
        let source = "<script>\n  opaque\n</script>\n";
        let value = spans(
            json!([{ "type":"block", "value": { "type":"pages-opaque", "parents":[], "attrs":{"source":source,"importId":"fixture","kind":"markdown"}, "isEmbed":false } }]),
        );
        assert_eq!(spans_to_markdown(&value).expect("export"), source);
    }

    #[test]
    fn task_indentation_uses_the_list_marker_not_checkbox_width() {
        let value = spans(json!([
            {"type":"block","value":{"type":"task-list-item","parents":[],"attrs":{"checked":true},"isEmbed":false}},
            {"type":"text","value":"done","marks":{}},
            {"type":"block","value":{"type":"paragraph","parents":["task-list-item"],"attrs":{},"isEmbed":false}},
            {"type":"text","value":"second paragraph","marks":{}}
        ]));
        assert_eq!(
            spans_to_markdown(&value).expect("export"),
            "- [x] done\n\n  second paragraph"
        );
    }
    #[test]
    fn native_roundtrip_preserves_rich_structure_and_marks() {
        for source in [
            "# Heading\n\nText **bold and *italic* tail** and `code`.",
            "**bold *and italic* bold** then *italic **and bold** italic*.",
            "> quoted\n>\n> * nested\n> * second",
            "- [x] task\n- [ ] next\n\n  continuation",
            "| A | B |\n| :--- | ---: |\n| a<br>b | `a\\|b` |",
            "![猫](https://example.org/cat.png \"title\")",
            "```mermaid\ngraph TD\n A-->B\n```",
            "a  \nb",
            "a [**bold**](https://example.org/) z",
            "Unicode 👩🏽‍💻 and é",
        ] {
            let original =
                crate::markdown_to_spans(source, &crate::ImportOptions::default()).expect("import");
            let exported = spans_to_markdown(&original).expect(source);
            let reimported = crate::markdown_to_spans(&exported, &crate::ImportOptions::default())
                .expect("reimport");
            assert_eq!(original, reimported, "{source} exported as {exported}");
        }
    }

    #[test]
    fn unsupported_native_features_fail_without_changing_spans() {
        for native in [
            json!([{ "type":"text", "value":"colored", "marks":{"color":"red"} }]),
            json!([{ "type":"block", "value":{"type":"aside","parents":[],"attrs":{},"isEmbed":false} }, {"type":"text","value":"note","marks":{}}]),
            json!([{ "type":"text", "value":" padded ", "marks":{"strong":true} }]),
            json!([{ "type":"text", "value":"a\nb", "marks":{"code":true} }]),
            json!([{ "type":"block", "value":{"type":"image","parents":["blockquote","paragraph"],"attrs":{"src":"/image.png"},"isEmbed":true} }]),
        ] {
            let value = spans(native);
            let before = value.clone();
            assert!(spans_to_markdown(&value).is_err(), "{value:?}");
            assert_eq!(value, before);
        }
    }

    #[test]
    fn highlight_exports_as_a_fixed_tag_in_registry_order() {
        for (native, markdown) in [
            (
                json!([{ "type":"text", "value":"launch date", "marks":{"strong":true,"highlight":"green"} }]),
                r#"**<mark data-color="green">launch date</mark>**"#,
            ),
            (
                json!([{ "type":"text", "value":"both", "marks":{"em":true,"strong":true,"highlight":"#00ff00","code":true} }]),
                r##"***<mark data-color="#00ff00">`both`</mark>***"##,
            ),
            (
                json!([{ "type":"text", "value":"linked", "marks":{"highlight":"pink","link":"{\"href\":\"/a\",\"title\":null}"} }]),
                r#"[<mark data-color="pink">linked</mark>](</a>)"#,
            ),
            // Boundary whitespace is ordinary text inside an HTML tag.
            (
                json!([{ "type":"text", "value":" padded ", "marks":{"highlight":"blue"} }]),
                r#"<mark data-color="blue">&#32;padded&#32;</mark>"#,
            ),
            // A tag that ends closes in place; the strong run continues.
            (
                json!([
                    { "type":"text", "value":"a ", "marks":{"highlight":"yellow"} },
                    { "type":"text", "value":"b", "marks":{"highlight":"yellow","strong":true} },
                    { "type":"text", "value":" c", "marks":{"strong":true} }
                ]),
                r#"<mark data-color="yellow">a&#32;**b</mark>&#32;c**"#,
            ),
        ] {
            let value = spans(native);
            let exported = spans_to_markdown(&value).expect("export");
            assert_eq!(exported, markdown);
            assert_eq!(
                crate::markdown_to_spans(&exported, &crate::ImportOptions::default())
                    .expect("reimport"),
                value
            );
        }
    }

    #[test]
    fn literal_highlight_tags_export_escaped() {
        let value = spans(
            json!([{ "type":"text", "value":"use <mark> tags and </MARK> too", "marks":{} }]),
        );
        let exported = spans_to_markdown(&value).expect("export");
        assert!(exported.starts_with("use \\<mark"), "{exported}");
        assert_eq!(
            crate::markdown_to_spans(&exported, &crate::ImportOptions::default())
                .expect("reimport"),
            value
        );
    }

    #[test]
    fn invalid_highlight_values_fail_export() {
        for color in [json!("red"), json!("#ABCDEF"), json!(true)] {
            let value = spans(json!([{ "type":"text", "value":"x", "marks":{"highlight":color} }]));
            assert!(spans_to_markdown(&value).is_err(), "{color}");
        }
    }

    #[test]
    fn malformed_table_structure_is_not_dropped() {
        let value = spans(json!([
            {"type":"block","value":{"type":"table","parents":[],"attrs":{},"isEmbed":false}},
            {"type":"text","value":"content outside a row","marks":{}}
        ]));
        assert!(spans_to_markdown(&value).is_err());
    }
    #[test]
    fn rejects_native_states_that_markdown_would_normalize() {
        for native in [
            json!([
                {"type":"block","value":{"type":"paragraph","parents":[],"attrs":{},"isEmbed":false}},
                {"type":"block","value":{"type":"paragraph","parents":[],"attrs":{},"isEmbed":false}},
                {"type":"text","value":"after empty paragraph","marks":{}}
            ]),
            json!([{"type":"text","value":"literal\nnewline","marks":{}}]),
            json!([{"type":"text","value":"literal\rcarriage return","marks":{}}]),
            json!([
                {"type":"block","value":{"type":"code-block","parents":[],"attrs":{"params":"text"},"isEmbed":false}},
                {"type":"text","value":"~~code, not strikethrough~~","marks":{}}
            ]),
        ] {
            let value = spans(native);
            let before = value.clone();
            assert!(spans_to_markdown(&value).is_err(), "{value:?}");
            assert_eq!(value, before);
        }
    }

    #[test]
    fn preserves_unmarked_boundary_whitespace_as_entities() {
        let value =
            spans(json!([{ "type":"text", "value":"    indented and padded  ", "marks":{} }]));
        let markdown = spans_to_markdown(&value).expect("export");
        assert_eq!(
            crate::markdown_to_spans(&markdown, &crate::ImportOptions::default()).expect("import"),
            value
        );
        assert!(markdown.starts_with("&#32;"));
        assert!(markdown.ends_with("&#32;&#32;"));
    }
    #[test]
    fn mixed_opaque_and_editable_blocks_refuse_export_without_mutation() {
        let opaque = json!({"type":"block","value":{"type":"pages-opaque","parents":[],"attrs":{"source":"<custom>preserved</custom>\n","importId":"import-42","kind":"markdown"},"isEmbed":false}});
        let paragraph = json!({"type":"block","value":{"type":"paragraph","parents":[],"attrs":{},"isEmbed":false}});
        let text = json!({"type":"text","value":"Editable neighbor","marks":{}});
        for native in [
            json!([opaque, paragraph, text]),
            json!([paragraph, text, opaque]),
        ] {
            let value = spans(native);
            let before = value.clone();
            let error = spans_to_markdown(&value)
                .expect_err("mixed source cannot round-trip through the whole-source opaque gate");
            assert!(error.to_string().contains("cannot preserve"));
            assert_eq!(value, before);
        }
    }

    #[test]
    fn sole_opaque_export_preserves_source_and_keeps_metadata_native() {
        for source in [
            "",
            "# instruction source\n\n",
            "<custom>\n exact bytes 👩🏽‍💻\n</custom>\n",
        ] {
            let value = spans(
                json!([{ "type":"block", "value": { "type":"pages-opaque", "parents":[], "attrs":{"source":source,"importId":"import-42","kind":"instruction"}, "isEmbed":false } }]),
            );
            let before = value.clone();
            assert_eq!(spans_to_markdown(&value).expect("source export"), source);
            assert_eq!(value, before);
        }
    }
    #[test]
    fn structural_only_task_siblings_keep_their_own_marker_lines() {
        let source = "- [ ]\n  - [x] a\n- [x]\n  - [ ] b\n";
        let original =
            crate::markdown_to_spans(source, &crate::ImportOptions::default()).expect("import");
        let exported = spans_to_markdown(&original).expect("export");
        assert_eq!(exported, "- [ ]\n  - [x] a\n\n- [x]\n  - [ ] b");
        let imported = crate::markdown_to_spans(&exported, &crate::ImportOptions::default())
            .expect("reimport");
        assert_eq!(original, imported);
    }
}
