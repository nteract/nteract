use markdown::mdast;
use markdown::unist::Position;
use markdown::{Constructs, ParseOptions};
use serde::{Deserialize, Serialize};

mod render_json;

pub use render_json::{error_to_json, render_plan_json};

const DEFAULT_WIDTH: usize = 720;
const AVG_CHAR_WIDTH: usize = 8;
const BODY_LINE_HEIGHT: usize = 22;
const CODE_LINE_HEIGHT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownProjectOptions {
    pub mdx: MdxMode,
    pub raw_html: RawHtmlMode,
    pub width: usize,
    pub islands: bool,
}

impl Default for MarkdownProjectOptions {
    fn default() -> Self {
        Self {
            mdx: MdxMode::Isolate,
            raw_html: RawHtmlMode::Isolate,
            width: DEFAULT_WIDTH,
            islands: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MdxMode {
    Disabled,
    Isolate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanMode {
    Markdown,
    Mdx,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawHtmlMode {
    Escape,
    Isolate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownPlan {
    pub version: u8,
    pub mode: PlanMode,
    pub source_len: usize,
    pub root: ProjectedNode,
    pub blocks: Vec<ProjectedNode>,
    pub anchors: Vec<MarkdownAnchor>,
    pub isolated_regions: Vec<IsolatedRegion>,
    pub text_fallback: String,
    pub measurement: MeasurementPlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ReconcilerSnapshot {
    root: Option<SnapshotNode>,
    next_id: u64,
}

impl ReconcilerSnapshot {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(bytes: &[u8]) -> ReconcilerSnapshot {
        serde_json::from_slice(bytes).unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SnapshotNode {
    id: String,
    key: StructuralKey,
    content_hash: u64,
    children: Vec<SnapshotNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StructuralKey {
    kind: NodeKind,
    lane: SafetyLane,
    isolation_kind: Option<IsolationKind>,
    // Tag identity is part of the key so a same-kind tag swap is a replace, not
    // an edit: isolation_tag covers active-HTML elements (<video> -> <iframe>),
    // island_tag covers MDX components (<Frog /> -> <Chart />). Without the tag
    // here, compat would carry the old id onto a different component and alias
    // two distinct nodes, which breaks id-anchored comments and collab state.
    isolation_tag: Option<String>,
    island_tag: Option<String>,
    // island_inline distinguishes a block <Frog/> from an inline <Frog/> for the
    // same reason: they share a kind and tag, so without this a block->inline swap
    // would alias the id instead of remounting. They are never siblings today, but
    // keeping it in the key means a future flow/text unification stays correct.
    island_inline: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    Island,
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
    pub isolation_tag: Option<String>,
    pub island_tag: Option<String>,
    pub island_inline: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SafetyLane {
    Host,
    Escaped,
    Isolated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IsolationKind {
    RawHtml,
    ActiveHtml,
    Mdx,
    Component,
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

pub fn project_from_mdast(
    mdast: &markdown::mdast::Node,
    source: &str,
    options: &MarkdownProjectOptions,
) -> MarkdownPlan {
    let (plan, _) =
        project_from_mdast_reconciled(mdast, source, options, &ReconcilerSnapshot::default());
    plan
}

pub fn project_from_mdast_reconciled(
    mdast: &markdown::mdast::Node,
    source: &str,
    options: &MarkdownProjectOptions,
    previous: &ReconcilerSnapshot,
) -> (MarkdownPlan, ReconcilerSnapshot) {
    let mut context = ProjectionContext::new(source, options, true);
    let mut root = project_node(mdast, &mut context);
    root.id = "root".to_string();

    let next_id = if let Some(previous_root) = &previous.root {
        let mut mint = IdMint::new(previous.next_id);
        reconcile_children(&mut root.children, &previous_root.children, &mut mint);
        mint.next_id
    } else {
        assign_legacy_ids(&mut root);
        1
    };

    let plan = assemble_plan(root, source, options);
    let snapshot = ReconcilerSnapshot {
        root: Some(snapshot_from_node(&plan.root)),
        next_id,
    };
    (plan, snapshot)
}

fn assemble_plan(
    mut root: ProjectedNode,
    source: &str,
    options: &MarkdownProjectOptions,
) -> MarkdownPlan {
    let mut finalization = FinalizationContext::default();
    finalize_node(&mut root, &mut finalization);

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

    MarkdownPlan {
        version: 1,
        mode: if options.islands {
            PlanMode::Mdx
        } else {
            PlanMode::Markdown
        },
        source_len: source.len(),
        root,
        blocks,
        anchors: finalization.anchors,
        isolated_regions: finalization.isolated_regions,
        text_fallback,
        measurement: MeasurementPlan {
            estimated_height,
            confidence,
            width: options.width,
        },
    }
}

pub fn project_markdown_with_options(
    source: &str,
    options: &MarkdownProjectOptions,
) -> Result<MarkdownPlan, MarkdownProjectError> {
    let (plan, _) = project_markdown_reconciled(source, options, &ReconcilerSnapshot::default())?;
    Ok(plan)
}

pub fn project_markdown_reconciled(
    source: &str,
    options: &MarkdownProjectOptions,
    previous: &ReconcilerSnapshot,
) -> Result<(MarkdownPlan, ReconcilerSnapshot), MarkdownProjectError> {
    let parse_options = parse_options(options.islands);
    let mdast =
        markdown::to_mdast(source, &parse_options).map_err(|message| MarkdownProjectError {
            message: message.reason,
        })?;
    Ok(project_from_mdast_reconciled(
        &mdast, source, options, previous,
    ))
}

fn parse_options(islands: bool) -> ParseOptions {
    let mut constructs = Constructs::gfm();
    constructs.html_flow = true;
    constructs.html_text = true;
    constructs.math_flow = true;
    constructs.math_text = true;
    if islands {
        // Flow and text both try the HTML construct before the MDX-JSX one on `<`
        // and only fall through on failure. A complete tag like `<Frog size={96} />`
        // is valid HTML, so html_flow/html_text would swallow the JSX before
        // mdx_jsx_flow/mdx_jsx_text sees it. Routing block and inline `<...>` to MDX
        // JSX requires the HTML constructs off. This is the islands-on lane only;
        // islands-off keeps them on, so plain `.md` stays byte-identical.
        constructs.mdx_jsx_flow = true;
        constructs.mdx_jsx_text = true;
        constructs.html_flow = false;
        constructs.html_text = false;
    }

    ParseOptions {
        constructs,
        ..ParseOptions::default()
    }
}

#[derive(Default)]
struct FinalizationContext {
    anchors: Vec<MarkdownAnchor>,
    isolated_regions: Vec<IsolatedRegion>,
    slug_counts: std::collections::BTreeMap<String, usize>,
}

impl FinalizationContext {
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

fn finalize_node(node: &mut ProjectedNode, context: &mut FinalizationContext) {
    if node.kind == NodeKind::Heading {
        if let Some(depth) = node.attrs.depth {
            let slug = context.unique_slug(&node.fallback.text);
            node.attrs.anchor_slug = Some(slug.clone());
            context.anchors.push(MarkdownAnchor {
                id: format!("anchor:{slug}"),
                slug,
                title: node.fallback.text.clone(),
                level: depth,
                block_id: node.id.clone(),
                span: node.span.clone(),
            });
        }
    } else {
        node.attrs.anchor_slug = None;
    }

    if node.safety.lane == SafetyLane::Isolated {
        let kind = node.attrs.isolation_kind.unwrap_or(IsolationKind::RawHtml);
        context.isolated_regions.push(IsolatedRegion {
            id: format!("isolation:{}", node.id),
            block_id: node.id.clone(),
            kind,
            reason: node.safety.reason.clone(),
            span: node.span.clone(),
            fallback_text: node.fallback.text.clone(),
        });
    }

    for child in &mut node.children {
        finalize_node(child, context);
    }
}

struct IdMint {
    next_id: u64,
}

impl IdMint {
    fn new(next_id: u64) -> Self {
        Self {
            next_id: next_id.max(1),
        }
    }

    fn mint(&mut self) -> String {
        let id = format!("node:reconciled:{}", self.next_id);
        self.next_id += 1;
        id
    }
}

fn reconcile_children(current: &mut [ProjectedNode], previous: &[SnapshotNode], mint: &mut IdMint) {
    let current_hashes = current.iter().map(content_hash).collect::<Vec<_>>();
    let current_keys = current.iter().map(structural_key).collect::<Vec<_>>();
    let mut matches = vec![None; current.len()];

    let mut current_start = 0;
    let mut previous_start = 0;
    let mut current_end = current.len();
    let mut previous_end = previous.len();

    while current_start < current_end
        && previous_start < previous_end
        && unique_eq_at(
            &current_keys,
            &current_hashes,
            previous,
            current_start,
            previous_start,
            current_start..current_end,
            previous_start..previous_end,
        )
    {
        matches[current_start] = Some(previous_start);
        current_start += 1;
        previous_start += 1;
    }

    while current_start < current_end
        && previous_start < previous_end
        && unique_eq_at(
            &current_keys,
            &current_hashes,
            previous,
            current_end - 1,
            previous_end - 1,
            current_start..current_end,
            previous_start..previous_end,
        )
    {
        current_end -= 1;
        previous_end -= 1;
        matches[current_end] = Some(previous_end);
    }

    lcs_eq_matches(
        &current_keys,
        &current_hashes,
        previous,
        current_start..current_end,
        previous_start..previous_end,
        &mut matches,
    );
    match_exact_moves(
        &current_keys,
        &current_hashes,
        previous,
        current_start..current_end,
        previous_start..previous_end,
        &mut matches,
    );
    zip_compatible_leftovers(
        &current_keys,
        previous,
        current_start..current_end,
        previous_start..previous_end,
        &mut matches,
    );

    for (current_index, previous_index) in matches.into_iter().enumerate() {
        if let Some(previous_index) = previous_index {
            let previous_node = &previous[previous_index];
            current[current_index].id = previous_node.id.clone();
            if current_hashes[current_index] == previous_node.content_hash {
                apply_snapshot_ids(&mut current[current_index], previous_node);
            } else {
                reconcile_children(
                    &mut current[current_index].children,
                    &previous_node.children,
                    mint,
                );
            }
        } else {
            assign_fresh_ids(&mut current[current_index], mint);
        }
    }
}

fn unique_eq_at(
    current_keys: &[StructuralKey],
    current_hashes: &[u64],
    previous: &[SnapshotNode],
    current_index: usize,
    previous_index: usize,
    current_range: std::ops::Range<usize>,
    previous_range: std::ops::Range<usize>,
) -> bool {
    if !eq_at(
        current_keys,
        current_hashes,
        previous,
        current_index,
        previous_index,
    ) {
        return false;
    }

    let previous_matches = previous_range
        .clone()
        .filter(|index| {
            eq_at(
                current_keys,
                current_hashes,
                previous,
                current_index,
                *index,
            )
        })
        .count();
    if previous_matches != 1 {
        return false;
    }

    current_range
        .filter(|index| {
            eq_at(
                current_keys,
                current_hashes,
                previous,
                *index,
                previous_index,
            )
        })
        .count()
        == 1
}

fn lcs_eq_matches(
    current_keys: &[StructuralKey],
    current_hashes: &[u64],
    previous: &[SnapshotNode],
    current_range: std::ops::Range<usize>,
    previous_range: std::ops::Range<usize>,
    matches: &mut [Option<usize>],
) {
    let current_len = current_range.end - current_range.start;
    let previous_len = previous_range.end - previous_range.start;
    if current_len == 0 || previous_len == 0 {
        return;
    }

    let columns = previous_len + 1;
    let mut lengths = vec![0usize; (current_len + 1) * columns];
    for current_offset in 0..current_len {
        for previous_offset in 0..previous_len {
            let current_index = current_range.start + current_offset;
            let previous_index = previous_range.start + previous_offset;
            let cell = (current_offset + 1) * columns + previous_offset + 1;
            if eq_at(
                current_keys,
                current_hashes,
                previous,
                current_index,
                previous_index,
            ) {
                lengths[cell] = lengths[current_offset * columns + previous_offset] + 1;
            } else {
                lengths[cell] = lengths[current_offset * columns + previous_offset + 1]
                    .max(lengths[(current_offset + 1) * columns + previous_offset]);
            }
        }
    }

    let mut current_offset = current_len;
    let mut previous_offset = previous_len;
    while current_offset > 0 && previous_offset > 0 {
        let current_index = current_range.start + current_offset - 1;
        let previous_index = previous_range.start + previous_offset - 1;
        let cell = current_offset * columns + previous_offset;
        let diagonal = (current_offset - 1) * columns + previous_offset - 1;
        if eq_at(
            current_keys,
            current_hashes,
            previous,
            current_index,
            previous_index,
        ) && lengths[cell] == lengths[diagonal] + 1
        {
            matches[current_index] = Some(previous_index);
            current_offset -= 1;
            previous_offset -= 1;
        } else if lengths[current_offset * columns + previous_offset - 1]
            >= lengths[(current_offset - 1) * columns + previous_offset]
        {
            previous_offset -= 1;
        } else {
            current_offset -= 1;
        }
    }
}

fn match_exact_moves(
    current_keys: &[StructuralKey],
    current_hashes: &[u64],
    previous: &[SnapshotNode],
    current_range: std::ops::Range<usize>,
    previous_range: std::ops::Range<usize>,
    matches: &mut [Option<usize>],
) {
    let mut previous_leftovers = unmatched_previous(previous.len(), matches, previous_range);
    for current_index in current_range {
        if matches[current_index].is_some() {
            continue;
        }

        if let Some(position) = previous_leftovers.iter().position(|previous_index| {
            eq_at(
                current_keys,
                current_hashes,
                previous,
                current_index,
                *previous_index,
            )
        }) {
            matches[current_index] = Some(previous_leftovers.remove(position));
        }
    }
}

fn zip_compatible_leftovers(
    current_keys: &[StructuralKey],
    previous: &[SnapshotNode],
    current_range: std::ops::Range<usize>,
    previous_range: std::ops::Range<usize>,
    matches: &mut [Option<usize>],
) {
    let current_leftovers = current_range
        .filter(|index| matches[*index].is_none())
        .collect::<Vec<_>>();
    let previous_leftovers = unmatched_previous(previous.len(), matches, previous_range);
    let front_surplus = current_leftovers
        .len()
        .saturating_sub(previous_leftovers.len());

    for (current_index, previous_index) in current_leftovers
        .iter()
        .skip(front_surplus)
        .zip(previous_leftovers.iter())
    {
        if compat_at(current_keys, previous, *current_index, *previous_index) {
            matches[*current_index] = Some(*previous_index);
        }
    }
}

fn unmatched_previous(
    previous_len: usize,
    matches: &[Option<usize>],
    previous_range: std::ops::Range<usize>,
) -> Vec<usize> {
    let mut used = vec![false; previous_len];
    for previous_index in matches.iter().flatten() {
        used[*previous_index] = true;
    }
    previous_range.filter(|index| !used[*index]).collect()
}

fn eq_at(
    current_keys: &[StructuralKey],
    current_hashes: &[u64],
    previous: &[SnapshotNode],
    current_index: usize,
    previous_index: usize,
) -> bool {
    compat_at(current_keys, previous, current_index, previous_index)
        && current_hashes[current_index] == previous[previous_index].content_hash
}

fn compat_at(
    current_keys: &[StructuralKey],
    previous: &[SnapshotNode],
    current_index: usize,
    previous_index: usize,
) -> bool {
    current_keys[current_index] == previous[previous_index].key
}

fn apply_snapshot_ids(current: &mut ProjectedNode, previous: &SnapshotNode) {
    current.id = previous.id.clone();
    for (current_child, previous_child) in current.children.iter_mut().zip(&previous.children) {
        apply_snapshot_ids(current_child, previous_child);
    }
}

fn assign_fresh_ids(node: &mut ProjectedNode, mint: &mut IdMint) {
    if node.kind == NodeKind::Root {
        node.id = "root".to_string();
    } else {
        node.id = mint.mint();
    }
    for child in &mut node.children {
        assign_fresh_ids(child, mint);
    }
}

fn assign_legacy_ids(node: &mut ProjectedNode) {
    if node.kind == NodeKind::Root {
        node.id = "root".to_string();
    } else {
        node.id = node_id(node.kind, &node.span);
    }
    for child in &mut node.children {
        assign_legacy_ids(child);
    }
}

fn snapshot_from_node(node: &ProjectedNode) -> SnapshotNode {
    SnapshotNode {
        id: node.id.clone(),
        key: structural_key(node),
        content_hash: content_hash(node),
        children: node.children.iter().map(snapshot_from_node).collect(),
    }
}

fn structural_key(node: &ProjectedNode) -> StructuralKey {
    StructuralKey {
        kind: node.kind,
        lane: node.safety.lane,
        isolation_kind: node.attrs.isolation_kind,
        isolation_tag: node.attrs.isolation_tag.clone(),
        island_tag: node.attrs.island_tag.clone(),
        island_inline: node.attrs.island_inline,
    }
}

fn content_hash(node: &ProjectedNode) -> u64 {
    let mut hasher = StableHasher::new();
    hasher.write_str("node");
    hasher.write_str(node_kind_label(node.kind));
    hasher.write_str(safety_lane_label(node.safety.lane));
    hasher.write_option_str(node.attrs.isolation_tag.as_deref());
    hasher.write_option_str(node.attrs.island_tag.as_deref());
    hasher.write_bool(node.attrs.island_inline);
    hasher.write_option_str(node.attrs.isolation_kind.map(isolation_kind_label));
    hasher.write_str(&node.safety.reason);
    hash_attrs(&mut hasher, &node.attrs);
    hasher.write_usize(node.children.len());
    if node.children.is_empty() {
        hasher.write_str(&node.fallback.copy_text);
    }
    for child in &node.children {
        hasher.write_u64(content_hash(child));
    }
    hasher.finish()
}

fn hash_attrs(hasher: &mut StableHasher, attrs: &NodeAttrs) {
    hasher.write_option_u8(attrs.depth);
    hasher.write_option_bool(attrs.ordered);
    hasher.write_option_u32(attrs.start);
    hasher.write_option_bool(attrs.spread);
    hasher.write_option_bool(attrs.checked);
    hasher.write_option_str(attrs.lang.as_deref());
    hasher.write_option_str(attrs.meta.as_deref());
    hasher.write_option_str(attrs.url.as_deref());
    hasher.write_option_str(attrs.title.as_deref());
    hasher.write_option_str(attrs.alt.as_deref());
    hasher.write_option_str(attrs.identifier.as_deref());
    hasher.write_option_str(attrs.label.as_deref());
    hasher.write_usize(attrs.align.len());
    for align in &attrs.align {
        hasher.write_str(table_align_label(*align));
    }
}

struct StableHasher {
    hash: u64,
}

impl StableHasher {
    fn new() -> Self {
        Self {
            hash: 0xcbf29ce484222325,
        }
    }

    fn finish(self) -> u64 {
        self.hash
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.hash ^= u64::from(*byte);
            self.hash = self.hash.wrapping_mul(0x100000001b3);
        }
    }

    fn write_str(&mut self, value: &str) {
        self.write_usize(value.len());
        self.write_bytes(value.as_bytes());
    }

    fn write_bool(&mut self, value: bool) {
        self.write_bytes(&[u8::from(value)]);
    }

    fn write_u64(&mut self, value: u64) {
        self.write_bytes(&value.to_le_bytes());
    }

    fn write_usize(&mut self, value: usize) {
        self.write_u64(value as u64);
    }

    fn write_u32(&mut self, value: u32) {
        self.write_bytes(&value.to_le_bytes());
    }

    fn write_u8(&mut self, value: u8) {
        self.write_bytes(&[value]);
    }

    fn write_option_str(&mut self, value: Option<&str>) {
        match value {
            Some(value) => {
                self.write_bool(true);
                self.write_str(value);
            }
            None => self.write_bool(false),
        }
    }

    fn write_option_bool(&mut self, value: Option<bool>) {
        match value {
            Some(value) => {
                self.write_bool(true);
                self.write_bool(value);
            }
            None => self.write_bool(false),
        }
    }

    fn write_option_u32(&mut self, value: Option<u32>) {
        match value {
            Some(value) => {
                self.write_bool(true);
                self.write_u32(value);
            }
            None => self.write_bool(false),
        }
    }

    fn write_option_u8(&mut self, value: Option<u8>) {
        match value {
            Some(value) => {
                self.write_bool(true);
                self.write_u8(value);
            }
            None => self.write_bool(false),
        }
    }
}

struct ProjectionContext<'a> {
    source: &'a str,
    options: &'a MarkdownProjectOptions,
    anchors: Vec<MarkdownAnchor>,
    isolated_regions: Vec<IsolatedRegion>,
    slug_counts: std::collections::BTreeMap<String, usize>,
    defer_outputs: bool,
}

impl<'a> ProjectionContext<'a> {
    fn new(source: &'a str, options: &'a MarkdownProjectOptions, defer_outputs: bool) -> Self {
        Self {
            source,
            options,
            anchors: Vec::new(),
            isolated_regions: Vec::new(),
            slug_counts: std::collections::BTreeMap::new(),
            defer_outputs,
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
            if let Some(math_source) = bare_display_tex_environment(context.source, &span) {
                kind = NodeKind::MathBlock;
                text = math_source.to_string();
                copy_text = math_source.to_string();
                children.clear();
            } else if let Some(math_source) = bracket_display_tex(context.source, &span) {
                kind = NodeKind::MathBlock;
                text = math_source.to_string();
                copy_text = math_source.to_string();
                children.clear();
            } else {
                kind = NodeKind::Paragraph;
            }
        }
        mdast::Node::Heading(heading) => {
            kind = NodeKind::Heading;
            attrs.depth = Some(heading.depth);
            if !context.defer_outputs {
                let slug = context.unique_slug(&text);
                attrs.anchor_slug = Some(slug.clone());
            }
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
            attrs.isolation_tag = html_isolation_tag(&html.value, classification);
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
        mdast::Node::MdxJsxFlowElement(element) if context.options.islands => {
            kind = NodeKind::Island;
            text = "[isolated MDX region]".to_string();
            copy_text = source_slice(context.source, &span).to_string();
            attrs.island_tag = element.name.clone();
            attrs.isolation_tag = element.name.clone();
            attrs.island_inline = false;
            attrs.isolation_kind = Some(IsolationKind::Component);
            safety = Safety {
                lane: SafetyLane::Isolated,
                reason: "isolated-mdx-island".to_string(),
            };
            children.clear();
        }
        mdast::Node::MdxJsxFlowElement(element) => {
            kind = NodeKind::Mdx;
            text = "[isolated MDX region]".to_string();
            copy_text = source_slice(context.source, &span).to_string();
            attrs.isolation_kind = Some(IsolationKind::Mdx);
            attrs.isolation_tag = element.name.clone();
            safety = Safety {
                lane: match context.options.mdx {
                    MdxMode::Disabled | MdxMode::Isolate => SafetyLane::Isolated,
                },
                reason: "mdx-compiles-to-active-js".to_string(),
            };
            children.clear();
        }
        mdast::Node::MdxJsxTextElement(element) if context.options.islands => {
            // Inline island (`<Badge/>` inside a paragraph). Mirrors the block
            // MdxJsxFlowElement island arm above, but island_inline marks it so the
            // host mounts it in flow. island_tag is part of the structural key, so a
            // `<Frog/>` -> `<Chart/>` swap replaces the id rather than aliasing it.
            kind = NodeKind::Island;
            text = "[isolated MDX region]".to_string();
            copy_text = source_slice(context.source, &span).to_string();
            attrs.island_tag = element.name.clone();
            attrs.isolation_tag = element.name.clone();
            attrs.island_inline = true;
            attrs.isolation_kind = Some(IsolationKind::Component);
            safety = Safety {
                lane: SafetyLane::Isolated,
                reason: "isolated-mdx-island".to_string(),
            };
            children.clear();
        }
        mdast::Node::MdxJsxTextElement(element) => {
            kind = NodeKind::Mdx;
            text = "[isolated MDX region]".to_string();
            copy_text = source_slice(context.source, &span).to_string();
            attrs.isolation_kind = Some(IsolationKind::Mdx);
            attrs.isolation_tag = element.name.clone();
            safety = Safety {
                lane: match context.options.mdx {
                    MdxMode::Disabled | MdxMode::Isolate => SafetyLane::Isolated,
                },
                reason: "mdx-compiles-to-active-js".to_string(),
            };
            children.clear();
        }
        mdast::Node::MdxjsEsm(_)
        | mdast::Node::MdxFlowExpression(_)
        | mdast::Node::MdxTextExpression(_) => {
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
        id: if context.defer_outputs {
            String::new()
        } else {
            node_id(kind, &span)
        },
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

    if !context.defer_outputs && projected.kind == NodeKind::Heading {
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

    if !context.defer_outputs && projected.safety.lane == SafetyLane::Isolated {
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

fn node_kind_label(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Root => "root",
        NodeKind::Paragraph => "paragraph",
        NodeKind::Heading => "heading",
        NodeKind::Blockquote => "blockquote",
        NodeKind::List => "list",
        NodeKind::ListItem => "list-item",
        NodeKind::CodeBlock => "code-block",
        NodeKind::MathBlock => "math-block",
        NodeKind::ThematicBreak => "thematic-break",
        NodeKind::Html => "html",
        NodeKind::Table => "table",
        NodeKind::TableRow => "table-row",
        NodeKind::TableCell => "table-cell",
        NodeKind::Definition => "definition",
        NodeKind::FootnoteDefinition => "footnote-definition",
        NodeKind::Text => "text",
        NodeKind::Emphasis => "emphasis",
        NodeKind::Strong => "strong",
        NodeKind::Delete => "delete",
        NodeKind::InlineCode => "inline-code",
        NodeKind::InlineMath => "inline-math",
        NodeKind::Break => "break",
        NodeKind::Link => "link",
        NodeKind::LinkReference => "link-reference",
        NodeKind::Image => "image",
        NodeKind::ImageReference => "image-reference",
        NodeKind::FootnoteReference => "footnote-reference",
        NodeKind::Mdx => "mdx",
        NodeKind::Frontmatter => "frontmatter",
        NodeKind::Island => "island",
        NodeKind::Unknown => "unknown",
    }
}

fn safety_lane_label(lane: SafetyLane) -> &'static str {
    match lane {
        SafetyLane::Host => "host",
        SafetyLane::Escaped => "escaped",
        SafetyLane::Isolated => "isolated",
    }
}

fn isolation_kind_label(kind: IsolationKind) -> &'static str {
    match kind {
        IsolationKind::RawHtml => "raw-html",
        IsolationKind::ActiveHtml => "active-html",
        IsolationKind::Mdx => "mdx",
        IsolationKind::Component => "component",
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

fn table_align(align: &mdast::AlignKind) -> TableAlign {
    match align {
        mdast::AlignKind::None => TableAlign::None,
        mdast::AlignKind::Left => TableAlign::Left,
        mdast::AlignKind::Right => TableAlign::Right,
        mdast::AlignKind::Center => TableAlign::Center,
    }
}

fn classify_html(value: &str) -> IsolationKind {
    if active_html_tag(value).is_some() {
        return IsolationKind::ActiveHtml;
    }
    if looks_like_mdx_component(value) {
        return IsolationKind::Mdx;
    }
    IsolationKind::RawHtml
}

fn html_isolation_tag(value: &str, kind: IsolationKind) -> Option<String> {
    match kind {
        IsolationKind::ActiveHtml => active_html_tag(value),
        IsolationKind::Mdx | IsolationKind::Component => first_html_tag(value),
        IsolationKind::RawHtml => None,
    }
}

fn active_html_tag(value: &str) -> Option<String> {
    let active = [
        "script", "style", "iframe", "object", "embed", "link", "form", "input", "button",
        "textarea", "select", "video", "audio", "canvas", "svg",
    ];
    let lower = value.to_ascii_lowercase();
    active
        .iter()
        .find(|tag| lower.contains(&format!("<{tag}")))
        .map(|tag| (*tag).to_string())
}

fn first_html_tag(value: &str) -> Option<String> {
    let trimmed = value.trim_start();
    let rest = trimmed.strip_prefix('<')?.trim_start();
    if rest.starts_with('/') || rest.starts_with('!') || rest.starts_with('?') {
        return None;
    }
    let name = rest
        .split(|character: char| character.is_whitespace() || character == '>' || character == '/')
        .next()
        .unwrap_or("");
    (!name.is_empty()).then(|| name.to_string())
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
        (IsolationKind::Component, _) => Safety {
            lane: SafetyLane::Isolated,
            reason: "isolated component region".to_string(),
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
        IsolationKind::Component => "[isolated component region]",
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
        NodeKind::Html | NodeKind::Mdx | NodeKind::Island => measured(
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
    let char_count = text.chars().count();
    (char_count / chars_per_line).max(1) + usize::from(!char_count.is_multiple_of(chars_per_line))
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_was_dash = false;
        } else if (character.is_whitespace() || character == '-')
            && !last_was_dash
            && !slug.is_empty()
        {
            slug.push('-');
            last_was_dash = true;
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

/// Recognizes a standalone bare TeX environment as MathJax's
/// `processEnvironments` does: any paragraph that is entirely
/// `\begin{X}...\end{X}` (matched name, X non-empty) routes to the host math
/// renderer. There is no environment whitelist, so `cases`, the matrix family,
/// `gather`, `multline`, `aligned`, `split`, `alignat`, and friends all render
/// because they are valid once inside math mode.
fn bare_display_tex_environment<'a>(source: &'a str, span: &SourceSpan) -> Option<&'a str> {
    let trimmed = source_slice(source, span).trim();
    let environment = tex_environment_name(trimmed)?;
    let closing = format!("\\end{{{environment}}}");
    trimmed
        .ends_with(&closing)
        .then_some(trimmed)
        .filter(|value| *value != closing)
}

/// Recognizes a standalone `\[...\]` display-math paragraph the way MathJax's
/// tex2jax does. markdown-rs treats `\[` and `\]` as backslash escapes (the `\`
/// is dropped from the parsed text), so we read the raw source span and check
/// that the paragraph is entirely a single balanced `\[...\]` block. The first
/// `\]` must be the closing delimiter; prose after it (`\[ x \] after \]`)
/// stays a paragraph because the block is not standalone.
fn bracket_display_tex<'a>(source: &'a str, span: &SourceSpan) -> Option<&'a str> {
    let trimmed = source_slice(source, span).trim();
    let after_open = trimmed.strip_prefix("\\[")?;
    // The first `\]` closes the display region.
    let close_rel = after_open.find("\\]")?;
    let inner = after_open[..close_rel].trim();
    let after_close = &after_open[close_rel + "\\]".len()..];
    // Nothing but whitespace may follow the closing `\]`.
    (!inner.is_empty() && after_close.trim().is_empty()).then_some(inner)
}

fn tex_environment_name(source: &str) -> Option<&str> {
    let rest = source.strip_prefix("\\begin{")?;
    let end = rest.find('}')?;
    let environment = &rest[..end];
    (!environment.is_empty()).then_some(environment)
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
    fn projects_bare_jupyter_tex_environments_as_math_blocks() {
        let source = [
            "\\begin{align}",
            "a^2 + b^2 &= c^2 \\\\",
            "\\sin^2(\\theta) + \\cos^2(\\theta) &= 1",
            "\\end{align}",
            "",
            "\\begin{equation*}",
            "\\left( \\sum_{k=1}^n a_k b_k \\right)^2 \\leq \\left( \\sum_{k=1}^n a_k^2 \\right) \\left( \\sum_{k=1}^n b_k^2 \\right)",
            "\\end{equation*}",
            "",
            "\\begin{array}{cc}",
            "a & b \\\\",
            "c & d",
            "\\end{array}",
        ]
        .join("\n");
        let plan = project_markdown(&source).unwrap();

        assert_eq!(plan.blocks.len(), 3);
        assert!(plan
            .blocks
            .iter()
            .all(|block| block.kind == NodeKind::MathBlock));
        assert_eq!(
            plan.blocks[0].fallback.copy_text,
            source.lines().take(4).collect::<Vec<_>>().join("\n")
        );
        assert!(plan.blocks[1]
            .fallback
            .copy_text
            .starts_with("\\begin{equation*}"));
        assert!(plan.blocks[2]
            .fallback
            .copy_text
            .starts_with("\\begin{array}{cc}"));
        assert_eq!(plan.measurement.confidence, MeasurementConfidence::Low);
    }

    #[test]
    fn keeps_mixed_tex_environment_prose_as_markdown_text() {
        let plan = project_markdown("Before \\begin{align}x&=y\\end{align} after").unwrap();

        assert_eq!(plan.blocks.len(), 1);
        assert_eq!(plan.blocks[0].kind, NodeKind::Paragraph);
        assert!(contains_kind(&plan.blocks[0], NodeKind::Text));
    }

    #[test]
    fn projects_jupyter_matrix_cases_and_family_as_math_blocks() {
        // #3834: MathJax's `processEnvironments` renders any bare
        // `\begin{X}...\end{X}` as display math, so the matrix family, `cases`,
        // `gather`, `multline`, `aligned`, and `alignat` all render without an
        // environment whitelist. KaTeX handles each once it is in math mode.
        let environments = [
            (
                "cases",
                "\\begin{cases}\nx & \\text{if } x \\ge 0 \\\\\n-x & \\text{otherwise}\n\\end{cases}",
            ),
            (
                "pmatrix",
                "\\begin{pmatrix}\n\\cos\\theta & -\\sin\\theta \\\\\n\\sin\\theta & \\cos\\theta\n\\end{pmatrix}",
            ),
            ("bmatrix", "\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}"),
            ("vmatrix", "\\begin{vmatrix}a & b \\\\ c & d\\end{vmatrix}"),
            ("matrix", "\\begin{matrix}a & b \\\\ c & d\\end{matrix}"),
            ("gather", "\\begin{gather}a = b \\\\ c = d\\end{gather}"),
            ("multline", "\\begin{multline}a \\\\ b\\end{multline}"),
            ("aligned", "\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}"),
            ("alignat", "\\begin{alignat}{2}a &= b \\\\ c &= d\\end{alignat}"),
        ];

        for (name, source) in environments {
            let plan = project_markdown(source).unwrap_or_else(|_| panic!("{name} projected"));
            assert_eq!(plan.blocks.len(), 1, "{name} produced one block");
            assert_eq!(plan.blocks[0].kind, NodeKind::MathBlock, "{name} is math");
            assert_eq!(
                plan.blocks[0].fallback.copy_text, source,
                "{name} text intact"
            );
        }
    }

    #[test]
    fn projects_unknown_tex_environment_as_math_for_mathjax_parity() {
        // MathJax does not keep an environment whitelist; any balanced bare
        // environment routes to the renderer. This documents that intentional
        // widening from the #3377 curated set.
        let plan = project_markdown("\\begin{notreal}\nbody\n\\end{notreal}").unwrap();

        assert_eq!(plan.blocks.len(), 1);
        assert_eq!(plan.blocks[0].kind, NodeKind::MathBlock);
        assert_eq!(
            plan.blocks[0].fallback.copy_text,
            "\\begin{notreal}\nbody\n\\end{notreal}"
        );
    }

    #[test]
    fn projects_display_bracket_tex_delimiters() {
        // #3834: a standalone `\[...\]` block routes to the host math renderer
        // the way MathJax's tex2jax handles it. markdown-rs treats `\[` / `\]`
        // as backslash escapes (the `\` is dropped from the parsed text), so we
        // recover the inner LaTeX from the raw source span. Inline `\(...\)` is
        // intentionally out of scope — see issue #3834.
        let display = project_markdown("\\[\nx = y\nz = w\n\\]").unwrap();
        assert_eq!(display.blocks.len(), 1);
        assert_eq!(display.blocks[0].kind, NodeKind::MathBlock);
        assert_eq!(display.blocks[0].fallback.text, "x = y\nz = w");
    }

    #[test]
    fn keeps_mixed_bracket_tex_delimiters_as_prose() {
        // The #3377 constraint: mixed inline prose stays normal text even with
        // the new delimiter. `before \[ x \] after` is not a standalone block.
        let bracket = project_markdown("before \\[ x \\] after on one line").unwrap();
        assert_eq!(bracket.blocks.len(), 1);
        assert_eq!(bracket.blocks[0].kind, NodeKind::Paragraph);
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

    #[test]
    fn islands_option_projects_block_jsx_as_island() {
        let options = MarkdownProjectOptions {
            islands: true,
            ..Default::default()
        };
        let plan = project_markdown_with_options("<Frog size={96} />\n", &options).unwrap();
        assert_eq!(plan.version, 1);
        assert_eq!(plan.mode, PlanMode::Mdx);
        let island = plan
            .blocks
            .iter()
            .find(|block| block.kind == NodeKind::Island)
            .expect("expected an Island node");
        assert_eq!(island.attrs.island_tag.as_deref(), Some("Frog"));
        assert_eq!(island.attrs.isolation_kind, Some(IsolationKind::Component));
    }

    #[test]
    fn islands_off_leaves_block_jsx_non_island() {
        let options = MarkdownProjectOptions {
            islands: false,
            ..Default::default()
        };
        let plan = project_markdown_with_options("<Frog size={96} />\n", &options).unwrap();
        assert_eq!(plan.version, 1);
        assert_eq!(plan.mode, PlanMode::Markdown);
        assert!(plan
            .blocks
            .iter()
            .all(|block| block.kind != NodeKind::Island));
    }

    #[test]
    fn islands_option_projects_inline_jsx_as_inline_island() {
        let options = MarkdownProjectOptions {
            islands: true,
            ..Default::default()
        };
        let plan = project_markdown_with_options("Text with <Frog /> after.\n", &options).unwrap();
        assert_eq!(plan.mode, PlanMode::Mdx);
        let paragraph = plan
            .blocks
            .iter()
            .find(|block| block.kind == NodeKind::Paragraph)
            .expect("expected a paragraph block");
        let island = paragraph
            .children
            .iter()
            .find(|child| child.kind == NodeKind::Island)
            .expect("expected an inline Island child inside the paragraph");
        assert_eq!(island.attrs.island_tag.as_deref(), Some("Frog"));
        assert!(island.attrs.island_inline);
        assert_eq!(island.attrs.isolation_kind, Some(IsolationKind::Component));
    }

    #[test]
    fn islands_off_leaves_inline_jsx_non_island() {
        let plan = project_markdown_with_options(
            "Text with <Frog /> after.\n",
            &MarkdownProjectOptions::default(),
        )
        .unwrap();
        assert_eq!(plan.mode, PlanMode::Markdown);
        let paragraph = plan
            .blocks
            .iter()
            .find(|block| block.kind == NodeKind::Paragraph)
            .expect("expected a paragraph block");
        assert!(paragraph
            .children
            .iter()
            .all(|child| child.kind != NodeKind::Island));
    }

    #[test]
    fn reconciler_insert_above_keeps_following_ids() {
        let (before, snapshot) = reconcile_default("alpha\n\nbeta\n");
        let alpha_id = before.blocks[0].id.clone();
        let beta_id = before.blocks[1].id.clone();

        let (after, _) =
            reconcile_default_with_snapshot("intro\n\nalpha edited\n\nbeta\n", &snapshot);

        assert!(after.blocks[0].id.starts_with("node:reconciled:"));
        assert_ne!(after.blocks[0].id, alpha_id);
        assert_eq!(after.blocks[1].id, alpha_id);
        assert_ne!(after.blocks[1].span.end, before.blocks[0].span.end);
        assert_eq!(after.blocks[2].id, beta_id);
    }

    #[test]
    fn reconciler_insert_above_with_duplicates_no_misassign() {
        let source = "## Notes\n\n---\n\n## Notes\n\n---\n";
        let (before, snapshot) = reconcile_default(source);
        let before_ids = before
            .blocks
            .iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();

        let (after, _) =
            reconcile_default_with_snapshot(&format!("## Notes\n\n---\n\n{source}"), &snapshot);

        assert_eq!(after.blocks.len(), 6);
        assert!(!before_ids.contains(&after.blocks[0].id));
        assert!(!before_ids.contains(&after.blocks[1].id));
        assert_eq!(after.blocks[2].id, before_ids[0]);
        assert_eq!(after.blocks[3].id, before_ids[1]);
        assert_eq!(after.blocks[4].id, before_ids[2]);
        assert_eq!(after.blocks[5].id, before_ids[3]);
    }

    #[test]
    fn reconciler_edit_inside_keeps_id_and_changes_hash() {
        let (before, snapshot) = reconcile_default("alpha *cat* beta\n");
        let block_id = before.blocks[0].id.clone();
        let before_hash = snapshot_hash(&snapshot, &block_id);

        let (after, next_snapshot) =
            reconcile_default_with_snapshot("alpha *kitten* beta\n", &snapshot);
        let after_hash = snapshot_hash(&next_snapshot, &block_id);

        assert_eq!(after.blocks[0].id, block_id);
        assert_ne!(after.blocks[0].span.end, before.blocks[0].span.end);
        assert_ne!(after_hash, before_hash);
    }

    #[test]
    fn reconciler_reorder_keeps_moved_block_id() {
        let (before, snapshot) = reconcile_default("alpha\n\nbeta\n\ngamma\n");
        let alpha_id = before.blocks[0].id.clone();
        let beta_id = before.blocks[1].id.clone();
        let gamma_id = before.blocks[2].id.clone();

        let (after, _) = reconcile_default_with_snapshot("beta\n\nalpha\n\ngamma\n", &snapshot);

        assert_eq!(after.blocks[0].id, beta_id);
        assert_eq!(after.blocks[1].id, alpha_id);
        assert_eq!(after.blocks[2].id, gamma_id);
    }

    #[test]
    fn reconciler_snapshot_round_trips_through_bytes() {
        let (_, snapshot) = reconcile_default("# Title\n\nalpha *beta*\n\n---\n");

        let restored = ReconcilerSnapshot::from_bytes(&snapshot.to_bytes());

        assert_eq!(restored, snapshot);
    }

    #[test]
    fn reconciler_snapshot_bytes_preserve_shifted_block_ids() {
        let source = "alpha\n\nbeta\n\ngamma\n";
        let (before, snapshot) = reconcile_default(source);
        let before_ids = before
            .blocks
            .iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        let restored = ReconcilerSnapshot::from_bytes(&snapshot.to_bytes());

        let (after, _) =
            reconcile_default_with_snapshot("intro\n\nalpha\n\nbeta\n\ngamma\n", &restored);

        assert_eq!(after.blocks.len(), 4);
        assert!(after.blocks[0].id.starts_with("node:reconciled:"));
        assert_eq!(after.blocks[1].id, before_ids[0]);
        assert_eq!(after.blocks[2].id, before_ids[1]);
        assert_eq!(after.blocks[3].id, before_ids[2]);
    }

    #[test]
    fn reconciler_snapshot_from_bytes_falls_back_to_cold_start() {
        let source = "alpha\n\nbeta\n";
        let empty = ReconcilerSnapshot::from_bytes(&[]);
        let garbage = ReconcilerSnapshot::from_bytes(b"not json");

        assert_eq!(empty, ReconcilerSnapshot::default());
        assert_eq!(garbage, ReconcilerSnapshot::default());

        let (from_empty, _) = reconcile_default_with_snapshot(source, &empty);
        let (from_garbage, _) = reconcile_default_with_snapshot(source, &garbage);

        assert_legacy_ids(&from_empty.root);
        assert_legacy_ids(&from_garbage.root);
    }

    #[test]
    fn reconciler_replace_cross_kind_gets_fresh_id() {
        let (before, snapshot) = reconcile_default("alpha\n");
        let old_id = before.blocks[0].id.clone();

        let (after, _) = reconcile_default_with_snapshot("## alpha\n", &snapshot);
        let after_ids = collect_projected_ids(&after.root);

        assert!(after.blocks[0].id.starts_with("node:reconciled:"));
        assert!(!after_ids.contains(&old_id));
    }

    #[test]
    fn reconciler_lane_flip_deliberate_remount() {
        let source = "<div>wow</div>\n";
        let escaped = MarkdownProjectOptions {
            raw_html: RawHtmlMode::Escape,
            ..Default::default()
        };
        let isolated = MarkdownProjectOptions {
            raw_html: RawHtmlMode::Isolate,
            ..Default::default()
        };
        let (before, snapshot) =
            project_markdown_reconciled(source, &escaped, &ReconcilerSnapshot::default()).unwrap();
        let (after, _) = project_markdown_reconciled(source, &isolated, &snapshot).unwrap();

        assert_eq!(before.blocks[0].safety.lane, SafetyLane::Escaped);
        assert_eq!(after.blocks[0].safety.lane, SafetyLane::Isolated);
        assert_ne!(after.blocks[0].id, before.blocks[0].id);
        assert_eq!(after.isolated_regions[0].block_id, after.blocks[0].id);
    }

    #[test]
    fn reconciler_offset_decoupling_keeps_shifted_ids() {
        let (before, snapshot) = reconcile_default("beta with *cat*\n");
        let block_id = before.blocks[0].id.clone();
        let emphasis_id = find_kind(&before.blocks[0], NodeKind::Emphasis)
            .unwrap()
            .id
            .clone();
        let emphasis_start = find_kind(&before.blocks[0], NodeKind::Emphasis)
            .unwrap()
            .span
            .start;

        let (after, _) = reconcile_default_with_snapshot("intro\n\nbeta with *cat*\n", &snapshot);
        let after_emphasis = find_kind(&after.blocks[1], NodeKind::Emphasis).unwrap();

        assert_eq!(after.blocks[1].id, block_id);
        assert_ne!(after.blocks[1].span.start, before.blocks[0].span.start);
        assert_eq!(after_emphasis.id, emphasis_id);
        assert_ne!(after_emphasis.span.start, emphasis_start);
    }

    #[test]
    fn reconciler_active_html_tag_swap_remounts() {
        let (before, snapshot) = reconcile_default("<video></video>\n");
        let (after, _) = reconcile_default_with_snapshot("<iframe></iframe>\n", &snapshot);
        let before_html = find_kind(&before.blocks[0], NodeKind::Html).unwrap();
        let after_html = find_kind(&after.blocks[0], NodeKind::Html).unwrap();

        assert_eq!(before_html.attrs.isolation_tag.as_deref(), Some("video"));
        assert_eq!(after_html.attrs.isolation_tag.as_deref(), Some("iframe"));
        assert_ne!(after_html.id, before_html.id);
    }

    #[test]
    fn reconciler_island_component_swap_remounts() {
        let options = MarkdownProjectOptions {
            islands: true,
            ..Default::default()
        };
        let (before, snapshot) =
            project_markdown_reconciled("<Frog />\n", &options, &ReconcilerSnapshot::default())
                .unwrap();
        let (after, _) = project_markdown_reconciled("<Chart />\n", &options, &snapshot).unwrap();

        assert_eq!(before.blocks[0].attrs.island_tag.as_deref(), Some("Frog"));
        assert_eq!(after.blocks[0].attrs.island_tag.as_deref(), Some("Chart"));
        // A different component at the same slot mints a fresh id instead of
        // aliasing onto Frog's id.
        assert_ne!(after.blocks[0].id, before.blocks[0].id);
        assert!(after.blocks[0].id.starts_with("node:reconciled:"));
    }

    #[test]
    fn stateless_entry_points_keep_legacy_offset_ids() {
        let source = "# Title\n\nalpha <i>wow</i> $x$\n\n---\n\n<iframe src=\"https://example.com\"></iframe>\n";
        let options = MarkdownProjectOptions::default();
        let mdast = markdown::to_mdast(source, &parse_options(options.islands)).unwrap();
        let from_markdown = project_markdown(source).unwrap();
        let from_options = project_markdown_with_options(source, &options).unwrap();
        let from_mdast = project_from_mdast(&mdast, source, &options);

        assert_eq!(from_markdown, from_options);
        assert_eq!(from_markdown, from_mdast);
        assert_legacy_ids(&from_markdown.root);
        assert_eq!(
            from_markdown.anchors[0].block_id,
            from_markdown.blocks[0].id
        );
        assert_eq!(
            from_markdown.isolated_regions[0].id,
            format!("isolation:{}", from_markdown.isolated_regions[0].block_id)
        );
        assert_eq!(
            render_plan_json(&from_markdown, source, "rust-wasm"),
            render_plan_json(&from_mdast, source, "rust-wasm")
        );

        let island_options = MarkdownProjectOptions {
            islands: true,
            ..Default::default()
        };
        let island =
            project_markdown_with_options("<Frog size={96} />\n", &island_options).unwrap();
        assert_legacy_ids(&island.root);
        assert_eq!(island.blocks[0].attrs.island_tag.as_deref(), Some("Frog"));
    }

    fn reconcile_default(source: &str) -> (MarkdownPlan, ReconcilerSnapshot) {
        reconcile_default_with_snapshot(source, &ReconcilerSnapshot::default())
    }

    fn reconcile_default_with_snapshot(
        source: &str,
        snapshot: &ReconcilerSnapshot,
    ) -> (MarkdownPlan, ReconcilerSnapshot) {
        project_markdown_reconciled(source, &MarkdownProjectOptions::default(), snapshot).unwrap()
    }

    fn snapshot_hash(snapshot: &ReconcilerSnapshot, id: &str) -> u64 {
        find_snapshot(snapshot.root.as_ref().unwrap(), id)
            .map(|node| node.content_hash)
            .unwrap()
    }

    fn find_snapshot<'a>(node: &'a SnapshotNode, id: &str) -> Option<&'a SnapshotNode> {
        if node.id == id {
            return Some(node);
        }
        node.children
            .iter()
            .find_map(|child| find_snapshot(child, id))
    }

    fn collect_projected_ids(node: &ProjectedNode) -> Vec<String> {
        let mut ids = vec![node.id.clone()];
        for child in &node.children {
            ids.extend(collect_projected_ids(child));
        }
        ids
    }

    fn assert_legacy_ids(node: &ProjectedNode) {
        if node.kind == NodeKind::Root {
            assert_eq!(node.id, "root");
        } else {
            assert_eq!(node.id, node_id(node.kind, &node.span));
        }
        for child in &node.children {
            assert_legacy_ids(child);
        }
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
