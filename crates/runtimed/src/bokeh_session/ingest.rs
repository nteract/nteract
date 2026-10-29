//! Kernel delta ingest: parse the launcher's `nteract_bokeh_delta` messages,
//! coalesce them, move large values and column data to the blob store, and
//! turn data events into column refs, broadcasts and the late-joiner tail.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use base64::Engine;
use notebook_protocol::protocol::{BlobDurability, BokehSessionBufferRef};
use runtime_doc::{
    bokeh_prop_needs_blob, BokehBlobRef, BokehColumnRef, BokehModelState, BokehSessionMeta,
    BokehSessionSnapshot, BOKEH_PROP_BLOB_THRESHOLD,
};
use serde_json::{Map, Value};
use tracing::warn;

use super::{
    hex_sha256, required_str, BOKEH_BUFFER_MEDIA_TYPE, BOKEH_COLUMN_MEDIA_TYPE,
    BOKEH_PROP_MEDIA_TYPE, BOKEH_WIRE_SCHEMA_VERSION,
};
use crate::blob_store::{BlobStore, EphemeralBlobLease, EphemeralBlobOwner};
use crate::output_blob_publisher::OutputBlobPublisher;

pub(crate) type BufferMap = HashMap<String, Vec<u8>>;

/// Blob writes that peers may read, published to the cloud room when set.
pub(crate) struct BlobSink<'a> {
    store: &'a BlobStore,
    publisher: &'a OutputBlobPublisher,
    owner: Option<&'a EphemeralBlobOwner>,
    leases: std::sync::Mutex<HashMap<String, EphemeralBlobLease>>,
}

impl<'a> BlobSink<'a> {
    pub(crate) fn new(store: &'a BlobStore, publisher: &'a OutputBlobPublisher) -> Self {
        Self {
            store,
            publisher,
            owner: None,
            leases: Default::default(),
        }
    }

    pub(crate) fn leased(
        store: &'a BlobStore,
        publisher: &'a OutputBlobPublisher,
        owner: &'a EphemeralBlobOwner,
    ) -> Self {
        Self {
            store,
            publisher,
            owner: Some(owner),
            leases: Default::default(),
        }
    }

