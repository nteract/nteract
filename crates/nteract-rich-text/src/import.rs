use markdown::{mdast::Node, Constructs, ParseOptions};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::{
    safe_url, validate_spans, Attributes, Block, CodecError, ImportOptions, Marks, Result, Span,
    MAX_DEPTH, MAX_INPUT_BYTES,
};

/// Import the conservative `pages-markdown-v1` profile into native span data.
/// Unsupported syntax within admission bounds is retained as one opaque block,
/// never silently removed. Both source and resulting serialized spans must fit.
pub fn markdown_to_spans(source: &str, options: &ImportOptions<'_>) -> Result<Vec<Span>> {
    if source.len() > MAX_INPUT_BYTES {
        return Err(CodecError("Markdown exceeds the input byte limit".into()));
    }
    if options.kind != "markdown" || unsupported_syntax(source)? {
        return opaque(source, options);
    }
    guard_container_prefixes(source)?;

    // This is deliberately not Constructs::gfm(): Pages keeps bare URLs as
    // text, recognizes tasks only in bullet lists, and preserves extensions
    // without a native representation instead of interpreting them differently.
    let tree = markdown::to_mdast(source, &parse_options())
        .map_err(|error| CodecError(error.to_string()))?;

    if needs_opaque(&tree, 0, false)? {
        return opaque(source, options);
    }
    let Node::Root(root) = tree else {
        return Err(CodecError("Markdown parser did not return a root".into()));
    };
    let mut builder = Builder {
        source,
        spans: Vec::new(),
        tags: Vec::new(),
        next_tag: 0,
        highlight: None,
        highlighted_image: false,
    };
    for node in &root.children {
        builder.block(node, &[], root.children.len() == 1)?;
    }
    // An image marker cannot carry a highlight, as with links and emphasis.
    if builder.highlighted_image {
        return opaque(source, options);
    }
    validate_spans(&builder.spans)?;
    Ok(builder.spans)
}

fn expression(cache: &'static OnceLock<Regex>, pattern: &str) -> Result<&'static Regex> {
    if let Some(regex) = cache.get() {
        return Ok(regex);
    }
    let regex = Regex::new(pattern)
        .map_err(|error| CodecError(format!("Invalid codec pattern: {error}")))?;
    Ok(cache.get_or_init(|| regex))
}

fn parse_options() -> ParseOptions {
    ParseOptions {
        constructs: Constructs {
            gfm_table: true,
            html_flow: false,
            // HTML tokens let table-only <br> remain distinct from escaped
            // or entity-encoded text. Other HTML tokens stay literal text.
            html_text: true,
            ..Constructs::default()
        },
        ..ParseOptions::default()
    }
}

/// Bound container work before invoking the parser: a short line of thousands
/// of `>` markers otherwise spends substantial CPU building a rejected tree.
/// This is a conservative admission check, not a second Markdown parser. The
/// AST guard below still enforces the actual combined block/inline depth.
fn guard_container_prefixes(source: &str) -> Result<()> {
    let mut fence: Option<(u8, usize, usize)> = None;
    for line in source.lines() {
        let mut rest = line.trim_start_matches([' ', '\t']);
        // An indented code line is not a fence opener. Treating it as one
        // would exempt following real containers from the admission guard.
        let mut can_open_fence =
            line.len() - rest.len() <= 3 && !line[..line.len() - rest.len()].contains('\t');
        if let Some((marker, length, quotes)) = fence {
            // Only strip the quote wrappers outside the code fence. Additional
            // `>` characters are literal code, not new Markdown containers.
            let mut wrapped = true;
            for _ in 0..quotes {
                if let Some(after) = rest.strip_prefix('>') {
                    rest = after.trim_start_matches([' ', '\t']);
                } else {
                    wrapped = false;
                    break;
                }
            }
            if wrapped {
                let run = rest.bytes().take_while(|byte| *byte == marker).count();
                if run >= length && rest[run..].trim().is_empty() {
                    fence = None;
                }
                continue;
            }
            fence = None;
            rest = line.trim_start_matches([' ', '\t']);
        }

        let mut depth = 0;
        let mut quotes = 0;
        loop {
            let consumed = if rest.starts_with('>') {
                quotes += 1;
                1
            } else {
                list_prefix_len(rest)
            };
            if consumed == 0 {
                break;
            }
            depth += 1;
            if depth > MAX_DEPTH {
                return Err(CodecError(
                    "Markdown container prefix exceeds the depth limit before parsing".into(),
                ));
            }
            let after = &rest[consumed..];
            rest = after.trim_start_matches([' ', '\t']);
            can_open_fence &=
                after.len() - rest.len() <= 3 && !after[..after.len() - rest.len()].contains('\t');
        }
        if let Some(marker @ (b'`' | b'~')) = rest.bytes().next() {
            let length = rest.bytes().take_while(|byte| *byte == marker).count();
            // List indentation can close a nested fence implicitly. Rather
            // than duplicate that parser, keep checking those prefixes.
            if can_open_fence
                && depth == quotes
                && length >= 3
                && (marker != b'`' || !rest[length..].contains('`'))
            {
                fence = Some((marker, length, quotes));
            }
        }
    }
    Ok(())
}

fn list_prefix_len(source: &str) -> usize {
    let bytes = source.as_bytes();
    let marker_len = match bytes.first() {
        Some(b'-' | b'+' | b'*') => 1,
        Some(b'0'..=b'9') => {
            let digits = bytes
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digits > 9 || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return 0;
            }
            digits + 1
        }
        _ => return 0,
    };
    if matches!(bytes.get(marker_len), Some(b' ' | b'\t')) {
        marker_len
    } else {
        0
    }
}

