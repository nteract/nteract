use markdown::mdast;
use markdown::unist::Position;
use markdown::{Constructs, ParseOptions};

const DEFAULT_WIDTH: usize = 720;
const AVG_CHAR_WIDTH: usize = 8;
const BODY_LINE_HEIGHT: usize = 22;
const CODE_LINE_HEIGHT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownProjectOptions {
    pub mdx: MdxMode,
    pub raw_html: RawHtmlMode,
    pub width: usize,
}

impl Default for MarkdownProjectOptions {
    fn default() -> Self {
        Self {
            mdx: MdxMode::Isolate,
            raw_html: RawHtmlMode::Isolate,
            width: DEFAULT_WIDTH,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MdxMode {
    Disabled,
    Isolate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawHtmlMode {
    Escape,
    Isolate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownPlan {
    pub version: u8,
    pub source_len: usize,
    pub root: ProjectedNode,
    pub blocks: Vec<ProjectedNode>,
    pub anchors: Vec<MarkdownAnchor>,
    pub isolated_regions: Vec<IsolatedRegion>,
    pub text_fallback: String,
    pub measurement: MeasurementPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedNode {
    pub id: String,
    pub kind: NodeKind,
    pub span: SourceSpan,
    pub safety: Safety,
    pub fallback: Fallback,
    pub attrs: NodeAttrs,
    pub measurement: BlockMeasurement,
    pub children: Vec<ProjectedNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Root,
    Paragraph,
    Heading,
    Blockquote,
    List,
    ListItem,
    CodeBlock,
    MathBlock,
    ThematicBreak,
    Html,
    Table,
    TableRow,
    TableCell,
    Definition,
    FootnoteDefinition,
    Text,
    Emphasis,
    Strong,
    Delete,
    InlineCode,
    InlineMath,
    Break,
    Link,
    LinkReference,
    Image,
    ImageReference,
    FootnoteReference,
    Mdx,
    Frontmatter,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NodeAttrs {
    pub depth: Option<u8>,
    pub ordered: Option<bool>,
    pub start: Option<u32>,
    pub spread: Option<bool>,
    pub checked: Option<bool>,
    pub lang: Option<String>,
    pub meta: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub alt: Option<String>,
    pub identifier: Option<String>,
    pub label: Option<String>,
    pub align: Vec<TableAlign>,
    pub anchor_slug: Option<String>,
    pub isolation_kind: Option<IsolationKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableAlign {
    None,
    Left,
    Right,
    Center,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSpan {
    pub start: usize,
    pub end: usize,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

impl SourceSpan {
    fn empty() -> Self {
        Self {
            start: 0,
            end: 0,
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Safety {
    pub lane: SafetyLane,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyLane {
    Host,
    Escaped,
    Isolated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsolationKind {
    RawHtml,
    ActiveHtml,
    Mdx,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fallback {
    pub text: String,
    pub copy_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownAnchor {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub level: u8,
    pub block_id: String,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolatedRegion {
    pub id: String,
    pub block_id: String,
    pub kind: IsolationKind,
    pub reason: String,
    pub span: SourceSpan,
    pub fallback_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeasurementPlan {
    pub estimated_height: usize,
    pub confidence: MeasurementConfidence,
    pub width: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockMeasurement {
    pub estimated_height: usize,
    pub confidence: MeasurementConfidence,
    pub basis: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MeasurementConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug)]
pub struct MarkdownProjectError {
    pub message: String,
}

impl core::fmt::Display for MarkdownProjectError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MarkdownProjectError {}

pub fn project_markdown(source: &str) -> Result<MarkdownPlan, MarkdownProjectError> {
    project_markdown_with_options(source, &MarkdownProjectOptions::default())
}

pub fn project_markdown_with_options(
    source: &str,
    options: &MarkdownProjectOptions,
) -> Result<MarkdownPlan, MarkdownProjectError> {
    let parse_options = parse_options();
    let mdast =
        markdown::to_mdast(source, &parse_options).map_err(|message| MarkdownProjectError {
            message: message.reason,
        })?;
    let mut context = ProjectionContext::new(source, options);
    let mut root = project_node(&mdast, &mut context);
    root.id = "root".to_string();

    let blocks = root.children.clone();
    let text_fallback = blocks
        .iter()
        .filter_map(|node| {
            if node.fallback.text.is_empty() {
                None
            } else {
                Some(node.fallback.text.as_str())
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let confidence = blocks
        .iter()
        .map(|node| node.measurement.confidence)
        .max()
        .unwrap_or(MeasurementConfidence::High);
    let estimated_height = blocks
        .iter()
        .map(|node| node.measurement.estimated_height)
        .sum();

    Ok(MarkdownPlan {
        version: 1,
        source_len: source.len(),
        root,
        blocks,
        anchors: context.anchors,
        isolated_regions: context.isolated_regions,
        text_fallback,
        measurement: MeasurementPlan {
            estimated_height,
            confidence,
            width: options.width,
        },
    })
}

fn parse_options() -> ParseOptions {
    let mut constructs = Constructs::gfm();
    constructs.html_flow = true;
    constructs.html_text = true;
    constructs.math_flow = true;
    constructs.math_text = true;

    ParseOptions {
        constructs,
        ..ParseOptions::default()
    }
}

struct ProjectionContext<'a> {
    source: &'a str,
    options: &'a MarkdownProjectOptions,
    anchors: Vec<MarkdownAnchor>,
    isolated_regions: Vec<IsolatedRegion>,
    slug_counts: std::collections::BTreeMap<String, usize>,
}

impl<'a> ProjectionContext<'a> {
    fn new(source: &'a str, options: &'a MarkdownProjectOptions) -> Self {
        Self {
            source,
            options,
            anchors: Vec::new(),
            isolated_regions: Vec::new(),
            slug_counts: std::collections::BTreeMap::new(),
        }
    }

    fn unique_slug(&mut self, title: &str) -> String {
        let slug = slugify(title);
        let count = self.slug_counts.entry(slug.clone()).or_insert(0);
        *count += 1;
        if *count == 1 {
            slug
        } else {
            format!("{slug}-{count}")
        }
    }
}

fn project_node(node: &mdast::Node, context: &mut ProjectionContext<'_>) -> ProjectedNode {
    let span = node
        .position()
        .map(span_from_position)
        .unwrap_or_else(SourceSpan::empty);
    let mut attrs = NodeAttrs::default();
    let mut children = node
        .children()
        .map(|items| {
            items
                .iter()
                .map(|child| project_node(child, context))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let kind;
    let mut text = node.to_string();
    let mut copy_text = text.clone();
    let mut safety = Safety {
        lane: SafetyLane::Host,
        reason: "static-markdown".to_string(),
    };

    match node {
        mdast::Node::Root(_) => {
            kind = NodeKind::Root;
            text.clear();
            copy_text.clear();
        }
        mdast::Node::Paragraph(_) => {
            kind = NodeKind::Paragraph;
        }
        mdast::Node::Heading(heading) => {
            kind = NodeKind::Heading;
            attrs.depth = Some(heading.depth);
            let slug = context.unique_slug(&text);
            attrs.anchor_slug = Some(slug.clone());
        }
        mdast::Node::Blockquote(_) => {
            kind = NodeKind::Blockquote;
        }
        mdast::Node::List(list) => {
            kind = NodeKind::List;
            attrs.ordered = Some(list.ordered);
            attrs.start = list.start;
            attrs.spread = Some(list.spread);
        }
        mdast::Node::ListItem(item) => {
            kind = NodeKind::ListItem;
            attrs.checked = item.checked;
            attrs.spread = Some(item.spread);
        }
        mdast::Node::Code(code) => {
            kind = NodeKind::CodeBlock;
            text = code.value.clone();
            copy_text = code.value.clone();
            attrs.lang = code.lang.clone();
            attrs.meta = code.meta.clone();
        }
        mdast::Node::Math(math) => {
            kind = NodeKind::MathBlock;
            text = math.value.clone();
            copy_text = math.value.clone();
            attrs.meta = math.meta.clone();
        }
        mdast::Node::ThematicBreak(_) => {
            kind = NodeKind::ThematicBreak;
            text.clear();
            copy_text.clear();
        }
        mdast::Node::Html(html) => {
            let classification = classify_html(&html.value);
            kind = NodeKind::Html;
            text = isolated_fallback(classification).to_string();
            copy_text = html.value.clone();
            attrs.isolation_kind = Some(classification);
            safety = html_safety(classification, context.options.raw_html);
            children.clear();
        }
        mdast::Node::Table(table) => {
            kind = NodeKind::Table;
            attrs.align = table.align.iter().map(table_align).collect();
        }
        mdast::Node::TableRow(_) => {
            kind = NodeKind::TableRow;
        }
        mdast::Node::TableCell(_) => {
            kind = NodeKind::TableCell;
        }
        mdast::Node::Definition(definition) => {
            kind = NodeKind::Definition;
            attrs.url = Some(definition.url.clone());
            attrs.title = definition.title.clone();
            attrs.identifier = Some(definition.identifier.clone());
            attrs.label = definition.label.clone();
        }
        mdast::Node::FootnoteDefinition(definition) => {
            kind = NodeKind::FootnoteDefinition;
            attrs.identifier = Some(definition.identifier.clone());
            attrs.label = definition.label.clone();
        }
        mdast::Node::Text(value) => {
            kind = NodeKind::Text;
            text = value.value.clone();
            copy_text = value.value.clone();
        }
        mdast::Node::Emphasis(_) => {
            kind = NodeKind::Emphasis;
        }
        mdast::Node::Strong(_) => {
            kind = NodeKind::Strong;
        }
        mdast::Node::Delete(_) => {
            kind = NodeKind::Delete;
        }
        mdast::Node::InlineCode(code) => {
            kind = NodeKind::InlineCode;
            text = code.value.clone();
            copy_text = code.value.clone();
        }
        mdast::Node::InlineMath(math) => {
            kind = NodeKind::InlineMath;
            text = math.value.clone();
            copy_text = math.value.clone();
        }
        mdast::Node::Break(_) => {
            kind = NodeKind::Break;
            text = "\n".to_string();
            copy_text = "\n".to_string();
        }
        mdast::Node::Link(link) => {
            kind = NodeKind::Link;
            attrs.url = Some(link.url.clone());
            attrs.title = link.title.clone();
        }
        mdast::Node::LinkReference(reference) => {
            kind = NodeKind::LinkReference;
            attrs.identifier = Some(reference.identifier.clone());
            attrs.label = reference.label.clone();
        }
        mdast::Node::Image(image) => {
            kind = NodeKind::Image;
            text = image.alt.clone();
            copy_text = image.alt.clone();
            attrs.url = Some(image.url.clone());
            attrs.title = image.title.clone();
            attrs.alt = Some(image.alt.clone());
        }
        mdast::Node::ImageReference(reference) => {
            kind = NodeKind::ImageReference;
            attrs.alt = Some(reference.alt.clone());
            attrs.identifier = Some(reference.identifier.clone());
            attrs.label = reference.label.clone();
        }
        mdast::Node::FootnoteReference(reference) => {
            kind = NodeKind::FootnoteReference;
            attrs.identifier = Some(reference.identifier.clone());
            attrs.label = reference.label.clone();
        }
        mdast::Node::MdxjsEsm(_)
        | mdast::Node::MdxFlowExpression(_)
        | mdast::Node::MdxTextExpression(_)
        | mdast::Node::MdxJsxFlowElement(_)
        | mdast::Node::MdxJsxTextElement(_) => {
            kind = NodeKind::Mdx;
            text = "[isolated MDX region]".to_string();
            copy_text = source_slice(context.source, &span).to_string();
            attrs.isolation_kind = Some(IsolationKind::Mdx);
            safety = Safety {
                lane: match context.options.mdx {
                    MdxMode::Disabled | MdxMode::Isolate => SafetyLane::Isolated,
                },
                reason: "mdx-compiles-to-active-js".to_string(),
            };
            children.clear();
        }
        mdast::Node::Toml(toml) => {
            kind = NodeKind::Frontmatter;
            text = toml.value.clone();
            copy_text = toml.value.clone();
        }
        mdast::Node::Yaml(yaml) => {
            kind = NodeKind::Frontmatter;
            text = yaml.value.clone();
            copy_text = yaml.value.clone();
        }
    }

    let mut projected = ProjectedNode {
        id: node_id(kind, &span),
        kind,
        span,
        safety,
        fallback: Fallback { text, copy_text },
        attrs,
        measurement: BlockMeasurement {
            estimated_height: 0,
            confidence: MeasurementConfidence::High,
            basis: String::new(),
        },
        children,
    };

    if projected.kind == NodeKind::Heading {
        if let (Some(depth), Some(slug)) =
            (projected.attrs.depth, projected.attrs.anchor_slug.clone())
        {
            context.anchors.push(MarkdownAnchor {
                id: format!("anchor:{slug}"),
                slug,
                title: projected.fallback.text.clone(),
                level: depth,
                block_id: projected.id.clone(),
                span: projected.span.clone(),
            });
        }
    }

    if projected.safety.lane == SafetyLane::Isolated {
        let kind = projected
            .attrs
            .isolation_kind
            .unwrap_or(IsolationKind::RawHtml);
        context.isolated_regions.push(IsolatedRegion {
            id: format!("isolation:{}", projected.id),
            block_id: projected.id.clone(),
            kind,
            reason: projected.safety.reason.clone(),
            span: projected.span.clone(),
            fallback_text: projected.fallback.text.clone(),
        });
    }

    projected.measurement = estimate_node(&projected, context.options.width);
    projected
}

fn span_from_position(position: &Position) -> SourceSpan {
    SourceSpan {
        start: position.start.offset,
        end: position.end.offset,
        start_line: position.start.line,
        start_column: position.start.column,
        end_line: position.end.line,
        end_column: position.end.column,
    }
}

fn node_id(kind: NodeKind, span: &SourceSpan) -> String {
    format!("node:{kind:?}:{}:{}", span.start, span.end)
}

fn table_align(align: &mdast::AlignKind) -> TableAlign {
    match align {
        mdast::AlignKind::None => TableAlign::None,
        mdast::AlignKind::Left => TableAlign::Left,
        mdast::AlignKind::Right => TableAlign::Right,
        mdast::AlignKind::Center => TableAlign::Center,
    }
}

fn classify_html(value: &str) -> IsolationKind {
    let lower = value.to_ascii_lowercase();
    let active = [
        "<script",
        "<style",
        "<iframe",
        "<object",
        "<embed",
        "<link",
        "<form",
        "<input",
        "<button",
        "<textarea",
        "<select",
        "<video",
        "<audio",
        "<canvas",
        "<svg",
    ];
    if active.iter().any(|needle| lower.contains(needle)) {
        return IsolationKind::ActiveHtml;
    }
    if looks_like_mdx_component(value) {
        return IsolationKind::Mdx;
    }
    IsolationKind::RawHtml
}

fn looks_like_mdx_component(value: &str) -> bool {
    let trimmed = value.trim_start();
    let Some(rest) = trimmed.strip_prefix('<') else {
        return false;
    };
    rest.chars()
        .next()
        .map(|character| character.is_ascii_uppercase())
        .unwrap_or(false)
}

fn html_safety(kind: IsolationKind, mode: RawHtmlMode) -> Safety {
    match (kind, mode) {
        (IsolationKind::Mdx, _) => Safety {
            lane: SafetyLane::Isolated,
            reason: "mdx-compiles-to-active-js".to_string(),
        },
        (IsolationKind::ActiveHtml, _) => Safety {
            lane: SafetyLane::Isolated,
            reason: "raw-html-active-element".to_string(),
        },
        (IsolationKind::RawHtml, RawHtmlMode::Escape) => Safety {
            lane: SafetyLane::Escaped,
            reason: "raw-html-escaped".to_string(),
        },
        (IsolationKind::RawHtml, RawHtmlMode::Isolate) => Safety {
            lane: SafetyLane::Isolated,
            reason: "raw-html-requires-policy".to_string(),
        },
    }
}

fn isolated_fallback(kind: IsolationKind) -> &'static str {
    match kind {
        IsolationKind::Mdx => "[isolated MDX region]",
        IsolationKind::ActiveHtml => "[isolated active HTML region]",
        IsolationKind::RawHtml => "[isolated raw HTML region]",
    }
}

fn estimate_node(node: &ProjectedNode, width: usize) -> BlockMeasurement {
    match node.kind {
        NodeKind::Root => measured(
            node.children
                .iter()
                .map(|child| child.measurement.estimated_height)
                .sum(),
            MeasurementConfidence::Medium,
            "sum of child estimates",
        ),
        NodeKind::Heading => {
            let height = match node.attrs.depth.unwrap_or(3) {
                1 => 40,
                2 => 34,
                3 => 30,
                4 => 26,
                _ => 24,
            };
            measured(height, MeasurementConfidence::High, "heading rhythm")
        }
        NodeKind::Paragraph | NodeKind::Blockquote | NodeKind::TableCell => {
            let lines = estimate_wrapped_lines(&node.fallback.text, width);
            measured(
                lines * BODY_LINE_HEIGHT + 8,
                MeasurementConfidence::Medium,
                "text wrap heuristic",
            )
        }
        NodeKind::List => measured(
            node.children.len().max(1) * BODY_LINE_HEIGHT + 12,
            MeasurementConfidence::Medium,
            "list item count",
        ),
        NodeKind::CodeBlock => measured(
            node.fallback.text.lines().count().max(1) * CODE_LINE_HEIGHT + 24,
            MeasurementConfidence::High,
            "code line count",
        ),
        NodeKind::MathBlock => measured(64, MeasurementConfidence::Low, "display math placeholder"),
        NodeKind::Table => measured(
            node.children.len().max(2) * 34 + 16,
            MeasurementConfidence::Low,
            "table row count",
        ),
        NodeKind::Html | NodeKind::Mdx => measured(
            96,
            MeasurementConfidence::Low,
            "isolated or escaped raw region",
        ),
        NodeKind::ThematicBreak => measured(24, MeasurementConfidence::High, "static rule"),
        _ => measured(0, MeasurementConfidence::High, "inline or structural child"),
    }
}

fn measured(
    estimated_height: usize,
    confidence: MeasurementConfidence,
    basis: &str,
) -> BlockMeasurement {
    BlockMeasurement {
        estimated_height,
        confidence,
        basis: basis.to_string(),
    }
}

fn estimate_wrapped_lines(text: &str, width: usize) -> usize {
    let chars_per_line = (width / AVG_CHAR_WIDTH).max(20);
    (text.chars().count() / chars_per_line).max(1)
        + usize::from(text.chars().count() % chars_per_line != 0)
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_was_dash = false;
        } else if character.is_whitespace() || character == '-' {
            if !last_was_dash && !slug.is_empty() {
                slug.push('-');
                last_was_dash = true;
            }
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "section".to_string()
    } else {
        slug
    }
}

fn source_slice<'a>(source: &'a str, span: &SourceSpan) -> &'a str {
    source.get(span.start..span.end).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_headings_with_anchors_and_source_spans() {
        let plan = project_markdown("# Title\n\n## Title\n").unwrap();

        assert_eq!(plan.blocks.len(), 2);
        assert_eq!(plan.anchors[0].slug, "title");
        assert_eq!(plan.anchors[1].slug, "title-2");
        assert_eq!(plan.blocks[0].kind, NodeKind::Heading);
        assert_eq!(plan.blocks[0].span.start, 0);
        assert_eq!(plan.blocks[0].span.end, 7);
        assert_eq!(plan.blocks[0].span.start_line, 1);
        assert_eq!(plan.blocks[0].attrs.depth, Some(1));
    }

    #[test]
    fn projects_gfm_tasks_tables_delete_and_autolinks() {
        let source = [
            "- [x] done and ~~old~~",
            "- [ ] visit https://example.com",
            "",
            "| metric | value |",
            "| --- | ---: |",
            "| rows | 128 |",
        ]
        .join("\n");
        let plan = project_markdown(&source).unwrap();

        let list = &plan.blocks[0];
        assert_eq!(list.kind, NodeKind::List);
        assert_eq!(list.children[0].kind, NodeKind::ListItem);
        assert_eq!(list.children[0].attrs.checked, Some(true));
        assert_eq!(list.children[1].attrs.checked, Some(false));
        assert!(contains_kind(list, NodeKind::Delete));
        assert!(contains_kind(list, NodeKind::Link));

        let table = &plan.blocks[1];
        assert_eq!(table.kind, NodeKind::Table);
        assert_eq!(table.attrs.align, vec![TableAlign::None, TableAlign::Right]);
        assert_eq!(table.children.len(), 2);
        assert_eq!(table.children[0].children.len(), 2);
    }

    #[test]
    fn projects_math_code_links_and_images_for_renderer_adapters() {
        let source = [
            "Inline $x^2$ and [docs](https://nteract.io).",
            "",
            "![plot](attachment:plot.png)",
            "",
            "```python",
            "print('ok')",
            "```",
            "",
            "$$",
            "x = y",
            "$$",
        ]
        .join("\n");
        let plan = project_markdown(&source).unwrap();

        assert!(contains_kind(&plan.blocks[0], NodeKind::InlineMath));
        assert!(contains_kind(&plan.blocks[0], NodeKind::Link));
        assert!(contains_kind(&plan.blocks[1], NodeKind::Image));
        assert_eq!(plan.blocks[2].kind, NodeKind::CodeBlock);
        assert_eq!(plan.blocks[2].attrs.lang.as_deref(), Some("python"));
        assert_eq!(plan.blocks[2].fallback.copy_text, "print('ok')");
        assert_eq!(plan.blocks[3].kind, NodeKind::MathBlock);
        assert_eq!(plan.blocks[3].fallback.copy_text, "x = y");
        assert_eq!(plan.measurement.confidence, MeasurementConfidence::Low);
    }

    #[test]
    fn parses_inline_raw_html_with_the_nteract_gfm_profile() {
        let plan = project_markdown("alpha <i>wow</i> omega").unwrap();

        assert_eq!(plan.blocks[0].kind, NodeKind::Paragraph);
        let html_node = find_kind(&plan.blocks[0], NodeKind::Html).unwrap();
        assert_eq!(html_node.attrs.isolation_kind, Some(IsolationKind::RawHtml));
        assert_eq!(html_node.safety.lane, SafetyLane::Isolated);
        assert_eq!(html_node.safety.reason, "raw-html-requires-policy");
    }

    #[test]
    fn projects_unclosed_fenced_code_as_streaming_code_block() {
        let plan = project_markdown("```ts\nconst plan = wasm.project(source);").unwrap();

        assert_eq!(plan.blocks.len(), 1);
        assert_eq!(plan.blocks[0].kind, NodeKind::CodeBlock);
        assert_eq!(plan.blocks[0].attrs.lang.as_deref(), Some("ts"));
        assert_eq!(
            plan.blocks[0].fallback.copy_text,
            "const plan = wasm.project(source);"
        );
    }

    #[test]
    fn isolates_active_html_and_mdx_like_html_without_host_execution() {
        let source = [
            "<script>alert(1)</script>",
            "",
            "<PlotlyChart data={forecast} />",
        ]
        .join("\n");
        let plan = project_markdown(&source).unwrap();

        assert_eq!(plan.blocks.len(), 2);
        assert_eq!(plan.blocks[0].safety.lane, SafetyLane::Isolated);
        assert_eq!(
            plan.blocks[0].attrs.isolation_kind,
            Some(IsolationKind::ActiveHtml)
        );
        assert_eq!(plan.blocks[1].safety.lane, SafetyLane::Isolated);
        assert_eq!(
            plan.blocks[1].attrs.isolation_kind,
            Some(IsolationKind::Mdx)
        );
        assert_eq!(plan.isolated_regions.len(), 2);
        assert_eq!(
            plan.text_fallback,
            "[isolated active HTML region]\n\n[isolated MDX region]"
        );
    }

    #[test]
    fn can_escape_non_active_raw_html_as_native_text() {
        let options = MarkdownProjectOptions {
            raw_html: RawHtmlMode::Escape,
            ..MarkdownProjectOptions::default()
        };
        let plan = project_markdown_with_options("alpha <i>bravo</i>", &options).unwrap();

        assert_eq!(plan.blocks[0].kind, NodeKind::Paragraph);
        let html_node = find_kind(&plan.blocks[0], NodeKind::Html).unwrap();
        assert_eq!(html_node.safety.lane, SafetyLane::Escaped);
        assert!(plan.isolated_regions.is_empty());
    }

    fn contains_kind(node: &ProjectedNode, kind: NodeKind) -> bool {
        find_kind(node, kind).is_some()
    }

    fn find_kind(node: &ProjectedNode, kind: NodeKind) -> Option<&ProjectedNode> {
        if node.kind == kind {
            return Some(node);
        }
        node.children
            .iter()
            .find_map(|child| find_kind(child, kind))
    }
}
