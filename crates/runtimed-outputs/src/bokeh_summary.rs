//! `text/llm+plain` summaries of Bokeh/Panel document sessions.
//!
//! A live session is read from its `BokehSessionDoc` snapshot; a saved or
//! frozen output from the Bokeh DocJson in its session payload. Both are
//! normalized into one model graph, then rendered as widgets (with the ids
//! `set_bokeh_property` accepts), text, plots, data sources and tables, with
//! layouts collapsed and every section capped.

use std::collections::{BTreeMap, HashSet};

use base64::Engine as _;
use runtime_doc::{BokehBlobRef, BokehSessionSnapshot, BokehSessionStatus};
use serde_json::{json, Value};

use crate::output_resolver::{resolve_content_ref, LiveOutputView, PayloadSummarizer, ResolveCtx};
use crate::resolved_output::DataValue;

pub use runtime_doc::BOKEH_SESSION_MIME;

const MAX_WIDGETS: usize = 40;
const MAX_TEXTS: usize = 12;
const MAX_PLOTS: usize = 10;
const MAX_SOURCES: usize = 10;
const MAX_TABLES: usize = 10;
const MAX_COLUMNS: usize = 12;
const MAX_OPTIONS: usize = 8;
const SUMMARY_MAX_CHARS: usize = 6000;
/// Blob-backed values worth fetching for display; larger ones are named only.
const MAX_PROP_BLOB_BYTES: u64 = 64 * 1024;
/// Column refs carry no length, so rows are counted by fetching a column;
/// sources whose columns are all larger are listed as not counted.
const MAX_COLUMN_BLOB_BYTES: u64 = 256 * 1024;

/// Props a summary displays; only these are fetched when blob-backed.
const DISPLAY_PROPS: &[&str] = &[
    "value",
    "options",
    "labels",
    "title",
    "label",
    "name",
    "text",
    "object",
    "axis_label",
];

/// Widget properties that may be absent because they hold their default.
const DEFAULTED_PROPS: &[&str] = &[
    "value",
    "value_input",
    "value_throttled",
    "active",
    "disabled",
    "visible",
    "label",
    "title",
    "placeholder",
    "start",
    "end",
    "step",
    "low",
    "high",
    "options",
    "text",
    "object",
];

/// Live state of one session output, keyed by output id in
/// [`ResolveCtx::live_views`].
#[derive(Debug, Clone)]
pub struct BokehSessionView {
    pub session_id: String,
    pub status: BokehSessionStatus,
    pub epoch: u64,
    /// `None` when the session document could not be synced; the summary
    /// then falls back to the output's saved document.
    pub snapshot: Option<BokehSessionSnapshot>,
    /// Rows per data source, counted from its smallest column when that is
    /// small enough to fetch.
    pub source_rows: BTreeMap<String, usize>,
}

/// A model `set_bokeh_property` should write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BokehTarget {
    pub model_id: String,
    pub kind: String,
    pub label: Option<String>,
    /// Values must never be echoed (password inputs).
    pub secret: bool,
}

pub fn status_label(status: BokehSessionStatus) -> &'static str {
    match status {
        BokehSessionStatus::Connected => "connected",
        BokehSessionStatus::Disconnected => "disconnected",
        BokehSessionStatus::Closed => "closed",
        BokehSessionStatus::Error => "error",
    }
}

// ── Preparing a live view ───────────────────────────────────────────────

/// Build a view, fetching blob-backed display values and counting rows.
pub async fn prepare_bokeh_view(
    session_id: &str,
    status: BokehSessionStatus,
    epoch: u64,
    snapshot: Option<BokehSessionSnapshot>,
    ctx: ResolveCtx<'_>,
) -> BokehSessionView {
    let mut view = BokehSessionView {
        session_id: session_id.to_string(),
        status,
        epoch,
        snapshot,
        source_rows: BTreeMap::new(),
    };
    let Some(snapshot) = view.snapshot.as_mut() else {
        return view;
    };
    for model in snapshot.models.values_mut() {
        for (name, encoded) in model.props.iter_mut() {
            if !DISPLAY_PROPS.contains(&name.as_str()) {
                continue;
            }
            let Some(blob) = BokehBlobRef::parse(encoded) else {
                continue;
            };
            if blob.size <= MAX_PROP_BLOB_BYTES {
                if let Some(text) = fetch_blob_text(&blob.blob, ctx).await {
                    *encoded = text;
                }
            }
        }
    }
    for (source_id, columns) in snapshot.columns.iter().take(MAX_SOURCES) {
        // Columns of a source share a length, so the cheapest one will do.
        let Some(column) = columns
            .values()
            .filter(|column| column.size <= MAX_COLUMN_BLOB_BYTES)
            .min_by_key(|column| column.size)
        else {
            continue;
        };
        let rows = fetch_blob_text(&column.blob, ctx)
            .await
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| column_length(&value));
        if let Some(rows) = rows {
            view.source_rows.insert(source_id.clone(), rows);
        }
    }
    view
}

async fn fetch_blob_text(hash: &str, ctx: ResolveCtx<'_>) -> Option<String> {
    let blob_base_url = ctx.blob_base_url.map(String::from);
    let blob_store_path = ctx.blob_store_path.map(|path| path.to_path_buf());
    match resolve_content_ref(
        &json!({ "blob": hash }),
        &blob_base_url,
        &blob_store_path,
        Some("text/plain"),
    )
    .await?
    {
        DataValue::Text(text) => Some(text),
        _ => None,
    }
}

// ── Model graph ─────────────────────────────────────────────────────────

struct Node {
    type_name: String,
    /// Bokeh-encoded values; references are `{"id": ...}`.
    props: BTreeMap<String, Value>,
}

struct Source {
    columns: Vec<String>,
    rows: Option<usize>,
    /// A live source whose columns were too large to fetch (or unreadable),
    /// so a missing count is not mistaken for an empty source.
    rows_skipped: bool,
}

#[derive(Default)]
struct Graph {
    roots: Vec<String>,
    models: BTreeMap<String, Node>,
    sources: BTreeMap<String, Source>,
}

fn decode_prop(encoded: &str) -> Value {
    match BokehBlobRef::parse(encoded) {
        Some(blob) => json!({ "$large": blob.size }),
        None => serde_json::from_str(encoded).unwrap_or_else(|_| Value::String(encoded.into())),
    }
}

fn graph_from_snapshot(
    snapshot: &BokehSessionSnapshot,
    source_rows: &BTreeMap<String, usize>,
) -> Graph {
    let models = snapshot
        .models
        .iter()
        .map(|(id, model)| {
            let props = model
                .props
                .iter()
                .map(|(name, encoded)| (name.clone(), decode_prop(encoded)))
                .collect();
            (
                id.clone(),
                Node {
                    type_name: model.type_name.clone(),
                    props,
                },
            )
        })
        .collect();
    let sources = snapshot
        .columns
        .iter()
        .map(|(id, columns)| {
            (
                id.clone(),
                Source {
                    columns: columns.keys().cloned().collect(),
                    rows: source_rows.get(id).copied(),
                    rows_skipped: !columns.is_empty() && !source_rows.contains_key(id),
                },
            )
        })
        .collect();
    Graph {
        roots: snapshot.meta.root_ids.clone(),
        models,
        sources,
    }
}

