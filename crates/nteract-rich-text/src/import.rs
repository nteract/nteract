use markdown::{mdast::Node, Constructs, ParseOptions};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::{
    safe_url, validate_spans, Attributes, Block, CodecError, ImportOptions, Marks, Result, Span,
    MAX_DEPTH, MAX_INPUT_BYTES,
};

/// Import the `pages-markdown-v1` profile into native span data, as the
/// JavaScript `parseMarkdown` in `pages/model/richtext.mjs` does. Math and
/// HTML Pages can't represent stay literal text (see `scan`); content whose
/// kind is not Markdown is all literal text, and so is Markdown that would
/// parse to less than it says (see `lossy`). Import never writes a preserved
/// block. Both source and resulting serialized spans must fit.
pub fn markdown_to_spans(source: &str, options: &ImportOptions<'_>) -> Result<Vec<Span>> {
    if source.len() > MAX_INPUT_BYTES {
        return Err(CodecError("Markdown exceeds the input byte limit".into()));
    }
    if options.kind != "markdown" {
        return literal_document(source);
    }
    guard_container_prefixes(source)?;
    let original = source;

    // This is deliberately not Constructs::gfm(): Pages keeps bare URLs as
    // text, recognizes tasks only in bullet lists, and has no footnotes.
    let parse = |text: &str| {
        markdown::to_mdast(text, &parse_options()).map_err(|error| CodecError(error.to_string()))
    };
    let normalized = normalize(source);
    // The parser drops a leading byte order mark, which Markdown-it keeps as
    // text. The scan reads it as U+3000, a space of the same length in the
    // same line-start class, and the parser reads it as an entity.
    let bom = normalized.starts_with('\u{feff}');
    let scanned = if bom {
        normalized.replacen('\u{feff}', "\u{3000}", 1)
    } else {
        normalized.clone()
    };
    let tree = parse(&scanned)?;
    let mut text = literalize(&normalized, &scan(&scanned, &tree)?);
    if bom {
        let body = text.as_deref().unwrap_or(&normalized);
        text = Some(format!("&#xFEFF;{}", &body['\u{feff}'.len_utf8()..]));
    }
    let (source, tree) = match text {
        Some(text) => {
            let tree = parse(&text)?;
            (std::borrow::Cow::Owned(text), tree)
        }
        None => (std::borrow::Cow::Owned(normalized), tree),
    };
    let source: &str = &source;

    if lossy(&tree, 0, false)? {
        return literal_document(original);
    }
    let mut tree = tree;
    let mut definitions = Definitions::new();
    if collect_definitions(&mut tree, &mut definitions) || !all_used(&tree, &definitions) {
        return literal_document(original);
    }
    let Node::Root(root) = tree else {
        return Err(CodecError("Markdown parser did not return a root".into()));
    };
    let mut builder = Builder {
        source,
        definitions,
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
        return literal_document(original);
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
            gfm_strikethrough: true,
            html_flow: false,
            // HTML tokens let table-only <br> remain distinct from escaped
            // or entity-encoded text. Other HTML tokens stay literal text.
            html_text: true,
            ..Constructs::default()
        },
        // Markdown-it's strikethrough needs two tildes.
        gfm_strikethrough_single_tilde: false,
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

// Math has no node in Pages, so its source stays literal text. These rules,
// the JavaScript `MATH_SYNTAX` in `pages/model/richtext.mjs`, decide what
// counts as math. The two have the same pattern text, which the
// `math_pattern_matches_pages` test compares:
// - A `$$` at a line start, after optional spaces, opens display math.
// - A `$$` pair on one line is display math, with or without spaces.
// - A `$` pair follows Pandoc's dollar rule: the opening `$` is followed
//   by a non-space, the closing `$` follows a non-space and is not
//   followed by a digit. "$30 and $25" stays prose.
// When unsure, the text counts as math. Unicode `\s` here and JavaScript
// `\s` disagree on U+0085 and U+FEFF, so each rule spells out its spaces:
// - The dollar rule's spaces are ASCII whitespace, [ \t\n\v\f\r].
// - Before a line-start `$$`, a space is any character either codec's
//   `\s` matched that does not start a line.
// A line starts at the start of input or after LF, CR, CRLF, U+2028 or
// U+2029, the line terminators of JavaScript's multiline `^`. `(?m)`
// disagrees on CR, U+2028 and U+2029, so the pattern has no multiline
// flag and writes line starts as `(?:^|\r\n?|[\n\u2028\u2029])`. Line
// terminators are not in the prefix class, so the branches never overlap.
// `\uXXXX` names the same code point here as in the JavaScript pattern.
const MATH_PATTERN: &str = r"(?:^|\r\n?|[\n\u2028\u2029])[ \t\v\f\u00a0\u0085\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*\$\$|\$\$(?:[^\n$]|\$[^\n$])*\$\$|\$[^ \t\n\v\f\r$](?:[^ \t\n\v\f\r$]|[ \t\v\f\r]+[^ \t\n\v\f\r$])*\$(?:[^0-9]|$)";

/// Markdown-it reads CRLF and CR as LF and NUL as U+FFFD; the JavaScript scan
/// reads the same text, so this one does too.
fn normalize(source: &str) -> String {
    if !source.contains(['\r', '\0']) {
        return source.to_owned();
    }
    source
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "\u{fffd}")
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Construct {
    Math,
    Html,
    /// The opening bracket of a link, image or definition whose destination
    /// Pages refuses. Escaping it leaves the syntax as text, as Markdown-it
    /// does when its link validation fails.
    Unsafe,
}

#[derive(Debug)]
struct Scan {
    /// Byte ranges into the normalized source, ordered and not overlapping.
    found: Vec<(Construct, usize, usize)>,
    /// Code and backslash-escaped bytes, which are never syntax.
    masked: Vec<bool>,
}

/// Math, HTML and unsafe destinations outside code in `source`, the same
/// ranges the JavaScript `scanMarkdown` finds. Code positions come from the
/// parsed tree; a backslash escapes the ASCII punctuation after it.
fn scan(source: &str, tree: &Node) -> Result<Scan> {
    fn walk(
        node: &Node,
        source: &str,
        in_table: bool,
        masked: &mut [bool],
        found: &mut Vec<(Construct, usize, usize)>,
    ) -> Result<()> {
        let range = node.position().map(|p| (p.start.offset, p.end.offset));
        match node {
            Node::Code(_) | Node::InlineCode(_) => {
                if let Some((start, end)) = range {
                    masked[start..end].fill(true);
                }
                return Ok(());
            }
            Node::Html(html) => {
                let allowed = highlight_tag(&html.value)? != Tag::Literal
                    || (in_table && table_break(&html.value)?);
                if let (false, Some((start, end))) = (allowed, range) {
                    found.push((Construct::Html, start, end));
                }
                return Ok(());
            }
            Node::Link(markdown::mdast::Link { url, .. })
            | Node::Definition(markdown::mdast::Definition { url, .. })
                if !safe_url(url) =>
            {
                // An autolink opens with `<`; other links and definitions
                // with `[`.
                if let Some(at) = range.and_then(|(start, end)| {
                    source[start..end]
                        .find(['[', '<'])
                        .map(|offset| start + offset)
                }) {
                    found.push((Construct::Unsafe, at, at + 1));
                }
            }
            Node::Image(image) if !safe_url(&image.url) => {
                if let Some((start, _)) = range {
                    found.push((Construct::Unsafe, start + 1, start + 2));
                }
            }
            _ => {}
        }
        let in_table = in_table || matches!(node, Node::Table(_));
        if let Some(children) = node.children() {
            for child in children {
                walk(child, source, in_table, masked, found)?;
            }
        }
        Ok(())
    }
    static MATH: OnceLock<Regex> = OnceLock::new();
    static BLANK: OnceLock<Regex> = OnceLock::new();
    let bytes = source.as_bytes();
    let mut masked = vec![false; bytes.len()];
    let mut others = Vec::new();
    walk(tree, source, false, &mut masked, &mut others)?;
    let mut index = 0;
    while index + 1 < bytes.len() {
        if !masked[index] && bytes[index] == b'\\' && bytes[index + 1].is_ascii_punctuation() {
            masked[index + 1] = true;
            index += 2;
        } else {
            index += 1;
        }
    }
    // Masked bytes read as NUL; line breaks stay for the line-start rules.
    let text: String = String::from_utf8(
        bytes
            .iter()
            .zip(&masked)
            .map(|(byte, masked)| if *masked && *byte != b'\n' { 0 } else { *byte })
            .collect(),
    )
    .map_err(|error| CodecError(error.to_string()))?;
    let math = expression(&MATH, MATH_PATTERN)?;
    let blank = expression(&BLANK, r"\n[ \t]*\n")?;
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(matched) = math.find_at(&text, at) {
        let first = matched.start() + matched.as_str().find('$').unwrap_or(0);
        let end = if matched.end() - first == 2 {
            // A line-start `$$` opens display math. It runs to the next `$$`
            // before a blank line, or to that blank line.
            let paragraph_end = blank
                .find_at(&text, matched.end())
                .map_or(text.len(), |blank| blank.start());
            match text[matched.end()..].find("$$") {
                Some(close) if matched.end() + close < paragraph_end => matched.end() + close + 2,
                _ => paragraph_end,
            }
        } else if text.as_bytes()[first + 1] == b'$' {
            matched.end()
        } else {
            // The dollar rule's body holds no `$`; its match may read one
            // character past the closing `$`.
            text[first + 1..]
                .find('$')
                .map_or(matched.end(), |close| first + close + 2)
        };
        found.push((Construct::Math, first, end));
        at = end.max(matched.start() + 1);
    }
    // HTML inside math is part of the math.
    for range in others {
        if !found.iter().any(|(construct, start, end)| {
            *construct == Construct::Math && range.1 >= *start && range.1 < *end
        }) {
            found.push(range);
        }
    }
    found.sort_by_key(|(_, start, _)| *start);
    // An HTML comment or instruction can span a math range. Overlapping
    // ranges merge, and the first one names the construct.
    let mut merged: Vec<(Construct, usize, usize)> = Vec::new();
    for range in found {
        match merged.last_mut() {
            Some(last) if range.1 < last.2 => last.2 = last.2.max(range.2),
            _ => merged.push(range),
        }
    }
    Ok(Scan {
        found: merged,
        masked,
    })
}

/// The source with every ASCII punctuation character in each range, outside
/// code, backslash-escaped, so the parser reads the range as its literal
/// characters; None when nothing needs it. A line break between two lines of
/// display math becomes a hard break, so it keeps its lines.
fn literalize(source: &str, scan: &Scan) -> Option<String> {
    if scan.found.is_empty() {
        return None;
    }
    let bytes = source.as_bytes();
    let mut result = Vec::with_capacity(bytes.len() + 16);
    let mut copied = 0;
    for &(construct, start, end) in &scan.found {
        result.extend_from_slice(&bytes[copied..start]);
        for index in start..end {
            let byte = bytes[index];
            let hard_break = construct == Construct::Math
                && byte == b'\n'
                && index > start
                && index + 1 < end
                && bytes[index - 1] != b'\n'
                && bytes[index + 1] != b'\n'
                && !scan.masked[index + 1];
            if !scan.masked[index] && (hard_break || byte.is_ascii_punctuation()) {
                result.push(b'\\');
            }
            result.push(byte);
        }
        copied = end;
    }
    result.extend_from_slice(&bytes[copied..]);
    String::from_utf8(result).ok()
}

/// Non-Markdown content as text: one paragraph per run of lines, each line
/// break a hard break.
fn literal_document(source: &str) -> Result<Vec<Span>> {
    static BLANK: OnceLock<Regex> = OnceLock::new();
    let normalized = normalize(source);
    let paragraphs: Vec<&str> = expression(&BLANK, r"\n[ \t]*\n")?
        .split(&normalized)
        .filter(|part| !part.trim().is_empty())
        .collect();
    let mut spans = Vec::new();
    for part in &paragraphs {
        if paragraphs.len() > 1 {
            spans.push(Span::Block {
                value: Block {
                    kind: "paragraph".into(),
                    parents: Vec::new(),
                    attrs: Attributes::new(),
                    is_embed: false,
                },
            });
        }
        // Line breaks at a paragraph's edges separate it; they aren't content.
        for (index, line) in part.trim_matches('\n').split('\n').enumerate() {
            if index > 0 {
                spans.push(Span::Block {
                    value: Block {
                        kind: "hard-break".into(),
                        parents: vec!["paragraph".into()],
                        attrs: Attributes::new(),
                        is_embed: true,
                    },
                });
            }
            if !line.is_empty() {
                spans.push(Span::Text {
                    value: line.into(),
                    marks: Marks::new(),
                });
            }
        }
    }
    validate_spans(&spans)?;
    Ok(spans)
}

fn table_break(html: &str) -> Result<bool> {
    static TABLE_BREAK: OnceLock<Regex> = OnceLock::new();
    Ok(expression(&TABLE_BREAK, r"(?i)^<br\s*/?\s*>$")?.is_match(html))
}

/// Reference definitions by identifier. The first definition of an
/// identifier wins, as in CommonMark.
type Definitions = std::collections::HashMap<String, (String, Option<String>)>;

/// Move every definition out of the tree into `definitions`. Like
/// Markdown-it, a definition leaves no block behind, so the blocks around it
/// are siblings. Returns whether a label was defined twice: the second
/// destination would be dropped.
fn collect_definitions(node: &mut Node, definitions: &mut Definitions) -> bool {
    let Some(children) = node.children_mut() else {
        return false;
    };
    let mut repeated = false;
    children.retain(|child| {
        let Node::Definition(definition) = child else {
            return true;
        };
        match definitions.entry(definition.identifier.clone()) {
            std::collections::hash_map::Entry::Occupied(_) => repeated = true,
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert((definition.url.clone(), definition.title.clone()));
            }
        }
        false
    });
    for child in children {
        repeated |= collect_definitions(child, definitions);
    }
    repeated
}

