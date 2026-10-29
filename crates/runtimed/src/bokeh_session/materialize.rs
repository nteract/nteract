//! Materialize a session document into Bokeh DocJson for the saved output.
//!
//! A frozen or saved session must render without the session document, so
//! the output's session payload carries the materialized DocJson as
//! `snapshot.document`, with columns and blob-backed values inlined and the
//! duplicate `session_doc` removed. `document` stays the display-time
//! payload, byte-equal to the durable execution record; only `snapshot` is a
//! declared mutable replay field. Column blobs hold each source as of its
//! last fold or replacement; the retained streams and patches since then are
//! replayed over them ([`apply_tail`]).

use std::collections::{BTreeMap, BTreeSet, HashSet};

use notebook_protocol::protocol::BokehSessionEvents;
use runtime_doc::{
    BokehBlobRef, BokehColumnRef, BokehSessionSnapshot, RuntimeStateHandle, BOKEH_SESSION_MIME,
};
use serde_json::{json, Map, Value};
use tracing::warn;

use super::ingest::{
    event_base_version, event_kind, event_source, inline_buffers, referenced_buffer_ids, BufferMap,
    BytesEncoding,
};
use crate::blob_store::BlobStore;
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_store::ContentRef;

/// A session document's state plus the data events retained since each
/// source's last fold, which its column blobs do not contain yet.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SnapshotWithTail {
    pub(crate) snapshot: BokehSessionSnapshot,
    pub(crate) tail: Vec<BokehSessionEvents>,
    /// Sources whose retained events were dropped; their state past the
    /// column blobs is unknown, so materializing refuses them.
    pub(crate) incomplete_sources: BTreeSet<String>,
}

impl SnapshotWithTail {
    /// The column blobs alone, without any retained events.
    pub(crate) fn folded(&self) -> Self {
        Self {
            snapshot: self.snapshot.clone(),
            ..Self::default()
        }
    }
}

/// One source's encoded column values as of `version`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SourceColumns {
    pub(crate) version: u64,
    pub(crate) columns: BTreeMap<String, Value>,
}

/// Decode a stored value, reading it from the blob store when offloaded.
pub(crate) async fn resolve_value(encoded: &str, blob_store: &BlobStore) -> anyhow::Result<Value> {
    read_value(encoded, blob_store).await?.ok_or_else(|| {
        let hash = BokehBlobRef::parse(encoded).map(|blob| blob.blob);
        anyhow::anyhow!("Bokeh value blob {} is missing", hash.unwrap_or_default())
    })
}

/// [`resolve_value`], with `None` when the value's blob no longer exists.
async fn read_value(encoded: &str, blob_store: &BlobStore) -> anyhow::Result<Option<Value>> {
    let text = match BokehBlobRef::parse(encoded) {
        Some(blob) => match blob_store.get(&blob.blob).await? {
            Some(bytes) => String::from_utf8(bytes)?,
            None => return Ok(None),
        },
        None => encoded.to_string(),
    };
    Ok(Some(serde_json::from_str(&text)?))
}

/// [`read_value`] for the materialized state, which drops a value whose blob
/// is gone: failing would fail every later freeze and save of the session.
async fn read_stored_value(
    encoded: &str,
    what: &str,
    blob_store: &BlobStore,
) -> anyhow::Result<Option<Value>> {
    let value = read_value(encoded, blob_store).await?;
    if value.is_none() {
        warn!("[bokeh-session] Dropping {what}: its value blob is missing");
    }
    Ok(value)
}

async fn load_column(column: &BokehColumnRef, blob_store: &BlobStore) -> anyhow::Result<Value> {
    read_column(column, blob_store)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Bokeh column blob {} is missing", column.blob))
}

async fn read_column(
    column: &BokehColumnRef,
    blob_store: &BlobStore,
) -> anyhow::Result<Option<Value>> {
    match blob_store.get(&column.blob).await? {
        Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        None => Ok(None),
    }
}

/// Every source's column blobs, at the highest column version (a partial
/// replacement leaves untouched columns at older versions). A column whose
/// blob no longer exists is dropped, as in [`read_stored_value`].
pub(crate) async fn load_columns(
    snapshot: &BokehSessionSnapshot,
    blob_store: &BlobStore,
) -> anyhow::Result<BTreeMap<String, SourceColumns>> {
    let mut sources = BTreeMap::new();
    for (source_id, columns) in &snapshot.columns {
        let mut source = SourceColumns {
            version: columns.values().map(|c| c.version).max().unwrap_or(0),
            columns: BTreeMap::new(),
        };
        for (name, column) in columns {
            match read_column(column, blob_store).await? {
                Some(value) => {
                    source.columns.insert(name.clone(), value);
                }
                None => warn!(
                    "[bokeh-session] Dropping column {source_id}.{name}: blob {} is missing",
                    column.blob
                ),
            }
        }
        sources.insert(source_id.clone(), source);
    }
    Ok(sources)
}

/// Bokeh DocJson for the state: roots expanded depth-first, each model
/// defined at its first reference, unreachable models dropped, and each
/// source's retained tail applied to its columns. Fails rather than
/// returning an older state when any tail cannot be replayed.
pub(crate) async fn materialize_doc_json(
    state: &SnapshotWithTail,
    blob_store: &BlobStore,
) -> anyhow::Result<Value> {
    let snapshot = &state.snapshot;
    if let Some(source_id) = state.incomplete_sources.first() {
        anyhow::bail!("the retained tail of {source_id} lost events");
    }
    let encoding = BytesEncoding::for_bokeh_version(&snapshot.meta.bokeh_version);
    let loaded = load_columns(snapshot, blob_store).await?;
    let mut sources = apply_tail(loaded, &state.tail, encoding, blob_store).await?;

    let mut models: BTreeMap<String, (String, Map<String, Value>)> = BTreeMap::new();
    for (id, model) in &snapshot.models {
        let mut attributes = Map::new();
        for (name, encoded) in &model.props {
            let what = format!("{id}.{name}");
            if let Some(value) = read_stored_value(encoded, &what, blob_store).await? {
                attributes.insert(name.clone(), value);
            }
        }
        if let Some(source) = sources.remove(id) {
            let entries: Vec<Value> = source
                .columns
                .into_iter()
                .map(|(name, column)| json!([name, column]))
                .collect();
            attributes.insert(
                "data".to_string(),
                json!({"type": "map", "entries": entries}),
            );
        }
        models.insert(id.clone(), (model.type_name.clone(), attributes));
    }

    let mut emitted = HashSet::new();
    let roots = snapshot
        .meta
        .root_ids
        .iter()
        .filter(|id| models.contains_key(*id))
        .map(|id| expand_model(id, &models, &mut emitted))
        .collect::<Vec<_>>();

    let mut doc = Map::new();
    if let Some(extras) = &snapshot.meta.doc_extras {
        if let Some(Value::Object(extras)) =
            read_stored_value(extras, "doc_extras", blob_store).await?
        {
            doc.extend(extras);
        }
    }
    doc.insert("version".to_string(), json!(snapshot.meta.bokeh_version));
    if let Some(title) = &snapshot.meta.title {
        doc.insert("title".to_string(), json!(title));
    }
    doc.insert("roots".to_string(), Value::Array(roots));
    Ok(Value::Object(doc))
}