/// Graph of a Bokeh DocJson, whose models are defined inline at their first
/// reference.
fn graph_from_doc_json(doc: &Value) -> Option<Graph> {
    let roots = doc.get("roots")?.as_array()?;
    let mut graph = Graph::default();
    for root in roots {
        flatten(root, &mut graph);
        if let Some(id) = root.get("id").and_then(Value::as_str) {
            graph.roots.push(id.to_string());
        }
    }
    Some(graph)
}

/// Register inline model definitions and replace them by references.
fn flatten(value: &Value, graph: &mut Graph) -> Value {
    match value {
        Value::Object(map) => {
            let is_model = map.get("type").and_then(Value::as_str) == Some("object");
            if let (true, Some(id), Some(name)) = (
                is_model,
                map.get("id").and_then(Value::as_str),
                map.get("name").and_then(Value::as_str),
            ) {
                if !graph.models.contains_key(id) {
                    // Reserve the id first so cycles terminate.
                    graph.models.insert(
                        id.to_string(),
                        Node {
                            type_name: name.to_string(),
                            props: BTreeMap::new(),
                        },
                    );
                    let mut props = BTreeMap::new();
                    if let Some(Value::Object(attributes)) = map.get("attributes") {
                        for (key, attribute) in attributes {
                            if key == "data" && is_data_source(name) {
                                graph
                                    .sources
                                    .insert(id.to_string(), source_from_data(attribute));
                                continue;
                            }
                            props.insert(key.clone(), flatten(attribute, graph));
                        }
                    }
                    if let Some(node) = graph.models.get_mut(id) {
                        node.props = props;
                    }
                }
                return json!({ "id": id });
            }
            Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), flatten(value, graph)))
                    .collect(),
            )
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| flatten(item, graph)).collect())
        }
        other => other.clone(),
    }
}

fn source_from_data(data: &Value) -> Source {
    let entries = map_entries(data);
    Source {
        columns: entries.iter().map(|(name, _)| name.clone()).collect(),
        rows: entries
            .first()
            .and_then(|(_, column)| column_length(column)),
        rows_skipped: false,
    }
}

/// Entries of a plain object or Bokeh's `{"type": "map", "entries": ...}`.
fn map_entries(value: &Value) -> Vec<(String, &Value)> {
    if value.get("type").and_then(Value::as_str) == Some("map") {
        return value
            .get("entries")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let pair = entry.as_array()?;
                        let key = match pair.first()? {
                            Value::String(key) => key.clone(),
                            other => other.to_string(),
                        };
                        Some((key, pair.get(1)?))
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        _ => Vec::new(),
    }
}

/// Length of one Bokeh-encoded column.
fn column_length(value: &Value) -> Option<usize> {
    match value {
        Value::Array(items) => Some(items.len()),
        Value::Object(map) => {
            if let Some(first) = map
                .get("shape")
                .and_then(Value::as_array)
                .and_then(|shape| shape.first())
                .and_then(Value::as_u64)
            {
                return Some(first as usize);
            }
            match map.get("array") {
                Some(Value::Array(items)) => Some(items.len()),
                Some(bytes) => {
                    let data = bytes.get("data")?.as_str()?;
                    let size = match map.get("dtype").and_then(Value::as_str)? {
                        "int8" | "uint8" | "bool" => 1,
                        "int16" | "uint16" => 2,
                        "int32" | "uint32" | "float32" => 4,
                        _ => 8,
                    };
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .ok()?;
                    Some(uncompressed_len(&decoded) / size)
                }
                None => None,
            }
        }
        _ => None,
    }
}

/// Bokeh 3.8+ gzips inlined buffers; the gzip trailer's ISIZE field gives
/// the original length without decompressing.
fn uncompressed_len(decoded: &[u8]) -> usize {
    match decoded {
        [0x1f, 0x8b, .., a, b, c, d] if decoded.len() >= 18 => {
            u32::from_le_bytes([*a, *b, *c, *d]) as usize
        }
        _ => decoded.len(),
    }
}

// ── Classification ──────────────────────────────────────────────────────

fn base_name(type_name: &str) -> &str {
    type_name.rsplit('.').next().unwrap_or(type_name)
}

fn is_data_source(type_name: &str) -> bool {
    matches!(
        base_name(type_name),
        "ColumnDataSource"
            | "AjaxDataSource"
            | "ServerSentDataSource"
            | "WebDataSource"
            | "GeoJSONDataSource"
    )
}

const LAYOUTS: &[&str] = &[
    "Column",
    "Row",
    "FlexBox",
    "GridBox",
    "GridPlot",
    "GridStack",
    "Tabs",
    "TabPanel",
    "Card",
    "Accordion",
    "Page",
    "Paper",
    "Container",
    "Grid",
    "Box",
    "Spacer",
    "VSpacer",
    "HSpacer",
    "Divider",
    "Drawer",
    "Dialog",
    "Modal",
    "Feed",
    "Swipe",
    "Stack",
    "ScrollButton",
    "Template",
];

const TEXTS: &[&str] = &[
    "Div",
    "Paragraph",
    "PreText",
    "HTML",
    "Markdown",
    "Typography",
    "Alert",
    "Str",
    "LaTeX",
    "MathJax",
    "KaTeX",
    "Number",
    "String",
];

const PLOTS: &[&str] = &["Figure", "figure", "Plot", "GMap", "GMapPlot"];

const TABLES: &[&str] = &["DataTable", "DataTabulator", "Tabulator", "DataCube"];

const WIDGET_SUFFIXES: &[&str] = &[
    "Slider", "Input", "Picker", "Select", "Choice", "Button", "Toggle", "Checkbox", "Switch",
    "Spinner", "Group", "Progress", "Rating", "Selector", "Area",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Category {
    Widget,
    Text,
    Plot,
    Table,
    Layout,
    Other,
}

/// One displayed component. ESM components (panel-material-ui) keep their
/// values on a separate data model, which is the id writes go to.
struct Component<'a> {
    id: &'a str,
    kind: String,
    props: &'a BTreeMap<String, Value>,
    category: Category,
}

fn ref_id(value: &Value) -> Option<&str> {
    let map = value.as_object()?;
    if map.len() != 1 {
        return None;
    }
    map.get("id")?.as_str()
}

fn collect_refs<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    if let Some(id) = ref_id(value) {
        out.push(id);
        return;
    }
    match value {
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, out)),
        Value::Object(map) => map.values().for_each(|item| collect_refs(item, out)),
        _ => {}
    }
}