    pub(crate) fn take_leases(&self) -> HashMap<String, EphemeralBlobLease> {
        std::mem::take(
            &mut *self
                .leases
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    async fn put(
        &self,
        bytes: &[u8],
        media_type: &str,
        durability: BlobDurability,
    ) -> anyhow::Result<String> {
        let hash = if let Some(owner) = self
            .owner
            .filter(|_| durability == BlobDurability::Ephemeral)
        {
            let lease = owner.next_lease();
            let hash = self
                .store
                .put_leased_ephemeral(bytes, media_type, &lease)
                .await?;
            {
                let mut leases = self
                    .leases
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let existing = leases.entry(hash.clone()).or_insert_with(|| lease.clone());
                if existing.generation < lease.generation {
                    *existing = lease;
                }
            }
            hash
        } else {
            self.store
                .put_with_durability(bytes, media_type, durability)
                .await?
        };
        self.publisher
            .publish_artifact(
                hash.clone(),
                bytes.len() as u64,
                media_type.to_string(),
                self.store,
            )
            .await?;
        Ok(hash)
    }
}

/// Buffers referenced by blob hash, as in the display payload's
/// `session_doc_buffers` (the launcher stashed them through `BLOB_REF_MIME`).
pub(crate) async fn stored_buffers(
    descriptors: Option<&Value>,
    blob_store: &BlobStore,
) -> anyhow::Result<BufferMap> {
    let mut buffers = BufferMap::new();
    for descriptor in descriptors.and_then(Value::as_array).into_iter().flatten() {
        let id = required_str(descriptor, "id")?;
        let hash = required_str(descriptor, "hash")?;
        let data = blob_store
            .get(hash)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer {hash} is missing from blob storage"))?;
        validate_buffer(descriptor, &data)?;
        buffers.insert(id.to_string(), data);
    }
    Ok(buffers)
}

/// Buffers carried by the Jupyter message, indexed by `buffer_index`.
fn wire_buffers(descriptors: Option<&Value>, raw: &[Vec<u8>]) -> anyhow::Result<BufferMap> {
    let mut buffers = BufferMap::new();
    for descriptor in descriptors.and_then(Value::as_array).into_iter().flatten() {
        let id = required_str(descriptor, "id")?;
        let index = descriptor
            .get("buffer_index")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer {id} is missing buffer_index"))?
            as usize;
        let data = raw
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer index {index} is out of range"))?;
        validate_buffer(descriptor, data)?;
        buffers.insert(id.to_string(), data.clone());
    }
    Ok(buffers)
}

fn validate_buffer(descriptor: &Value, data: &[u8]) -> anyhow::Result<()> {
    if let Some(size) = descriptor.get("size").and_then(Value::as_u64) {
        anyhow::ensure!(
            size == data.len() as u64,
            "Bokeh buffer size mismatch: expected {size}, got {}",
            data.len()
        );
    }
    if let Some(expected) = descriptor.get("hash").and_then(Value::as_str) {
        let actual = hex_sha256(data);
        anyhow::ensure!(
            expected == actual,
            "Bokeh buffer hash mismatch: expected {expected}, got {actual}"
        );
    }
    Ok(())
}

/// A data event or message with the transaction that produced it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Tagged {
    pub(crate) transaction_id: String,
    pub(crate) value: Value,
}

/// One or more coalesced kernel deltas for a session, before blob offload.
#[derive(Debug, Default)]
pub(crate) struct KernelDelta {
    pub(crate) session_id: String,
    pub(crate) meta: Map<String, Value>,
    pub(crate) models_added: BTreeMap<String, Value>,
    pub(crate) props_changed: BTreeMap<String, BTreeMap<String, Value>>,
    pub(crate) models_removed: BTreeSet<String>,
    pub(crate) data_events: Vec<Tagged>,
    pub(crate) messages: Vec<Tagged>,
    pub(crate) buffers: BufferMap,
}

impl KernelDelta {
    pub(crate) fn parse(content: &Value, raw_buffers: &[Vec<u8>]) -> anyhow::Result<Self> {
        anyhow::ensure!(
            content.get("schema_version").and_then(Value::as_u64)
                == Some(BOKEH_WIRE_SCHEMA_VERSION),
            "unsupported Bokeh delta schema"
        );
        let session_id = required_str(content, "session_id")?.to_string();
        let transaction_id = required_str(content, "transaction_id")?.to_string();
        let object = |key: &str| -> Map<String, Value> {
            content
                .get(key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        };
        let tagged = |key: &str| -> Vec<Tagged> {
            content
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|value| Tagged {
                    transaction_id: transaction_id.clone(),
                    value: value.clone(),
                })
                .collect()
        };
        let props_changed = object("props_changed")
            .into_iter()
            .filter_map(|(id, props)| match props {
                Value::Object(props) => Some((id, props.into_iter().collect())),
                _ => None,
            })
            .collect();
        let models_removed = content
            .get("models_removed")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect();
        let mut delta = Self {
            session_id,
            meta: object("meta"),
            models_added: object("models_added").into_iter().collect(),
            props_changed,
            models_removed,
            data_events: Vec::new(),
            messages: tagged("messages"),
            buffers: wire_buffers(content.get("buffers"), raw_buffers)?,
        };
        for event in tagged("data_events") {
            delta.push_data_event(event);
        }
        Ok(delta)
    }

    /// Fold a later delta for the same session into this one.
    pub(crate) fn merge(&mut self, later: KernelDelta) {
        self.meta.extend(later.meta);
        for id in later.models_removed {
            self.models_added.remove(&id);
            self.props_changed.remove(&id);
            self.models_removed.insert(id);
        }
        for (id, model) in later.models_added {
            self.models_removed.remove(&id);
            self.props_changed.remove(&id);
            self.models_added.insert(id, model);
        }
        for (id, props) in later.props_changed {
            if let Some(Value::Object(model_props)) = self
                .models_added
                .get_mut(&id)
                .and_then(|model| model.get_mut("props"))
            {
                model_props.extend(props);
            } else {
                self.props_changed.entry(id).or_default().extend(props);
            }
        }
        for event in later.data_events {
            self.push_data_event(event);
        }
        self.messages.extend(later.messages);
        self.buffers.extend(later.buffers);
    }