/// Replay retained data events over the loaded columns as Bokeh's `stream`
/// (with rollover), `patch` and column replacement do. A source advances
/// through events chained from its version, skipping events a fold already
/// covers. A version gap, a missing blob or an event that cannot be
/// replayed fails the whole replay, so no caller writes a partial state.
/// Blob reads happen here; decoding and replay run on a blocking thread,
/// since a tail can touch columns of many megabytes.
pub(crate) async fn apply_tail(
    sources: BTreeMap<String, SourceColumns>,
    tail: &[BokehSessionEvents],
    encoding: BytesEncoding,
    blob_store: &BlobStore,
) -> anyhow::Result<BTreeMap<String, SourceColumns>> {
    let plan = plan_replay(&sources, tail, blob_store).await?;
    if plan.is_empty() {
        return Ok(sources);
    }
    let (replayed, _) =
        tokio::task::spawn_blocking(move || replay(sources, plan, encoding)).await??;
    Ok(replayed)
}

/// A chained event with the blobs it reads.
struct PreparedEvent {
    new_version: u64,
    event: Value,
    buffers: BufferMap,
    /// Replacement columns loaded from their blob refs.
    replaced: BTreeMap<String, Value>,
}

type ReplayPlan = BTreeMap<String, Vec<PreparedEvent>>;

async fn plan_replay(
    sources: &BTreeMap<String, SourceColumns>,
    tail: &[BokehSessionEvents],
    blob_store: &BlobStore,
) -> anyhow::Result<ReplayPlan> {
    type Chained<'a> = (u64, u64, &'a Value, &'a BokehSessionEvents);
    let mut by_source: BTreeMap<&str, Vec<Chained<'_>>> = BTreeMap::new();
    for envelope in tail {
        for event in &envelope.data_events {
            let (Some(source_id), Some(base), Some(new)) = (
                event_source(event),
                event_base_version(event),
                event.get("new_version").and_then(Value::as_u64),
            ) else {
                anyhow::bail!("retained Bokeh data event has no source or versions");
            };
            anyhow::ensure!(
                new > base,
                "retained event for {source_id} does not advance"
            );
            by_source
                .entry(source_id)
                .or_default()
                .push((base, new, event, envelope));
        }
    }
    let mut plan = ReplayPlan::new();
    for (source_id, mut events) in by_source {
        events.sort_by_key(|(base, ..)| *base);
        let mut version = sources.get(source_id).map_or(0, |source| source.version);
        let mut prepared = Vec::new();
        for (base, new, event, envelope) in events {
            if base < version {
                continue;
            }
            anyhow::ensure!(
                base == version,
                "the retained tail of {source_id} has a gap at version {version}"
            );
            let mut replaced = BTreeMap::new();
            if event_kind(event) == Some("ColumnDataChanged") {
                for (name, value) in map_entries(event.get("columns"))? {
                    if let Ok(column) = serde_json::from_value::<BokehColumnRef>(value.clone()) {
                        replaced.insert(name, load_column(&column, blob_store).await?);
                    }
                }
            }
            prepared.push(PreparedEvent {
                new_version: new,
                event: event.clone(),
                buffers: event_buffers(event, envelope, blob_store).await?,
                replaced,
            });
            version = new;
        }
        if !prepared.is_empty() {
            plan.insert(source_id.to_string(), prepared);
        }
    }
    Ok(plan)
}

#[derive(Debug, Default, PartialEq)]
struct ReplayStats {
    /// Stored columns decoded and re-encoded; each touched column once.
    decoded_columns: usize,
    encoded_columns: usize,
}

fn replay(
    mut sources: BTreeMap<String, SourceColumns>,
    plan: ReplayPlan,
    encoding: BytesEncoding,
) -> anyhow::Result<(BTreeMap<String, SourceColumns>, ReplayStats)> {
    let mut stats = ReplayStats::default();
    for (source_id, events) in plan {
        let SourceColumns {
            mut version,
            columns,
        } = sources.remove(&source_id).unwrap_or_default();
        let mut columns: BTreeMap<String, Column> = columns
            .into_iter()
            .map(|(name, value)| (name, Column::Encoded(value)))
            .collect();
        for event in &events {
            apply_event(&mut columns, event, encoding, &mut stats).map_err(|error| {
                anyhow::anyhow!("replaying {source_id} past version {version}: {error}")
            })?;
            version = event.new_version;
        }
        let mut encoded = BTreeMap::new();
        for (name, column) in columns {
            if matches!(column, Column::Decoded(_)) {
                stats.encoded_columns += 1;
            }
            encoded.insert(name, column.encode(encoding)?);
        }
        sources.insert(
            source_id,
            SourceColumns {
                version,
                columns: encoded,
            },
        );
    }
    Ok((sources, stats))
}

/// The stored column, decoded in place on first use. Bokeh only streams
/// and patches existing columns.
fn column_mut<'a>(
    columns: &'a mut BTreeMap<String, Column>,
    name: &str,
    encoding: BytesEncoding,
    stats: &mut ReplayStats,
) -> anyhow::Result<&'a mut Decoded> {
    let column = columns
        .get_mut(name)
        .ok_or_else(|| anyhow::anyhow!("column {name} does not exist"))?;
    if let Column::Encoded(value) = column {
        let decoded = Decoded::decode(std::mem::take(value), &BufferMap::new(), encoding)?;
        stats.decoded_columns += 1;
        *column = Column::Decoded(decoded);
    }
    match column {
        Column::Decoded(decoded) => Ok(decoded),
        Column::Encoded(_) => anyhow::bail!("column {name} was not decoded"),
    }
}

fn apply_event(
    columns: &mut BTreeMap<String, Column>,
    prepared: &PreparedEvent,
    encoding: BytesEncoding,
    stats: &mut ReplayStats,
) -> anyhow::Result<()> {
    let PreparedEvent {
        event,
        buffers,
        replaced,
        ..
    } = prepared;
    match event_kind(event) {
        Some("ColumnsStreamed") => {
            let rollover = event.get("rollover").and_then(Value::as_u64);
            for (name, chunk) in map_entries(event.get("data"))? {
                let chunk = Decoded::decode(chunk.clone(), buffers, encoding)?;
                let column = column_mut(columns, &name, encoding, stats)?;
                column.append(chunk)?;
                if let Some(rollover) = rollover {
                    column.roll_over(rollover as usize);
                }
            }
        }
        Some("ColumnsPatched") => {
            for (name, patches) in map_entries(event.get("patches"))? {
                let patches = patches
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("patches for {name} are not a list"))?;
                let column = column_mut(columns, &name, encoding, stats)?;
                for patch in patches {
                    let Some([index, value]) = patch.as_array().map(Vec::as_slice) else {
                        anyhow::bail!("patch for {name} is not an (index, value) pair");
                    };
                    column.patch(index, value, buffers, encoding)?;
                }
            }
        }
        Some("ColumnDataChanged") => {
            for (name, value) in map_entries(event.get("columns"))? {
                let value = match replaced.get(&name) {
                    Some(loaded) => loaded.clone(),
                    None => inline_buffers(value, buffers, encoding)?,
                };
                columns.insert(name, Column::Encoded(value));
            }
            for name in event
                .get("columns_removed")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                columns.remove(name);
            }
        }
        other => anyhow::bail!("cannot replay Bokeh data event {other:?}"),
    }
    Ok(())
}