fn str_prop<'a>(props: &'a BTreeMap<String, Value>, name: &str) -> Option<&'a str> {
    props.get(name)?.as_str()
}

impl Graph {
    /// The data model of an ESM component, if `id` is one.
    fn esm_data(&self, node: &Node) -> Option<(&str, &Node)> {
        if !(node.props.contains_key("esm") || node.props.contains_key("class_name")) {
            return None;
        }
        let data_id = node.props.get("data").and_then(ref_id)?;
        self.models
            .get_key_value(data_id)
            .map(|(id, node)| (id.as_str(), node))
    }

    fn component<'a>(&'a self, id: &'a str, node: &'a Node) -> Component<'a> {
        let (id, kind, props) = match self.esm_data(node) {
            Some((data_id, data)) => {
                let kind = str_prop(&node.props, "class_name")
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        base_name(&data.type_name)
                            .trim_end_matches(|c: char| c.is_ascii_digit())
                            .to_string()
                    });
                (data_id, kind, &data.props)
            }
            None => (id, base_name(&node.type_name).to_string(), &node.props),
        };
        let category = categorize(&kind, props, self.sources.contains_key(id));
        Component {
            id,
            kind,
            props,
            category,
        }
    }

    /// Displayable components in page order: depth first from the roots,
    /// then anything unreachable.
    fn components(&self) -> Vec<Component<'_>> {
        let mut seen = HashSet::new();
        let mut data_models = HashSet::new();
        for node in self.models.values() {
            if let Some((data_id, _)) = self.esm_data(node) {
                data_models.insert(data_id);
            }
        }
        let mut order = Vec::new();
        let mut stack: Vec<&str> = self.roots.iter().rev().map(String::as_str).collect();
        while let Some(id) = stack.pop() {
            let Some((id, node)) = self.models.get_key_value(id) else {
                continue;
            };
            if !seen.insert(id.as_str()) {
                continue;
            }
            if !data_models.contains(id.as_str()) {
                order.push(id.as_str());
            }
            let mut refs = Vec::new();
            for value in node.props.values() {
                collect_refs(value, &mut refs);
            }
            if let Some((_, data)) = self.esm_data(node) {
                for value in data.props.values() {
                    collect_refs(value, &mut refs);
                }
            }
            stack.extend(refs.into_iter().rev());
        }
        for id in self.models.keys() {
            if !seen.contains(id.as_str()) && !data_models.contains(id.as_str()) {
                order.push(id.as_str());
            }
        }
        order
            .into_iter()
            .map(|id| self.component(id, &self.models[id]))
            .collect()
    }

    fn is_secret(&self, id: &str) -> bool {
        if self
            .models
            .get(id)
            .is_some_and(|node| node.type_name.contains("Password"))
        {
            return true;
        }
        self.models.values().any(|node| {
            self.esm_data(node)
                .is_some_and(|(data_id, _)| data_id == id)
                && str_prop(&node.props, "class_name").is_some_and(|kind| kind.contains("Password"))
        })
    }
}

fn categorize(kind: &str, props: &BTreeMap<String, Value>, is_source: bool) -> Category {
    if is_source || is_data_source(kind) {
        return Category::Other;
    }
    if PLOTS.contains(&kind) {
        return Category::Plot;
    }
    if TABLES.contains(&kind) {
        return Category::Table;
    }
    if TEXTS.contains(&kind) {
        return Category::Text;
    }
    if LAYOUTS.contains(&kind) {
        return Category::Layout;
    }
    if kind.contains("Password")
        || (!kind.ends_with("Editor") && WIDGET_SUFFIXES.iter().any(|s| kind.ends_with(s)))
    {
        return Category::Widget;
    }
    let labelled = ["title", "label"]
        .iter()
        .any(|key| props.contains_key(*key));
    if labelled && (props.contains_key("value") || props.contains_key("active")) {
        return Category::Widget;
    }
    Category::Other
}

/// The model to write for `model` (an id, unique id prefix, or a widget's
/// label, title or name) and `property`.
pub fn resolve_bokeh_target(
    snapshot: &BokehSessionSnapshot,
    model: &str,
    property: &str,
) -> Result<BokehTarget, String> {
    let graph = graph_from_snapshot(snapshot, &BTreeMap::new());
    let matched = if graph.models.contains_key(model) {
        model.to_string()
    } else {
        let prefixed: Vec<&String> = graph
            .models
            .keys()
            .filter(|id| model.len() >= 3 && id.starts_with(model))
            .collect();
        match prefixed.as_slice() {
            [id] => (*id).clone(),
            [_, ..] => return Err(format!("model id prefix {model:?} is ambiguous")),
            [] => {
                let wanted = model.to_lowercase();
                let named: Vec<String> = graph
                    .components()
                    .into_iter()
                    .filter(|c| c.category == Category::Widget)
                    .filter(|c| {
                        ["label", "title", "name"].iter().any(|key| {
                            str_prop(c.props, key).is_some_and(|v| v.to_lowercase() == wanted)
                        })
                    })
                    .map(|c| c.id.to_string())
                    .collect();
                match named.as_slice() {
                    [id] => id.clone(),
                    [] => return Err(format!("no model or widget named {model:?}")),
                    ids => {
                        return Err(format!(
                            "{model:?} names several widgets ({}); pass a model id",
                            ids.join(", ")
                        ))
                    }
                }
            }
        }
    };
    // An ESM component's values live on its data model.
    let mut model_id = matched;
    if let Some((data_id, data)) = graph.esm_data(&graph.models[&model_id]) {
        let on_wrapper = graph.models[&model_id].props.contains_key(property);
        if data.props.contains_key(property) || !on_wrapper {
            model_id = data_id.to_string();
        }
    }
    // The hub accepts any non-reference name, but a misspelled one would only
    // fail in Python after the write. Defaults are omitted from documents, so
    // common widget properties are allowed when absent.
    let node = &graph.models[&model_id];
    if property == "data"
        && (graph.sources.contains_key(&model_id) || is_data_source(&node.type_name))
    {
        return Err(format!(
            "{model_id} is a data source; its columns are not property values"
        ));
    }
    if !node.props.contains_key(property) && !DEFAULTED_PROPS.contains(&property) {
        let mut known: Vec<&str> = node.props.keys().map(String::as_str).collect();
        known.truncate(20);
        return Err(format!(
            "{model_id} ({}) has no property {property:?} set; set properties: {}",
            base_name(&node.type_name),
            known.join(", ")
        ));
    }
    let component = graph
        .components()
        .into_iter()
        .find(|c| c.id == model_id)
        .map(|c| {
            let label = label_of(&c);
            (c.kind, label)
        });
    let (kind, label) = component.unwrap_or_else(|| {
        (
            base_name(&graph.models[&model_id].type_name).to_string(),
            None,
        )
    });
    Ok(BokehTarget {
        secret: graph.is_secret(&model_id),
        model_id,
        kind,
        label,
    })
}