    /// Append a data event. A full-column replacement that covers every
    /// column touched by the source's still-pending events replaces them,
    /// so intermediate frames never reach the blob store under backpressure.
    fn push_data_event(&mut self, mut event: Tagged) {
        if event_kind(&event.value) == Some("ColumnDataChanged") {
            if let (Some(source_id), Some(covered)) = (
                event_source(&event.value).map(str::to_string),
                event_columns(&event.value),
            ) {
                let pending: Vec<usize> = self
                    .data_events
                    .iter()
                    .enumerate()
                    .filter(|(_, pending)| event_source(&pending.value) == Some(&source_id))
                    .map(|(index, _)| index)
                    .collect();
                let superseded = !pending.is_empty()
                    && pending.iter().all(|index| {
                        event_columns(&self.data_events[*index].value)
                            .is_some_and(|columns| columns.is_subset(&covered))
                    });
                if superseded {
                    let base = event_base_version(&self.data_events[pending[0]].value);
                    for index in pending.into_iter().rev() {
                        self.data_events.remove(index);
                    }
                    if let (Some(base), Some(object)) = (base, event.value.as_object_mut()) {
                        object.insert("base_version".to_string(), Value::from(base));
                    }
                }
            }
        }
        self.data_events.push(event);
    }
}

pub(crate) fn event_kind(event: &Value) -> Option<&str> {
    event.get("kind").and_then(Value::as_str)
}

pub(crate) fn event_source(event: &Value) -> Option<&str> {
    event.get("source_id").and_then(Value::as_str)
}

pub(crate) fn event_base_version(event: &Value) -> Option<u64> {
    event
        .get("base_version")
        .or_else(|| event.get("version"))
        .and_then(Value::as_u64)
}

/// Columns a data event reads or writes; `None` for an unknown kind.
fn event_columns(event: &Value) -> Option<BTreeSet<String>> {
    match event_kind(event)? {
        "ColumnsStreamed" => Some(encoded_map_keys(event.get("data")?)),
        "ColumnsPatched" => Some(encoded_map_keys(event.get("patches")?)),
        "ColumnsFolded" => Some(encoded_map_keys(event.get("columns")?)),
        "ColumnDataChanged" => {
            let mut columns = encoded_map_keys(event.get("columns")?);
            columns.extend(
                event
                    .get("columns_removed")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|name| name.as_str().map(str::to_string)),
            );
            Some(columns)
        }
        _ => None,
    }
}

/// Keys of a plain JSON object or of Bokeh's `{"type": "map", "entries"}`.
fn encoded_map_keys(value: &Value) -> BTreeSet<String> {
    match value {
        Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("map") => map
            .get("entries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get(0).and_then(Value::as_str).map(str::to_string))
            .collect(),
        Value::Object(map) => map.keys().cloned().collect(),
        _ => BTreeSet::new(),
    }
}

/// How a Bokeh version expects base64 `bytes` values: BokehJS 3.8+
/// gunzips every base64 buffer unconditionally, older versions never do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BytesEncoding {
    Base64,
    GzipBase64,
}

impl BytesEncoding {
    pub(crate) fn for_bokeh_version(version: &str) -> Self {
        let mut parts = version.split('.').map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u64>().ok()
        });
        match (parts.next().flatten(), parts.next().flatten()) {
            (Some(major), Some(minor)) if (major, minor) < (3, 8) => Self::Base64,
            _ => Self::GzipBase64,
        }
    }

    pub(crate) fn encode(self, data: &[u8]) -> anyhow::Result<String> {
        let engine = base64::engine::general_purpose::STANDARD;
        match self {
            Self::Base64 => Ok(engine.encode(data)),
            Self::GzipBase64 => {
                use std::io::Write as _;
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(data)?;
                Ok(engine.encode(encoder.finish()?))
            }
        }
    }

    /// Inverse of [`Self::encode`].
    pub(crate) fn decode(self, data: &str) -> anyhow::Result<Vec<u8>> {
        let decoded = base64::engine::general_purpose::STANDARD.decode(data)?;
        match self {
            Self::Base64 => Ok(decoded),
            Self::GzipBase64 => {
                use std::io::Read as _;
                let mut out = Vec::new();
                flate2::read::GzDecoder::new(&decoded[..]).read_to_end(&mut out)?;
                Ok(out)
            }
        }
    }
}