async fn event_buffers(
    event: &Value,
    envelope: &BokehSessionEvents,
    blob_store: &BlobStore,
) -> anyhow::Result<BufferMap> {
    let mut ids = BTreeSet::new();
    referenced_buffer_ids(event, &mut ids);
    let mut buffers = BufferMap::new();
    for id in ids {
        let buffer = envelope
            .buffers
            .iter()
            .find(|buffer| buffer.id == id)
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer {id} is not attached to its event"))?;
        let data = blob_store
            .get(&buffer.blob)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer blob {} is missing", buffer.blob))?;
        buffers.insert(id, data);
    }
    Ok(buffers)
}

/// Entries of a plain JSON object or of Bokeh's `{"type": "map", "entries"}`.
fn map_entries(value: Option<&Value>) -> anyhow::Result<Vec<(String, &Value)>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(map)) if map.get("type").and_then(Value::as_str) == Some("map") => map
            .get("entries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|entry| match entry.as_array().map(Vec::as_slice) {
                Some([Value::String(key), value]) => Ok((key.clone(), value)),
                _ => Err(anyhow::anyhow!("malformed Bokeh map entry")),
            })
            .collect(),
        Some(Value::Object(map)) => Ok(map.iter().map(|(k, v)| (k.clone(), v)).collect()),
        Some(_) => anyhow::bail!("expected a Bokeh map"),
    }
}

#[derive(Debug, Clone)]
enum Column {
    /// As loaded; re-emitted unchanged unless an event touches it.
    Encoded(Value),
    Decoded(Decoded),
}

impl Column {
    fn encode(self, encoding: BytesEncoding) -> anyhow::Result<Value> {
        match self {
            Self::Encoded(value) => Ok(value),
            Self::Decoded(column) => column.encode(encoding),
        }
    }
}

/// An ndarray's template (when it has one), dtype and little-endian data.
type TypedParts = (Option<Map<String, Value>>, Dtype, Vec<u8>);

#[derive(Debug, Clone)]
enum Decoded {
    List(Vec<Value>),
    /// A one-dimensional numeric `ndarray`; `template` keeps its other keys.
    Typed {
        template: Map<String, Value>,
        dtype: Dtype,
        data: Vec<u8>,
    },
}

impl Decoded {
    /// Decode a column or chunk. Buffer refs resolve through `buffers`;
    /// stored columns carry their buffers inline.
    fn decode(value: Value, buffers: &BufferMap, encoding: BytesEncoding) -> anyhow::Result<Self> {
        let mut map = match value {
            Value::Array(_) => return Ok(Self::List(list_items(value, buffers, encoding)?)),
            Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("ndarray") => map,
            _ => anyhow::bail!("unsupported Bokeh column encoding"),
        };
        anyhow::ensure!(
            map.get("shape")
                .and_then(Value::as_array)
                .is_some_and(|shape| shape.len() == 1),
            "only one-dimensional ndarray columns can be replayed"
        );
        let bytes = match map.remove("array") {
            // Object dtype: Bokeh sends the values as a list.
            Some(items @ Value::Array(_)) => {
                return Ok(Self::List(list_items(items, buffers, encoding)?))
            }
            Some(Value::Object(bytes))
                if bytes.get("type").and_then(Value::as_str) == Some("bytes") =>
            {
                bytes
            }
            _ => anyhow::bail!("malformed ndarray column"),
        };
        anyhow::ensure!(
            map.get("order").and_then(Value::as_str).unwrap_or("little") == "little",
            "big-endian ndarray columns cannot be replayed"
        );
        let name = map.get("dtype").and_then(Value::as_str).unwrap_or_default();
        let dtype = Dtype::parse(name)
            .ok_or_else(|| anyhow::anyhow!("unsupported ndarray dtype {name:?}"))?;
        let data = match bytes.get("data") {
            Some(Value::String(text)) => encoding.decode(text)?,
            Some(Value::Object(reference)) => {
                let id = reference
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("ndarray buffer ref has no id"))?;
                buffers
                    .get(id)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("Bokeh buffer {id} was not sent"))?
            }
            _ => anyhow::bail!("malformed ndarray buffer"),
        };
        anyhow::ensure!(
            data.len() % dtype.size() == 0,
            "ndarray buffer length does not match dtype {name}"
        );
        Ok(Self::Typed {
            template: map,
            dtype,
            data,
        })
    }

    fn len(&self) -> usize {
        match self {
            Self::List(items) => items.len(),
            Self::Typed { dtype, data, .. } => data.len() / dtype.size(),
        }
    }

    fn into_list(self) -> Vec<Value> {
        match self {
            Self::List(items) => items,
            Self::Typed { dtype, data, .. } => data
                .chunks_exact(dtype.size())
                .map(|item| dtype.read(item))
                .collect(),
        }
    }

    /// Append as Bokeh's `_stream` does: lists extend lists, and when
    /// either side is an ndarray `np.append` converts the list with
    /// `np.asarray` and promotes both to their common dtype.
    fn append(&mut self, chunk: Decoded) -> anyhow::Result<()> {
        if let (Self::List(items), Self::List(_)) = (&mut *self, &chunk) {
            items.extend(chunk.into_list());
            return Ok(());
        }
        let column = std::mem::replace(self, Self::List(Vec::new()));
        let (template, dtype, data) = column.into_typed()?;
        let (chunk_template, chunk_dtype, chunk_data) = chunk.into_typed()?;
        let target = dtype.promote(chunk_dtype);
        let mut data = dtype.cast(data, target)?;
        data.extend(chunk_dtype.cast(chunk_data, target)?);
        *self = Self::Typed {
            template: template.or(chunk_template).unwrap_or_default(),
            dtype: target,
            data,
        };
        Ok(())
    }

    /// The values as a typed buffer; a list gets the dtype `np.asarray`
    /// would give it, and no template.
    fn into_typed(self) -> anyhow::Result<TypedParts> {
        match self {
            Self::Typed {
                template,
                dtype,
                data,
            } => Ok((Some(template), dtype, data)),
            Self::List(items) => {
                let dtype = Dtype::infer(&items)?;
                let mut data = vec![0; items.len() * dtype.size()];
                for (item, out) in items.iter().zip(data.chunks_exact_mut(dtype.size())) {
                    dtype.write(item, out)?;
                }
                Ok((None, dtype, data))
            }
        }
    }

    /// Keep only the last `keep` values.
    fn roll_over(&mut self, keep: usize) {
        let drop = self.len().saturating_sub(keep);
        match self {
            Self::List(items) => {
                items.drain(..drop);
            }
            Self::Typed { dtype, data, .. } => {
                data.drain(..drop * dtype.size());
            }
        }
    }

    fn patch(
        &mut self,
        index: &Value,
        value: &Value,
        buffers: &BufferMap,
        encoding: BytesEncoding,
    ) -> anyhow::Result<()> {
        let len = self.len();
        match index {
            Value::Number(number) => {
                let index = number
                    .as_i64()
                    .ok_or_else(|| anyhow::anyhow!("patch index {number} is not an integer"))?;
                let resolved = if index < 0 { index + len as i64 } else { index };
                anyhow::ensure!(
                    (0..len as i64).contains(&resolved),
                    "patch index {index} is out of range for {len} values"
                );
                self.set(resolved as usize, value, buffers, encoding)
            }
            Value::Object(slice) if slice.get("type").and_then(Value::as_str) == Some("slice") => {
                let indices = slice_indices(slice, len)?;
                let values = Decoded::decode(value.clone(), buffers, encoding)?.into_list();
                anyhow::ensure!(
                    values.len() == indices.len(),
                    "slice patch has {} values for {} positions",
                    values.len(),
                    indices.len()
                );
                for (index, value) in indices.into_iter().zip(values) {
                    self.set(index, &value, buffers, encoding)?;
                }
                Ok(())
            }
            _ => anyhow::bail!("multi-dimensional patches cannot be replayed"),
        }
    }

    /// Overwrite one value. Typed arrays cast like a NumPy assignment.
    fn set(
        &mut self,
        index: usize,
        value: &Value,
        buffers: &BufferMap,
        encoding: BytesEncoding,
    ) -> anyhow::Result<()> {
        match self {
            Self::Typed { dtype, data, .. } => {
                let size = dtype.size();
                dtype.write(value, &mut data[index * size..(index + 1) * size])
            }
            Self::List(items) => {
                items[index] = inline_buffers(value, buffers, encoding)?;
                Ok(())
            }
        }
    }

    fn encode(self, encoding: BytesEncoding) -> anyhow::Result<Value> {
        match self {
            Self::List(items) => Ok(Value::Array(items)),
            Self::Typed {
                mut template,
                dtype,
                data,
            } => {
                template.insert("type".to_string(), json!("ndarray"));
                template.insert("dtype".to_string(), json!(dtype.name()));
                template.insert("order".to_string(), json!("little"));
                template.insert("shape".to_string(), json!([data.len() / dtype.size()]));
                template.insert(
                    "array".to_string(),
                    json!({"type": "bytes", "data": encoding.encode(&data)?}),
                );
                Ok(Value::Object(template))
            }
        }
    }
}