// ── Rendering ───────────────────────────────────────────────────────────

/// Summary of a live session from its document.
pub fn summarize_bokeh_session(view: &BokehSessionView) -> Option<String> {
    let snapshot = view.snapshot.as_ref()?;
    let graph = graph_from_snapshot(snapshot, &view.source_rows);
    let meta = &snapshot.meta;
    let mut header = vec![format!(
        "Bokeh session {} ({} {}, Bokeh {}): {}, epoch {}",
        short(&view.session_id, 12),
        meta.producer_name,
        meta.producer_version,
        meta.bokeh_version,
        status_label(view.status),
        view.epoch,
    )];
    if let Some(title) = meta.title.as_deref().filter(|t| !t.is_empty()) {
        header.push(format!("Title: {}", fmt_text(title, 80)));
    }
    let footer = (view.status == BokehSessionStatus::Connected).then(|| {
        "Change a value with set_bokeh_property(cell_id, model, property, value); writes run Python callbacks.".to_string()
    });
    Some(render(&graph, header, footer))
}

/// The state a payload was last saved with: `snapshot.document` (written
/// on save and freeze) over the display-time `document`.
fn saved_doc_json(payload: &Value) -> Option<&Value> {
    payload
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("document"))
        .filter(|document| document.is_object())
        .or_else(|| payload.get("document"))
}

/// Summary of a saved or frozen output from its payload's saved document.
/// `view` carries the session status when the room still knows it.
pub fn summarize_bokeh_payload(payload: &Value, view: Option<&BokehSessionView>) -> Option<String> {
    let doc_json = saved_doc_json(payload)?;
    let graph = graph_from_doc_json(doc_json)?;
    let producer = payload.get("producer");
    let producer = format!(
        "{} {}",
        producer
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("bokeh"),
        producer
            .and_then(|p| p.get("version"))
            .and_then(Value::as_str)
            .unwrap_or("")
    );
    let bokeh = payload
        .get("bokeh_version")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let state = match view {
        Some(view) if view.status == BokehSessionStatus::Connected => {
            "connected, but the live document is unavailable; showing the state saved with the output".to_string()
        }
        Some(view) => format!(
            "{}; read-only state saved with the output",
            status_label(view.status)
        ),
        None => "no live session; read-only state saved with the output".to_string(),
    };
    let session = payload
        .get("session_id")
        .and_then(Value::as_str)
        .map(|id| format!(" {}", short(id, 12)))
        .unwrap_or_default();
    let mut header = vec![format!(
        "Bokeh session{session} ({}, Bokeh {bokeh}): {state}",
        producer.trim_end()
    )];
    if let Some(title) = doc_json
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    {
        header.push(format!("Title: {}", fmt_text(title, 80)));
    }
    Some(render(&graph, header, None))
}

fn render(graph: &Graph, header: Vec<String>, footer: Option<String>) -> String {
    let components = graph.components();
    let mut widgets = Vec::new();
    let mut texts = Vec::new();
    let mut plots = Vec::new();
    let mut tables = Vec::new();
    let mut layouts: Vec<(String, usize)> = Vec::new();
    let mut other = 0usize;
    for component in &components {
        match component.category {
            Category::Widget => widgets.push(widget_line(graph, component)),
            Category::Text => texts.push(text_line(component)),
            Category::Plot => plots.push(plot_line(graph, component)),
            Category::Table => tables.push(table_line(component)),
            Category::Layout => {
                match layouts.iter_mut().find(|(kind, _)| *kind == component.kind) {
                    Some((_, count)) => *count += 1,
                    None => layouts.push((component.kind.clone(), 1)),
                }
            }
            Category::Other => {
                if !graph.sources.contains_key(component.id) {
                    other += 1;
                }
            }
        }
    }
    let sources: Vec<String> = graph
        .sources
        .iter()
        .map(|(id, source)| source_line(graph, id, source))
        .collect();

    let mut lines = header;
    push_section(&mut lines, "Widgets", widgets, MAX_WIDGETS);
    push_section(&mut lines, "Text", texts, MAX_TEXTS);
    push_section(&mut lines, "Plots", plots, MAX_PLOTS);
    push_section(&mut lines, "Data sources", sources, MAX_SOURCES);
    push_section(&mut lines, "Tables", tables, MAX_TABLES);
    if !layouts.is_empty() {
        let listed = layouts
            .iter()
            .map(|(kind, count)| match count {
                1 => kind.clone(),
                n => format!("{kind} \u{d7}{n}"),
            })
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Layouts (collapsed): {listed}"));
    }
    if other > 0 {
        lines.push(format!(
            "{other} other models (glyphs, axes, tools, styles) not listed"
        ));
    }
    lines.extend(footer);
    cap_lines(lines, SUMMARY_MAX_CHARS)
}

fn push_section(lines: &mut Vec<String>, title: &str, items: Vec<String>, max: usize) {
    if items.is_empty() {
        return;
    }
    lines.push(format!("{title} ({}):", items.len()));
    let total = items.len();
    lines.extend(items.into_iter().take(max).map(|item| format!("  {item}")));
    if total > max {
        lines.push(format!("  \u{2026} {} more omitted", total - max));
    }
}

fn cap_lines(lines: Vec<String>, max_chars: usize) -> String {
    let mut out = String::new();
    let total = lines.len();
    for (index, line) in lines.iter().enumerate() {
        if out.len() + line.len() + 1 > max_chars {
            out.push_str(&format!(
                "\u{2026} {} more lines omitted (summary capped at {max_chars} characters)",
                total - index
            ));
            return out;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.truncate(out.trim_end().len());
    out
}

fn label_of(component: &Component<'_>) -> Option<String> {
    ["label", "title", "name"].iter().find_map(|key| {
        let value = str_prop(component.props, key)?;
        // Panel's generated names ("Column00264") carry no meaning.
        let generated = value
            .strip_prefix(component.kind.as_str())
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()));
        (!value.is_empty() && !generated).then(|| value.to_string())
    })
}