/// Replace `{"type": "bytes", "data": {"id": ...}}` with base64 data.
pub(crate) fn inline_buffers(
    value: &Value,
    buffers: &BufferMap,
    encoding: BytesEncoding,
) -> anyhow::Result<Value> {
    Ok(match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("bytes") {
                if let Some(id) = map
                    .get("data")
                    .and_then(|data| data.get("id"))
                    .and_then(Value::as_str)
                {
                    let data = buffers
                        .get(id)
                        .ok_or_else(|| anyhow::anyhow!("Bokeh buffer {id} was not sent"))?;
                    let mut inlined = map.clone();
                    inlined.insert("data".to_string(), Value::String(encoding.encode(data)?));
                    return Ok(Value::Object(inlined));
                }
            }
            Value::Object(
                map.iter()
                    .map(|(key, value)| {
                        Ok((key.clone(), inline_buffers(value, buffers, encoding)?))
                    })
                    .collect::<anyhow::Result<_>>()?,
            )
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| inline_buffers(item, buffers, encoding))
                .collect::<anyhow::Result<_>>()?,
        ),
        other => other.clone(),
    })
}

pub(crate) fn referenced_buffer_ids(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("bytes") {
                if let Some(id) = map
                    .get("data")
                    .and_then(|data| data.get("id"))
                    .and_then(Value::as_str)
                {
                    out.insert(id.to_string());
                    return;
                }
            }
            map.values()
                .for_each(|value| referenced_buffer_ids(value, out));
        }
        Value::Array(items) => items
            .iter()
            .for_each(|item| referenced_buffer_ids(item, out)),
        _ => {}
    }
}

/// Re-encode a value as the JSON string the document stores, moving it to
/// the blob store when `bokeh_prop_needs_blob` says so.
async fn encode_value(value: &Value, sink: &BlobSink<'_>) -> anyhow::Result<String> {
    let encoded = serde_json::to_string(value)?;
    if !bokeh_prop_needs_blob(&encoded) {
        return Ok(encoded);
    }
    let hash = sink
        .put(
            encoded.as_bytes(),
            BOKEH_PROP_MEDIA_TYPE,
            BlobDurability::Durable,
        )
        .await?;
    Ok(BokehBlobRef {
        blob: hash,
        size: encoded.len() as u64,
        media_type: BOKEH_PROP_MEDIA_TYPE.to_string(),
    }
    .encode())
}

async fn encode_model(model: &Value, sink: &BlobSink<'_>) -> anyhow::Result<BokehModelState> {
    let mut props = BTreeMap::new();
    for (name, value) in model
        .get("props")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        props.insert(name.clone(), encode_value(value, sink).await?);
    }
    Ok(BokehModelState {
        type_name: required_str(model, "type")?.to_string(),
        ref_props: model
            .get("ref_props")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|prop| prop.as_str().map(str::to_string))
            .collect(),
        props,
    })
}

/// Partial meta from a delta, with `doc_extras` already encoded. Absent
/// fields keep the stored value; `title`/`doc_extras` may be cleared.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct MetaPatch {
    session_id: Option<String>,
    producer_name: Option<String>,
    producer_version: Option<String>,
    bokeh_version: Option<String>,
    root_ids: Option<Vec<String>>,
    title: Option<Option<String>>,
    doc_extras: Option<Option<String>>,
}

impl MetaPatch {
    async fn encode(partial: &Map<String, Value>, sink: &BlobSink<'_>) -> anyhow::Result<Self> {
        let string = |key: &str| partial.get(key).and_then(Value::as_str).map(str::to_string);
        let doc_extras = match partial.get("doc_extras") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(extras) => {
                let encoded = serde_json::to_string(extras)?;
                Some(Some(if encoded.len() > BOKEH_PROP_BLOB_THRESHOLD {
                    let hash = sink
                        .put(
                            encoded.as_bytes(),
                            BOKEH_PROP_MEDIA_TYPE,
                            BlobDurability::Durable,
                        )
                        .await?;
                    BokehBlobRef {
                        blob: hash,
                        size: encoded.len() as u64,
                        media_type: BOKEH_PROP_MEDIA_TYPE.to_string(),
                    }
                    .encode()
                } else {
                    encoded
                }))
            }
        };
        Ok(Self {
            session_id: string("session_id"),
            producer_name: string("producer_name"),
            producer_version: string("producer_version"),
            bokeh_version: string("bokeh_version"),
            root_ids: partial
                .get("root_ids")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(|id| id.as_str().map(str::to_string))
                        .collect()
                }),
            title: partial
                .get("title")
                .map(|title| title.as_str().map(str::to_string)),
            doc_extras,
        })
    }

    pub(crate) fn apply(&self, meta: &mut BokehSessionMeta) {
        let set = |slot: &mut String, value: &Option<String>| {
            if let Some(value) = value {
                slot.clone_from(value);
            }
        };
        set(&mut meta.session_id, &self.session_id);
        set(&mut meta.producer_name, &self.producer_name);
        set(&mut meta.producer_version, &self.producer_version);
        set(&mut meta.bokeh_version, &self.bokeh_version);
        if let Some(root_ids) = &self.root_ids {
            meta.root_ids.clone_from(root_ids);
        }
        if let Some(title) = &self.title {
            meta.title.clone_from(title);
        }
        if let Some(extras) = &self.doc_extras {
            meta.doc_extras.clone_from(extras);
        }
    }
}