fn unsupported_syntax(source: &str) -> Result<bool> {
    static TASK_PREFIX: OnceLock<Regex> = OnceLock::new();
    static MATH: OnceLock<Regex> = OnceLock::new();
    static UNSUPPORTED: OnceLock<Regex> = OnceLock::new();
    static LINE_HTML: OnceLock<Regex> = OnceLock::new();
    // Omit bullet task prefixes before checking for reference links. Unlike
    // scanning decoded text, this keeps escaped brackets literal.
    let task = expression(
        &TASK_PREFIX,
        r"(?m)^(\s*(?:>\s*)*[-+*][ \t]+)\[[ xX]\]([ \t]+|$)",
    )?;
    let syntax = task.replace_all(source, "${1}${2}");
    // Math on one line is preserved, as in the JavaScript `MATH` gate, which
    // has the same pattern text:
    // - A `$$` pair is display math, with or without spaces around it.
    // - A `$` pair follows Pandoc's dollar rule: the opening `$` is followed
    //   by a non-space, the closing `$` follows a non-space and is not
    //   followed by a digit. "$30 and $25" stays prose.
    // A space is ASCII whitespace, [ \t\n\v\f\r], and nothing else. Unicode
    // `\s` here and JavaScript `\s` disagree on U+0085 and U+FEFF. Every other
    // character, including U+00A0 and U+2028, is content.
    if expression(
        &MATH,
        r"(?m)\$\$(?:[^\n$]|\$[^\n$])*\$\$|\$[^ \t\n\v\f\r$](?:[^ \t\n\v\f\r$]|[ \t\v\f\r]+[^ \t\n\v\f\r$])*\$(?:[^0-9]|$)",
    )?
    .is_match(&syntax)
        || expression(
            &UNSUPPORTED,
            r"(?m)(^|\n)\s*(\$\$|---\s*$)|!?\[[^\]]*\]\s*\[|^\s*\[[^\]]+\]:|~~",
        )?
        .is_match(&syntax)
    {
        return Ok(true);
    }
    // A line that starts with HTML is opaque, except a highlight tag. The
    // JavaScript gate is `<(?!\/?mark[ \t\r\n>])`: the tag name must be
    // followed by ASCII whitespace or `>`, so `<marker>`, `<mark:x>` and
    // `<mark\u{a0}>` stay opaque. Any line-start `<` without that tag matches.
    Ok(
        expression(&LINE_HTML, r"(?m)(?:^|\n)\s*<(?i:(/?mark)[ \t\r\n>])?")?
            .captures_iter(&syntax)
            .any(|captures| captures.get(1).is_none()),
    )
}

fn opaque(source: &str, options: &ImportOptions<'_>) -> Result<Vec<Span>> {
    let spans = vec![Span::Block {
        value: Block {
            kind: "pages-opaque".into(),
            parents: Vec::new(),
            attrs: Attributes::from([
                ("source".into(), json!(source)),
                ("importId".into(), json!(options.import_id)),
                ("kind".into(), json!(options.kind)),
            ]),
            is_embed: false,
        },
    }];
    validate_spans(&spans)?;
    Ok(spans)
}

