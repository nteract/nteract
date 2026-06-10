use std::collections::HashSet;

use super::*;
use base64::Engine as _;

pub(crate) struct ParsedIpynbCells {
    pub cells: Vec<CellSnapshot>,
    pub outputs_by_cell: HashMap<String, Vec<serde_json::Value>>,
    pub attachments: HashMap<String, serde_json::Value>,
}

/// Parse cells from a Jupyter notebook JSON object.
///
/// Returns `Some(ParsedIpynbCells)` if parsing succeeded (including empty
/// `cells: []`), or `None` if the `cells` key is missing or invalid.
///
/// The source field can be either a string or an array of strings (lines).
/// We normalize it to a single string.
///
/// For older notebooks (pre-nbformat 4.5) without cell IDs we mint a fresh
/// UUID per cell. The next save writes those UUIDs back, upgrading the file
/// to nbformat 4.5. Positional `__external_cell_N` IDs were briefly used
/// here and caused source/cell-type desync when the autosave-write-watch
/// loop renumbered them by position — see issue and review notes.
///
/// Positions are generated incrementally using fractional indexing.
pub(crate) fn parse_cells_from_ipynb(json: &serde_json::Value) -> Option<ParsedIpynbCells> {
    use loro_fractional_index::FractionalIndex;

    let cells_json = json.get("cells").and_then(|c| c.as_array())?;

    let mut prev_position: Option<FractionalIndex> = None;
    let mut outputs_by_cell: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    let mut attachments: HashMap<String, serde_json::Value> = HashMap::new();

    let parsed_cells = cells_json
        .iter()
        .map(|cell| {
            let id = cell
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            let cell_type = cell
                .get("cell_type")
                .and_then(|v| v.as_str())
                .unwrap_or("code")
                .to_string();

            let position = match &prev_position {
                None => FractionalIndex::default(),
                Some(prev) => FractionalIndex::new_after(prev),
            };
            let position_str = position.to_string();
            prev_position = Some(position);

            let source = match cell.get("source") {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };

            let execution_count = match cell.get("execution_count") {
                Some(serde_json::Value::Number(n)) => n.to_string(),
                _ => "null".to_string(),
            };

            let outputs: Vec<serde_json::Value> = cell
                .get("outputs")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if !outputs.is_empty() {
                outputs_by_cell.insert(id.clone(), outputs);
            }

            if let Some(att) = cell.get("attachments") {
                if att.is_object() {
                    attachments.insert(id.clone(), att.clone());
                }
            }

            let metadata = match cell.get("metadata") {
                Some(v) if v.is_object() => v.clone(),
                _ => serde_json::json!({}),
            };

            CellSnapshot {
                id,
                cell_type,
                position: position_str,
                source,
                execution_count,
                metadata,
                resolved_assets: std::collections::HashMap::new(),
                attachments: std::collections::HashMap::new(),
            }
        })
        .collect();

    Some(ParsedIpynbCells {
        cells: parsed_cells,
        outputs_by_cell,
        attachments,
    })
}

/// Parse notebook metadata from a .ipynb JSON value.
///
/// Uses `NotebookMetadataSnapshot::from_metadata_value` which extracts
/// kernelspec, language_info, and runt namespace from the metadata.
pub(crate) fn parse_metadata_from_ipynb(
    json: &serde_json::Value,
) -> Option<NotebookMetadataSnapshot> {
    let metadata = json.get("metadata")?;
    Some(NotebookMetadataSnapshot::from_metadata_value(metadata))
}

/// Convert raw output JSON strings to blob store manifest references.
///
/// Each output is parsed, converted to a manifest (with large data offloaded
/// to the blob store), and the manifest itself is stored in the blob store.
/// Returns a vec of manifest hashes suitable for storing in the Automerge doc.
///
/// Falls back to storing the raw JSON string if manifest creation fails.
async fn outputs_to_manifest_refs(
    raw_outputs: &[serde_json::Value],
    blob_store: &BlobStore,
) -> Vec<serde_json::Value> {
    let mut refs = Vec::with_capacity(raw_outputs.len());
    for output_value in raw_outputs {
        let output_ref = match crate::output_store::create_manifest(
            output_value,
            blob_store,
            crate::output_store::DEFAULT_INLINE_THRESHOLD,
        )
        .await
        {
            Ok(manifest) => manifest.to_json(),
            Err(e) => {
                warn!("[notebook-sync] Failed to create output manifest: {}", e);
                fallback_output_with_id(output_value)
            }
        };
        refs.push(output_ref);
    }
    refs
}

/// Number of cells to add per batch during streaming load.
/// After each batch, a sync message is sent so the frontend can render
/// cells progressively.
pub(crate) const STREAMING_BATCH_SIZE: usize = 3;

type NbformatAttachmentMap = HashMap<String, serde_json::Value>;
type ResolvedAssets = HashMap<String, String>;

pub(crate) struct ParsedStreamingNotebook {
    pub cells: Vec<StreamingCell>,
    pub metadata: Option<NotebookMetadataSnapshot>,
    pub metadata_value: Option<serde_json::Value>,
    pub attachments: NbformatAttachmentMap,
}
type StreamingLoadBatchEntry = (
    usize,
    StreamingCell,
    Vec<serde_json::Value>,
    ResolvedAssets,
    AttachmentRefs,
);

fn should_resolve_markdown_assets(cell_type: &str) -> bool {
    cell_type == "markdown"
}

/// Cell data parsed for streaming load.
///
/// Unlike `CellSnapshot` — which no longer carries outputs at all (they live
/// in `RuntimeStateDoc` keyed by `execution_id`) — this struct pairs the
/// cell fields with its parsed outputs in one value. Outputs are kept as
/// `serde_json::Value` to avoid the serialize→parse round-trip when
/// processing through `create_manifest`.
pub(crate) struct StreamingCell {
    pub(crate) id: String,
    pub(crate) cell_type: String,
    pub(crate) position: String,
    pub(crate) source: String,
    pub(crate) execution_count: String,
    pub(crate) outputs: Vec<serde_json::Value>,
    pub(crate) metadata: serde_json::Value,
}

/// Convert a `jiter::JsonValue` to a `serde_json::Value`.
///
/// Used to bridge jiter's fast zero-copy parsing with code that expects
/// serde_json types (e.g., `output_store::create_manifest`).
fn jiter_to_serde(jv: &jiter::JsonValue<'_>) -> serde_json::Value {
    match jv {
        jiter::JsonValue::Null => serde_json::Value::Null,
        jiter::JsonValue::Bool(b) => serde_json::Value::Bool(*b),
        jiter::JsonValue::Int(i) => serde_json::json!(*i),
        jiter::JsonValue::BigInt(b) => serde_json::Value::String(b.to_string()),
        jiter::JsonValue::Float(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        jiter::JsonValue::Str(s) => serde_json::Value::String(s.to_string()),
        jiter::JsonValue::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(jiter_to_serde).collect())
        }
        jiter::JsonValue::Object(obj) => {
            let map = obj
                .iter()
                .map(|(k, v)| (k.to_string(), jiter_to_serde(v)))
                .collect();
            serde_json::Value::Object(map)
        }
    }
}

/// Look up a key in a jiter JSON object (which is a flat slice of key-value pairs).
///
/// `LazyIndexMap` derefs to `[(Cow<str>, JsonValue)]`, so the built-in `.get()`
/// takes a `usize` index. This helper does the string-key search.
fn jobj_get<'a, 's>(
    obj: &'a [(std::borrow::Cow<'s, str>, jiter::JsonValue<'s>)],
    key: &str,
) -> Option<&'a jiter::JsonValue<'s>> {
    obj.iter().find(|(k, _)| k.as_ref() == key).map(|(_, v)| v)
}