/// Whether some reference uses every definition; an unused one's destination
/// would be dropped.
fn all_used(tree: &Node, definitions: &Definitions) -> bool {
    fn walk(node: &Node, used: &mut std::collections::HashSet<String>) {
        match node {
            Node::LinkReference(reference) => {
                used.insert(reference.identifier.clone());
            }
            Node::ImageReference(reference) => {
                used.insert(reference.identifier.clone());
            }
            _ => {}
        }
        if let Some(children) = node.children() {
            for child in children {
                walk(child, used);
            }
        }
    }
    if definitions.is_empty() {
        return true;
    }
    let mut used = std::collections::HashSet::new();
    walk(tree, &mut used);
    definitions.keys().all(|label| used.contains(label))
}

/// Markdown that would parse to less than it says, which import keeps as
/// literal text, as the JavaScript `pages_lossy` rules do: an image inside a
/// link or mark (an image marker can't carry one), a link with no text, and a
/// table body row with more cells than its header. Constructs this profile
/// doesn't enable count too, so a parser change can't drop content.
fn lossy(node: &Node, depth: usize, inside_marks: bool) -> Result<bool> {
    if depth > MAX_DEPTH {
        return Err(CodecError(
            "Markdown nesting exceeds the depth limit".into(),
        ));
    }
    // Neither construct is enabled; this keeps a parser change from dropping
    // content.
    if matches!(
        node,
        Node::FootnoteDefinition(_)
            | Node::FootnoteReference(_)
            | Node::Math(_)
            | Node::InlineMath(_)
    ) {
        return Ok(true);
    }
    if matches!(node, Node::Link(link) if !safe_url(&link.url))
        || matches!(node, Node::Image(image) if !safe_url(&image.url))
    {
        return Ok(true);
    }
    if inside_marks && matches!(node, Node::Image(_) | Node::ImageReference(_)) {
        return Ok(true);
    }
    match node {
        Node::Link(markdown::mdast::Link { children, .. })
        | Node::LinkReference(markdown::mdast::LinkReference { children, .. })
            if children.is_empty() =>
        {
            return Ok(true)
        }
        Node::Table(table)
            if table.children.iter().skip(1).any(
                |row| matches!(row, Node::TableRow(row) if row.children.len() > table.align.len()),
            ) =>
        {
            return Ok(true)
        }
        _ => {}
    }
    let inside_marks = inside_marks
        || matches!(
            node,
            Node::Link(_)
                | Node::LinkReference(_)
                | Node::Strong(_)
                | Node::Emphasis(_)
                | Node::Delete(_)
        );
    if let Some(children) = node.children() {
        for child in children {
            if lossy(child, depth + 1, inside_marks)? {
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
    definitions: Definitions,
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
            Node::ThematicBreak(_) => {
                self.marker("horizontal-rule", parents, Attributes::new(), false);
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
                Node::Delete(delete) => {
                    let mut nested = marks.clone();
                    nested.insert("strike".into(), Value::Bool(true));
                    self.inlines(&delete.children, parents, &nested, in_table)?;
                }
                Node::Link(link) => {
                    self.link(
                        &link.url,
                        &link.title,
                        &link.children,
                        parents,
                        marks,
                        in_table,
                    )?;
                }
                Node::LinkReference(reference) => {
                    let (url, title) = self.definition(&reference.identifier)?;
                    self.link(&url, &title, &reference.children, parents, marks, in_table)?;
                }
                Node::ImageReference(reference) => {
                    let (url, title) = self.definition(&reference.identifier)?;
                    self.highlighted_image |= self.highlight.is_some();
                    self.marker(
                        "image",
                        parents,
                        Attributes::from([
                            ("src".into(), json!(url)),
                            ("alt".into(), json!(reference.alt)),
                            ("title".into(), json!(title)),
                        ]),
                        true,
                    );
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
                        _ if in_table && table_break(&html.value)? => {
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

impl Builder<'_> {
    fn definition(&self, identifier: &str) -> Result<(String, Option<String>)> {
        self.definitions
            .get(identifier)
            .cloned()
            .ok_or_else(|| CodecError("A Markdown reference has no definition".into()))
    }

    fn link(
        &mut self,
        url: &str,
        title: &Option<String>,
        children: &[Node],
        parents: &[String],
        marks: &Marks,
        in_table: bool,
    ) -> Result<()> {
        let mut nested = marks.clone();
        let value = format!("{{\"href\":{},\"title\":{}}}", json!(url), json!(title));
        nested.insert("link".into(), Value::String(value));
        self.inlines(children, parents, &nested, in_table)
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

    /// The Pages source, read the way `marks.rs` reads its registry. Both
    /// files exist wherever this crate builds; the Pages CI job checks out
    /// only its own tree, so the comparison lives here.
    const PAGES_RICHTEXT: &str = include_str!(
        "../../../docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/richtext.mjs"
    );

    #[test]
    fn math_pattern_matches_pages() {
        let Some((_, after)) = PAGES_RICHTEXT.split_once("export const MATH_SYNTAX =") else {
            panic!("Pages exports MATH_SYNTAX");
        };
        let Some(body) = after.trim_start().strip_prefix('/') else {
            panic!("MATH_SYNTAX is a regex literal");
        };
        let Some((pattern, rest)) = body.split_once("/;") else {
            panic!("MATH_SYNTAX ends with a flagless `/;`");
        };
        assert!(
            !pattern.contains('\n') && rest.starts_with('\n'),
            "MATH_SYNTAX is one flagless literal"
        );
        assert_eq!(pattern, MATH_PATTERN);
        Regex::new(pattern).unwrap();
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
    fn former_preserved_constructs_import_natively_or_as_text() {
        let opaque = |spans: &[Span]| {
            spans
                .iter()
                .any(|span| matches!(span, Span::Block { value } if value.kind == "pages-opaque"))
        };
        assert_eq!(
            import("***"),
            vec![Span::Block {
                value: Block {
                    kind: "horizontal-rule".into(),
                    parents: vec![],
                    attrs: Attributes::new(),
                    is_embed: false,
                },
            }]
        );
        assert_eq!(
            import("~~deleted~~"),
            vec![text("deleted", json!({"strike": true}))]
        );
        assert_eq!(import("<b>html</b>"), vec![text("<b>html</b>", json!({}))]);
        assert_eq!(
            import("[link][ref]\n\n[ref]: /x"),
            vec![text(
                "link",
                json!({"link": "{\"href\":\"/x\",\"title\":null}"})
            )]
        );
        assert_eq!(
            import("[bad](javascript:alert(1))"),
            vec![text("[bad](javascript:alert(1))", json!({}))]
        );
        assert_eq!(import("$x$ and `$y$`")[0], text("$x$ and ", json!({})));
        for source in [
            "***",
            "~~deleted~~",
            "<b>html</b>",
            "$x$",
            "[bad](javascript:x)",
        ] {
            assert!(!opaque(&import(source)), "{source}");
        }
    }

    #[test]
    fn code_spans_and_fences_hide_math_and_html() {
        for source in [
            "`~~x~~` and `$x$` and `<div>`",
            "```\n$$\n<div>\n```",
            "    $x$ <b>",
            "> ```\n> $y$\n> ```",
            "Escaped \\$x\\$ text",
        ] {
            let normalized = normalize(source);
            let tree = markdown::to_mdast(&normalized, &parse_options()).unwrap();
            assert!(
                scan(&normalized, &tree).unwrap().found.is_empty(),
                "{source}"
            );
        }
        let tree = markdown::to_mdast("`$a$` then $b$", &parse_options()).unwrap();
        let found = scan("`$a$` then $b$", &tree).unwrap().found;
        assert_eq!(found, vec![(Construct::Math, 11, 14)]);
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
    fn lossy_markdown_stays_literal_text() {
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
            assert_eq!(spans, literal_document(source).unwrap(), "{source}");
        }
        for source in [
            "| a |\n| --- |\n| b | c |",
            "[](https://example.org)",
            "[r]: /x",
            "[r]: /a\n[r]: /b\n\n[q][r]",
            "Text <mark>and ![caption](image.png)</mark>",
        ] {
            assert_eq!(
                import(source),
                literal_document(source).unwrap(),
                "{source}"
            );
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
        // Literal source is subject to the same bound, including JSON
        // escaping. Refuse explicitly rather than truncate its content.
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
    fn html_scan_admits_only_highlight_tags() {
        let found = |source: &str| {
            let tree = markdown::to_mdast(source, &parse_options()).unwrap();
            scan(source, &tree).unwrap().found
        };
        for source in [
            "<mark>a</mark>",
            "</mark> b",
            "  <MARK>c",
            "<mark data-color=\"blue\">d",
        ] {
            assert!(found(source).is_empty(), "{source}");
        }
        // An autolink to a scheme Pages refuses stays text: its `<` is escaped.
        assert_eq!(found("<mark:x>"), vec![(Construct::Unsafe, 0, 1)]);
        for source in ["<marker>x</marker>", "<b>y</b>", "<span><mark>"] {
            assert_eq!(
                found(source).first().map(|range| range.0),
                Some(Construct::Html),
                "{source}"
            );
        }
    }

    #[test]
    fn highlighted_images_stay_literal_text() {
        let options = ImportOptions {
            import_id: "image-import",
            kind: "markdown",
        };
        let source = "Text <mark>and ![caption](image.png)</mark>";
        assert_eq!(
            markdown_to_spans(source, &options).unwrap(),
            literal_document(source).unwrap()
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