async fn store_columns(
    columns: &Value,
    buffers: &BufferMap,
    encoding: BytesEncoding,
    version: u64,
    durability: BlobDurability,
    sink: &BlobSink<'_>,
) -> anyhow::Result<BTreeMap<String, BokehColumnRef>> {
    let mut refs = BTreeMap::new();
    for (name, value) in columns.as_object().into_iter().flatten() {
        let bytes = serde_json::to_vec(&inline_buffers(value, buffers, encoding)?)?;
        let blob = sink
            .put(&bytes, BOKEH_COLUMN_MEDIA_TYPE, durability)
            .await?;
        refs.insert(
            name.clone(),
            BokehColumnRef {
                blob,
                size: bytes.len() as u64,
                version,
            },
        );
    }
    Ok(refs)
}

async fn store_event_buffers(
    values: &[&Value],
    buffers: &BufferMap,
    sink: &BlobSink<'_>,
) -> anyhow::Result<Vec<BokehSessionBufferRef>> {
    let mut ids = BTreeSet::new();
    for value in values {
        referenced_buffer_ids(value, &mut ids);
    }
    let mut refs = Vec::with_capacity(ids.len());
    for id in ids {
        let data = buffers
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("Bokeh buffer {id} was not sent"))?;
        // One-off: freed once the late-joiner tail no longer needs it.
        let blob = sink
            .put(data, BOKEH_BUFFER_MEDIA_TYPE, BlobDurability::Ephemeral)
            .await?;
        refs.push(BokehSessionBufferRef {
            id,
            blob,
            size: data.len() as u64,
            media_type: BOKEH_BUFFER_MEDIA_TYPE.to_string(),
        });
    }
    Ok(refs)
}

/// The epoch-0 snapshot from the display payload's `session_doc`.
pub(crate) async fn snapshot_from_session_doc(
    session_id: &str,
    session_doc: &Value,
    buffers: &BufferMap,
    sink: &BlobSink<'_>,
) -> anyhow::Result<BokehSessionSnapshot> {
    let mut meta = BokehSessionMeta {
        session_id: session_id.to_string(),
        ..Default::default()
    };
    if let Some(partial) = session_doc.get("meta").and_then(Value::as_object) {
        MetaPatch::encode(partial, sink).await?.apply(&mut meta);
    }
    let mut models = BTreeMap::new();
    for (id, model) in session_doc
        .get("models")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        models.insert(id.clone(), encode_model(model, sink).await?);
    }
    let encoding = BytesEncoding::for_bokeh_version(&meta.bokeh_version);
    let mut columns = BTreeMap::new();
    for event in session_doc
        .get("data_events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|event| event_kind(event) == Some("ColumnsFolded"))
    {
        let source_id = required_str(event, "source_id")?;
        let version = event.get("version").and_then(Value::as_u64).unwrap_or(0);
        let refs = store_columns(
            event.get("columns").unwrap_or(&Value::Null),
            buffers,
            encoding,
            version,
            BlobDurability::Durable,
            sink,
        )
        .await?;
        columns.insert(source_id.to_string(), refs);
    }
    Ok(BokehSessionSnapshot {
        epoch: 0,
        meta,
        models,
        columns,
    })
}

/// What a data event does to the session once its blobs are stored.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DataOp {
    /// A stream or patch: broadcast and retained in the source's tail.
    Event {
        transaction_id: String,
        source_id: String,
        event: Value,
        buffers: Vec<BokehSessionBufferRef>,
        bytes: usize,
    },
    /// Columns at the version connected peers already hold; clears the tail.
    Fold {
        source_id: String,
        columns: BTreeMap<String, BokehColumnRef>,
    },
    /// Full-column replacement; peers load the new blobs.
    Replace {
        transaction_id: String,
        source_id: String,
        base_version: u64,
        new_version: u64,
        columns: BTreeMap<String, BokehColumnRef>,
        removed: Vec<String>,
    },
}