fn widget_line(graph: &Graph, component: &Component<'_>) -> String {
    let props = component.props;
    let secret = component.kind.contains("Password") || graph.is_secret(component.id);
    let mut parts = Vec::new();
    if secret {
        // SECURITY: these summaries reach LLM/MCP consumers.
        parts.push("value=****".to_string());
    } else if let Some(value) = props.get("value") {
        parts.push(format!("value={}", fmt_value(value)));
    } else if let Some(active) = props.get("active") {
        parts.push(format!("active={}", fmt_value(active)));
    } else if !component.kind.ends_with("Button") {
        parts.push("value=(default)".to_string());
    }
    for (low, high) in [("start", "end"), ("low", "high")] {
        match (props.get(low), props.get(high)) {
            (Some(a), Some(b)) => parts.push(format!("({}\u{2013}{})", fmt_value(a), fmt_value(b))),
            (Some(a), None) => parts.push(format!("{low}={}", fmt_value(a))),
            (None, Some(b)) => parts.push(format!("{high}={}", fmt_value(b))),
            (None, None) => {}
        }
    }
    for key in ["step", "max", "clicks"] {
        if let Some(value) = props.get(key) {
            parts.push(format!("{key}={}", fmt_value(value)));
        }
    }
    for key in ["options", "labels"] {
        if let Some(options) = props.get(key) {
            parts.push(format!("{key}={}", fmt_options(options)));
        }
    }
    let label = label_of(component)
        .map(|label| format!(" {}", fmt_text(&label, 40)))
        .unwrap_or_default();
    let detail = if parts.is_empty() {
        String::new()
    } else {
        format!(": {}", parts.join(" "))
    };
    format!(
        "{} {}{label}{detail}",
        short(component.id, 12),
        component.kind
    )
}

fn text_line(component: &Component<'_>) -> String {
    let text = ["text", "object", "value"]
        .iter()
        .find_map(|key| component.props.get(*key))
        .map(|value| match value {
            Value::String(text) => fmt_text(&strip_markup(text), 80),
            other => fmt_value(other),
        })
        .unwrap_or_else(|| "(empty)".to_string());
    format!("{} {}: {text}", short(component.id, 12), component.kind)
}