/// Parse a notebook file into streaming cells using jiter for fast JSON parsing.
///
/// Returns `(cells, Option<metadata_snapshot>)`. Outputs are kept as
/// `serde_json::Value` so they can be passed directly to `create_manifest`
/// without a serialize→parse round-trip.
pub(crate) fn parse_notebook_jiter(bytes: &[u8]) -> Result<ParsedStreamingNotebook, String> {
    let json = jiter::JsonValue::parse(bytes, false)
        .map_err(|e| format!("Invalid notebook JSON: {}", e))?;

    let obj = match &json {
        jiter::JsonValue::Object(obj) => obj,
        _ => return Err("Notebook is not a JSON object".to_string()),
    };

    // Parse metadata by converting to serde_json (metadata is small)
    let metadata_value = jobj_get(obj, "metadata").map(jiter_to_serde);
    let metadata = metadata_value
        .as_ref()
        .map(NotebookMetadataSnapshot::from_metadata_value);

    let cells_arr = match jobj_get(obj, "cells") {
        Some(jiter::JsonValue::Array(arr)) => arr,
        Some(_) => return Err("'cells' is not an array".to_string()),
        // A notebook with no `cells` key is malformed (nbformat requires it),
        // exactly like a non-array `cells`. Erroring here (rather than returning
        // an empty notebook) means the streaming load FAILS, so the room stays
        // empty-and-never-ready and the autosave zeroing guard preserves the
        // file on disk instead of overwriting recoverable-but-clobbered content
        // with an empty notebook. A genuine empty notebook still has `cells: []`
        // and loads normally.
        None => return Err("notebook has no 'cells' key".to_string()),
    };

    use loro_fractional_index::FractionalIndex;
    let mut prev_position: Option<FractionalIndex> = None;

    let mut cells = Vec::with_capacity(cells_arr.len());
    let mut attachments = HashMap::new();
    for cell in cells_arr.iter() {
        let cell_obj = match cell {
            jiter::JsonValue::Object(obj) => obj,
            _ => continue,
        };

        let id = jobj_get(cell_obj, "id")
            .and_then(|v| match v {
                jiter::JsonValue::Str(s) => Some(s.to_string()),
                _ => None,
            })
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let cell_type = jobj_get(cell_obj, "cell_type")
            .and_then(|v| match v {
                jiter::JsonValue::Str(s) => Some(s.to_string()),
                _ => None,
            })
            .unwrap_or_else(|| "code".to_string());

        // Generate position incrementally (O(1) per cell, not O(n²))
        let position = match &prev_position {
            None => FractionalIndex::default(),
            Some(prev) => FractionalIndex::new_after(prev),
        };
        let position_str = position.to_string();
        prev_position = Some(position);

        // Source can be a string or array of strings (Jupyter multiline format)
        let source = match jobj_get(cell_obj, "source") {
            Some(jiter::JsonValue::Str(s)) => s.to_string(),
            Some(jiter::JsonValue::Array(arr)) => arr
                .iter()
                .filter_map(|v| match v {
                    jiter::JsonValue::Str(s) => Some(s.as_ref()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        };

        let execution_count = match jobj_get(cell_obj, "execution_count") {
            Some(jiter::JsonValue::Int(n)) => n.to_string(),
            _ => "null".to_string(),
        };

        // Keep outputs as serde_json::Value — avoids serialize→parse round-trip
        let outputs = match jobj_get(cell_obj, "outputs") {
            Some(jiter::JsonValue::Array(arr)) => arr.iter().map(jiter_to_serde).collect(),
            _ => vec![],
        };

        // Extract cell metadata (preserves all fields, normalize to object)
        let metadata = match jobj_get(cell_obj, "metadata").map(jiter_to_serde) {
            Some(v) if v.is_object() => v,
            _ => serde_json::json!({}),
        };

        if let Some(jiter::JsonValue::Object(_)) = jobj_get(cell_obj, "attachments") {
            attachments.insert(
                id.clone(),
                jobj_get(cell_obj, "attachments")
                    .map(jiter_to_serde)
                    .unwrap_or_else(|| serde_json::json!({})),
            );
        }

        cells.push(StreamingCell {
            id,
            cell_type,
            position: position_str,
            source,
            execution_count,
            outputs,
            metadata,
        });
    }

    Ok(ParsedStreamingNotebook {
        cells,
        metadata,
        metadata_value,
        attachments,
    })
}

#[derive(Debug)]
struct LoadedWidgetComm {
    comm_id: String,
    model_module: String,
    model_name: String,
    state: serde_json::Value,
    seq: u64,
}

async fn widget_comms_from_notebook_metadata(
    metadata: Option<&serde_json::Value>,
    blob_store: &BlobStore,
) -> Vec<LoadedWidgetComm> {
    let Some(models) = metadata
        .and_then(|metadata| metadata.get("widgets"))
        .and_then(|widgets| widgets.get(WIDGET_STATE_MIME))
        .and_then(|widget_state| widget_state.get("state"))
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };

    let mut entries: Vec<_> = models.iter().collect();
    entries.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut comms = Vec::new();
    for (seq, (comm_id, model)) in entries.into_iter().enumerate() {
        let Some(model_name) = widget_model_metadata_field(model, "model_name") else {
            warn!(
                "[notebook-sync] Skipping widget metadata model {} with missing model_name",
                comm_id
            );
            continue;
        };
        let Some(model_module) = widget_model_metadata_field(model, "model_module") else {
            warn!(
                "[notebook-sync] Skipping widget metadata model {} with missing model_module",
                comm_id
            );
            continue;
        };

        let mut state = model
            .get("state")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        ensure_widget_state_model_field(&mut state, "_model_name", &model_name);
        ensure_widget_state_model_field(&mut state, "_model_module", &model_module);
        if let Some(version) = widget_model_metadata_field(model, "model_module_version") {
            ensure_widget_state_model_field(&mut state, "_model_module_version", &version);
        }

        let (buffer_paths, buffers) = widget_metadata_buffers(model);
        let (state, _) =
            crate::output_prep::store_widget_buffers(&state, &buffer_paths, &buffers, blob_store)
                .await;

        comms.push(LoadedWidgetComm {
            comm_id: comm_id.clone(),
            model_module,
            model_name,
            state,
            seq: seq as u64,
        });
    }

    comms
}

fn widget_model_metadata_field(model: &serde_json::Value, key: &str) -> Option<String> {
    let state_key = format!("_{key}");
    model
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            model
                .get("state")
                .and_then(|state| state.get(&state_key))
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn ensure_widget_state_model_field(state: &mut serde_json::Value, key: &str, value: &str) {
    let Some(obj) = state.as_object_mut() else {
        return;
    };
    if obj
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|existing| !existing.is_empty())
        .is_none()
    {
        obj.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
}

fn widget_metadata_buffers(model: &serde_json::Value) -> (Vec<Vec<String>>, Vec<Vec<u8>>) {
    let Some(buffers) = model.get("buffers").and_then(serde_json::Value::as_array) else {
        return (Vec::new(), Vec::new());
    };

    let mut paths = Vec::new();
    let mut bytes = Vec::new();
    for buffer in buffers {
        let encoding = buffer
            .get("encoding")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("base64");
        if encoding != "base64" {
            warn!(
                "[notebook-sync] Skipping widget metadata buffer with unsupported encoding {}",
                encoding
            );
            continue;
        }

        let Some(path) = widget_metadata_buffer_path(buffer.get("path")) else {
            warn!("[notebook-sync] Skipping widget metadata buffer with invalid path");
            continue;
        };
        let Some(data) = buffer.get("data").and_then(serde_json::Value::as_str) else {
            warn!("[notebook-sync] Skipping widget metadata buffer with missing data");
            continue;
        };
        let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(data) else {
            warn!("[notebook-sync] Skipping widget metadata buffer with invalid base64 data");
            continue;
        };

        paths.push(path);
        bytes.push(decoded);
    }

    (paths, bytes)
}

fn widget_metadata_buffer_path(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let path = value?.as_array()?;
    let segments = path
        .iter()
        .filter_map(|segment| {
            segment
                .as_str()
                .map(str::to_string)
                .or_else(|| segment.as_u64().map(|value| value.to_string()))
                .or_else(|| segment.as_i64().map(|value| value.to_string()))
        })
        .collect::<Vec<_>>();
    if segments.len() == path.len() {
        Some(segments)
    } else {
        None
    }
}

fn write_widget_comm_topology_to_state_doc(
    state_doc: &mut RuntimeStateDoc,
    comms: &[LoadedWidgetComm],
) -> Result<(), runtime_doc::RuntimeStateError> {
    for comm in comms {
        state_doc.put_comm(
            &comm.comm_id,
            JUPYTER_WIDGET_TARGET,
            &comm.model_module,
            &comm.model_name,
            &serde_json::json!({}),
            comm.seq,
        )?;
    }
    Ok(())
}

fn write_widget_comm_state_to_comms_doc(
    comms_doc: &mut runtime_doc::CommsDoc,
    comms: &[LoadedWidgetComm],
) -> Result<(), runtime_doc::RuntimeStateError> {
    for comm in comms {
        comms_doc.put_comm_state(&comm.comm_id, &comm.state)?;
    }
    Ok(())
}

/// Convert a single output `serde_json::Value` to a blob store manifest hash.
///
/// Like `outputs_to_manifest_refs` but takes a `Value` directly instead of a
/// JSON string, avoiding the serialize→parse round-trip during notebook load.
pub(crate) async fn output_value_to_manifest_ref(
    output: &serde_json::Value,
    blob_store: &BlobStore,
) -> serde_json::Value {
    match crate::output_store::create_manifest(
        output,
        blob_store,
        crate::output_store::DEFAULT_INLINE_THRESHOLD,
    )
    .await
    {
        Ok(manifest) => manifest.to_json(),
        Err(e) => {
            warn!("[streaming-load] Failed to create output manifest: {}", e);
            fallback_output_with_id(output)
        }
    }
}

/// Ensure a raw output carries a non-empty `output_id` before it lands in
/// RuntimeStateDoc. Used by every call site that falls back to the raw
/// input on `create_manifest` failure — the frontend's per-output store
/// drops outputs without a real id, so the daemon invariant has to hold
/// on the error path too.
pub(crate) fn fallback_output_with_id(output: &serde_json::Value) -> serde_json::Value {
    let mut fallback = output.clone();
    if let Some(obj) = fallback.as_object_mut() {
        let needs_id = obj
            .get("output_id")
            .and_then(|v| v.as_str())
            .map(|s| s.is_empty())
            .unwrap_or(true);
        if needs_id {
            obj.insert(
                "output_id".to_string(),
                serde_json::Value::String(uuid::Uuid::new_v4().to_string()),
            );
        }
    }
    fallback
}

/// Placeholder for draining incoming sync replies during streaming load.
///
/// In theory, the client sends sync replies after each batch and we should
/// drain them to prevent socket buffer deadlock. In practice:
///
/// 1. `recv_typed_frame` uses `read_exact` internally, which is NOT
///    cancellation-safe. Wrapping it in `tokio::time::timeout` risks
///    cancelling mid-frame, leaving the stream desynchronized.
/// 2. With release-mode load times (~56ms for 50 cells), the OS socket
///    buffer (typically 64KB+) easily absorbs the client's sync replies.
/// 3. Non-sync frames (requests) would be silently dropped.
///
/// The sync replies are processed normally once the main select loop starts
/// after streaming completes.
async fn drain_incoming_frames<R>(
    _reader: &mut R,
    _room: &NotebookRoom,
    _peer_state: &mut sync::State,
) where
    R: AsyncRead + Unpin,
{
    // No-op. See doc comment above.
}

/// Stream notebook cells into the Automerge doc in batches, sending sync
/// messages after each batch so the frontend renders cells progressively.
///
/// This replaces the "load everything then sync once" approach. With a 50-cell
/// notebook, the frontend sees the first 3 cells in ~30ms instead of waiting
/// for all 50.
///
/// The caller must have already won `room.try_start_loading()` and must call
/// `room.finish_loading()` after this returns (success or failure).
pub(crate) async fn streaming_load_cells<R, W>(
    reader: &mut R,
    writer: &mut W,
    room: &NotebookRoom,
    path: &Path,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
    peer_state: &mut sync::State,
) -> Result<usize, String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let start = std::time::Instant::now();

    // 1. Read and parse the notebook file with jiter
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Failed to read notebook: {}", e))?;

    let parsed = parse_notebook_jiter(&bytes)?;
    let cells = parsed.cells;
    let metadata = parsed.metadata;
    let widget_comms =
        widget_comms_from_notebook_metadata(parsed.metadata_value.as_ref(), &room.blob_store).await;
    let nbformat_attachments = parsed.attachments;

    let total_cells = cells.len();
    info!(
        "[streaming-load] Parsed {} cells from {} in {:?}",
        total_cells,
        path.display(),
        start.elapsed()
    );
    let loaded_sources: HashMap<String, String> = cells
        .iter()
        .map(|cell| (cell.id.clone(), cell.source.clone()))
        .collect();
    let should_seed_save_baseline = match room.file_binding.path().await {
        Some(bound_path) => bound_path == path,
        None => false,
    };
    if should_seed_save_baseline {
        // The file watcher is live while cells stream to the frontend. Seed the
        // disk-source baseline before exposing batches so an unchanged initial
        // watch event cannot roll back immediate live edits.
        *room.persistence.last_save_sources.write().await = loaded_sources;
        // Also seed the disk-hash staleness baseline: these bytes are what this
        // daemon read; autosave refuses to overwrite anything else until the
        // watcher reconciles it.
        room.persistence.note_disk_content(&bytes);
    }
    let notebook_path = room
        .file_binding
        .path()
        .await
        .map(|p| p.to_string_lossy().to_string());
    let context_id = super::notebook_execution_context_id(room, notebook_path.as_deref());
    let durable_records = durable_execution_records(execution_store, &context_id).await;

    if !widget_comms.is_empty() {
        room.state
            .with_doc(|sd| write_widget_comm_topology_to_state_doc(sd, &widget_comms))
            .map_err(|e| format!("Failed to load widget metadata into runtime state: {e}"))?;
        room.comms
            .with_doc(|cd| write_widget_comm_state_to_comms_doc(cd, &widget_comms))
            .map_err(|e| format!("Failed to load widget metadata into comms doc: {e}"))?;
    }

    // 2. Stream cells in batches
    let mut cell_iter = cells.into_iter().enumerate().peekable();
    let mut batch_num = 0u32;

    while cell_iter.peek().is_some() {
        let batch_start = std::time::Instant::now();

        // Collect one batch and process outputs through blob store (outside doc lock)
        let mut batch: Vec<StreamingLoadBatchEntry> = Vec::new();
        for _ in 0..STREAMING_BATCH_SIZE {
            let Some((idx, cell)) = cell_iter.next() else {
                break;
            };
            let mut output_refs = Vec::with_capacity(cell.outputs.len());
            for output in &cell.outputs {
                output_refs.push(output_value_to_manifest_ref(output, &room.blob_store).await);
            }
            let attachment_refs = nbformat_attachments_to_blob_refs(
                nbformat_attachments.get(&cell.id),
                &room.blob_store,
            )
            .await
            .map_err(|e| format!("Failed to ingest attachments for {}: {e}", cell.id))?;
            let mut resolved_assets = if should_resolve_markdown_assets(&cell.cell_type) {
                resolve_markdown_assets(&cell.source, Some(path), None, &room.blob_store).await
            } else {
                ResolvedAssets::new()
            };
            if should_resolve_markdown_assets(&cell.cell_type) {
                resolved_assets.extend(resolved_attachment_assets(&cell.source, &attachment_refs));
            }
            batch.push((idx, cell, output_refs, resolved_assets, attachment_refs));
        }

        // Store outputs in RuntimeStateDoc with durable execution state when a
        // matching terminal record exists, otherwise mint synthetic IDs.
        // Collect (cell_id, execution) pairs for linking below.
        let mut cell_executions: HashMap<String, LoadedExecution> = HashMap::new();
        let mut claimed_execution_ids = HashSet::new();
        for (_idx, cell, output_refs, _resolved_assets, _attachment_refs) in &batch {
            if output_refs.is_empty() {
                continue;
            }
            let parsed_ec = cell.execution_count.parse::<i64>().ok();
            let execution = durable_or_synthetic_execution(
                &durable_records,
                &mut claimed_execution_ids,
                DurableExecutionLookup {
                    context_id: &context_id,
                    notebook_path: notebook_path.as_deref(),
                    cell_id: &cell.id,
                    source: &cell.source,
                    execution_count: parsed_ec,
                    outputs: output_refs,
                },
            );
            cell_executions.insert(cell.id.clone(), execution);
        }
        let _ = room.state.with_doc(|sd| {
            for (_idx, cell, output_refs, _resolved_assets, _attachment_refs) in &batch {
                if let Some(execution) = cell_executions.get(&cell.id) {
                    let _ = sd.create_execution(&execution.execution_id);
                    let _ = sd.set_outputs(&execution.execution_id, output_refs);
                    if let Ok(ec) = cell.execution_count.parse::<i64>() {
                        let _ = sd.set_execution_count(&execution.execution_id, ec);
                    }
                    let _ = sd.set_execution_done(&execution.execution_id, execution.success);
                }
            }
            Ok(())
        });

        // Add batch to Automerge doc and generate sync message (inside lock)
        let encoded = {
            let mut doc = room.doc.write().await;
            for (_idx, cell, _output_refs, resolved_assets, attachment_refs) in &batch {
                doc.add_cell_full(
                    &cell.id,
                    &cell.cell_type,
                    &cell.position,
                    &cell.source,
                    &cell.execution_count,
                    &cell.metadata,
                )
                .map_err(|e| format!("Failed to add cell {}: {}", cell.id, e))?;
                // Link cell to its synthetic execution_id
                if let Some(execution) = cell_executions.get(&cell.id) {
                    let _ = doc.set_execution_id(&cell.id, Some(&execution.execution_id));
                }
                doc.set_cell_resolved_assets(&cell.id, resolved_assets)
                    .map_err(|e| format!("Failed to set resolved assets for {}: {}", cell.id, e))?;
                doc.set_cell_attachments(&cell.id, attachment_refs)
                    .map_err(|e| format!("Failed to set attachments for {}: {}", cell.id, e))?;
            }
            match doc.generate_sync_message_recovering(peer_state, "streaming-load-cells") {
                Ok(message) => message.map(|m| m.encode()),
                Err(e) => {
                    warn!("[streaming-load] cell sync generation failed: {}", e);
                    return Err(format!("cell sync generation failed: {e}"));
                }
            }
        };

        // Send sync message outside the lock
        if let Some(encoded) = encoded {
            connection::send_typed_frame(writer, NotebookFrameType::AutomergeSync, &encoded)
                .await
                .map_err(|e| format!("Failed to send sync message: {}", e))?;
        }

        // Notify other peers in the room
        let _ = room.broadcasts.changed_tx.send(());
        // RuntimeStateDoc notification is automatic via with_doc heads check

        // Drain incoming sync replies to prevent deadlock
        drain_incoming_frames(reader, room, peer_state).await;

        batch_num += 1;
        debug!(
            "[streaming-load] Batch {} ({} cells) in {:?}",
            batch_num,
            batch.len(),
            batch_start.elapsed(),
        );
    }

    // 3. Set metadata (if present) and sync it
    if let Some(meta) = metadata {
        let encoded = {
            let mut doc = room.doc.write().await;
            if let Err(e) = doc.set_metadata_snapshot(&meta) {
                warn!("[streaming-load] Failed to set metadata: {}", e);
            }
            match doc.generate_sync_message_recovering(peer_state, "streaming-load-meta") {
                Ok(message) => message.map(|m| m.encode()),
                Err(e) => {
                    warn!("[streaming-load] metadata sync generation failed: {}", e);
                    return Err(format!("metadata sync generation failed: {e}"));
                }
            }
        };
        if let Some(encoded) = encoded {
            connection::send_typed_frame(writer, NotebookFrameType::AutomergeSync, &encoded)
                .await
                .map_err(|e| format!("Failed to send metadata sync: {}", e))?;
        }
        let _ = room.broadcasts.changed_tx.send(());
        drain_incoming_frames(reader, room, peer_state).await;
    }

    info!(
        "[streaming-load] Loaded {} cells in {} batches ({:?})",
        total_cells,
        batch_num,
        start.elapsed()
    );

    Ok(total_cells)
}

/// Test helper for loading notebook cells and metadata from a `.ipynb` file
/// into a `NotebookDoc`.
#[cfg(test)]
pub(crate) async fn load_notebook_from_disk(
    doc: &mut NotebookDoc,
    path: &std::path::Path,
    blob_store: &BlobStore,
) -> Result<usize, String> {
    load_notebook_from_disk_with_state_doc(doc, None, path, blob_store).await
}

/// Test helper for loading a notebook from disk into the notebook doc and,
/// optionally, the `RuntimeStateDoc`.
#[cfg(test)]
pub(crate) async fn load_notebook_from_disk_with_state_doc(
    doc: &mut NotebookDoc,
    state_doc: Option<&mut RuntimeStateDoc>,
    path: &std::path::Path,
    blob_store: &BlobStore,
) -> Result<usize, String> {
    load_notebook_from_disk_with_state_doc_and_execution_store(
        doc, state_doc, path, blob_store, None,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn load_notebook_from_disk_with_runtime_docs(
    doc: &mut NotebookDoc,
    state_doc: Option<&mut RuntimeStateDoc>,
    comms_doc: Option<&mut runtime_doc::CommsDoc>,
    path: &std::path::Path,
    blob_store: &BlobStore,
) -> Result<usize, String> {
    load_notebook_from_disk_with_runtime_docs_and_execution_store(
        doc, state_doc, comms_doc, path, blob_store, None,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn load_notebook_from_disk_with_state_doc_and_execution_store(
    doc: &mut NotebookDoc,
    state_doc: Option<&mut RuntimeStateDoc>,
    path: &std::path::Path,
    blob_store: &BlobStore,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<usize, String> {
    load_notebook_from_disk_with_runtime_docs_and_execution_store(
        doc,
        state_doc,
        None,
        path,
        blob_store,
        execution_store,
    )
    .await
}

/// Everything [`apply_notebook_load`] needs to mutate the docs, prepared by
/// [`prepare_notebook_load`] with no doc reference in scope. The split keeps
/// the async blob-store work outside any doc lock (tokio-mutex discipline).
#[cfg(test)]
pub(crate) struct PreparedNotebookLoad {
    cells: Vec<PreparedNotebookCell>,
    widget_comms: Vec<LoadedWidgetComm>,
    metadata: Option<NotebookMetadataSnapshot>,
}

#[cfg(test)]
struct PreparedNotebookCell {
    cell: CellSnapshot,
    attachment_refs: AttachmentRefs,
    parsed_ec: Option<i64>,
    /// `Some` when the cell has outputs or an execution count; carries the
    /// durable-or-synthetic execution and its manifest refs.
    execution: Option<(LoadedExecution, Vec<serde_json::Value>)>,
    resolved_assets: Option<ResolvedAssets>,
}

/// Async half of the test loader: file read, JSON parse, blob-store
/// manifest/attachment/widget ingestion. Takes no doc reference, so callers
/// holding a room `RwLock` run this *before* taking the lock.
#[cfg(test)]
pub(crate) async fn prepare_notebook_load(
    path: &std::path::Path,
    blob_store: &BlobStore,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<PreparedNotebookLoad, String> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("Failed to read notebook: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid notebook JSON: {}", e))?;

    // Parse cells. Outputs come back in a parallel map keyed by cell_id —
    // they're destined for RuntimeStateDoc, keyed by a freshly-minted
    // synthetic execution_id per cell.
    let ParsedIpynbCells {
        cells,
        outputs_by_cell,
        attachments: nbformat_attachments,
    } = parse_cells_from_ipynb(&json)
        .ok_or_else(|| "Failed to parse cells from notebook".to_string())?;
    let widget_comms = widget_comms_from_notebook_metadata(json.get("metadata"), blob_store).await;
    let context_id = path.to_string_lossy().to_string();
    let durable_records = durable_execution_records(execution_store, &context_id).await;
    let mut claimed_execution_ids = HashSet::new();

    let mut prepared_cells = Vec::with_capacity(cells.len());
    for cell in cells {
        let attachment_refs =
            nbformat_attachments_to_blob_refs(nbformat_attachments.get(&cell.id), blob_store)
                .await
                .map_err(|e| format!("Failed to ingest attachments for {}: {e}", cell.id))?;
        let parsed_ec: Option<i64> = cell.execution_count.parse::<i64>().ok();
        let cell_outputs = outputs_by_cell.get(&cell.id);
        let has_outputs = cell_outputs.map(|o| !o.is_empty()).unwrap_or(false);

        let execution = if has_outputs || parsed_ec.is_some() {
            let output_refs = if let Some(outs) = cell_outputs.filter(|o| !o.is_empty()) {
                outputs_to_manifest_refs(outs, blob_store).await
            } else {
                Vec::new()
            };
            let execution = durable_or_synthetic_execution(
                &durable_records,
                &mut claimed_execution_ids,
                DurableExecutionLookup {
                    context_id: &context_id,
                    notebook_path: Some(&context_id),
                    cell_id: &cell.id,
                    source: &cell.source,
                    execution_count: parsed_ec,
                    outputs: &output_refs,
                },
            );
            Some((execution, output_refs))
        } else {
            None
        };

        let resolved_assets = if should_resolve_markdown_assets(&cell.cell_type) {
            let mut resolved_assets =
                resolve_markdown_assets(&cell.source, Some(path), None, blob_store).await;
            resolved_assets.extend(resolved_attachment_assets(&cell.source, &attachment_refs));
            Some(resolved_assets)
        } else {
            None
        };

        prepared_cells.push(PreparedNotebookCell {
            cell,
            attachment_refs,
            parsed_ec,
            execution,
            resolved_assets,
        });
    }

    Ok(PreparedNotebookLoad {
        cells: prepared_cells,
        widget_comms,
        metadata: parse_metadata_from_ipynb(&json),
    })
}

/// Synchronous half of the test loader: apply a [`PreparedNotebookLoad`] to
/// the docs. No `.await` — safe to call while holding a room lock.
#[cfg(test)]
pub(crate) fn apply_notebook_load(
    doc: &mut NotebookDoc,
    mut state_doc: Option<&mut RuntimeStateDoc>,
    comms_doc: Option<&mut runtime_doc::CommsDoc>,
    prepared: PreparedNotebookLoad,
) -> Result<usize, String> {
    if let Some(ref mut sd) = state_doc {
        write_widget_comm_topology_to_state_doc(sd, &prepared.widget_comms)
            .map_err(|e| format!("Failed to load widget metadata into state doc: {}", e))?;
    }
    if let Some(cd) = comms_doc {
        write_widget_comm_state_to_comms_doc(cd, &prepared.widget_comms)
            .map_err(|e| format!("Failed to load widget metadata into comms doc: {}", e))?;
    }

    let cell_count = prepared.cells.len();
    for (i, prepared_cell) in prepared.cells.into_iter().enumerate() {
        let PreparedNotebookCell {
            cell,
            attachment_refs,
            parsed_ec,
            execution,
            resolved_assets,
        } = prepared_cell;
        doc.add_cell(i, &cell.id, &cell.cell_type)
            .map_err(|e| format!("Failed to add cell: {}", e))?;
        doc.update_source(&cell.id, &cell.source)
            .map_err(|e| format!("Failed to update source: {}", e))?;
        doc.set_cell_attachments(&cell.id, &attachment_refs)
            .map_err(|e| format!("Failed to set attachments: {}", e))?;

        if let Some((execution, output_refs)) = execution {
            if let Some(ref mut sd) = state_doc {
                let _ = sd.create_execution(&execution.execution_id);
                if !output_refs.is_empty() {
                    sd.set_outputs(&execution.execution_id, &output_refs)
                        .map_err(|e| format!("Failed to set outputs in state doc: {}", e))?;
                }
                if let Some(ec) = parsed_ec {
                    let _ = sd.set_execution_count(&execution.execution_id, ec);
                }
                let _ = sd.set_execution_done(&execution.execution_id, execution.success);
            }
            doc.set_execution_id(&cell.id, Some(&execution.execution_id))
                .map_err(|e| format!("Failed to set execution_id: {}", e))?;
        }
        if let Some(resolved_assets) = resolved_assets {
            doc.set_cell_resolved_assets(&cell.id, &resolved_assets)
                .map_err(|e| format!("Failed to set resolved assets: {}", e))?;
        }
    }

    if let Some(metadata_snapshot) = prepared.metadata {
        doc.set_metadata_snapshot(&metadata_snapshot)
            .map_err(|e| format!("Failed to set metadata: {}", e))?;
    }

    Ok(cell_count)
}

#[cfg(test)]
async fn load_notebook_from_disk_with_runtime_docs_and_execution_store(
    doc: &mut NotebookDoc,
    state_doc: Option<&mut RuntimeStateDoc>,
    comms_doc: Option<&mut runtime_doc::CommsDoc>,
    path: &std::path::Path,
    blob_store: &BlobStore,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<usize, String> {
    let prepared = prepare_notebook_load(path, blob_store, execution_store).await?;
    apply_notebook_load(doc, state_doc, comms_doc, prepared)
}

#[derive(Debug, Clone)]
struct LoadedExecution {
    execution_id: String,
    success: bool,
}

struct DurableExecutionLookup<'a> {
    context_id: &'a str,
    notebook_path: Option<&'a str>,
    cell_id: &'a str,
    source: &'a str,
    execution_count: Option<i64>,
    outputs: &'a [serde_json::Value],
}

async fn durable_execution_records(
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
    context_id: &str,
) -> Vec<runtimed_client::execution_store::ExecutionRecord> {
    match execution_store {
        Some(store) => store.list_context("notebook", context_id).await,
        None => Vec::new(),
    }
}

fn durable_or_synthetic_execution(
    durable_records: &[runtimed_client::execution_store::ExecutionRecord],
    claimed_execution_ids: &mut HashSet<String>,
    lookup: DurableExecutionLookup<'_>,
) -> LoadedExecution {
    if let Some(record) = durable_records.iter().find(|record| {
        !claimed_execution_ids.contains(&record.execution_id)
            && record.matches_notebook_cell(
                lookup.context_id,
                lookup.notebook_path,
                lookup.cell_id,
                lookup.source,
                lookup.execution_count,
                lookup.outputs,
            )
    }) {
        claimed_execution_ids.insert(record.execution_id.clone());
        return LoadedExecution {
            execution_id: record.execution_id.clone(),
            success: record.terminal_success(),
        };
    }

    LoadedExecution {
        execution_id: uuid::Uuid::new_v4().to_string(),
        success: true,
    }
}

/// Create a new notebook with daemon-owned default metadata and one code cell.
///
/// Called by daemon-owned notebook creation (`CreateNotebook` handshake).
/// Uses the provided env_id or generates a new one, and populates the doc
/// with default metadata for the specified runtime. Fresh notebook structure
/// is seeded here so clients never need to infer "new notebook" from a
/// transient zero-cell sync state.
///
/// Returns the env_id used on success.
pub fn create_empty_notebook(
    doc: &mut NotebookDoc,
    runtime: &str,
    default_python_env: crate::settings_doc::PythonEnvType,
    env_id: Option<&str>,
    package_manager: Option<notebook_protocol::connection::PackageManager>,
    dependencies: &[String],
) -> Result<String, String> {
    let env_id = env_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let metadata_snapshot = build_new_notebook_metadata(
        runtime,
        &env_id,
        default_python_env,
        package_manager,
        dependencies,
    );

    // Seeded deps land as plain dep metadata. By default the notebook arrives
    // Untrusted and the trust dialog drives the allowlist write. The
    // `CreateNotebook` handshake path seeds the allowlist directly when deps
    // were explicit on the request — the caller already supplied them, so the
    // tool call itself is the consent event. See `handle_create_notebook` and
    // `seed_trust_from_doc_metadata`.

    doc.set_metadata_snapshot(&metadata_snapshot)
        .map_err(|e| format!("Failed to set metadata: {}", e))?;
    doc.add_cell(0, &uuid::Uuid::new_v4().to_string(), "code")
        .map_err(|e| format!("Failed to seed first cell: {}", e))?;

    Ok(env_id)
}

/// Build default metadata for a new notebook based on runtime.
///
/// Package manager resolution priority:
/// 1. Explicit `package_manager` - use it, even with empty deps.
/// 2. No `package_manager`, non-empty `dependencies` - use `default_python_env`.
/// 3. Neither - preserve current behavior (empty section based on `default_python_env`).
pub(crate) fn build_new_notebook_metadata(
    runtime: &str,
    env_id: &str,
    default_python_env: crate::settings_doc::PythonEnvType,
    package_manager: Option<notebook_protocol::connection::PackageManager>,
    dependencies: &[String],
) -> NotebookMetadataSnapshot {
    use notebook_doc::metadata::{
        CondaInlineMetadata, KernelspecSnapshot, LanguageInfoSnapshot, RuntMetadata,
        UvInlineMetadata,
    };

    let (kernelspec, language_info, runt) = match runtime {
        "deno" => (
            KernelspecSnapshot {
                name: "deno".to_string(),
                display_name: "Deno".to_string(),
                language: Some("typescript".to_string()),
                extras: std::collections::BTreeMap::new(),
            },
            LanguageInfoSnapshot {
                name: "typescript".to_string(),
                version: None,
                extras: std::collections::BTreeMap::new(),
            },
            RuntMetadata {
                schema_version: "1".to_string(),
                env_id: Some(env_id.to_string()),
                uv: None,
                conda: None,
                pixi: None,
                deno: None,
                extra: std::collections::BTreeMap::new(),
            },
        ),
        _ => {
            // Resolve which package manager section to create:
            //   1. Explicit package_manager from the request — resolved via
            //      `PackageManager::resolve()` so wire aliases ("pip",
            //      "mamba") fold to canonical variants.
            //   2. Unknown wire value that isn't an alias — fall back to
            //      `default_python_env` and log; the wire layer is permissive
            //      but the daemon must land on a real section.
            //   3. No explicit manager — use `default_python_env`.
            use notebook_protocol::connection::PackageManager;
            let default_from_setting = || match default_python_env {
                crate::settings_doc::PythonEnvType::Conda => PackageManager::Conda,
                crate::settings_doc::PythonEnvType::Pixi => PackageManager::Pixi,
                _ => PackageManager::Uv,
            };
            let effective_manager: PackageManager = match package_manager {
                Some(pm) => match pm.resolve() {
                    Ok(resolved) => resolved,
                    Err(msg) => {
                        tracing::warn!(
                            "[runtimed] build_new_notebook_metadata: {msg}; falling back to default_python_env"
                        );
                        default_from_setting()
                    }
                },
                None => default_from_setting(),
            };

            let deps = dependencies.to_vec();

            let (uv, conda, pixi) = match effective_manager {
                PackageManager::Conda => (
                    None,
                    Some(CondaInlineMetadata {
                        dependencies: deps,
                        channels: vec!["conda-forge".to_string()],
                        python: None,
                    }),
                    None,
                ),
                PackageManager::Pixi => (
                    None,
                    None,
                    Some(notebook_doc::metadata::PixiInlineMetadata {
                        dependencies: deps,
                        pypi_dependencies: vec![],
                        channels: vec!["conda-forge".to_string()],
                        python: None,
                    }),
                ),
                PackageManager::Uv => (
                    Some(UvInlineMetadata {
                        dependencies: deps,
                        requires_python: None,
                        prerelease: None,
                    }),
                    None,
                    None,
                ),
                // Resolved above — this branch is defensive; Unknown would
                // already have been folded to a canonical variant or the
                // default_python_env fallback.
                PackageManager::Unknown(_) => unreachable!(
                    "effective_manager was resolved above; Unknown shouldn't reach this match"
                ),
            };

            (
                KernelspecSnapshot {
                    name: "python3".to_string(),
                    display_name: "Python 3".to_string(),
                    language: Some("python".to_string()),
                    extras: std::collections::BTreeMap::new(),
                },
                LanguageInfoSnapshot {
                    name: "python".to_string(),
                    version: None,
                    extras: std::collections::BTreeMap::new(),
                },
                RuntMetadata {
                    schema_version: "1".to_string(),
                    env_id: Some(env_id.to_string()),
                    uv,
                    conda,
                    pixi,
                    deno: None,
                    extra: std::collections::BTreeMap::new(),
                },
            )
        }
    };

    NotebookMetadataSnapshot {
        kernelspec: Some(kernelspec),
        language_info: Some(language_info),
        runt,
        extras: std::collections::BTreeMap::new(),
    }
}

/// Apply external .ipynb changes to the Automerge doc.
///
/// Compares cells by ID and:
/// - Adds new cells
/// - Removes deleted cells
/// - Updates source, execution_count, and outputs for modified cells
/// - Handles cell reordering by rebuilding the cell list
///
/// When a kernel is running, outputs and execution counts are preserved
/// to avoid losing in-progress execution results.
///
/// Returns true if any changes were applied.
pub(crate) async fn apply_ipynb_changes(
    room: &NotebookRoom,
    external_cells: &[CellSnapshot],
    external_outputs: &HashMap<String, Vec<serde_json::Value>>,
    external_attachments: &HashMap<String, serde_json::Value>,
    has_running_kernel: bool,
) -> bool {
    let current_cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };

    // Pre-convert external outputs through the blob store so they're stored as
    // manifest hashes rather than raw JSON. This also ensures comparisons against
    // the doc's existing manifest hashes work correctly.
    let converted_outputs: HashMap<String, Vec<serde_json::Value>> = {
        let mut map = HashMap::new();
        for (cell_id, raw_outputs) in external_outputs {
            if !raw_outputs.is_empty() {
                let refs = outputs_to_manifest_refs(raw_outputs, &room.blob_store).await;
                map.insert(cell_id.clone(), refs);
            }
        }
        map
    };
    let notebook_path_for_assets = room.file_binding.path().await;
    let converted_attachments: HashMap<String, AttachmentRefs> = {
        let mut map = HashMap::new();
        for cell in external_cells {
            let refs = match nbformat_attachments_to_blob_refs(
                external_attachments.get(&cell.id),
                &room.blob_store,
            )
            .await
            {
                Ok(refs) => refs,
                Err(e) => {
                    warn!(
                        "[notebook-watch] Failed to ingest attachments for {}: {}",
                        cell.id, e
                    );
                    return false;
                }
            };
            if !refs.is_empty() {
                map.insert(cell.id.clone(), refs);
            }
        }
        map
    };
    let empty_assets = HashMap::new();
    let empty_attachments = HashMap::new();
    let converted_assets: HashMap<String, ResolvedAssets> = {
        let mut map = HashMap::new();
        for cell in external_cells {
            if should_resolve_markdown_assets(&cell.cell_type) {
                let mut resolved_assets = resolve_markdown_assets(
                    &cell.source,
                    notebook_path_for_assets.as_deref(),
                    None,
                    &room.blob_store,
                )
                .await;
                resolved_assets.extend(resolved_attachment_assets(
                    &cell.source,
                    converted_attachments
                        .get(cell.id.as_str())
                        .unwrap_or(&empty_attachments),
                ));
                map.insert(cell.id.clone(), resolved_assets);
            }
        }
        map
    };

    // Build maps for comparison
    let current_map: HashMap<&str, &CellSnapshot> =
        current_cells.iter().map(|c| (c.id.as_str(), c)).collect();
    let external_map: HashMap<&str, &CellSnapshot> =
        external_cells.iter().map(|c| (c.id.as_str(), c)).collect();

    // Check if cell order changed
    let current_ids: Vec<&str> = current_cells.iter().map(|c| c.id.as_str()).collect();
    let external_ids: Vec<&str> = external_cells.iter().map(|c| c.id.as_str()).collect();
    let order_changed = {
        // Filter to only IDs that exist in both, then compare order
        let common_current: Vec<&str> = current_ids
            .iter()
            .filter(|id| external_map.contains_key(*id))
            .copied()
            .collect();
        let common_external: Vec<&str> = external_ids
            .iter()
            .filter(|id| current_map.contains_key(*id))
            .copied()
            .collect();
        common_current != common_external
    };

    // Detect wholesale file replacement: the current doc has cells, the
    // external file has cells, but they share zero cell IDs. This happens
    // when an external process (e.g. an AI agent) writes a completely new
    // notebook to the same path. Route through the rebuild path so the cell
    // list is replaced atomically instead of trying to infer an incremental
    // edit script across unrelated IDs.
    let no_common_cells = !current_ids.is_empty()
        && !external_ids.is_empty()
        && !current_ids.iter().any(|id| external_map.contains_key(id));

    // Struct for collecting deferred state_doc writes so the doc write
    // guard is not held across state_doc `.await` (deadlock prevention).
    struct DeferredExecution<'a> {
        synthetic_eid: String,
        outputs: &'a [serde_json::Value],
        execution_count: Option<i64>,
    }

    // If order changed or the file was wholesale-replaced, rebuild the
    // cell list as a document-owned transaction. The baseline is the current
    // live document because the file watcher compares disk content against
    // `last_save_sources`; using a transaction avoids minting a parallel fork
    // actor while keeping actor restoration and panic recovery document-owned.
    if order_changed || no_common_cells {
        debug!(
            "[notebook-watch] {} — rebuilding cell list",
            if no_common_cells {
                "Wholesale file replacement detected (zero common cells)"
            } else {
                "Cell order changed"
            }
        );

        // Scope the doc write guard so it drops before state_doc and
        // saved_sources `.await`s (deadlock prevention).
        let deferred_executions = {
            let mut doc = room.doc.write().await;
            let current_execution_ids: HashMap<String, String> = current_cells
                .iter()
                .filter_map(|cell| {
                    doc.get_execution_id(&cell.id)
                        .map(|execution_id| (cell.id.clone(), execution_id))
                })
                .collect();
            let heads = doc.get_heads();

            match doc.transact_at_heads_recovering(
                &heads,
                Some("runtimed:filesystem"),
                "file-watcher-order-transaction",
                |doc| {
                    // Delete all current cells and re-add in external order.
                    for cell in &current_cells {
                        let _ = doc.delete_cell(&cell.id);
                    }

                    let mut deferred: Vec<DeferredExecution> = Vec::new();

                    for (index, ext_cell) in external_cells.iter().enumerate() {
                        if doc
                            .add_cell(index, &ext_cell.id, &ext_cell.cell_type)
                            .is_ok()
                        {
                            let _ = doc.update_source(&ext_cell.id, &ext_cell.source);

                            // For existing cells with running kernel: preserve current execution_id
                            // (outputs live in RuntimeStateDoc, keyed by execution_id)
                            // For new cells: defer state_doc writes until after doc lock is released
                            if has_running_kernel {
                                if current_map.contains_key(ext_cell.id.as_str()) {
                                    // Existing cell - preserve in-progress state (execution_id stays)
                                    // execution_count is in RuntimeStateDoc via execution_id
                                    if let Some(eid) = current_execution_ids.get(&ext_cell.id) {
                                        let _ =
                                            doc.set_execution_id(&ext_cell.id, Some(eid.as_str()));
                                    }
                                } else {
                                    // New cell - collect for deferred state_doc write
                                    let ext_outputs = converted_outputs
                                        .get(ext_cell.id.as_str())
                                        .map(|v| v.as_slice())
                                        .unwrap_or(&[]);
                                    let parsed_ec: Option<i64> =
                                        ext_cell.execution_count.parse().ok();
                                    if !ext_outputs.is_empty() || parsed_ec.is_some() {
                                        let synthetic_eid = uuid::Uuid::new_v4().to_string();
                                        let _ = doc
                                            .set_execution_id(&ext_cell.id, Some(&synthetic_eid));
                                        deferred.push(DeferredExecution {
                                            synthetic_eid,
                                            outputs: ext_outputs,
                                            execution_count: parsed_ec,
                                        });
                                    }
                                }
                            } else {
                                let ext_outputs = converted_outputs
                                    .get(ext_cell.id.as_str())
                                    .map(|v| v.as_slice())
                                    .unwrap_or(&[]);
                                let parsed_ec: Option<i64> = ext_cell.execution_count.parse().ok();
                                if !ext_outputs.is_empty() || parsed_ec.is_some() {
                                    let synthetic_eid = uuid::Uuid::new_v4().to_string();
                                    let _ =
                                        doc.set_execution_id(&ext_cell.id, Some(&synthetic_eid));
                                    deferred.push(DeferredExecution {
                                        synthetic_eid,
                                        outputs: ext_outputs,
                                        execution_count: parsed_ec,
                                    });
                                }
                            }
                            let ext_assets = converted_assets
                                .get(ext_cell.id.as_str())
                                .unwrap_or(&empty_assets);
                            let _ = doc.set_cell_resolved_assets(&ext_cell.id, ext_assets);
                            let ext_attachments = converted_attachments
                                .get(ext_cell.id.as_str())
                                .unwrap_or(&empty_attachments);
                            let _ = doc.set_cell_attachments(&ext_cell.id, ext_attachments);
                        }
                    }

                    Ok(deferred)
                },
            ) {
                Ok(deferred) => deferred,
                Err(e) => {
                    warn!("[file-watcher] order transaction failed: {}", e);
                    // Do not create RuntimeStateDoc executions for cells that
                    // failed to commit to the notebook doc.
                    Vec::new()
                }
            }
        }; // doc guard dropped here

        // Apply deferred state_doc writes
        if !deferred_executions.is_empty() {
            let _ = room.state.with_doc(|sd| {
                for de in &deferred_executions {
                    let _ = sd.create_execution(&de.synthetic_eid);
                    if !de.outputs.is_empty() {
                        let _ = sd.set_outputs(&de.synthetic_eid, de.outputs);
                    }
                    if let Some(ec) = de.execution_count {
                        let _ = sd.set_execution_count(&de.synthetic_eid, ec);
                    }
                    let _ = sd.set_execution_done(&de.synthetic_eid, true);
                }
                Ok(())
            });
        }

        // Update saved_sources baseline so subsequent external edits are
        // detected correctly (same as the non-order-change path).
        {
            let mut saved = room.persistence.last_save_sources.write().await;
            saved.clear();
            for ext_cell in external_cells {
                saved.insert(ext_cell.id.clone(), ext_cell.source.clone());
            }
        }

        return true;
    }

    // Snapshot saved_sources before the doc write lock to avoid holding
    // doc across saved_sources `.await` (deadlock prevention).
    let saved_sources_snapshot = room.last_save_sources_snapshot().await;
    let have_save_snapshot = !saved_sources_snapshot.is_empty();

    // Find cells to delete — only cells that existed in our last save
    // but are no longer on disk (genuine external deletion). Cells that
    // are in the CRDT but NOT in last_save_sources were created after
    // the save and should be preserved (the user or agent just added them).
    //
    // If we've never saved (last_save_sources is empty), we have no
    // baseline to distinguish "externally deleted" from "just created in
    // CRDT but not yet saved." Skip deletions entirely — it's safer to
    // keep extra cells than to silently drop cells a client just created.
    let cells_to_delete: Vec<String> = if !have_save_snapshot {
        if !current_cells.is_empty() {
            debug!(
                "[notebook-watch] No save snapshot — skipping deletion of {} CRDT cells not on disk",
                current_cells.iter().filter(|c| !external_map.contains_key(c.id.as_str())).count()
            );
        }
        Vec::new()
    } else {
        current_cells
            .iter()
            .filter(|c| {
                !external_map.contains_key(c.id.as_str())
                    && saved_sources_snapshot.contains_key(c.id.as_str())
            })
            .map(|c| c.id.clone())
            .collect()
    };

    // Snapshot current execution state from state_doc before acquiring
    // the doc write lock, so we don't hold state_doc and doc simultaneously
    // (deadlock prevention).
    let current_execution_state: HashMap<String, (Vec<serde_json::Value>, Option<i64>)> =
        if !has_running_kernel {
            // Need doc read to get execution IDs, then state_doc read for outputs.
            // Do both reads in scoped blocks.
            let eid_map: HashMap<String, String> = {
                let doc = room.doc.read().await;
                let mut map = HashMap::new();
                for ext_cell in external_cells.iter() {
                    if current_map.contains_key(ext_cell.id.as_str()) {
                        if let Some(eid) = doc.get_execution_id(&ext_cell.id) {
                            map.insert(ext_cell.id.clone(), eid);
                        }
                    }
                }
                map
            };
            room.state
                .read(|sd| {
                    let mut state_map = HashMap::new();
                    for (cell_id, eid) in &eid_map {
                        let outputs = sd.get_outputs(eid);
                        let ec = sd.get_execution(eid).and_then(|e| e.execution_count);
                        state_map.insert(cell_id.clone(), (outputs, ec));
                    }
                    state_map
                })
                .unwrap_or_default()
        } else {
            HashMap::new()
        };

    // Scope the doc write guard so it drops before state_doc and
    // saved_sources `.await`s (deadlock prevention: no lock held
    // across `.await`).
    let (changed, deferred_execs) = {
        let mut doc = room.doc.write().await;
        let heads = doc.get_heads();
        match doc.transact_at_heads_recovering(
            &heads,
            Some("runtimed:filesystem"),
            "file-watcher-update-transaction",
            |doc| {
                let mut changed = false;

                for cell_id in cells_to_delete {
                    debug!("[notebook-watch] Deleting cell: {}", cell_id);
                    if let Ok(true) = doc.delete_cell(&cell_id) {
                        changed = true;
                    }
                }

                // Source comparison uses last_save_sources (what we wrote to disk)
                // instead of the live CRDT (which may have progressed with new user
                // typing since the save). This prevents the file watcher from
                // treating our own autosave as an "external change" and overwriting
                // the user's recent edits. Only genuine external changes (git pull,
                // external editor) — where the disk content differs from what we
                // last saved — trigger a source update.
                let mut deferred_execs: Vec<DeferredExecution> = Vec::new();
                // Track cells whose execution_id should be cleared (no new outputs)
                let mut clear_execution_ids: Vec<String> = Vec::new();

                // Process external cells in order (add new or update existing)
                for (index, ext_cell) in external_cells.iter().enumerate() {
                    if let Some(current_cell) = current_map.get(ext_cell.id.as_str()) {
                        // Cell exists — check if source genuinely changed externally.
                        // Compare disk content against what we last saved, NOT the live
                        // CRDT. If disk matches our last save, the change is from our
                        // own autosave and should be ignored (the CRDT may have
                        // progressed with new typing since then).
                        let saved_source = saved_sources_snapshot.get(ext_cell.id.as_str());
                        let is_external_change = match saved_source {
                            Some(saved) => ext_cell.source != *saved,
                            None => current_cell.source != ext_cell.source,
                        };

                        if is_external_change {
                            debug!("[notebook-watch] Updating source for cell: {}", ext_cell.id);
                            if doc.update_source(&ext_cell.id, &ext_cell.source).is_ok() {
                                changed = true;
                            }
                        }

                        // Update cell type if changed
                        if current_cell.cell_type != ext_cell.cell_type {
                            debug!(
                                "[notebook-watch] Cell type changed for {}: {} -> {}",
                                ext_cell.id, current_cell.cell_type, ext_cell.cell_type
                            );
                            // Cell type changes require recreating the cell (rare case)
                            // For now, just log - full support would need more work
                        }

                        // Preserve outputs and execution_count if kernel is running
                        if !has_running_kernel {
                            let ext_outputs = converted_outputs
                                .get(ext_cell.id.as_str())
                                .map(|v| v.as_slice())
                                .unwrap_or(&[]);
                            let parsed_ec: Option<i64> = ext_cell.execution_count.parse().ok();

                            // Compare external outputs and execution_count against
                            // pre-snapshotted RuntimeStateDoc state
                            let current_eid = doc.get_execution_id(&ext_cell.id);
                            let (current_outputs, current_ec) = current_execution_state
                                .get(ext_cell.id.as_str())
                                .cloned()
                                .unwrap_or((Vec::new(), None));

                            let outputs_changed = current_outputs.as_slice() != ext_outputs;
                            let ec_changed = current_ec != parsed_ec;

                            if outputs_changed || ec_changed {
                                if !ext_outputs.is_empty() || parsed_ec.is_some() {
                                    debug!(
                                        "[notebook-watch] Updating outputs/execution_count for cell: {}",
                                        ext_cell.id
                                    );
                                    let synthetic_eid = uuid::Uuid::new_v4().to_string();
                                    let _ =
                                        doc.set_execution_id(&ext_cell.id, Some(&synthetic_eid));
                                    deferred_execs.push(DeferredExecution {
                                        synthetic_eid,
                                        outputs: ext_outputs,
                                        execution_count: parsed_ec,
                                    });
                                    changed = true;
                                } else if current_eid.is_some() {
                                    clear_execution_ids.push(ext_cell.id.clone());
                                    changed = true;
                                }
                            }
                        }

                        let ext_assets = converted_assets
                            .get(ext_cell.id.as_str())
                            .unwrap_or(&empty_assets);
                        if current_cell.resolved_assets != *ext_assets {
                            if let Ok(true) = doc.set_cell_resolved_assets(&ext_cell.id, ext_assets)
                            {
                                changed = true;
                            }
                        }
                        let ext_attachments = converted_attachments
                            .get(ext_cell.id.as_str())
                            .unwrap_or(&empty_attachments);
                        if current_cell.attachments != *ext_attachments {
                            if let Ok(true) = doc.set_cell_attachments(&ext_cell.id, ext_attachments)
                            {
                                changed = true;
                            }
                        }
                    } else {
                        // New cell - add it
                        // New cells don't have any in-progress state, so always use external values
                        debug!(
                            "[notebook-watch] Adding new cell at index {}: {}",
                            index, ext_cell.id
                        );
                        if doc
                            .add_cell(index, &ext_cell.id, &ext_cell.cell_type)
                            .is_ok()
                        {
                            changed = true;
                            let _ = doc.update_source(&ext_cell.id, &ext_cell.source);
                            let ext_outputs = converted_outputs
                                .get(ext_cell.id.as_str())
                                .map(|v| v.as_slice())
                                .unwrap_or(&[]);
                            let parsed_ec: Option<i64> = ext_cell.execution_count.parse().ok();
                            if !ext_outputs.is_empty() || parsed_ec.is_some() {
                                let synthetic_eid = uuid::Uuid::new_v4().to_string();
                                let _ = doc.set_execution_id(&ext_cell.id, Some(&synthetic_eid));
                                deferred_execs.push(DeferredExecution {
                                    synthetic_eid,
                                    outputs: ext_outputs,
                                    execution_count: parsed_ec,
                                });
                            }
                            let ext_assets = converted_assets
                                .get(ext_cell.id.as_str())
                                .unwrap_or(&empty_assets);
                            let _ = doc.set_cell_resolved_assets(&ext_cell.id, ext_assets);
                            let ext_attachments = converted_attachments
                                .get(ext_cell.id.as_str())
                                .unwrap_or(&empty_attachments);
                            let _ = doc.set_cell_attachments(&ext_cell.id, ext_attachments);
                        }
                    }
                }

                // Apply clear_execution_ids before integrating the transaction.
                for cell_id in &clear_execution_ids {
                    let _ = doc.set_execution_id(cell_id, None);
                }

                Ok((changed, deferred_execs))
            },
        ) {
            Ok(result) => result,
            Err(e) => {
                warn!("[file-watcher] update transaction failed: {}", e);
                (false, Vec::new())
            }
        }
    }; // doc guard dropped here

    // Apply deferred state_doc writes
    if !deferred_execs.is_empty() {
        let _ = room.state.with_doc(|sd| {
            for de in &deferred_execs {
                let _ = sd.create_execution(&de.synthetic_eid);
                if !de.outputs.is_empty() {
                    let _ = sd.set_outputs(&de.synthetic_eid, de.outputs);
                }
                if let Some(ec) = de.execution_count {
                    let _ = sd.set_execution_count(&de.synthetic_eid, ec);
                }
                let _ = sd.set_execution_done(&de.synthetic_eid, true);
            }
            Ok(())
        });
    }

    // Update saved_sources baseline after applying external changes so
    // that subsequent external edits are detected correctly (P2-a) and
    // externally-added cells become deletable if later removed (P2-b).
    if changed {
        let mut saved = room.persistence.last_save_sources.write().await;
        for ext_cell in external_cells {
            saved.insert(ext_cell.id.clone(), ext_cell.source.clone());
        }
        // Remove entries for cells we just deleted
        saved.retain(|id, _| external_map.contains_key(id.as_str()));
    }

    changed
}