/// A coalesced delta after blob offload, ready to commit in one change.
#[derive(Debug, Default)]
pub(crate) struct PreparedFlush {
    pub(crate) session_id: String,
    pub(crate) meta: Option<MetaPatch>,
    pub(crate) models_added: BTreeMap<String, BokehModelState>,
    pub(crate) props_changed: BTreeMap<String, BTreeMap<String, String>>,
    pub(crate) models_removed: BTreeSet<String>,
    pub(crate) data_ops: Vec<DataOp>,
    pub(crate) messages: Vec<Tagged>,
    pub(crate) message_buffers: Vec<BokehSessionBufferRef>,
}

pub(crate) async fn prepare_flush(
    delta: KernelDelta,
    encoding: BytesEncoding,
    sink: &BlobSink<'_>,
) -> anyhow::Result<PreparedFlush> {
    let mut flush = PreparedFlush {
        session_id: delta.session_id,
        models_removed: delta.models_removed,
        ..Default::default()
    };
    if !delta.meta.is_empty() {
        flush.meta = Some(MetaPatch::encode(&delta.meta, sink).await?);
    }
    for (id, model) in &delta.models_added {
        flush
            .models_added
            .insert(id.clone(), encode_model(model, sink).await?);
    }
    for (id, props) in &delta.props_changed {
        let mut encoded = BTreeMap::new();
        for (name, value) in props {
            encoded.insert(name.clone(), encode_value(value, sink).await?);
        }
        flush.props_changed.insert(id.clone(), encoded);
    }
    for Tagged {
        transaction_id,
        value: event,
    } in delta.data_events
    {
        let (Some(kind), Some(source_id)) = (event_kind(&event), event_source(&event)) else {
            warn!("[bokeh-session] Dropping malformed data event");
            continue;
        };
        let source_id = source_id.to_string();
        let op = match kind {
            "ColumnsStreamed" | "ColumnsPatched" => {
                let buffers = store_event_buffers(&[&event], &delta.buffers, sink).await?;
                let bytes = serde_json::to_vec(&event)?.len()
                    + buffers.iter().map(|b| b.size as usize).sum::<usize>();
                DataOp::Event {
                    transaction_id,
                    source_id,
                    event,
                    buffers,
                    bytes,
                }
            }
            "ColumnsFolded" => DataOp::Fold {
                columns: store_columns(
                    event.get("columns").unwrap_or(&Value::Null),
                    &delta.buffers,
                    encoding,
                    event.get("version").and_then(Value::as_u64).unwrap_or(0),
                    BlobDurability::Durable,
                    sink,
                )
                .await?,
                source_id,
            },
            "ColumnDataChanged" => {
                let new_version = event
                    .get("new_version")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                DataOp::Replace {
                    columns: store_columns(
                        event.get("columns").unwrap_or(&Value::Null),
                        &delta.buffers,
                        encoding,
                        new_version,
                        // Freed once superseded by a later replacement or fold.
                        BlobDurability::Ephemeral,
                        sink,
                    )
                    .await?,
                    removed: event
                        .get("columns_removed")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|name| name.as_str().map(str::to_string))
                        .collect(),
                    base_version: event_base_version(&event).unwrap_or(0),
                    new_version,
                    transaction_id,
                    source_id,
                }
            }
            other => {
                warn!("[bokeh-session] Dropping unknown data event kind {other}");
                continue;
            }
        };
        flush.data_ops.push(op);
    }
    let message_values: Vec<&Value> = delta.messages.iter().map(|m| &m.value).collect();
    flush.message_buffers = store_event_buffers(&message_values, &delta.buffers, sink).await?;
    flush.messages = delta.messages;
    Ok(flush)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn wire_delta(transaction_id: &str, body: Value) -> Value {
        let mut content = json!({
            "schema_version": 1,
            "session_id": "session-1",
            "transaction_id": transaction_id,
            "models_added": {}, "props_changed": {}, "models_removed": [],
            "data_events": [], "messages": [], "buffers": [],
        });
        content
            .as_object_mut()
            .unwrap()
            .extend(body.as_object().unwrap().clone());
        content
    }

    fn cdc(base: u64, new: u64, columns: &[&str]) -> Value {
        json!({
            "kind": "ColumnDataChanged", "source_id": "p3", "base_version": base,
            "new_version": new,
            "columns": columns.iter().map(|c| (c.to_string(), json!([new]))).collect::<Map<_, _>>(),
            "columns_removed": [],
        })
    }

    fn stream(base: u64) -> Value {
        json!({
            "kind": "ColumnsStreamed", "source_id": "p3", "base_version": base,
            "new_version": base + 1,
            "data": {"type": "map", "entries": [["x", [1]]]}, "rollover": null,
        })
    }

    #[test]
    fn parse_validates_buffers_and_tags_events() {
        let data = b"abc".to_vec();
        let content = wire_delta(
            "tx-1",
            json!({
                "data_events": [stream(0)],
                "messages": [{"msg_type": "toast"}],
                "buffers": [{"id": "b1", "hash": hex_sha256(&data), "size": 3, "buffer_index": 0}],
            }),
        );
        let delta = KernelDelta::parse(&content, std::slice::from_ref(&data)).unwrap();
        assert_eq!(delta.buffers["b1"], data);
        assert_eq!(delta.data_events[0].transaction_id, "tx-1");
        assert_eq!(delta.messages.len(), 1);

        let mut bad = content.clone();
        bad["buffers"][0]["size"] = json!(4);
        assert!(KernelDelta::parse(&bad, &[data]).is_err());
    }

    #[test]
    fn merge_coalesces_models_props_and_meta() {
        let mut first = KernelDelta::parse(
            &wire_delta(
                "tx-1",
                json!({
                    "models_added": {"p9": {"type": "Div", "ref_props": [], "props": {"text": "a"}}},
                    "props_changed": {"p2": {"value": 1}},
                    "meta": {"title": "One"},
                }),
            ),
            &[],
        )
        .unwrap();
        let second = KernelDelta::parse(
            &wire_delta(
                "tx-2",
                json!({
                    "props_changed": {"p9": {"text": "b"}, "p2": {"value": 2}},
                    "models_removed": ["p4"],
                    "meta": {"root_ids": ["p1"]},
                }),
            ),
            &[],
        )
        .unwrap();
        first.merge(second);
        assert_eq!(first.models_added["p9"]["props"]["text"], "b");
        assert_eq!(first.props_changed["p2"]["value"], 2);
        assert!(!first.props_changed.contains_key("p9"));
        assert!(first.models_removed.contains("p4"));
        assert_eq!(first.meta["title"], "One");
        assert_eq!(first.meta["root_ids"], json!(["p1"]));

        let third = KernelDelta::parse(&wire_delta("tx-3", json!({"models_removed": ["p9"]})), &[])
            .unwrap();
        first.merge(third);
        assert!(!first.models_added.contains_key("p9"));
    }

    #[test]
    fn replacement_drops_pending_frames_it_covers() {
        let mut delta = KernelDelta::parse(
            &wire_delta("tx-1", json!({"data_events": [cdc(0, 1, &["x"])]})),
            &[],
        )
        .unwrap();
        for (tx, event) in [("tx-2", stream(1)), ("tx-3", cdc(2, 3, &["x", "y"]))] {
            delta.merge(
                KernelDelta::parse(&wire_delta(tx, json!({"data_events": [event]})), &[]).unwrap(),
            );
        }
        assert_eq!(delta.data_events.len(), 1);
        assert_eq!(delta.data_events[0].transaction_id, "tx-3");
        assert_eq!(delta.data_events[0].value["base_version"], 0);
        assert_eq!(delta.data_events[0].value["new_version"], 3);

        // A narrower replacement must not drop events on other columns.
        delta.merge(
            KernelDelta::parse(
                &wire_delta("tx-4", json!({"data_events": [stream(3)]})),
                &[],
            )
            .unwrap(),
        );
        let mut narrow = cdc(4, 5, &["y"]);
        narrow["source_id"] = json!("p3");
        delta.merge(
            KernelDelta::parse(&wire_delta("tx-5", json!({"data_events": [narrow]})), &[]).unwrap(),
        );
        assert_eq!(delta.data_events.len(), 3);
    }

    #[test]
    fn column_blobs_inline_buffers_as_base64() {
        let buffers = BufferMap::from([("b1".to_string(), vec![0u8, 1, 2])]);
        let column = json!({
            "type": "ndarray", "dtype": "uint8", "shape": [3],
            "array": {"type": "bytes", "data": {"id": "b1"}},
        });
        let inlined = inline_buffers(&column, &buffers, BytesEncoding::Base64).unwrap();
        assert_eq!(inlined["array"]["data"], "AAEC");
        let mut ids = BTreeSet::new();
        referenced_buffer_ids(&column, &mut ids);
        assert_eq!(ids, BTreeSet::from(["b1".to_string()]));
        assert!(inline_buffers(&column, &BufferMap::new(), BytesEncoding::Base64).is_err());
    }

    #[test]
    fn bokeh_3_8_and_later_inline_gzipped_buffers() {
        use std::io::Read as _;
        for (version, expected) in [
            ("3.7.3", BytesEncoding::Base64),
            ("2.4.3", BytesEncoding::Base64),
            ("3.8.0", BytesEncoding::GzipBase64),
            ("3.9.1", BytesEncoding::GzipBase64),
            ("3.10.0rc1", BytesEncoding::GzipBase64),
            ("4.0.0.dev1", BytesEncoding::GzipBase64),
            ("", BytesEncoding::GzipBase64),
        ] {
            assert_eq!(
                BytesEncoding::for_bokeh_version(version),
                expected,
                "{version}"
            );
        }

        let buffers = BufferMap::from([("b1".to_string(), vec![0u8, 1, 2])]);
        let column = json!({"type": "bytes", "data": {"id": "b1"}});
        let inlined = inline_buffers(&column, &buffers, BytesEncoding::GzipBase64).unwrap();
        let gzipped = base64::engine::general_purpose::STANDARD
            .decode(inlined["data"].as_str().unwrap())
            .unwrap();
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(&gzipped[..])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, vec![0u8, 1, 2]);
    }

    #[tokio::test]
    async fn prepare_flush_offloads_large_values_and_stores_columns() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let publisher = OutputBlobPublisher::none();
        let sink = BlobSink::new(&store, &publisher);
        let large = "x".repeat(BOKEH_PROP_BLOB_THRESHOLD + 10);
        let data = vec![7u8; 4];
        let delta = KernelDelta::parse(
            &wire_delta(
                "tx-1",
                json!({
                    "props_changed": {"p2": {"text": large, "value": 0.25}},
                    "meta": {"doc_extras": {"defs": []}, "title": null},
                    "data_events": [
                        {"kind": "ColumnsStreamed", "source_id": "p3", "base_version": 0, "new_version": 1,
                         "data": {"type": "map", "entries": [["x", {"type": "bytes", "data": {"id": "b1"}}]]},
                         "rollover": null},
                        {"kind": "ColumnsFolded", "source_id": "p3", "version": 1,
                         "columns": {"x": {"type": "bytes", "data": {"id": "b1"}}}},
                    ],
                    "buffers": [{"id": "b1", "hash": hex_sha256(&data), "size": 4, "buffer_index": 0}],
                }),
            ),
            std::slice::from_ref(&data),
        )
        .unwrap();
        let flush = prepare_flush(delta, BytesEncoding::Base64, &sink)
            .await
            .unwrap();

        assert_eq!(flush.props_changed["p2"]["value"], "0.25");
        let blob = BokehBlobRef::parse(&flush.props_changed["p2"]["text"]).expect("blob ref");
        assert_eq!(blob.media_type, BOKEH_PROP_MEDIA_TYPE);
        let stored = store.get(&blob.blob).await.unwrap().unwrap();
        assert_eq!(stored, serde_json::to_vec(&json!(large)).unwrap());

        let mut meta = BokehSessionMeta {
            title: Some("Old".into()),
            ..Default::default()
        };
        flush.meta.as_ref().unwrap().apply(&mut meta);
        assert_eq!(meta.title, None);
        assert_eq!(meta.doc_extras.as_deref(), Some(r#"{"defs":[]}"#));

        let DataOp::Event { buffers, .. } = &flush.data_ops[0] else {
            panic!("expected stream event");
        };
        assert_eq!(buffers[0].blob, hex_sha256(&data));
        let DataOp::Fold { columns, .. } = &flush.data_ops[1] else {
            panic!("expected fold");
        };
        assert_eq!(columns["x"].version, 1);
        let column: Value =
            serde_json::from_slice(&store.get(&columns["x"].blob).await.unwrap().unwrap()).unwrap();
        assert_eq!(column["data"], "BwcHBw==");
    }
}