/// List values with any nested buffer refs (e.g. image arrays) inlined.
fn list_items(
    value: Value,
    buffers: &BufferMap,
    encoding: BytesEncoding,
) -> anyhow::Result<Vec<Value>> {
    let value = if buffers.is_empty() {
        value
    } else {
        inline_buffers(&value, buffers, encoding)?
    };
    match value {
        Value::Array(items) => Ok(items),
        _ => anyhow::bail!("expected a list"),
    }
}

/// Python slice semantics over `len` values; Bokeh only allows positive steps.
fn slice_indices(slice: &Map<String, Value>, len: usize) -> anyhow::Result<Vec<usize>> {
    let bound = |key: &str| slice.get(key).and_then(Value::as_i64);
    let step = bound("step").unwrap_or(1);
    anyhow::ensure!(step > 0, "slice step must be positive");
    let clamp = |value: i64| {
        let value = if value < 0 { value + len as i64 } else { value };
        value.clamp(0, len as i64) as usize
    };
    let start = bound("start").map_or(0, clamp);
    let stop = bound("stop").map_or(len, clamp);
    Ok((start..stop).step_by(step as usize).collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dtype {
    Bool,
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
}

/// A JSON value as NumPy would see it on assignment.
enum Scalar {
    Bool(bool),
    Int(i128),
    Float(f64),
    None,
}

impl Scalar {
    fn parse(value: &Value) -> Option<Self> {
        match value {
            Value::Bool(value) => Some(Self::Bool(*value)),
            Value::Null => Some(Self::None),
            Value::Number(number) => Some(
                match number
                    .as_i64()
                    .map(i128::from)
                    .or_else(|| number.as_u64().map(i128::from))
                {
                    Some(int) => Self::Int(int),
                    None => Self::Float(number.as_f64()?),
                },
            ),
            Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("number") => {
                match map.get("value")?.as_str()? {
                    "nan" => Some(Self::Float(f64::NAN)),
                    "+inf" | "inf" => Some(Self::Float(f64::INFINITY)),
                    "-inf" => Some(Self::Float(f64::NEG_INFINITY)),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

impl Dtype {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "bool" => Self::Bool,
            "int8" => Self::I8,
            "uint8" => Self::U8,
            "int16" => Self::I16,
            "uint16" => Self::U16,
            "int32" => Self::I32,
            "uint32" => Self::U32,
            "int64" => Self::I64,
            "uint64" => Self::U64,
            "float32" => Self::F32,
            "float64" => Self::F64,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Bool => "bool",
            Self::I8 => "int8",
            Self::U8 => "uint8",
            Self::I16 => "int16",
            Self::U16 => "uint16",
            Self::I32 => "int32",
            Self::U32 => "uint32",
            Self::I64 => "int64",
            Self::U64 => "uint64",
            Self::F32 => "float32",
            Self::F64 => "float64",
        }
    }

    /// The dtype `np.asarray` gives a JSON list; `[]` is float64. Lists
    /// NumPy would hold as objects or strings cannot be appended to a
    /// typed column.
    fn infer(items: &[Value]) -> anyhow::Result<Self> {
        let (mut ints, mut floats, mut negative, mut wide) = (false, false, false, false);
        for item in items {
            match Scalar::parse(item) {
                Some(Scalar::Bool(_)) => {}
                Some(Scalar::Int(value)) => {
                    ints = true;
                    negative |= value < 0;
                    wide |= i64::try_from(value).is_err();
                }
                Some(Scalar::Float(_)) => floats = true,
                Some(Scalar::None) | None => {
                    anyhow::bail!("cannot append non-numeric value {item} to an ndarray column")
                }
            }
        }
        Ok(match (items.is_empty(), floats, ints) {
            (true, ..) | (_, true, _) => Self::F64,
            (_, _, true) if !wide => Self::I64,
            (_, _, true) if !negative => Self::U64,
            (_, _, true) => anyhow::bail!("integers outside int64 and uint64 cannot be appended"),
            _ => Self::Bool,
        })
    }

    /// NumPy's `result_type` for two arrays.
    fn promote(self, other: Self) -> Self {
        use Dtype::*;
        let signed = |size| match size {
            1 => I8,
            2 => I16,
            4 => I32,
            _ => I64,
        };
        let unsigned = |dtype: Self| matches!(dtype, U8 | U16 | U32 | U64);
        match (self, other) {
            (a, b) if a == b => a,
            (Bool, other) | (other, Bool) => other,
            (F64, _) | (_, F64) => F64,
            // float32 holds integers up to 16 bits exactly.
            (F32, int) | (int, F32) => {
                if int.size() <= 2 {
                    F32
                } else {
                    F64
                }
            }
            (a, b) if unsigned(a) == unsigned(b) => {
                if a.size() >= b.size() {
                    a
                } else {
                    b
                }
            }
            (a, b) => {
                let (int, uint) = if unsigned(a) { (b, a) } else { (a, b) };
                if int.size() > uint.size() {
                    int
                } else if uint.size() < 8 {
                    signed(uint.size() * 2)
                } else {
                    F64
                }
            }
        }
    }

    /// Values in `data` converted to `to`, which [`Self::promote`] chose,
    /// so the conversion is exact or rounds as NumPy does.
    fn cast(self, data: Vec<u8>, to: Self) -> anyhow::Result<Vec<u8>> {
        if self == to {
            return Ok(data);
        }
        let mut out = vec![0; data.len() / self.size() * to.size()];
        for (item, slot) in data
            .chunks_exact(self.size())
            .zip(out.chunks_exact_mut(to.size()))
        {
            to.write(&self.read(item), slot)?;
        }
        Ok(out)
    }

    fn size(self) -> usize {
        match self {
            Self::Bool | Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::I64 | Self::U64 | Self::F64 => 8,
        }
    }

    fn read(self, bytes: &[u8]) -> Value {
        match self {
            Self::Bool => Value::Bool(bytes[0] != 0),
            Self::I8 => Value::from(i8::from_le_bytes(le(bytes))),
            Self::U8 => Value::from(bytes[0]),
            Self::I16 => Value::from(i16::from_le_bytes(le(bytes))),
            Self::U16 => Value::from(u16::from_le_bytes(le(bytes))),
            Self::I32 => Value::from(i32::from_le_bytes(le(bytes))),
            Self::U32 => Value::from(u32::from_le_bytes(le(bytes))),
            Self::I64 => Value::from(i64::from_le_bytes(le(bytes))),
            Self::U64 => Value::from(u64::from_le_bytes(le(bytes))),
            Self::F32 => float_value(f64::from(f32::from_le_bytes(le(bytes)))),
            Self::F64 => float_value(f64::from_le_bytes(le(bytes))),
        }
    }

    /// Write `value` cast as NumPy assigns into this dtype: floats truncate
    /// into integers, `None` becomes NaN in floats. Values NumPy rejects
    /// (strings, NaN or out-of-range numbers into integers) are errors.
    fn write(self, value: &Value, out: &mut [u8]) -> anyhow::Result<()> {
        let rejected = || anyhow::anyhow!("cannot assign {value} to a {self:?} column");
        let scalar = Scalar::parse(value).ok_or_else(rejected)?;
        match self {
            Self::Bool => {
                out[0] = u8::from(match scalar {
                    Scalar::Bool(value) => value,
                    Scalar::Int(value) => value != 0,
                    Scalar::Float(value) => value != 0.0,
                    Scalar::None => false,
                });
            }
            Self::F32 | Self::F64 => {
                let float = match scalar {
                    Scalar::Bool(value) => f64::from(u8::from(value)),
                    Scalar::Int(value) => value as f64,
                    Scalar::Float(value) => value,
                    Scalar::None => f64::NAN,
                };
                if self == Self::F32 {
                    out.copy_from_slice(&(float as f32).to_le_bytes());
                } else {
                    out.copy_from_slice(&float.to_le_bytes());
                }
            }
            _ => {
                let int = match scalar {
                    Scalar::Bool(value) => i128::from(value),
                    Scalar::Int(value) => value,
                    Scalar::Float(value) if value.is_finite() => value.trunc() as i128,
                    Scalar::Float(_) | Scalar::None => return Err(rejected()),
                };
                let range = |_| rejected();
                match self {
                    Self::I8 => {
                        out.copy_from_slice(&i8::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::U8 => {
                        out.copy_from_slice(&u8::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::I16 => {
                        out.copy_from_slice(&i16::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::U16 => {
                        out.copy_from_slice(&u16::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::I32 => {
                        out.copy_from_slice(&i32::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::U32 => {
                        out.copy_from_slice(&u32::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::I64 => {
                        out.copy_from_slice(&i64::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::U64 => {
                        out.copy_from_slice(&u64::try_from(int).map_err(range)?.to_le_bytes())
                    }
                    Self::Bool | Self::F32 | Self::F64 => {}
                }
            }
        }
        Ok(())
    }
}

fn le<const N: usize>(bytes: &[u8]) -> [u8; N] {
    let mut out = [0; N];
    out.copy_from_slice(bytes);
    out
}

/// Bokeh's JSON for a float: non-finite values as `{"type": "number"}`.
fn float_value(value: f64) -> Value {
    if value.is_nan() {
        json!({"type": "number", "value": "nan"})
    } else if value.is_infinite() {
        json!({"type": "number", "value": if value > 0.0 { "+inf" } else { "-inf" }})
    } else {
        json!(value)
    }
}

fn expand_model(
    id: &str,
    models: &BTreeMap<String, (String, Map<String, Value>)>,
    emitted: &mut HashSet<String>,
) -> Value {
    if !emitted.insert(id.to_string()) {
        return json!({"id": id});
    }
    let (type_name, attributes) = &models[id];
    let attributes: Map<String, Value> = attributes
        .iter()
        .map(|(name, value)| (name.clone(), expand_refs(value, models, emitted)))
        .collect();
    json!({"type": "object", "name": type_name, "id": id, "attributes": attributes})
}

fn expand_refs(
    value: &Value,
    models: &BTreeMap<String, (String, Map<String, Value>)>,
    emitted: &mut HashSet<String>,
) -> Value {
    match value {
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(id) = map.get("id").and_then(Value::as_str) {
                    if models.contains_key(id) {
                        return expand_model(id, models, emitted);
                    }
                }
            }
            Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), expand_refs(value, models, emitted)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| expand_refs(item, models, emitted))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The output's session payload with `snapshot` set to the frozen state.
/// Its buffers are inlined, so `snapshot.buffers` is empty. Fails when the
/// tail cannot be replayed; callers keep the stored payload.
pub(crate) async fn frozen_payload(
    payload: &Value,
    state: &SnapshotWithTail,
    blob_store: &BlobStore,
) -> anyhow::Result<Value> {
    let mut payload = payload.clone();
    let object = payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Bokeh session payload must be an object"))?;
    object.insert(
        "snapshot".to_string(),
        json!({
            "document": materialize_doc_json(state, blob_store).await?,
            "buffers": [],
        }),
    );
    object.remove("session_doc");
    object.remove("session_doc_buffers");
    Ok(payload)
}

/// On kernel loss, write the frozen payload as a blob and point the
/// session's output at it, so reloads render the last state read-only.
pub(crate) async fn freeze_session_output(
    session_id: &str,
    session: &SnapshotWithTail,
    state: &RuntimeStateHandle,
    actor: Option<&str>,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<()> {
    let Some(record) = state.read(|doc| doc.get_bokeh_session(session_id))? else {
        anyhow::bail!("unknown Bokeh session {session_id}");
    };
    let Some(manifest) =
        state.read(|doc| doc.get_output(&record.execution_id, &record.output_id))?
    else {
        anyhow::bail!("Bokeh session {session_id} has no output");
    };
    let stored = manifest
        .get("data")
        .and_then(|data| data.get(BOKEH_SESSION_MIME))
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("output for {session_id} has no session payload"))?;
    let content: ContentRef = serde_json::from_value(stored.clone())?;
    let payload: Value = serde_json::from_str(&content.resolve(blob_store).await?)?;
    // The stored payload is the display-time document, older than any fold,
    // so a tail that cannot be replayed freezes the folded state instead.
    let frozen = match frozen_payload(&payload, session, blob_store).await {
        Ok(frozen) => frozen,
        Err(error) => {
            warn!("[bokeh-session] Freezing {session_id} without its retained tail: {error}");
            frozen_payload(&payload, &session.folded(), blob_store).await?
        }
    };
    let frozen = serde_json::to_vec(&frozen)?;
    let hash = blob_store.put(&frozen, BOKEH_SESSION_MIME).await?;
    blob_publisher
        .publish_artifact(
            hash.clone(),
            frozen.len() as u64,
            BOKEH_SESSION_MIME.to_string(),
            blob_store,
        )
        .await?;
    let frozen_ref = serde_json::to_value(ContentRef::Blob {
        blob: hash,
        size: frozen.len() as u64,
    })?;
    // Compare-and-swap against the manifest as it is now: a late
    // `update_display_data` from the dying kernel can land during the awaits
    // above. A newer session payload wins; other changes are kept.
    let written = state.transact_at_current_heads(actor, "runtime-state-bokeh-freeze", |doc| {
        let Some(mut current) = doc.get_output(&record.execution_id, &record.output_id) else {
            return Ok(false);
        };
        if current
            .get("data")
            .and_then(|data| data.get(BOKEH_SESSION_MIME))
            != Some(&stored)
        {
            return Ok(false);
        }
        current["data"][BOKEH_SESSION_MIME] = frozen_ref;
        doc.replace_output(&record.execution_id, &record.output_id, &current)
    })?;
    if !written {
        warn!("[bokeh-session] Not freezing {session_id}: its output changed while freezing");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::protocol::BokehSessionBufferRef;
    use runtime_doc::{BokehModelState, BokehSessionMeta};

    fn envelope(
        data_events: Vec<Value>,
        buffers: Vec<BokehSessionBufferRef>,
    ) -> BokehSessionEvents {
        BokehSessionEvents {
            session_id: "s".into(),
            epoch: 0,
            transaction_id: "tx".into(),
            data_events,
            messages: Vec::new(),
            buffers,
        }
    }

    fn source(version: u64, columns: &[(&str, Value)]) -> BTreeMap<String, SourceColumns> {
        BTreeMap::from([(
            "p3".to_string(),
            SourceColumns {
                version,
                columns: columns
                    .iter()
                    .map(|(name, value)| (name.to_string(), value.clone()))
                    .collect(),
            },
        )])
    }

    fn float64(values: &[f64], encoding: BytesEncoding) -> Value {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        json!({
            "type": "ndarray", "dtype": "float64", "order": "little", "shape": [values.len()],
            "array": {"type": "bytes", "data": encoding.encode(&bytes).unwrap()},
        })
    }

    fn floats(column: &Value, encoding: BytesEncoding) -> Vec<f64> {
        let data = encoding
            .decode(column["array"]["data"].as_str().unwrap())
            .unwrap();
        data.chunks_exact(8)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
            .collect()
    }

    fn event(value: Value) -> BokehSessionEvents {
        envelope(vec![value], Vec::new())
    }

    fn int64(values: &[i64]) -> Value {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        json!({
            "type": "ndarray", "dtype": "int64", "order": "little", "shape": [values.len()],
            "array": {"type": "bytes", "data": BytesEncoding::Base64.encode(&bytes).unwrap()},
        })
    }

    fn patch(base: u64, x: Value) -> BokehSessionEvents {
        event(
            json!({"kind": "ColumnsPatched", "source_id": "p3", "base_version": base,
                     "new_version": base + 1, "patches": {"x": x}}),
        )
    }

    #[tokio::test]
    async fn tail_streams_with_rollover_and_patches_lists() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let sources = source(2, &[("x", json!([1, 2, 3])), ("y", json!(["a", "b", "c"]))]);
        let tail = vec![
            // Already folded into the columns.
            event(
                json!({"kind": "ColumnsStreamed", "source_id": "p3", "base_version": 1,
                         "new_version": 2, "data": {"x": [99]}, "rollover": null}),
            ),
            event(
                json!({"kind": "ColumnsStreamed", "source_id": "p3", "base_version": 2,
                         "new_version": 3, "rollover": 4,
                         "data": {"type": "map", "entries": [["x", [4, 5]], ["y", ["d", "e"]]]}}),
            ),
            event(
                json!({"kind": "ColumnsPatched", "source_id": "p3", "base_version": 3,
                "new_version": 4, "patches": {"type": "map", "entries": [
                    ["x", [[0, 20], [-1, 50]]],
                    ["y", [[{"type": "slice", "start": 1, "stop": null, "step": 2}, ["D", "E"]]]],
                ]}}),
            ),
        ];
        let sources = apply_tail(sources, &tail, BytesEncoding::Base64, &blobs)
            .await
            .unwrap();
        let source = &sources["p3"];
        assert_eq!(source.version, 4);
        assert_eq!(source.columns["x"], json!([20, 3, 4, 50]));
        assert_eq!(source.columns["y"], json!(["b", "D", "d", "E"]));
    }

    #[tokio::test]
    async fn tail_keeps_typed_columns_typed_and_resolves_event_buffers() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let encoding = BytesEncoding::GzipBase64;
        let chunk: Vec<u8> = [3.0f64, 4.0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let chunk_blob = blobs.put(&chunk, "application/octet-stream").await.unwrap();
        let sources = source(0, &[("x", float64(&[1.0, 2.0], encoding))]);
        let tail = vec![
            envelope(
                vec![
                    json!({"kind": "ColumnsStreamed", "source_id": "p3", "base_version": 0,
                    "new_version": 1, "rollover": 3, "data": {"type": "map", "entries": [["x", {
                        "type": "ndarray", "dtype": "float64", "order": "little", "shape": [2],
                        "array": {"type": "bytes", "data": {"id": "b1"}},
                    }]]}}),
                ],
                vec![BokehSessionBufferRef {
                    id: "b1".into(),
                    blob: chunk_blob,
                    size: chunk.len() as u64,
                    media_type: "application/octet-stream".into(),
                }],
            ),
            patch(
                1,
                json!([[1, {"type": "number", "value": "nan"}], [2, null]]),
            ),
        ];
        let sources = apply_tail(sources, &tail, encoding, &blobs).await.unwrap();
        let column = &sources["p3"].columns["x"];
        assert_eq!(column["type"], "ndarray");
        assert_eq!(column["shape"], json!([3]));
        let values = floats(column, encoding);
        assert_eq!(values[0], 2.0);
        assert!(values[1].is_nan());
        assert!(values[2].is_nan(), "None assigns NaN, as in NumPy");
    }

    #[tokio::test]
    async fn typed_patches_cast_like_numpy_or_fail() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let encoding = BytesEncoding::Base64;
        let sources = source(0, &[("x", int64(&[0, 0, 0]))]);
        let tail = vec![patch(0, json!([[0, 1.5], [1, -2.7], [2, true]]))];
        let sources = apply_tail(sources, &tail, encoding, &blobs).await.unwrap();
        assert_eq!(sources["p3"].columns["x"], int64(&[1, -2, 1]));

        for (column, value) in [
            (float64(&[1.0], encoding), json!("n/a")),
            (int64(&[1]), json!({"type": "number", "value": "nan"})),
            (int64(&[1]), json!(1e30)),
        ] {
            let error = apply_tail(
                source(0, &[("x", column)]),
                &[patch(0, json!([[0, value]]))],
                encoding,
                &blobs,
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("cannot assign"), "{error}");
        }
    }

    fn stream(base: u64, x: Value) -> BokehSessionEvents {
        event(
            json!({"kind": "ColumnsStreamed", "source_id": "p3", "base_version": base,
                     "new_version": base + 1, "data": {"x": x}, "rollover": null}),
        )
    }

    fn ndarray(dtype: &str, bytes: &[u8], len: usize) -> Value {
        json!({
            "type": "ndarray", "dtype": dtype, "order": "little", "shape": [len],
            "array": {"type": "bytes", "data": BytesEncoding::Base64.encode(bytes).unwrap()},
        })
    }

    async fn replay_x(column: Value, tail: &[BokehSessionEvents]) -> anyhow::Result<Value> {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let sources = apply_tail(
            source(0, &[("x", column)]),
            tail,
            BytesEncoding::Base64,
            &blobs,
        )
        .await?;
        Ok(sources["p3"].columns["x"].clone())
    }

    /// `np.append` keeps an ndarray column typed, so later patches still
    /// cast to its dtype.
    #[tokio::test]
    async fn streaming_a_list_onto_an_ndarray_keeps_it_typed() {
        let x = replay_x(
            int64(&[1, 2]),
            &[stream(0, json!([3])), patch(1, json!([[0, 2.7]]))],
        )
        .await
        .unwrap();
        assert_eq!(x, int64(&[2, 2, 3]));

        let encoding = BytesEncoding::Base64;
        let x = replay_x(
            float64(&[1.0], encoding),
            &[stream(0, json!([2, true])), patch(1, json!([[0, null]]))],
        )
        .await
        .unwrap();
        assert_eq!(x["dtype"], "float64");
        let values = floats(&x, encoding);
        assert!(values[0].is_nan(), "None assigns NaN, as in NumPy");
        assert_eq!(values[1..], [2.0, 1.0]);
    }

    #[tokio::test]
    async fn streams_promote_to_the_common_dtype() {
        let encoding = BytesEncoding::Base64;
        let x = replay_x(int64(&[1]), &[stream(0, float64(&[2.5], encoding))])
            .await
            .unwrap();
        assert_eq!(x, float64(&[1.0, 2.5], encoding));

        let x = replay_x(int64(&[1]), &[stream(0, json!([2.5]))])
            .await
            .unwrap();
        assert_eq!(x, float64(&[1.0, 2.5], encoding));

        let x = replay_x(
            ndarray("int8", &[0xff], 1),
            &[stream(0, ndarray("uint8", &[200], 1))],
        )
        .await
        .unwrap();
        let int16: Vec<u8> = [-1i16, 200].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(x, ndarray("int16", &int16, 2));

        // A list column takes the ndarray's side, as `np.append` does.
        let x = replay_x(json!([1, 2]), &[stream(0, int64(&[3]))])
            .await
            .unwrap();
        assert_eq!(x, int64(&[1, 2, 3]));
    }

    #[tokio::test]
    async fn empty_chunks_append_nothing() {
        let x = replay_x(int64(&[1]), &[stream(0, int64(&[]))])
            .await
            .unwrap();
        assert_eq!(x, int64(&[1]));
        // `np.asarray([])` is float64, so NumPy promotes the column.
        let x = replay_x(int64(&[1]), &[stream(0, json!([]))])
            .await
            .unwrap();
        assert_eq!(x, float64(&[1.0], BytesEncoding::Base64));
        let x = replay_x(json!([1]), &[stream(0, json!([]))]).await.unwrap();
        assert_eq!(x, json!([1]));
    }

    #[tokio::test]
    async fn non_numeric_chunks_onto_an_ndarray_are_replay_errors() {
        for chunk in [json!(["a"]), json!([1, null]), json!([[1]])] {
            let error = replay_x(int64(&[1]), &[stream(0, chunk)])
                .await
                .unwrap_err();
            assert!(error.to_string().contains("non-numeric"), "{error}");
        }
        let error = replay_x(
            json!([1]),
            &[event(json!({
                "kind": "ColumnsStreamed", "source_id": "p3", "base_version": 0,
                "new_version": 1, "data": {"y": [1]}, "rollover": null,
            }))],
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("does not exist"), "{error}");
    }

    #[tokio::test]
    async fn tail_replacements_load_their_blobs() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let replaced = blobs.put(br#"[7,8]"#, "application/json").await.unwrap();
        let sources = source(0, &[("x", json!([1])), ("y", json!([1]))]);
        let tail = vec![
            event(
                json!({"kind": "ColumnDataChanged", "source_id": "p3", "base_version": 0,
                         "new_version": 1, "columns_removed": ["y"],
                         "columns": {"x": {"blob": replaced, "size": 5, "version": 1}}}),
            ),
            event(
                json!({"kind": "ColumnsStreamed", "source_id": "p3", "base_version": 1,
                         "new_version": 2, "data": {"x": [10]}, "rollover": null}),
            ),
        ];
        let sources = apply_tail(sources, &tail, BytesEncoding::Base64, &blobs)
            .await
            .unwrap();
        let source = &sources["p3"];
        assert_eq!(source.version, 2);
        assert_eq!(
            source.columns,
            BTreeMap::from([("x".to_string(), json!([7, 8, 10]))])
        );
    }

    #[tokio::test]
    async fn tails_that_cannot_be_replayed_are_errors() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let missing_buffer = envelope(
            vec![
                json!({"kind": "ColumnsStreamed", "source_id": "p3", "base_version": 0,
                "new_version": 1, "rollover": null, "data": {"x": {
                    "type": "ndarray", "dtype": "float64", "order": "little", "shape": [1],
                    "array": {"type": "bytes", "data": {"id": "b1"}},
                }}}),
            ],
            vec![BokehSessionBufferRef {
                id: "b1".into(),
                blob: "0".repeat(64),
                size: 8,
                media_type: "application/octet-stream".into(),
            }],
        );
        for (tail, expected) in [
            (vec![patch(1, json!([[0, 9]]))], "gap"),
            (vec![patch(0, json!([[[0, 1], 9]]))], "multi-dimensional"),
            (vec![missing_buffer], "missing"),
        ] {
            let error = apply_tail(
                source(0, &[("x", json!([1]))]),
                &tail,
                BytesEncoding::Base64,
                &blobs,
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[test]
    fn replay_decodes_each_touched_column_once() {
        let encoding = BytesEncoding::Base64;
        let sources = source(
            0,
            &[
                ("x", float64(&[1.0, 2.0], encoding)),
                ("y", json!([1, 2])),
                ("z", json!([0])),
            ],
        );
        let prepared = |base: u64, event: Value| PreparedEvent {
            new_version: base + 1,
            event,
            buffers: BufferMap::new(),
            replaced: BTreeMap::new(),
        };
        let mut events = Vec::new();
        for base in 0..50 {
            events.push(prepared(
                base,
                json!({"kind": "ColumnsPatched", "patches": {"x": [[0, base]]}}),
            ));
        }
        events.push(prepared(
            50,
            json!({"kind": "ColumnsStreamed", "rollover": 2,
                                        "data": {"x": [9.0], "y": [3]}}),
        ));
        let plan = ReplayPlan::from([("p3".to_string(), events)]);
        let (replayed, stats) = replay(sources, plan, encoding).unwrap();
        assert_eq!(
            stats,
            ReplayStats {
                decoded_columns: 2,
                encoded_columns: 2,
            },
            "x and y, each once; z untouched"
        );
        let source = &replayed["p3"];
        assert_eq!(source.version, 51);
        assert_eq!(source.columns["x"], float64(&[2.0, 9.0], encoding));
        assert_eq!(source.columns["y"], json!([2, 3]));
        assert_eq!(source.columns["z"], json!([0]));
    }

    #[tokio::test]
    async fn doc_json_expands_roots_and_inlines_columns_and_blobs() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let column = blobs.put(br#"[1,2,3]"#, "application/json").await.unwrap();
        let title = blobs
            .put(br#""A long title""#, "application/json")
            .await
            .unwrap();
        let model = |type_name: &str, props: &[(&str, String)]| BokehModelState {
            type_name: type_name.into(),
            ref_props: Vec::new(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        };
        let snapshot = BokehSessionSnapshot {
            epoch: 3,
            meta: BokehSessionMeta {
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: Some("Page".into()),
                doc_extras: Some(r#"{"defs":[]}"#.into()),
                ..Default::default()
            },
            models: BTreeMap::from([
                (
                    "p1".to_string(),
                    model(
                        "Row",
                        &[(
                            "children",
                            r#"[{"id":"p2"},{"id":"p3"},{"id":"p2"}]"#.into(),
                        )],
                    ),
                ),
                (
                    "p2".to_string(),
                    model(
                        "Div",
                        &[(
                            "text",
                            BokehBlobRef {
                                blob: title,
                                size: 14,
                                media_type: "application/json".into(),
                            }
                            .encode(),
                        )],
                    ),
                ),
                ("p3".to_string(), model("ColumnDataSource", &[])),
                ("orphan".to_string(), model("Div", &[])),
            ]),
            columns: BTreeMap::from([(
                "p3".to_string(),
                BTreeMap::from([(
                    "x".to_string(),
                    BokehColumnRef {
                        blob: column,
                        size: 7,
                        version: 4,
                    },
                )]),
            )]),
        };
        let state = SnapshotWithTail {
            snapshot,
            ..Default::default()
        };
        let doc = materialize_doc_json(&state, &blobs).await.unwrap();
        assert_eq!(doc["version"], "3.9.2");
        assert_eq!(doc["title"], "Page");
        assert_eq!(doc["defs"], json!([]));
        let root = &doc["roots"][0];
        assert_eq!(root["name"], "Row");
        let children = &root["attributes"]["children"];
        assert_eq!(children[0]["attributes"]["text"], "A long title");
        assert_eq!(
            children[1]["attributes"]["data"]["entries"][0],
            json!(["x", [1, 2, 3]])
        );
        assert_eq!(
            children[2],
            json!({"id": "p2"}),
            "later references stay refs"
        );
        assert!(!doc.to_string().contains("orphan"));

        let payload =
            json!({"session_id": "s", "document": {}, "session_doc": {}, "buffers": [{"id": "b"}]});
        let frozen = frozen_payload(&payload, &state, &blobs).await.unwrap();
        assert_eq!(frozen["snapshot"], json!({"document": doc, "buffers": []}));
        assert_eq!(
            frozen["document"],
            json!({}),
            "the display-time payload is kept"
        );
        assert_eq!(frozen["buffers"], json!([{"id": "b"}]));
        assert!(frozen.get("session_doc").is_none());

        // A second freeze replaces the snapshot and still keeps `document`.
        let refrozen = frozen_payload(&frozen, &state, &blobs).await.unwrap();
        assert_eq!(refrozen, frozen);
    }

    /// Item 5 (review 2026-10-29): a value, extras or column blob that no
    /// longer exists drops only that entry, so every later freeze and save
    /// does not fail on it.
    #[tokio::test]
    async fn missing_blobs_drop_only_their_values() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let kept = blobs.put(br#"[1,2]"#, "application/json").await.unwrap();
        let missing = |size| {
            BokehBlobRef {
                blob: "0".repeat(64),
                size,
                media_type: "application/json".into(),
            }
            .encode()
        };
        let snapshot = BokehSessionSnapshot {
            meta: BokehSessionMeta {
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                doc_extras: Some(missing(10)),
                ..Default::default()
            },
            models: BTreeMap::from([(
                "p1".to_string(),
                BokehModelState {
                    type_name: "ColumnDataSource".into(),
                    ref_props: Vec::new(),
                    props: BTreeMap::from([
                        ("name".to_string(), r#""src""#.to_string()),
                        ("tags".to_string(), missing(2000)),
                    ]),
                },
            )]),
            columns: BTreeMap::from([(
                "p1".to_string(),
                BTreeMap::from([
                    (
                        "x".to_string(),
                        BokehColumnRef {
                            blob: kept,
                            size: 5,
                            version: 1,
                        },
                    ),
                    (
                        "y".to_string(),
                        BokehColumnRef {
                            blob: "1".repeat(64),
                            size: 5,
                            version: 1,
                        },
                    ),
                ]),
            )]),
            ..Default::default()
        };
        let state = SnapshotWithTail {
            snapshot,
            ..Default::default()
        };
        let doc = materialize_doc_json(&state, &blobs).await.unwrap();
        let attributes = &doc["roots"][0]["attributes"];
        assert_eq!(attributes["name"], "src");
        assert!(attributes.get("tags").is_none());
        assert_eq!(
            attributes["data"]["entries"],
            json!([["x", [1, 2]]]),
            "the missing column is dropped"
        );
        assert!(doc.get("defs").is_none());
    }
}