fn plot_line(graph: &Graph, component: &Component<'_>) -> String {
    let props = component.props;
    let node = |value: &Value| ref_id(value).and_then(|id| graph.models.get(id));
    let title = match props.get("title") {
        Some(Value::String(title)) => Some(title.clone()),
        Some(value) => node(value)
            .and_then(|title| str_prop(&title.props, "text"))
            .map(str::to_string),
        None => None,
    }
    .filter(|title| !title.is_empty());
    let axis_labels = |sides: &[&str]| {
        sides
            .iter()
            .filter_map(|side| props.get(*side)?.as_array())
            .flatten()
            .filter_map(|axis| str_prop(&node(axis)?.props, "axis_label"))
            .filter(|label| !label.is_empty())
            .map(|label| fmt_text(label, 30))
            .collect::<Vec<_>>()
    };
    let mut glyphs: Vec<String> = Vec::new();
    let mut sources: Vec<String> = Vec::new();
    for renderer in props
        .get("renderers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(node)
    {
        if let Some(glyph) = renderer.props.get("glyph").and_then(node) {
            let glyph = base_name(&glyph.type_name).to_string();
            if !glyphs.contains(&glyph) {
                glyphs.push(glyph);
            }
        }
        if let Some(source) = renderer.props.get("data_source").and_then(ref_id) {
            let source = short(source, 12);
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    let mut parts = Vec::new();
    let (x, y) = (
        axis_labels(&["below", "above"]),
        axis_labels(&["left", "right"]),
    );
    if !x.is_empty() || !y.is_empty() {
        let mut axes = Vec::new();
        if !x.is_empty() {
            axes.push(format!("x={}", x.join("/")));
        }
        if !y.is_empty() {
            axes.push(format!("y={}", y.join("/")));
        }
        parts.push(axes.join(" "));
    }
    if !glyphs.is_empty() {
        parts.push(format!("glyphs {}", glyphs.join(", ")));
    }
    if !sources.is_empty() {
        parts.push(format!("source {}", sources.join(", ")));
    }
    let title = title
        .map(|title| format!(" {}", fmt_text(&title, 60)))
        .unwrap_or_default();
    let detail = if parts.is_empty() {
        String::new()
    } else {
        format!(": {}", parts.join("; "))
    };
    format!(
        "{} {}{title}{detail}",
        short(component.id, 12),
        component.kind
    )
}

fn source_line(graph: &Graph, id: &str, source: &Source) -> String {
    let kind = graph
        .models
        .get(id)
        .map(|node| base_name(&node.type_name))
        .unwrap_or("ColumnDataSource");
    let mut columns = source
        .columns
        .iter()
        .take(MAX_COLUMNS)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if source.columns.len() > MAX_COLUMNS {
        columns.push_str(&format!(
            ", \u{2026}+{}",
            source.columns.len() - MAX_COLUMNS
        ));
    }
    let rows = match source.rows {
        Some(rows) => format!(" ({} rows)", group_thousands(rows)),
        None if source.rows_skipped => " (rows not counted)".into(),
        None => String::new(),
    };
    format!("{} {kind}: {columns}{rows}", short(id, 12))
}

fn table_line(component: &Component<'_>) -> String {
    let props = component.props;
    let mut parts = Vec::new();
    if let Some(source) = props.get("source").and_then(ref_id) {
        parts.push(format!("source {}", short(source, 12)));
    }
    if let Some(columns) = props.get("columns").and_then(Value::as_array) {
        parts.push(format!("{} columns", columns.len()));
    }
    format!(
        "{} {}: {}",
        short(component.id, 12),
        component.kind,
        parts.join(", ")
    )
}

// ── Value formatting ────────────────────────────────────────────────────

fn short(id: &str, max: usize) -> String {
    if id.chars().count() <= max {
        id.to_string()
    } else {
        let head: String = id.chars().take(max.saturating_sub(1)).collect();
        format!("{head}\u{2026}")
    }
}

fn fmt_text(text: &str, max: usize) -> String {
    format!("{:?}", short(text, max))
}

fn fmt_value(value: &Value) -> String {
    match value {
        Value::String(text) => fmt_text(text, 60),
        Value::Array(items) => {
            let mut shown: Vec<String> = items.iter().take(MAX_OPTIONS).map(fmt_value).collect();
            if items.len() > MAX_OPTIONS {
                shown.push(format!("\u{2026}+{}", items.len() - MAX_OPTIONS));
            }
            format!("[{}]", shown.join(", "))
        }
        Value::Object(map) => {
            if let Some(size) = map.get("$large").and_then(Value::as_u64) {
                return format!("<{size} bytes, not shown>");
            }
            if map.get("type").and_then(Value::as_str) == Some("map") {
                let entries = map_entries(value);
                let mut shown: Vec<String> = entries
                    .iter()
                    .take(MAX_OPTIONS)
                    .map(|(key, value)| format!("{key}: {}", fmt_value(value)))
                    .collect();
                if entries.len() > MAX_OPTIONS {
                    shown.push(format!("\u{2026}+{}", entries.len() - MAX_OPTIONS));
                }
                return format!("{{{}}}", shown.join(", "));
            }
            short(&value.to_string(), 80)
        }
        other => other.to_string(),
    }
}

/// Options as their labels: plain values, `[value, label]` pairs, or
/// grouped maps.
fn fmt_options(options: &Value) -> String {
    let labels: Vec<String> = match options {
        Value::Array(items) => items
            .iter()
            .map(|item| match item.as_array().map(Vec::as_slice) {
                Some([_, label]) => fmt_value(label),
                _ => fmt_value(item),
            })
            .collect(),
        other => map_entries(other)
            .into_iter()
            .map(|(group, _)| fmt_text(&group, 40))
            .collect(),
    };
    if labels.is_empty() {
        return fmt_value(options);
    }
    let total = labels.len();
    let mut shown: Vec<String> = labels.into_iter().take(MAX_OPTIONS).collect();
    if total > MAX_OPTIONS {
        shown.push(format!("\u{2026}+{}", total - MAX_OPTIONS));
    }
    format!("[{}]", shown.join(", "))
}

/// Visible text of HTML; Panel's markup panes escape their HTML once more.
fn strip_markup(text: &str) -> String {
    let mut out = unescape(&strip_tags(text));
    if out.contains('<') {
        out = unescape(&strip_tags(&out));
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}

fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Whether `model_id` holds a value that must never be echoed.
pub fn bokeh_model_is_secret(snapshot: &BokehSessionSnapshot, model_id: &str) -> bool {
    graph_from_snapshot(snapshot, &BTreeMap::new()).is_secret(model_id)
}

impl LiveOutputView for BokehSessionView {
    fn summarize(&self) -> Option<String> {
        summarize_bokeh_session(self)
    }

    fn summarize_with_payload(&self, payload: &Value) -> Option<String> {
        summarize_bokeh_payload(payload, Some(self))
    }
}

pub const PAYLOAD_SUMMARIZER: PayloadSummarizer = PayloadSummarizer {
    mime: BOKEH_SESSION_MIME,
    summarize: |payload| summarize_bokeh_payload(payload, None),
};

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_doc::{BokehColumnRef, BokehModelState, BokehSessionMeta};

    fn model(type_name: &str, props: &[(&str, Value)]) -> BokehModelState {
        BokehModelState {
            type_name: type_name.into(),
            ref_props: Vec::new(),
            props: props
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
        }
    }

    fn r(id: &str) -> Value {
        json!({ "id": id })
    }

    /// Column page with classic and panel-material-ui widgets, a plot and
    /// a source.
    fn page() -> BokehSessionSnapshot {
        let models = [
            (
                "p1",
                model(
                    "Column",
                    &[(
                        "children",
                        json!([
                            r("p2"),
                            r("p3"),
                            r("p4"),
                            r("p5"),
                            r("p7"),
                            r("p10"),
                            r("p13")
                        ]),
                    )],
                ),
            ),
            (
                "p2",
                model(
                    "Slider",
                    &[
                        ("title", json!("Alpha")),
                        ("value", json!(0.5)),
                        ("start", json!(0)),
                        ("end", json!(1)),
                        ("step", json!(0.1)),
                    ],
                ),
            ),
            (
                "p3",
                model(
                    "PasswordInput",
                    &[("title", json!("Secret")), ("value", json!("hunter2"))],
                ),
            ),
            (
                "p4",
                model(
                    "Select",
                    &[
                        ("title", json!("Category")),
                        ("value", json!("b")),
                        ("options", json!(["a", "b", "c"])),
                    ],
                ),
            ),
            (
                "p5",
                model(
                    "panel.models.esm.ReactComponent",
                    &[
                        ("class_name", json!("IntSlider")),
                        ("data", r("p6")),
                        ("esm", json!("export function render() {}")),
                    ],
                ),
            ),
            (
                "p6",
                model(
                    "IntSlider1",
                    &[
                        ("label", json!("Window")),
                        ("value", json!(10)),
                        ("start", json!(1)),
                        ("end", json!(100)),
                    ],
                ),
            ),
            ("p7", model("Row", &[("children", json!([r("p8")]))])),
            (
                "p8",
                model(
                    "panel.models.esm.ReactComponent",
                    &[("class_name", json!("PasswordInput")), ("data", r("p9"))],
                ),
            ),
            (
                "p9",
                model(
                    "PasswordInput1",
                    &[("label", json!("Token")), ("value", json!("s3cret"))],
                ),
            ),
            (
                "p10",
                model(
                    "Figure",
                    &[
                        ("title", r("p11")),
                        ("below", json!([r("p14")])),
                        ("left", json!([r("p15")])),
                        ("renderers", json!([r("p16")])),
                    ],
                ),
            ),
            ("p11", model("Title", &[("text", json!("Sine"))])),
            (
                "p13",
                model("Div", &[("text", json!("<b>Tick &amp; 0</b>"))]),
            ),
            ("p14", model("LinearAxis", &[("axis_label", json!("time"))])),
            (
                "p15",
                model("LinearAxis", &[("axis_label", json!("value"))]),
            ),
            (
                "p16",
                model(
                    "GlyphRenderer",
                    &[("glyph", r("p17")), ("data_source", r("p18"))],
                ),
            ),
            (
                "p17",
                model("Line", &[("x", json!({"type": "field", "field": "x"}))]),
            ),
            ("p18", model("ColumnDataSource", &[])),
        ]
        .into_iter()
        .map(|(id, model)| (id.to_string(), model))
        .collect();
        let column = |blob: &str| BokehColumnRef {
            blob: blob.into(),
            size: 10,
            version: 0,
        };
        BokehSessionSnapshot {
            epoch: 0,
            meta: BokehSessionMeta {
                session_id: "session-abcdef123456".into(),
                producer_name: "panel".into(),
                producer_version: "1.9.4".into(),
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: Some("Dashboard".into()),
                doc_extras: None,
            },
            models,
            columns: BTreeMap::from([(
                "p18".to_string(),
                BTreeMap::from([
                    ("x".to_string(), column("aa11")),
                    ("y".to_string(), column("bb22")),
                ]),
            )]),
        }
    }

    fn view(
        snapshot: Option<BokehSessionSnapshot>,
        status: BokehSessionStatus,
    ) -> BokehSessionView {
        BokehSessionView {
            session_id: "session-abcdef123456".into(),
            status,
            epoch: 0,
            snapshot,
            source_rows: BTreeMap::from([("p18".to_string(), 1000)]),
        }
    }

    #[test]
    fn live_summary_lists_widgets_plots_sources_and_collapses_layouts() {
        let text =
            summarize_bokeh_session(&view(Some(page()), BokehSessionStatus::Connected)).unwrap();
        for expected in [
            "Bokeh session session-abc\u{2026} (panel 1.9.4, Bokeh 3.9.2): connected, epoch 0",
            "Title: \"Dashboard\"",
            "Widgets (5):",
            "  p2 Slider \"Alpha\": value=0.5 (0\u{2013}1) step=0.1",
            "  p3 PasswordInput \"Secret\": value=****",
            "  p4 Select \"Category\": value=\"b\" options=[\"a\", \"b\", \"c\"]",
            "  p6 IntSlider \"Window\": value=10 (1\u{2013}100)",
            "  p9 PasswordInput \"Token\": value=****",
            "Text (1):\n  p13 Div: \"Tick & 0\"",
            "Plots (1):\n  p10 Figure \"Sine\": x=\"time\" y=\"value\"; glyphs Line; source p18",
            "Data sources (1):\n  p18 ColumnDataSource: x, y (1,000 rows)",
            "Layouts (collapsed): Column, Row",
            "writes run Python callbacks",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        assert!(
            !text.contains("hunter2") && !text.contains("s3cret"),
            "{text}"
        );
        // Layouts and ESM data models get no lines of their own.
        assert!(
            !text.contains("p1 Column") && !text.contains("p7 Row"),
            "{text}"
        );
        assert!(!text.contains("p5 ") && !text.contains("p8 "), "{text}");
    }

    #[test]
    fn ended_sessions_omit_the_write_hint() {
        let text =
            summarize_bokeh_session(&view(Some(page()), BokehSessionStatus::Disconnected)).unwrap();
        assert!(text.contains("): disconnected, epoch 0"), "{text}");
        assert!(!text.contains("set_bokeh_property"), "{text}");
    }

    #[test]
    fn large_pages_are_capped_with_omission_counts() {
        let mut snapshot = page();
        let children: Vec<Value> = (0..300).map(|i| r(&format!("s{i}"))).collect();
        snapshot.models.insert(
            "p1".into(),
            model("Column", &[("children", Value::Array(children))]),
        );
        for i in 0..300 {
            snapshot.models.insert(
                format!("s{i}"),
                model(
                    "Slider",
                    &[
                        (
                            "title",
                            json!(format!("Slider number {i} with a long label")),
                        ),
                        ("value", json!(i)),
                        ("start", json!(0)),
                        ("end", json!(1000)),
                    ],
                ),
            );
        }
        let text =
            summarize_bokeh_session(&view(Some(snapshot), BokehSessionStatus::Connected)).unwrap();
        assert!(text.len() <= SUMMARY_MAX_CHARS, "{} chars", text.len());
        assert!(text.contains("Widgets (305):"), "{text}");
        assert!(text.contains("  \u{2026} 265 more omitted"), "{text}");
        assert_eq!(text.matches(" Slider \"").count(), MAX_WIDGETS);

        let lines: Vec<String> = (0..200).map(|i| format!("{i:0>80}")).collect();
        let capped = cap_lines(lines, 1000);
        assert!(capped.len() <= 1000 + 100);
        assert!(capped.ends_with("more lines omitted (summary capped at 1000 characters)"));
    }

    /// Bokeh DocJson as materialized for a frozen output: models defined
    /// at first reference, columns inline.
    fn frozen_payload() -> Value {
        serde_json::from_str(
            r#"{
            "session_id": "session-abcdef123456",
            "producer": {"name": "panel", "version": "1.9.4"},
            "bokeh_version": "3.9.2",
            "document": {
                "version": "3.9.2",
                "title": "Dashboard",
                "roots": [{
                    "type": "object", "name": "Row", "id": "p1",
                    "attributes": {"children": [
                        {"type": "object", "name": "TextInput", "id": "p2",
                         "attributes": {"title": "Filter", "value": "abc"}},
                        {"type": "object", "name": "PasswordInput", "id": "p3",
                         "attributes": {"title": "Secret", "value": "hunter2"}},
                        {"type": "object", "name": "Figure", "id": "p4", "attributes": {
                            "renderers": [{"type": "object", "name": "GlyphRenderer", "id": "p5",
                                "attributes": {
                                    "glyph": {"type": "object", "name": "Scatter", "id": "p6", "attributes": {}},
                                    "data_source": {"type": "object", "name": "ColumnDataSource", "id": "p7",
                                        "attributes": {"data": {"type": "map", "entries": [
                                            ["x", {"type": "ndarray", "array": {"type": "bytes", "data": "AAAAAAAAAAAAAAAAAAAAAA=="}, "shape": [2], "dtype": "float64", "order": "little"}],
                                            ["label", ["a", "b"]]
                                        ]}}}
                                }}]
                        }},
                        {"id": "p2"}
                    ]}
                }]
            }
        }"#,
        )
        .unwrap()
    }

    #[test]
    fn column_length_reads_gzipped_and_plain_buffers() {
        let column = |data: &str| {
            serde_json::json!({
                "type": "ndarray", "dtype": "float64",
                "array": {"type": "bytes", "data": data},
            })
        };
        // 24 zero bytes, gzipped by Bokeh 3.8+.
        assert_eq!(
            column_length(&column("H4sIAAEAAAAC/2NgwA4AIMrBoxgAAAA=")),
            Some(3)
        );
        assert_eq!(column_length(&column("AAAAAAAAAAAAAAAAAAAAAA==")), Some(2));
    }

    #[test]
    fn frozen_payload_summary_reads_the_saved_document() {
        let text = summarize_bokeh_payload(&frozen_payload(), None).unwrap();
        for expected in [
            "Bokeh session session-abc\u{2026} (panel 1.9.4, Bokeh 3.9.2): no live session; read-only state saved with the output",
            "  p2 TextInput \"Filter\": value=\"abc\"",
            "  p3 PasswordInput \"Secret\": value=****",
            "  p4 Figure: glyphs Scatter; source p7",
            "  p7 ColumnDataSource: x, label (2 rows)",
            "Layouts (collapsed): Row",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("set_bokeh_property"));

        let disconnected = view(None, BokehSessionStatus::Disconnected);
        let text = summarize_bokeh_payload(&frozen_payload(), Some(&disconnected)).unwrap();
        assert!(text.contains("): disconnected; read-only state saved with the output"));
    }

    fn manifest(payload: &Value) -> Value {
        json!({
            "output_type": "display_data",
            "output_id": "out-1",
            "data": {
                BOKEH_SESSION_MIME: {"inline": payload.to_string()},
                "text/plain": {"inline": "Row(TextInput, PasswordInput, Figure)"},
            },
        })
    }

    fn llm_text(output: &crate::resolved_output::Output) -> String {
        match output.data.as_ref().unwrap().get("text/llm+plain") {
            Some(DataValue::Text(text)) => text.clone(),
            other => panic!("no text/llm+plain: {other:?}"),
        }
    }

    fn live_views(view: BokehSessionView) -> crate::output_resolver::LiveOutputViews {
        crate::output_resolver::LiveOutputViews::from([(
            "out-1".to_string(),
            std::sync::Arc::new(view) as std::sync::Arc<dyn LiveOutputView>,
        )])
    }

    #[test]
    fn saved_snapshot_wins_over_the_display_time_document() {
        let mut payload = frozen_payload();
        let mut snapshot = payload["document"].clone();
        snapshot["roots"][0]["attributes"]["children"][0]["attributes"]["value"] = json!("saved");
        snapshot["title"] = json!("Saved dashboard");
        payload["snapshot"] = json!({"document": snapshot, "buffers": []});
        let text = summarize_bokeh_payload(&payload, None).unwrap();
        assert!(
            text.contains("p2 TextInput \"Filter\": value=\"saved\""),
            "{text}"
        );
        assert!(text.contains("Title: \"Saved dashboard\""), "{text}");

        payload["snapshot"] = Value::Null;
        let text = summarize_bokeh_payload(&payload, None).unwrap();
        assert!(text.contains("value=\"abc\""), "{text}");
    }

    #[tokio::test]
    async fn resolver_prefers_the_live_document_and_falls_back_to_the_payload() {
        let manifest = manifest(&frozen_payload());
        let frozen =
            crate::output_resolver::resolve_output_for_llm(&manifest, ResolveCtx::default())
                .await
                .unwrap();
        let text = llm_text(&frozen);
        assert!(
            text.contains("p2 TextInput \"Filter\": value=\"abc\""),
            "{text}"
        );
        assert!(text.contains("no live session"), "{text}");

        let views = live_views(view(Some(page()), BokehSessionStatus::Connected));
        let live = crate::output_resolver::resolve_output_for_llm(
            &manifest,
            ResolveCtx {
                live_views: Some(&views),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let text = llm_text(&live);
        assert!(text.contains("p6 IntSlider \"Window\": value=10"), "{text}");
        assert!(!text.contains("Filter"), "{text}");

        // Connected but not synced: saved state, labelled as such.
        let views = live_views(view(None, BokehSessionStatus::Connected));
        let unsynced = crate::output_resolver::resolve_output_for_llm(
            &manifest,
            ResolveCtx {
                live_views: Some(&views),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let text = llm_text(&unsynced);
        assert!(text.contains("live document is unavailable"), "{text}");
        assert!(text.contains("value=\"abc\""), "{text}");
    }

    #[tokio::test]
    async fn prepare_view_fetches_blob_values_and_counts_rows() {
        let store = tempfile::tempdir().unwrap();
        let write_blob = |hash: &str, content: &str| {
            let dir = store.path().join(&hash[..2]);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(&hash[2..]), content).unwrap();
        };
        let options: Vec<String> = (0..50).map(|i| format!("option-{i}")).collect();
        write_blob("cc33", &serde_json::to_string(&options).unwrap());
        write_blob("aa11", "[1, 2, 3, 4, 5]");
        let mut snapshot = page();
        snapshot.models.get_mut("p4").unwrap().props.insert(
            "options".into(),
            BokehBlobRef {
                blob: "cc33".into(),
                size: 600,
                media_type: "application/json".into(),
            }
            .encode(),
        );
        let view = prepare_bokeh_view(
            "session-abcdef123456",
            BokehSessionStatus::Connected,
            0,
            Some(snapshot),
            ResolveCtx {
                blob_store_path: Some(store.path()),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(view.source_rows.get("p18"), Some(&5));
        let text = summarize_bokeh_session(&view).unwrap();
        assert!(
            text.contains("options=[\"option-0\", \"option-1\", \"option-2\", \"option-3\", \"option-4\", \"option-5\", \"option-6\", \"option-7\", \u{2026}+42]"),
            "{text}"
        );
        assert!(text.contains("x, y (5 rows)"), "{text}");
    }

    #[tokio::test]
    async fn row_counts_never_fetch_large_column_blobs() {
        let store = tempfile::tempdir().unwrap();
        let write_blob = |hash: &str, content: &str| {
            let dir = store.path().join(&hash[..2]);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(&hash[2..]), content).unwrap();
        };
        // Declared sizes stand in for large blobs; small files show what a
        // fetch would read.
        write_blob("aa11", "[1, 2, 3]");
        write_blob("bb22", "[1, 2, 3, 4]");
        write_blob("dd44", "[1]");
        let column = |blob: &str, size: u64| BokehColumnRef {
            blob: blob.into(),
            size,
            version: 0,
        };
        let mut snapshot = page();
        snapshot.columns = BTreeMap::from([
            (
                "p18".to_string(),
                BTreeMap::from([
                    ("x".to_string(), column("aa11", 1024 * 1024)),
                    ("y".to_string(), column("bb22", 12)),
                ]),
            ),
            (
                "p19".to_string(),
                BTreeMap::from([("x".to_string(), column("dd44", 2 * 1024 * 1024))]),
            ),
        ]);
        let view = prepare_bokeh_view(
            "session-abcdef123456",
            BokehSessionStatus::Connected,
            0,
            Some(snapshot),
            ResolveCtx {
                blob_store_path: Some(store.path()),
                ..Default::default()
            },
        )
        .await;
        // Counted from the smallest column; skipped when every column is large.
        assert_eq!(view.source_rows.get("p18"), Some(&4));
        assert_eq!(view.source_rows.get("p19"), None);
        let text = summarize_bokeh_session(&view).unwrap();
        assert!(
            text.contains("p18 ColumnDataSource: x, y (4 rows)"),
            "{text}"
        );
        assert!(
            text.contains("p19 ColumnDataSource: x (rows not counted)"),
            "{text}"
        );
    }

    #[test]
    fn targets_resolve_by_id_prefix_and_label_and_follow_esm_data_models() {
        let mut snapshot = page();
        for id in ["q1001", "q1002", "uuid-4f2a9c"] {
            snapshot
                .models
                .insert(id.into(), model("Slider", &[("title", json!("Twin"))]));
        }
        let target = |model: &str| resolve_bokeh_target(&snapshot, model, "value");
        assert_eq!(target("uuid-4f").unwrap().model_id, "uuid-4f2a9c");
        assert!(target("q100").unwrap_err().contains("ambiguous"));
        assert!(target("Twin")
            .unwrap_err()
            .contains("names several widgets"));
        assert_eq!(target("p2").unwrap().model_id, "p2");
        assert_eq!(target("Alpha").unwrap().model_id, "p2");
        assert_eq!(target("category").unwrap().model_id, "p4");
        let window = target("p5").unwrap();
        assert_eq!(
            (
                window.model_id.as_str(),
                window.kind.as_str(),
                window.label.as_deref()
            ),
            ("p6", "IntSlider", Some("Window"))
        );
        assert_eq!(target("Window").unwrap().model_id, "p6");
        assert!(target("Token").unwrap().secret);
        assert!(target("p3").unwrap().secret);
        assert!(!target("p2").unwrap().secret);
        assert!(target("Missing")
            .unwrap_err()
            .contains("no model or widget"));
        let misspelled = resolve_bokeh_target(&snapshot, "p2", "valeu").unwrap_err();
        assert!(
            misspelled.contains("has no property \"valeu\""),
            "{misspelled}"
        );
        let columns = resolve_bokeh_target(&snapshot, "p18", "data").unwrap_err();
        assert!(columns.contains("data source"), "{columns}");
        // Props that exist only on the wrapper stay on it.
        assert_eq!(
            resolve_bokeh_target(&snapshot, "p5", "class_name")
                .unwrap()
                .model_id,
            "p5"
        );
    }
}