fn needs_opaque(node: &Node, depth: usize, inside_marks: bool) -> Result<bool> {
    if depth > MAX_DEPTH {
        return Err(CodecError(
            "Markdown nesting exceeds the depth limit".into(),
        ));
    }
    if matches!(
        node,
        Node::ThematicBreak(_)
            | Node::Definition(_)
            | Node::LinkReference(_)
            | Node::ImageReference(_)
            | Node::FootnoteDefinition(_)
            | Node::FootnoteReference(_)
            | Node::Delete(_)
            | Node::Math(_)
            | Node::InlineMath(_)
    ) {
        // The current JS adapter drops thematic breaks because it has no block
        // mapping. Retaining their source is an intentional compatibility fix.
        return Ok(true);
    }
    if matches!(node, Node::Link(link) if !safe_url(&link.url))
        || matches!(node, Node::Image(image) if !safe_url(&image.url))
    {
        return Ok(true);
    }
    // Marks live on text spans; an image marker cannot carry its enclosing
    // link or emphasis. Preserve the entire source before building any spans
    // instead of accepting an image with those semantics silently removed.
    if inside_marks && matches!(node, Node::Image(_)) {
        return Ok(true);
    }
    let inside_marks =
        inside_marks || matches!(node, Node::Link(_) | Node::Strong(_) | Node::Emphasis(_));
    if let Some(children) = node.children() {
        for child in children {
            if needs_opaque(child, depth + 1, inside_marks)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// How one inline HTML node imports. Only highlight tags are markup.
#[derive(Clone, Debug, PartialEq)]
enum Tag {
    Literal,
    Open(String),
    Close,
}

/// Classify one inline HTML node. Pages recognizes exactly `<mark>`,
/// `<mark data-color="…">` (either quote style) and `</mark>`. A color that
/// the registry rejects leaves the tag as literal text.
fn highlight_tag(html: &str) -> Result<Tag> {
    static OPEN: OnceLock<Regex> = OnceLock::new();
    static CLOSE: OnceLock<Regex> = OnceLock::new();
    if expression(&CLOSE, r"(?i)^</mark\s*>$")?.is_match(html) {
        return Ok(Tag::Close);
    }
    let open = expression(
        &OPEN,
        r#"(?i)^<mark(?:\s+data-color\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'))?\s*>$"#,
    )?;
    let Some(captures) = open.captures(html) else {
        return Ok(Tag::Literal);
    };
    let color = match captures.get(1).or_else(|| captures.get(2)) {
        Some(color) => crate::marks::normalize_highlight(color.as_str()),
        None => Some(crate::marks::default_highlight()?.to_owned()),
    };
    Ok(color.map_or(Tag::Literal, Tag::Open))
}

/// Highlight roles for every inline HTML node of one inline container, in
/// document order. Like the JavaScript balance pass, this works on the flat
/// token sequence: a nested open, an unopened close and an unclosed open are
/// literal text. Strong, emphasis and link boundaries do not scope a tag.
fn highlight_tags(children: &[Node]) -> Result<Vec<Tag>> {
    fn collect(nodes: &[Node], tags: &mut Vec<Tag>) -> Result<()> {
        for node in nodes {
            if let Node::Html(html) = node {
                tags.push(highlight_tag(&html.value)?);
            } else if let Some(children) = node.children() {
                collect(children, tags)?;
            }
        }
        Ok(())
    }
    let mut tags = Vec::new();
    collect(children, &mut tags)?;
    let mut open = None;
    for (index, tag) in tags.iter_mut().enumerate() {
        match tag {
            Tag::Open(_) if open.is_some() => *tag = Tag::Literal,
            Tag::Open(_) => open = Some(index),
            Tag::Close if open.take().is_none() => *tag = Tag::Literal,
            Tag::Close | Tag::Literal => {}
        }
    }
    if let Some(index) = open {
        tags[index] = Tag::Literal;
    }
    Ok(tags)
}

struct Builder<'a> {
    source: &'a str,
    spans: Vec<Span>,
    /// Highlight roles of the current inline container's HTML nodes.
    tags: Vec<Tag>,
    next_tag: usize,
    /// The open highlight color while walking the current inline container.
    highlight: Option<String>,
    highlighted_image: bool,
}

impl Builder<'_> {
    fn marker(&mut self, kind: &str, parents: &[String], attrs: Attributes, is_embed: bool) {
        self.spans.push(Span::Block {
            value: Block {
                kind: kind.into(),
                parents: parents.to_vec(),
                attrs,
                is_embed,
            },
        });
    }

    fn text(&mut self, value: &str, marks: &Marks) {
        if value.is_empty() {
            return;
        }
        if let Some(Span::Text {
            value: previous,
            marks: previous_marks,
        }) = self.spans.last_mut()
        {
            if previous_marks == marks {
                previous.push_str(value);
                return;
            }
        }
        self.spans.push(Span::Text {
            value: value.into(),
            marks: marks.clone(),
        });
    }

    fn block(&mut self, node: &Node, parents: &[String], implicit: bool) -> Result<()> {
        if parents.len() > MAX_DEPTH {
            return Err(CodecError(
                "Rich text nesting exceeds the depth limit".into(),
            ));
        }
        match node {
            Node::Paragraph(paragraph) => {
                if !implicit {
                    self.marker("paragraph", parents, Attributes::new(), false);
                }
                self.inline_container(
                    &paragraph.children,
                    &with_parent(parents, "paragraph"),
                    false,
                )?;
            }
            Node::Heading(heading) => {
                self.marker(
                    "heading",
                    parents,
                    Attributes::from([("level".into(), json!(heading.depth))]),
                    false,
                );
                self.inline_container(&heading.children, &with_parent(parents, "heading"), false)?;
            }
            Node::Code(code) => {
                let params = self.code_params(node);
                self.marker(
                    "code-block",
                    parents,
                    Attributes::from([("params".into(), json!(params))]),
                    false,
                );
                self.text(&code.value, &Marks::new());
            }
            Node::Blockquote(quote) => {
                self.container("blockquote", parents, &quote.children, Attributes::new())?;
            }
            Node::List(list) => {
                for item in &list.children {
                    let Node::ListItem(item) = item else {
                        return Err(CodecError("List contains a non-item node".into()));
                    };
                    let mut children = item.children.clone();
                    let checked = if list.ordered {
                        None
                    } else {
                        self.remove_task_prefix(&mut children)?
                    };
                    let kind = if checked.is_some() {
                        "task-list-item"
                    } else if list.ordered {
                        "ordered-list-item"
                    } else {
                        "unordered-list-item"
                    };
                    let attrs = checked.map_or_else(Attributes::new, |checked| {
                        Attributes::from([("checked".into(), json!(checked))])
                    });
                    self.container(kind, parents, &children, attrs)?;
                }
            }
            Node::Table(table) => {
                self.marker("table", parents, Attributes::new(), false);
                let table_parents = with_parent(parents, "table");
                for (row_index, row) in table.children.iter().enumerate() {
                    let Node::TableRow(row) = row else {
                        return Err(CodecError("Table contains a non-row node".into()));
                    };
                    self.marker("table-row", &table_parents, Attributes::new(), false);
                    let row_parents = with_parent(&table_parents, "table-row");
                    // Markdown-it pads short rows and ignores excess body cells.
                    for (column, align) in table.align.iter().enumerate() {
                        let kind = if row_index == 0 {
                            "table-header"
                        } else {
                            "table-cell"
                        };
                        let alignment = match align {
                            markdown::mdast::AlignKind::Left => Some("left"),
                            markdown::mdast::AlignKind::Center => Some("center"),
                            markdown::mdast::AlignKind::Right => Some("right"),
                            markdown::mdast::AlignKind::None => None,
                        };
                        let attrs = alignment.map_or_else(Attributes::new, |align| {
                            Attributes::from([("align".into(), json!(align))])
                        });
                        self.marker(kind, &row_parents, attrs, false);
                        if let Some(Node::TableCell(cell)) = row.children.get(column) {
                            self.inline_container(
                                &cell.children,
                                &with_parent(&row_parents, kind),
                                true,
                            )?;
                        }
                    }
                }
            }
            _ => {
                return Err(CodecError(
                    "Markdown node has no rich-text block mapping".into(),
                ))
            }
        }
        Ok(())
    }

    fn container(
        &mut self,
        kind: &str,
        parents: &[String],
        children: &[Node],
        attrs: Attributes,
    ) -> Result<()> {
        // A list item has an implicit leading paragraph even when its Markdown
        // AST starts with a nested list. Every item needs a marker: parent paths
        // alone cannot distinguish two neighboring items of the same type.
        // Structural quote wrappers may be inferred, unless that would reuse
        // the previous sibling's still-open parent path and merge the siblings.
        let children_parents = with_parent(parents, kind);
        let reuses_previous_container = self
            .spans
            .iter()
            .rev()
            .find_map(|span| {
                if let Span::Block { value } = span {
                    let mut path = value.parents.clone();
                    if !value.is_embed {
                        path.push(value.kind.clone());
                    }
                    Some(path.starts_with(&children_parents))
                } else {
                    None
                }
            })
            .unwrap_or(false);
        let has_text_child = children
            .iter()
            .any(|child| matches!(child, Node::Paragraph(_) | Node::Heading(_) | Node::Code(_)));
        if has_text_child
            || children.is_empty()
            || kind.ends_with("list-item")
            || reuses_previous_container
        {
            self.marker(kind, parents, attrs, false);
        }
        for (index, child) in children.iter().enumerate() {
            self.block(child, &children_parents, index == 0)?;
        }
        Ok(())
    }

    fn remove_task_prefix(&self, children: &mut [Node]) -> Result<Option<bool>> {
        static TASK_PREFIX: OnceLock<Regex> = OnceLock::new();
        let Some(Node::Paragraph(paragraph)) = children.first_mut() else {
            return Ok(None);
        };
        let Some(position) = &paragraph.position else {
            return Ok(None);
        };
        let raw = self
            .source
            .get(position.start.offset..position.end.offset)
            .ok_or_else(|| CodecError("Invalid Markdown source position".into()))?;
        let pattern = expression(&TASK_PREFIX, r"^\[([ xX])\](?:[ \t]+|$)")?;
        let Some(captures) = pattern.captures(raw) else {
            return Ok(None);
        };
        let checked = captures
            .get(1)
            .is_some_and(|capture| capture.as_str().eq_ignore_ascii_case("x"));
        let Some(prefix_len) = captures.get(0).map(|capture| capture.len()) else {
            return Ok(None);
        };
        let Some(Node::Text(first)) = paragraph.children.first_mut() else {
            return Ok(None);
        };
        if first.value.len() < prefix_len || !first.value.is_char_boundary(prefix_len) {
            return Err(CodecError("Task prefix did not match parsed text".into()));
        }
        first.value.drain(..prefix_len);
        Ok(Some(checked))
    }

    fn code_params(&self, node: &Node) -> String {
        let Some(position) = node.position() else {
            return String::new();
        };
        let Some(raw) = self.source.get(position.start.offset..position.end.offset) else {
            return String::new();
        };
        let line = raw.lines().next().unwrap_or_default();
        let fence = line.chars().next();
        if !matches!(fence, Some('`' | '~')) {
            return String::new();
        }
        let length = line
            .chars()
            .take_while(|character| Some(*character) == fence)
            .count();
        if length < 3 {
            return String::new();
        }
        line[length..].to_owned()
    }

    fn image_alt(&self, image: &markdown::mdast::Image) -> Result<String> {
        // mdast's image alt flattener drops Break nodes. Parsing the same label
        // as a link exposes its inline children, preserving alt-text newlines.
        let Some(position) = &image.position else {
            return Ok(image.alt.clone());
        };
        let Some(raw) = self.source.get(position.start.offset..position.end.offset) else {
            return Err(CodecError("Invalid image source position".into()));
        };
        let Some(link_source) = raw.strip_prefix('!') else {
            return Ok(image.alt.clone());
        };
        let parsed = markdown::to_mdast(link_source, &parse_options())
            .map_err(|error| CodecError(error.to_string()))?;
        if let Some(children) = parsed.children() {
            if let Some(Node::Paragraph(paragraph)) = children.first() {
                if let Some(Node::Link(link)) = paragraph.children.first() {
                    // Balanced highlight tags are markup in alt text too, so
                    // they leave no text, as in the JavaScript alt flattener.
                    let tags = highlight_tags(&link.children)?;
                    let mut next = 0;
                    return Ok(link
                        .children
                        .iter()
                        .map(|child| inline_plain_text(child, &tags, &mut next))
                        .collect());
                }
            }
        }
        Ok(image.alt.clone())
    }

    /// Import one paragraph, heading or table cell. Highlight tags balance
    /// within this container, never across blocks.
    fn inline_container(
        &mut self,
        children: &[Node],
        parents: &[String],
        in_table: bool,
    ) -> Result<()> {
        self.tags = highlight_tags(children)?;
        self.next_tag = 0;
        self.highlight = None;
        self.inlines(children, parents, &Marks::new(), in_table)?;
        self.highlight = None;
        Ok(())
    }

    /// Text marks plus the currently open highlight, if any.
    fn text_marks(&self, marks: &Marks) -> Marks {
        let mut marks = marks.clone();
        if let Some(color) = &self.highlight {
            marks.insert("highlight".into(), Value::String(color.clone()));
        }
        marks
    }

    fn inlines(
        &mut self,
        children: &[Node],
        parents: &[String],
        marks: &Marks,
        in_table: bool,
    ) -> Result<()> {
        static TABLE_BREAK: OnceLock<Regex> = OnceLock::new();
        for node in children {
            match node {
                Node::Text(text) => {
                    let marks = self.text_marks(marks);
                    self.text(
                        &text.value.replace("\r\n", "\n").replace(['\n', '\r'], " "),
                        &marks,
                    );
                }
                Node::InlineCode(code) => {
                    let mut nested = self.text_marks(marks);
                    nested.insert("code".into(), Value::Bool(true));
                    self.text(&code.value, &nested);
                }
                Node::Strong(strong) => {
                    let mut nested = marks.clone();
                    nested.insert("strong".into(), Value::Bool(true));
                    self.inlines(&strong.children, parents, &nested, in_table)?;
                }
                Node::Emphasis(emphasis) => {
                    let mut nested = marks.clone();
                    nested.insert("em".into(), Value::Bool(true));
                    self.inlines(&emphasis.children, parents, &nested, in_table)?;
                }
                Node::Link(link) => {
                    let mut nested = marks.clone();
                    let value = format!(
                        "{{\"href\":{},\"title\":{}}}",
                        json!(link.url),
                        json!(link.title)
                    );
                    nested.insert("link".into(), Value::String(value));
                    self.inlines(&link.children, parents, &nested, in_table)?;
                }
                Node::Image(image) => {
                    self.highlighted_image |= self.highlight.is_some();
                    self.marker(
                        "image",
                        parents,
                        Attributes::from([
                            ("src".into(), json!(image.url)),
                            ("alt".into(), json!(self.image_alt(image)?)),
                            ("title".into(), json!(image.title)),
                        ]),
                        true,
                    );
                }
                Node::Break(_) => self.marker("hard-break", parents, Attributes::new(), true),
                Node::Html(html) => {
                    let tag = self.tags.get(self.next_tag).cloned();
                    self.next_tag += 1;
                    match tag {
                        Some(Tag::Open(color)) => self.highlight = Some(color),
                        Some(Tag::Close) => self.highlight = None,
                        _ if in_table
                            && expression(&TABLE_BREAK, r"(?i)^<br\s*/?\s*>$")?
                                .is_match(&html.value) =>
                        {
                            self.marker("hard-break", parents, Attributes::new(), true);
                        }
                        _ => {
                            let marks = self.text_marks(marks);
                            self.text(&html.value, &marks);
                        }
                    }
                }
                _ => {
                    return Err(CodecError(
                        "Markdown node has no rich-text inline mapping".into(),
                    ))
                }
            }
        }
        Ok(())
    }
}

fn inline_plain_text(node: &Node, tags: &[Tag], next: &mut usize) -> String {
    match node {
        Node::Break(_) => "\n".into(),
        Node::Image(image) => image.alt.clone(),
        Node::Html(html) => {
            let tag = tags.get(*next);
            *next += 1;
            match tag {
                Some(Tag::Open(_) | Tag::Close) => String::new(),
                _ => html.value.replace("\r\n", "\n").replace('\r', "\n"),
            }
        }
        _ => node.children().map_or_else(
            || node.to_string().replace("\r\n", "\n").replace('\r', "\n"),
            |children| {
                children
                    .iter()
                    .map(|child| inline_plain_text(child, tags, next))
                    .collect()
            },
        ),
    }
}

fn with_parent(parents: &[String], kind: &str) -> Vec<String> {
    let mut path = parents.to_vec();
    path.push(kind.into());
    path
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Assertions below are test setup, not the public API.
mod tests {
    use super::*;

    fn import(source: &str) -> Vec<Span> {
        markdown_to_spans(source, &ImportOptions::default()).unwrap()
    }

    #[test]
    fn bare_urls_and_ordered_task_text_stay_prose() {
        assert_eq!(
            import("https://example.com"),
            vec![Span::Text {
                value: "https://example.com".into(),
                marks: Marks::new()
            }]
        );
        let ordered = import("1. [x] text");
        assert!(matches!(&ordered[0], Span::Block { value } if value.kind == "ordered-list-item"));
        assert!(matches!(&ordered[1], Span::Text { value, .. } if value == "[x] text"));
    }

    #[test]
    fn table_breaks_distinguish_markup_from_literal_text() {
        let spans = import("| H |\n| --- |\n| a<br>b &lt;br&gt; c `<br>` | ");
        assert_eq!(
            spans
                .iter()
                .filter(|span| matches!(span, Span::Block { value } if value.kind == "hard-break"))
                .count(),
            1
        );
        assert!(spans
            .iter()
            .any(|span| matches!(span, Span::Text { value, .. } if value.contains("<br> c"))));
        assert!(spans.iter().any(|span| matches!(span, Span::Text { value, marks } if value == "<br>" && marks.get("code") == Some(&Value::Bool(true)))));
    }

    #[test]
    fn unsupported_content_retains_source_and_provenance() {
        for source in [
            "***",
            "~~deleted~~",
            "<b>html</b>",
            "[link][ref]\n\n[ref]: /x",
            "[bad](javascript:alert(1))",
        ] {
            let spans = markdown_to_spans(
                source,
                &ImportOptions {
                    import_id: "import-1",
                    kind: "markdown",
                },
            )
            .unwrap();
            assert!(
                matches!(&spans[..], [Span::Block { value }] if value.kind == "pages-opaque" && value.attrs.get("source") == Some(&json!(source)) && value.attrs.get("importId") == Some(&json!("import-1")))
            );
        }
    }

    #[test]
    fn inline_code_preserves_surrounding_marks() {
        let spans = import("**`code`** and [`link code`](https://example.org)");
        assert!(
            matches!(&spans[0], Span::Text { marks, .. } if marks.get("code") == Some(&json!(true)) && marks.get("strong") == Some(&json!(true)))
        );
        assert!(
            matches!(&spans[2], Span::Text { marks, .. } if marks.get("code") == Some(&json!(true)) && marks.contains_key("link"))
        );
    }

    #[test]
    fn image_wrappers_preserve_whole_source_and_provenance() {
        for source in [
            "[![caption](image.png)](https://example.org)",
            "**![caption](image.png)**",
            "*![caption](image.png)*",
            "[***![caption](image.png)***](https://example.org)",
            "Before\n\n[Text and ![caption](image.png)](https://example.org)\n\nAfter\n",
            "| A |\n| --- |\n| **![caption](image.png)** |",
            "# [![caption](image.png)](https://example.org)",
            "> - *![caption](image.png)*",
        ] {
            let options = ImportOptions {
                import_id: "image-import",
                kind: "markdown",
            };
            let spans = markdown_to_spans(source, &options).unwrap();
            assert_eq!(spans, opaque(source, &options).unwrap(), "{source}");
            assert_eq!(crate::spans_to_markdown(&spans).unwrap(), source);
        }
    }

    #[test]
    fn image_wrapper_guard_does_not_leak_to_siblings_or_alt_text() {
        let source = "**Before** ![**caption**](image.png) [after](https://example.org)";
        let spans = import(source);
        assert!(spans.iter().any(|span| matches!(span, Span::Block { value } if value.kind == "image" && value.attrs.get("alt") == Some(&json!("caption")))));
        assert!(!spans
            .iter()
            .any(|span| matches!(span, Span::Block { value } if value.kind == "pages-opaque")));
        assert!(spans.iter().any(|span| matches!(span, Span::Text { value, marks } if value == "Before" && marks.contains_key("strong"))));
        assert!(spans.iter().any(|span| matches!(span, Span::Text { value, marks } if value == "after" && marks.contains_key("link"))));
    }

    #[test]
    fn line_endings_and_image_alt_breaks_are_preserved() {
        assert_eq!(import("a\r\nb"), import("a\nb"));
        let spans = import("![one  \ntwo](/asset)");
        assert!(
            matches!(&spans[0], Span::Block { value } if value.attrs.get("alt") == Some(&json!("one\ntwo")))
        );
    }

    #[test]
    fn input_and_nesting_limits_return_errors() {
        assert!(
            markdown_to_spans(&"x".repeat(MAX_INPUT_BYTES + 1), &ImportOptions::default()).is_err()
        );
        assert!(markdown_to_spans(
            &format!("{}deep", "> ".repeat(MAX_DEPTH + 2)),
            &ImportOptions::default()
        )
        .is_err());
    }

    #[test]
    fn source_and_serialized_spans_have_independent_admission_bounds() {
        // Even one text span has JSON overhead. Being below the source limit
        // alone does not guarantee that the converted spans fit.
        let source = "a".repeat(MAX_INPUT_BYTES - 1);
        let error = markdown_to_spans(&source, &ImportOptions::default()).unwrap_err();
        assert!(error.0.contains("Rich spans"));
        // Opaque source is subject to the same bound, including JSON escaping
        // and provenance. Refuse explicitly rather than truncate its content.
        let source = "\"".repeat(MAX_INPUT_BYTES / 2);
        let error = markdown_to_spans(
            &source,
            &ImportOptions {
                import_id: "fixture",
                kind: "instruction",
            },
        )
        .unwrap_err();
        assert!(error.0.contains("Rich spans"));
    }

    #[test]
    fn indented_code_does_not_open_an_admission_guard_fence() {
        let source = format!("    ```\n{}text", ">".repeat(40_000));
        let error = markdown_to_spans(&source, &ImportOptions::default()).unwrap_err();
        assert!(error.to_string().contains("before parsing"));
    }

    #[test]
    fn excessive_quote_prefixes_are_rejected_before_parsing() {
        for source in [
            format!("{}deep", ">".repeat(40_000)),
            format!("- {}deep", "> ".repeat(40_000)),
            format!("1. {}deep", "> ".repeat(40_000)),
        ] {
            let error = markdown_to_spans(&source, &ImportOptions::default()).unwrap_err();
            assert!(error.0.contains("before parsing"));
        }
    }

    #[test]
    fn quote_prefix_guard_does_not_interpret_fenced_code() {
        let literal = ">".repeat(40_000);
        let spans = import(&format!("```text\n{literal}\n```"));
        assert!(matches!(&spans[1], Span::Text { value, .. } if value == &literal));
        let source = format!(
            "> ```text\n> {literal}\n> ```\n\n{}deep",
            ">".repeat(40_000)
        );
        assert!(guard_container_prefixes(&source)
            .unwrap_err()
            .0
            .contains("before parsing"));
        for source in [
            format!("- ```text\n\n{}deep", ">".repeat(40_000)),
            format!("> ```text\n\n- {}deep", ">".repeat(40_000)),
        ] {
            assert!(guard_container_prefixes(&source)
                .unwrap_err()
                .0
                .contains("before parsing"));
        }
    }

    #[test]
    fn structural_only_list_siblings_keep_distinct_outer_markers() {
        for (source, kind) in [
            ("-\n  - a\n-\n  - b\n", "unordered-list-item"),
            ("1.\n   1. a\n2.\n   1. b\n", "ordered-list-item"),
            ("- > > a\n- > > b", "unordered-list-item"),
        ] {
            let spans = import(source);
            assert_eq!(spans.iter().filter(|span| matches!(span, Span::Block { value } if value.kind == kind && value.parents.is_empty())).count(), 2, "{source}");
        }
    }

    fn text(value: &str, marks: Value) -> Span {
        Span::Text {
            value: value.into(),
            marks: serde_json::from_value(marks).unwrap(),
        }
    }

    #[test]
    fn highlight_tags_import_as_registry_marks() {
        assert_eq!(
            import(r#"Set the **<mark data-color="green">launch date</mark>** today."#),
            vec![
                text("Set the ", json!({})),
                text("launch date", json!({"strong": true, "highlight": "green"})),
                text(" today.", json!({})),
            ]
        );
        assert_eq!(
            import("<mark>Bare</mark> <MARK Data-Color = ' #ABCDEF ' >hex</mark >"),
            vec![
                text("Bare", json!({"highlight": "yellow"})),
                text(" ", json!({})),
                text("hex", json!({"highlight": "#abcdef"})),
            ]
        );
        // Tags are flat tokens: they need not nest with emphasis.
        assert_eq!(
            import("<mark>a **b</mark> c**"),
            vec![
                text("a ", json!({"highlight": "yellow"})),
                text("b", json!({"highlight": "yellow", "strong": true})),
                text(" c", json!({"strong": true})),
            ]
        );
        assert_eq!(
            import("<mark>see `code`</mark>"),
            vec![
                text("see ", json!({"highlight": "yellow"})),
                text("code", json!({"highlight": "yellow", "code": true})),
            ]
        );
    }

    #[test]
    fn highlight_works_inside_table_cells() {
        let spans = import("| A |\n| --- |\n| x<br><mark data-color=\"blue\">y</mark> |");
        assert!(spans
            .iter()
            .any(|span| matches!(span, Span::Block { value } if value.kind == "hard-break")));
        assert_eq!(spans.last(), Some(&text("y", json!({"highlight": "blue"}))));
    }

    #[test]
    fn unbalanced_nested_and_invalid_highlight_tags_stay_literal() {
        for (source, expected) in [
            (
                r#"<mark>a <mark data-color="pink">b</mark> c</mark>"#,
                vec![
                    text(
                        r#"a <mark data-color="pink">b"#,
                        json!({"highlight": "yellow"}),
                    ),
                    text(" c</mark>", json!({})),
                ],
            ),
            (
                "Close </mark> first, then <mark>never closed.",
                vec![text(
                    "Close </mark> first, then <mark>never closed.",
                    json!({}),
                )],
            ),
            (
                r#"An <mark data-color="red">invalid</mark> color."#,
                vec![text(
                    r#"An <mark data-color="red">invalid</mark> color."#,
                    json!({}),
                )],
            ),
            (
                r#"<mark data-color="">empty</mark>"#,
                vec![text(r#"<mark data-color="">empty</mark>"#, json!({}))],
            ),
            (
                "Write \\<mark> tags as text.",
                vec![text("Write <mark> tags as text.", json!({}))],
            ),
            // Highlights balance within one block, never across blocks.
            (
                "<mark>first\n\nsecond</mark>",
                vec![
                    text("<mark>first", json!({})),
                    Span::Block {
                        value: Block {
                            kind: "paragraph".into(),
                            parents: vec![],
                            attrs: Attributes::new(),
                            is_embed: false,
                        },
                    },
                    text("second</mark>", json!({})),
                ],
            ),
        ] {
            let mut actual = import(source);
            // The first paragraph marker is implicit only for a sole block.
            if matches!(actual.first(), Some(Span::Block { value }) if value.kind == "paragraph") {
                actual.remove(0);
            }
            assert_eq!(actual, expected, "{source}");
        }
    }

    #[test]
    fn line_start_html_gate_admits_only_highlight_tags() {
        for source in [
            "<mark>a</mark>",
            "</mark> b",
            "  <MARK>c",
            "<mark data-color=\"blue\">d",
        ] {
            assert!(!unsupported_syntax(source).unwrap(), "{source}");
        }
        for source in [
            "<marker>x</marker>",
            "<markä>d",
            "<mark:x>",
            "<mark\u{a0}>x</mark>",
            "<b>y</b>",
            "text\n<mark_up>",
            "<span><mark>",
        ] {
            assert!(unsupported_syntax(source).unwrap(), "{source}");
        }
    }

    #[test]
    fn highlighted_images_preserve_whole_source() {
        let options = ImportOptions {
            import_id: "image-import",
            kind: "markdown",
        };
        let source = "Text <mark>and ![caption](image.png)</mark>";
        assert_eq!(
            markdown_to_spans(source, &options).unwrap(),
            opaque(source, &options).unwrap()
        );
        // Balanced tags inside alt text are markup, not alt characters.
        let spans = import("![<mark>x</mark> y](cat.png)");
        assert!(
            matches!(&spans[0], Span::Block { value } if value.attrs.get("alt") == Some(&json!("x y")))
        );
    }

    #[test]
    fn structural_only_quote_siblings_keep_their_boundary() {
        let spans = import("> > a\n\n> > b");
        assert!(
            matches!(&spans[2], Span::Block { value } if value.kind == "blockquote" && value.parents.is_empty())
        );
        assert!(
            matches!(&spans[3], Span::Block { value } if value.kind == "blockquote" && value.parents == ["blockquote"])
        );
        let nested_siblings = import("> > a\n>\n> > b");
        assert_ne!(spans, nested_siblings);
    }
}
