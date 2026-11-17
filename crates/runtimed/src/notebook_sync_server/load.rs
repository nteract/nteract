use runtimed_client::output_equivalence::{compare_outputs_with_policy, OutputComparison};
use std::collections::HashSet;

use super::*;
use base64::Engine as _;

fn legacy_cell_id(notebook_id: uuid::Uuid, index: usize) -> String {
    uuid::Uuid::new_v5(
        &notebook_id,
        format!("nteract:legacy-nbformat-cell:{index}").as_bytes(),
    )
    .to_string()
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

/// Split streaming cells into the watcher's diff shape: `CellSnapshot`s plus
/// outputs keyed by cell id.
///
/// A cell gets an entry in the outputs map only when it actually has outputs,
/// so callers may treat map membership as "has outputs".
pub(crate) fn streaming_cells_into_snapshots(
    cells: Vec<StreamingCell>,
) -> (Vec<CellSnapshot>, HashMap<String, Vec<serde_json::Value>>) {
    let mut outputs_by_cell = HashMap::new();
    let snapshots = cells
        .into_iter()
        .map(|cell| {
            let StreamingCell {
                id,
                cell_type,
                position,
                source,
                execution_count,
                outputs,
                metadata,
            } = cell;
            if !outputs.is_empty() {
                outputs_by_cell.insert(id.clone(), outputs);
            }
            CellSnapshot {
                id,
                cell_type,
                position,
                source,
                execution_count,
                metadata,
                resolved_assets: HashMap::new(),
                attachments: HashMap::new(),
            }
        })
        .collect();
    (snapshots, outputs_by_cell)
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
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// Parse `.ipynb` bytes into streaming cells using jiter for fast JSON parsing.
///
/// This is the single notebook parser: initial load, source reconciliation,
/// and the file watcher all read disk content through it. Outputs are kept as
/// `serde_json::Value` so they can be passed directly to `create_manifest`
/// without a serialize→parse round-trip; the watcher adapts them to its
/// diff shape via `streaming_cells_into_snapshots`.
///
/// The source field can be either a string or an array of strings (lines),
/// normalized to a single string. Non-object entries in `cells` are dropped:
/// no caller depends on synthesized placeholder cells (the watcher diffs by
/// cell id and the baseline refresh maps id to source), and enumeration runs
/// over the raw array so surviving idless cells keep their index-derived ids.
///
/// For older notebooks (pre-nbformat 4.5) without cell IDs we derive a UUIDv5
/// from the stable room identity and the legacy cell ordinal. Re-reading the
/// same idless file for recovery or a watcher edit therefore retains the exact
/// staged identity. The next save writes those IDs back, upgrading the file to
/// nbformat 4.5 and removing the ordinal fallback.
///
/// Positions are generated incrementally using fractional indexing.
pub(crate) fn parse_notebook_jiter_for_notebook(
    bytes: &[u8],
    notebook_id: uuid::Uuid,
) -> Result<ParsedStreamingNotebook, String> {
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
    for (index, cell) in cells_arr.iter().enumerate() {
        let cell_obj = match cell {
            jiter::JsonValue::Object(obj) => obj,
            _ => continue,
        };

        let id = jobj_get(cell_obj, "id")
            .and_then(|v| match v {
                jiter::JsonValue::Str(s) => Some(s.to_string()),
                _ => None,
            })
            .unwrap_or_else(|| legacy_cell_id(notebook_id, index));

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
    entries.sort_by_key(|(comm_id, _)| *comm_id);

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

struct PreparedInitialCell {
    cell: StreamingCell,
    output_refs: Vec<serde_json::Value>,
    resolved_assets: ResolvedAssets,
    attachment_refs: AttachmentRefs,
    execution: Option<LoadedExecution>,
}

struct PreparedInitialImport {
    source_content: Vec<u8>,
    fingerprint: super::recovery::SourceFingerprint,
    cells: Vec<PreparedInitialCell>,
    metadata: Option<NotebookMetadataSnapshot>,
    widget_comms: Vec<LoadedWidgetComm>,
    loaded_sources: HashMap<String, String>,
}

/// Fully validated and asset-resolved disk state for an explicit source
/// reconciliation. Preparation is async and completes before the recovery
/// journal is archived or the live document lock is acquired.
pub(crate) struct PreparedSourceReconciliation {
    prepared: PreparedInitialImport,
}

/// The exact causal replacement authored onto the live recovered document.
pub(crate) struct AppliedSourceReconciliation {
    pub(crate) fingerprint: super::recovery::SourceFingerprint,
    pub(crate) source_content: Vec<u8>,
    pub(crate) loaded_sources: HashMap<String, String>,
    pub(crate) heads: Vec<automerge::ChangeHash>,
    pub(crate) change_hashes: Vec<automerge::ChangeHash>,
    pub(crate) snapshot: Vec<u8>,
    executions: Vec<StagedExecutionImport>,
    widget_comms: Vec<StagedWidgetCommImport>,
}

/// Read, parse, and resolve every source-owned value before the live notebook
/// document is touched. Blob writes are content-addressed and therefore safe
/// to complete before the staged Automerge history is published.
async fn prepare_initial_import(
    room: &NotebookRoom,
    path: &Path,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<PreparedInitialImport, String> {
    let source_content = tokio::fs::read(path)
        .await
        .map_err(|error| format!("Failed to read notebook: {error}"))?;
    let fingerprint = super::recovery::source_fingerprint(&source_content);
    let parsed = parse_notebook_jiter_for_notebook(&source_content, room.id)?;
    let widget_comms =
        widget_comms_from_notebook_metadata(parsed.metadata_value.as_ref(), &room.blob_store).await;
    let notebook_path = room
        .file_binding
        .path()
        .await
        .map(|value| value.to_string_lossy().into_owned());
    let context_id = super::notebook_execution_context_id(room, notebook_path.as_deref());
    let durable_records = durable_execution_records(execution_store, &context_id).await;
    let mut claimed_execution_ids = HashSet::new();
    let mut prepared_cells = Vec::with_capacity(parsed.cells.len());
    let mut loaded_sources = HashMap::with_capacity(parsed.cells.len());

    for cell in parsed.cells {
        loaded_sources.insert(cell.id.clone(), cell.source.clone());
        let mut output_refs = Vec::with_capacity(cell.outputs.len());
        for output in &cell.outputs {
            output_refs.push(output_value_to_manifest_ref(output, &room.blob_store).await);
        }
        let attachment_refs =
            nbformat_attachments_to_blob_refs(parsed.attachments.get(&cell.id), &room.blob_store)
                .await
                .map_err(|error| {
                    format!("Failed to ingest attachments for {}: {error}", cell.id)
                })?;
        let mut resolved_assets = if should_resolve_markdown_assets(&cell.cell_type) {
            resolve_markdown_assets(&cell.source, Some(path), None, &room.blob_store).await
        } else {
            ResolvedAssets::new()
        };
        if should_resolve_markdown_assets(&cell.cell_type) {
            resolved_assets.extend(resolved_attachment_assets(&cell.source, &attachment_refs));
        }
        let execution_count = cell.execution_count.parse::<i64>().ok();
        let execution = if output_refs.is_empty() && execution_count.is_none() {
            None
        } else {
            Some(
                durable_or_synthetic_execution(
                    &durable_records,
                    &room.blob_store,
                    &mut claimed_execution_ids,
                    DurableExecutionLookup {
                        context_id: &context_id,
                        notebook_path: notebook_path.as_deref(),
                        cell_id: &cell.id,
                        source: &cell.source,
                        execution_count,
                        outputs: &output_refs,
                    },
                )
                .await,
            )
        };
        prepared_cells.push(PreparedInitialCell {
            cell,
            output_refs,
            resolved_assets,
            attachment_refs,
            execution,
        });
    }

    Ok(PreparedInitialImport {
        source_content,
        fingerprint,
        cells: prepared_cells,
        metadata: parsed.metadata,
        widget_comms,
        loaded_sources,
    })
}

/// Read and fully prepare the bound `.ipynb` before a caller commits to
/// archiving recovery history. This deliberately shares the initial source
/// preparation path so attachments, output blobs, markdown assets, metadata,
/// and stable disk cell IDs receive identical validation.
pub(crate) async fn prepare_source_reconciliation(
    room: &NotebookRoom,
    path: &Path,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<PreparedSourceReconciliation, String> {
    prepare_initial_import(room, path, execution_store)
        .await
        .map(|prepared| PreparedSourceReconciliation { prepared })
}

/// Author a deliberate disk-source replacement on top of the current live
/// recovered history. The caller must hold the room document write lock and
/// retain a pre-mutation snapshot for rollback if the journal commit fails.
pub(crate) fn apply_prepared_source_reconciliation(
    doc: &mut NotebookDoc,
    actor: &str,
    prepared: PreparedSourceReconciliation,
) -> Result<AppliedSourceReconciliation, String> {
    let baseline_heads = doc.get_heads();
    doc.transact_at_heads_recovering(
        &baseline_heads,
        Some(actor),
        "source-reconciliation",
        |doc| {
            doc.clear_all_cells()?;
            for prepared_cell in &prepared.prepared.cells {
                let cell = &prepared_cell.cell;
                doc.add_cell_full(
                    &cell.id,
                    &cell.cell_type,
                    &cell.position,
                    &cell.source,
                    &cell.execution_count,
                    &cell.metadata,
                )?;
                if let Some(execution) = &prepared_cell.execution {
                    doc.set_execution_id(&cell.id, Some(&execution.execution_id))?;
                }
                doc.set_cell_resolved_assets(&cell.id, &prepared_cell.resolved_assets)?;
                doc.set_cell_attachments(&cell.id, &prepared_cell.attachment_refs)?;
            }
            if let Some(metadata) = prepared.prepared.metadata.as_ref() {
                doc.set_metadata_snapshot(metadata)?;
            } else {
                doc.set_metadata_snapshot(&NotebookMetadataSnapshot::default())?;
            }
            Ok(())
        },
    )
    .map_err(|error| format!("Failed to author source reconciliation: {error}"))?;

    let changes = doc.doc_mut().get_changes(&baseline_heads);
    if changes.is_empty() {
        return Err("Source reconciliation authored no causal replacement changes".to_string());
    }
    let change_hashes = changes.iter().map(automerge::Change::hash).collect();
    let heads = doc.get_heads();
    let snapshot = doc.save();
    let (executions, widget_comms) = prepared_runtime_sidecars(&prepared.prepared);

    Ok(AppliedSourceReconciliation {
        fingerprint: prepared.prepared.fingerprint,
        source_content: prepared.prepared.source_content,
        loaded_sources: prepared.prepared.loaded_sources,
        heads,
        change_hashes,
        snapshot,
        executions,
        widget_comms,
    })
}

fn capture_staged_batch(
    staged: &mut NotebookDoc,
    previous_heads: &[automerge::ChangeHash],
) -> Option<StagedChangeBatch> {
    let changes = staged.doc_mut().get_changes(previous_heads);
    if changes.is_empty() {
        return None;
    }
    let hashes = changes.iter().map(automerge::Change::hash).collect();
    Some(StagedChangeBatch { changes, hashes })
}

async fn stage_initial_import(
    room: &NotebookRoom,
    generation: u64,
    prepared: PreparedInitialImport,
) -> Result<
    (
        Arc<StagedImportArtifact>,
        Arc<runtimed_client::protocol::NotebookProjection>,
    ),
    String,
> {
    let actor = format!("runtimed:source:{}:{generation}", room.id);
    let genesis = room.lifecycle.genesis_snapshot();
    let mut staged = NotebookDoc::load_with_actor(&genesis, &actor)
        .map_err(|error| format!("Failed to load canonical room genesis: {error}"))?;
    let mut change_batches = Vec::new();
    // Derive the sidecar imports while `prepared` is still whole; artifact
    // construction below partially moves it.
    let (executions, widget_comms) = prepared_runtime_sidecars(&prepared);

    for cells in prepared.cells.chunks(STREAMING_BATCH_SIZE) {
        let previous_heads = staged.get_heads();
        for prepared_cell in cells {
            let cell = &prepared_cell.cell;
            staged
                .add_cell_full(
                    &cell.id,
                    &cell.cell_type,
                    &cell.position,
                    &cell.source,
                    &cell.execution_count,
                    &cell.metadata,
                )
                .map_err(|error| format!("Failed to stage cell {}: {error}", cell.id))?;
            if let Some(execution) = &prepared_cell.execution {
                staged
                    .set_execution_id(&cell.id, Some(&execution.execution_id))
                    .map_err(|error| {
                        format!("Failed to stage execution for {}: {error}", cell.id)
                    })?;
            }
            staged
                .set_cell_resolved_assets(&cell.id, &prepared_cell.resolved_assets)
                .map_err(|error| format!("Failed to stage assets for {}: {error}", cell.id))?;
            staged
                .set_cell_attachments(&cell.id, &prepared_cell.attachment_refs)
                .map_err(|error| format!("Failed to stage attachments for {}: {error}", cell.id))?;
        }
        if let Some(batch) = capture_staged_batch(&mut staged, &previous_heads) {
            change_batches.push(batch);
        }
    }

    if let Some(metadata) = &prepared.metadata {
        let previous_heads = staged.get_heads();
        staged
            .set_metadata_snapshot(metadata)
            .map_err(|error| format!("Failed to stage notebook metadata: {error}"))?;
        if let Some(batch) = capture_staged_batch(&mut staged, &previous_heads) {
            change_batches.push(batch);
        }
    }

    let staged_heads = staged.get_heads();
    let change_hashes = change_batches
        .iter()
        .flat_map(|batch| batch.hashes.iter().copied())
        .collect::<Vec<_>>();
    let snapshot: Arc<[u8]> = staged.save().into();
    let projection = Arc::new(
        build_staged_notebook_projection(room, &mut staged, generation)
            .await
            .map_err(|error| format!("Failed to build staged projection: {error:#}"))?,
    );
    let artifact = Arc::new(StagedImportArtifact {
        generation,
        fingerprint: prepared.fingerprint,
        change_batches,
        change_hashes,
        staged_heads,
        snapshot,
        source_content: prepared.source_content.into(),
        cell_count: prepared.cells.len(),
        loaded_sources: prepared.loaded_sources,
        executions,
        widget_comms,
    });
    Ok((artifact, projection))
}

async fn journal_staged_import(
    room: &NotebookRoom,
    artifact: Arc<StagedImportArtifact>,
) -> Result<(), String> {
    let durability = Arc::clone(&room.durability);
    let generation = artifact.generation;
    let fingerprint = artifact.fingerprint;
    let change_hashes = artifact.change_hashes.iter().map(|hash| hash.0).collect();
    let durable_heads = artifact.staged_heads.iter().map(|head| head.0).collect();
    let snapshot = Vec::from(artifact.snapshot.as_ref());
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        durability
            .commit_staged_source(
                &snapshot,
                durable_heads,
                generation,
                fingerprint,
                change_hashes,
            )
            .map_err(|error| format!("Failed to commit staged recovery record: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Recovery journal task failed: {error}"))?
}

async fn rebuild_staged_projection_after_sidecars(
    room: &NotebookRoom,
    artifact: &StagedImportArtifact,
) -> Result<Arc<runtimed_client::protocol::NotebookProjection>, String> {
    let actor = format!(
        "runtimed:source-projection:{}:{}",
        room.id, artifact.generation
    );
    let mut staged = NotebookDoc::load_with_actor(artifact.snapshot.as_ref(), &actor)
        .map_err(|error| format!("Failed to reload staged projection document: {error}"))?;
    Ok(Arc::new(
        build_staged_notebook_projection(room, &mut staged, artifact.generation)
            .await
            .map_err(|error| format!("Failed to rebuild staged projection: {error:#}"))?,
    ))
}

fn publish_initial_file_checkpoint(
    room: &NotebookRoom,
    source_path: &Path,
    artifact: &StagedImportArtifact,
) -> Result<(), String> {
    let exported_heads = artifact
        .staged_heads
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let saved_at = std::fs::metadata(source_path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    room.persistence
        .restore_file_checkpoint(super::file_checkpoint::FileCheckpoint {
            path: source_path.to_path_buf(),
            exported_heads: artifact.staged_heads.iter().map(|head| head.0).collect(),
            file_fingerprint: artifact.fingerprint,
            save_sequence: 0,
            saved_at,
        });
    room.state
        .with_doc(|state| state.set_file_checkpoint(&exported_heads, 0))
        .map_err(|error| format!("Failed to publish source checkpoint state: {error}"))?;
    Ok(())
}

fn apply_staged_runtime_sidecars(
    room: &NotebookRoom,
    artifact: &StagedImportArtifact,
) -> Result<(), String> {
    apply_runtime_sidecars(room, &artifact.executions, &artifact.widget_comms)
}

fn prepared_runtime_sidecars(
    prepared: &PreparedInitialImport,
) -> (Vec<StagedExecutionImport>, Vec<StagedWidgetCommImport>) {
    let executions = prepared
        .cells
        .iter()
        .filter_map(|prepared_cell| {
            let execution = prepared_cell.execution.as_ref()?;
            Some(StagedExecutionImport {
                execution_id: execution.execution_id.clone(),
                state: execution.state.clone(),
            })
        })
        .collect();
    let widget_comms = prepared
        .widget_comms
        .iter()
        .map(|comm| StagedWidgetCommImport {
            comm_id: comm.comm_id.clone(),
            model_module: comm.model_module.clone(),
            model_name: comm.model_name.clone(),
            state: comm.state.clone(),
            seq: comm.seq,
        })
        .collect();
    (executions, widget_comms)
}

/// Rebind reconstructed source sidecars to the execution identifiers already
/// authored by the immutable staged generation.
///
/// A synthetic execution id is chosen while a source is first staged. After a
/// daemon restart, preparing the same `.ipynb` can choose a new synthetic id;
/// publishing outputs under that new id would leave the recovered NotebookDoc
/// pointing at missing RuntimeState. The journaled document is authoritative
/// for this identity, so recovery reuses its exact id.
async fn bind_prepared_executions_to_staged_document(
    prepared: &mut PreparedInitialImport,
    execution_ids: &HashMap<String, String>,
    blob_store: &BlobStore,
    notebook_id: &str,
    notebook_path: &str,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<(), String> {
    for prepared_cell in &mut prepared.cells {
        let Some(execution) = prepared_cell.execution.as_mut() else {
            continue;
        };
        let Some(staged_execution_id) = execution_ids.get(&prepared_cell.cell.id) else {
            return Err(format!(
                "source_degraded: recovered cell {} is missing its staged execution identity",
                prepared_cell.cell.id
            ));
        };
        // Never attach provenance found by content under a different ID to
        // the journal's execution ID. Resolve that exact durable record anew.
        *execution = LoadedExecution::synthetic(
            staged_execution_id.clone(),
            prepared_cell.cell.execution_count.parse::<i64>().ok(),
            &prepared_cell.output_refs,
        );
        if let Some(store) = execution_store {
            if let Some(record) = store.read_record(staged_execution_id).await {
                if record.execution_id != *staged_execution_id
                    || !(record.matches_recovered_notebook_cell_identity(
                        notebook_id,
                        notebook_path,
                        &prepared_cell.cell.id,
                        execution.state.execution_count,
                    ) || record.matches_notebook_cell_identity(
                        notebook_path,
                        Some(notebook_path),
                        &prepared_cell.cell.id,
                        &prepared_cell.cell.source,
                        execution.state.execution_count,
                    ))
                {
                    return Err(format!(
                        "source_degraded: durable execution {staged_execution_id} does not match the recovered notebook result"
                    ));
                }
                // The legacy importer drops an Arrow MIME when a saved chunk is
                // unavailable. Retain that evidence here: an omitted saved payload
                // cannot be used to prove a provenance conflict or a match.
                let arrow_mime = notebook_doc::mime::ARROW_STREAM_MANIFEST_MIME;
                if prepared_cell
                    .cell
                    .outputs
                    .iter()
                    .zip(&prepared_cell.output_refs)
                    .any(|(saved, imported)| {
                        saved
                            .get("data")
                            .and_then(|data| data.get(arrow_mime))
                            .is_some()
                            && imported
                                .get("data")
                                .and_then(|data| data.get(arrow_mime))
                                .is_none()
                    })
                {
                    return Err(format!(
                        "source_degraded: cannot verify durable execution {staged_execution_id}: saved Arrow chunk content is unavailable"
                    ));
                }
                let comparison = compare_outputs_with_policy(
                    &record.outputs,
                    &prepared_cell.output_refs,
                    |hash| async move { blob_store.get(&hash).await },
                    crate::extensions::replay_field_policy(),
                )
                .await;
                match comparison {
                    OutputComparison::Equivalent => {}
                    OutputComparison::Different => {
                        return Err(format!(
                            "source_degraded: durable execution {staged_execution_id} does not match the recovered notebook result"
                        ));
                    }
                    OutputComparison::Unavailable(reason) => {
                        return Err(format!(
                            "source_degraded: cannot verify durable execution {staged_execution_id}: {reason}"
                        ));
                    }
                }
                // A fresh import can journal a content-validated execution
                // before peer persistence qualifies its record for this room.
                // That retry must satisfy the same strict source/content
                // admission as a fresh load; a foreign identity alone cannot
                // recover provenance for edited source.
                *execution = LoadedExecution::from_record(&record, &prepared_cell.output_refs);
            }
        }
    }
    Ok(())
}

pub(crate) fn apply_reconciled_runtime_sidecars(
    room: &NotebookRoom,
    reconciliation: &AppliedSourceReconciliation,
) -> Result<(), String> {
    apply_runtime_sidecars(
        room,
        &reconciliation.executions,
        &reconciliation.widget_comms,
    )
}

fn apply_runtime_sidecars(
    room: &NotebookRoom,
    executions: &[StagedExecutionImport],
    widget_comms: &[StagedWidgetCommImport],
) -> Result<(), String> {
    room.state
        .with_doc(|state| {
            for execution in executions {
                state.restore_terminal_execution(&execution.execution_id, &execution.state)?;
            }
            for comm in widget_comms {
                state.put_comm(
                    &comm.comm_id,
                    JUPYTER_WIDGET_TARGET,
                    &comm.model_module,
                    &comm.model_name,
                    &serde_json::json!({}),
                    comm.seq,
                )?;
            }
            Ok(())
        })
        .map_err(|error| format!("Failed to publish staged runtime state: {error}"))?;
    room.comms
        .with_doc(|comms| {
            for comm in widget_comms {
                comms.put_comm_state(&comm.comm_id, &comm.state)?;
            }
            Ok(())
        })
        .map_err(|error| format!("Failed to publish staged comm state: {error}"))?;
    Ok(())
}

async fn publish_staged_import(
    room: &NotebookRoom,
    path: &Path,
    artifact: &StagedImportArtifact,
) -> Result<Vec<String>, String> {
    let current_source = tokio::fs::read(path)
        .await
        .map_err(|error| format!("Failed to re-read notebook before publication: {error}"))?;
    if super::recovery::source_fingerprint(&current_source) != artifact.fingerprint {
        return Err(
            "source_conflict: notebook changed after staging; preserved staged recovery and disk"
                .to_string(),
        );
    }

    let mut document_heads = room
        .lifecycle
        .availability()
        .status()
        .document_heads
        .clone();
    for (index, batch) in artifact.change_batches.iter().enumerate() {
        document_heads = {
            let mut doc = room.doc.write().await;
            let missing_change = batch
                .hashes
                .iter()
                .any(|hash| doc.doc_mut().get_change_by_hash(hash).is_none());
            if missing_change {
                doc.doc_mut()
                    .apply_changes(batch.changes.clone())
                    .map_err(|error| format!("Failed to publish staged batch: {error}"))?;
            }
            if let Some(missing) = batch
                .hashes
                .iter()
                .find(|hash| doc.doc_mut().get_change_by_hash(hash).is_none())
            {
                return Err(format!(
                    "Published batch is missing staged change {missing}"
                ));
            }
            doc.get_heads_hex()
        };
        if !room.lifecycle.note_published_batch(
            artifact.generation,
            index.saturating_add(1),
            document_heads.clone(),
        ) {
            return Err("session_superseded: source generation changed during publish".to_string());
        }
        let _ = room.broadcasts.changed_tx.send(());
        tokio::task::yield_now().await;
    }
    Ok(document_heads)
}

/// Reconstruct process-local projection and RuntimeState/Comms sidecars for a
/// matching journal generation without authoring a second source history.
pub(crate) async fn finalize_recovered_source(
    room: &NotebookRoom,
    path: &Path,
    generation: u64,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<(usize, Vec<String>), String> {
    let manifest = room.durability.manifest();
    if manifest.source_generation != generation
        || !matches!(
            manifest.source_phase,
            super::recovery::RecoverySourcePhase::DurablyStaged
                | super::recovery::RecoverySourcePhase::Ready
        )
    {
        return Err("source_degraded: recovery generation is not resumable".to_string());
    }

    let mut prepared = prepare_initial_import(room, path, execution_store).await?;
    if prepared.fingerprint != manifest.source_fingerprint {
        return Err(
            "source_conflict: disk changed while the recovered source was being finalized"
                .to_string(),
        );
    }

    let (cell_count, document_heads, execution_ids) = {
        let mut doc = room.doc.write().await;
        // A staged frontier proves all of its causal ancestors are present;
        // version 2 no longer persists every historical staged change hash.
        for raw_hash in &manifest.exported_heads {
            let hash = automerge::ChangeHash(*raw_hash);
            if doc.doc_mut().get_change_by_hash(&hash).is_none() {
                return Err(format!(
                    "source_degraded: recovered document is missing staged head {hash}"
                ));
            }
        }
        let execution_ids = doc
            .get_cell_ids()
            .into_iter()
            .filter_map(|cell_id| {
                doc.get_execution_id(&cell_id)
                    .map(|execution_id| (cell_id, execution_id))
            })
            .collect();
        (doc.cell_count(), doc.get_heads_hex(), execution_ids)
    };
    bind_prepared_executions_to_staged_document(
        &mut prepared,
        &execution_ids,
        &room.blob_store,
        &room.id.to_string(),
        &path.to_string_lossy(),
        execution_store,
    )
    .await?;
    let (executions, widget_comms) = prepared_runtime_sidecars(&prepared);
    apply_runtime_sidecars(room, &executions, &widget_comms)?;
    *room.persistence.last_save_sources.write().await = prepared.loaded_sources;
    room.persistence.note_disk_content(&prepared.source_content);

    let projection = Arc::new(
        super::projection::build_live_notebook_projection_for_generation(room, generation)
            .await
            .map_err(|error| format!("Failed to rebuild recovered projection: {error:#}"))?,
    );
    if !room.lifecycle.publish_recovered_projection_ready(
        generation,
        projection,
        document_heads.clone(),
    ) {
        return Err(
            "session_superseded: recovered source generation changed during finalization"
                .to_string(),
        );
    }
    room.durability
        .commit_source_ready(generation)
        .map_err(|error| format!("Failed to commit recovered source Ready marker: {error}"))?;
    Ok((cell_count, document_heads))
}

/// Prepare an immutable source history, commit it to the recovery journal,
/// then replay those exact changes into the live room in bounded batches.
pub(crate) async fn materialize_initial_load(
    room: &NotebookRoom,
    path: &Path,
    generation: u64,
    execution_store: Option<&runtimed_client::execution_store::ExecutionStore>,
) -> Result<(usize, Vec<String>), String> {
    let start = std::time::Instant::now();
    let artifact = if let Some(staged) = room.lifecycle.staged_import(generation) {
        room.lifecycle
            .prepared_projection(generation)
            .or_else(|| room.lifecycle.projection(generation))
            .ok_or_else(|| {
                "source_degraded: staged source projection is unavailable for retry".to_string()
            })?;
        staged
    } else {
        let prepared = prepare_initial_import(room, path, execution_store).await?;
        let total_cells = prepared.cells.len();
        if !room
            .lifecycle
            .note_prepared(generation, prepared.fingerprint, total_cells)
        {
            return Err("session_superseded: source generation changed during prepare".to_string());
        }
        let (artifact, projection) = stage_initial_import(room, generation, prepared).await?;
        if !room.lifecycle.record_prepared_artifacts(
            generation,
            Arc::clone(&artifact),
            Arc::clone(&projection),
        ) {
            return Err(
                "session_superseded: source generation changed before artifact ownership"
                    .to_string(),
            );
        }
        artifact
    };

    // Capture the current live prefix before the journal await. Peer changes
    // accepted after this point are merged into the durable union by
    // `commit_staged_source`; the first published batch refreshes these heads.
    // A resumed generation deliberately repeats this idempotent journal step:
    // cancellation may have retained the prepared artifact before its prior
    // journal worker reached a durable marker.
    let document_heads = {
        let mut doc = room.doc.write().await;
        doc.get_heads_hex()
    };
    if !room.lifecycle.note_journaling(generation) {
        return Err("session_superseded: source generation changed before journal".to_string());
    }
    // The blocking worker owns the durable marker. If this async task is
    // cancelled, the journal still finishes and the task lease terminalizes
    // the generation; a retry resumes the exact immutable artifact.
    journal_staged_import(room, Arc::clone(&artifact)).await?;

    // Runtime sidecars and the causal file checkpoint both advance
    // RuntimeStateDoc. Apply them only after the source artifact is durable,
    // then capture the retained projection from those exact resulting heads.
    // This prevents ProjectionReady from advertising runtime heads that were
    // stale before the first peer could even receive them.
    publish_initial_file_checkpoint(room, path, &artifact)?;
    apply_staged_runtime_sidecars(room, &artifact)?;
    if room.file_binding.path().await.as_deref() == Some(path) {
        *room.persistence.last_save_sources.write().await = artifact.loaded_sources.clone();
        room.persistence
            .note_disk_content(artifact.source_content.as_ref());
    }
    let projection = rebuild_staged_projection_after_sidecars(room, &artifact).await?;
    if !room.lifecycle.publish_projection_ready(
        generation,
        Arc::clone(&artifact),
        projection,
        document_heads,
    ) {
        return Err(
            "session_superseded: source generation changed before projection publish".to_string(),
        );
    }

    let document_heads = publish_staged_import(room, path, &artifact).await?;
    room.durability
        .commit_source_ready(generation)
        .map_err(|error| format!("Failed to commit source Ready marker: {error}"))?;
    info!(
        "[streaming-load] Published {} cells in {} immutable batches from {} ({:?})",
        artifact.cell_count,
        artifact.change_batches.len(),
        path.display(),
        start.elapsed()
    );
    Ok((artifact.cell_count, document_heads))
}

fn fail_initial_load(room: &Arc<NotebookRoom>, generation: u64, load_path: &Path, reason: String) {
    if room.initial_load.state() != (RoomInitialLoadState::Loading { generation }) {
        debug!(
            "[notebook-sync] Ignoring stale initial-load failure for room {} generation {}",
            room.id, generation
        );
        return;
    }

    // Do not roll the room back here. Batches are visible progressively and a
    // concurrent source (file watcher today, additional room-owned sources in
    // the future) may already have authored document truth. Clearing cells on
    // failure would erase those changes. The terminal `Failed` state gates a
    // coherent projection, and the failed-load persistence guard prevents the
    // partial materialization from overwriting the source file.
    room.mark_load_failed();
    if room
        .initial_load
        .complete_failed(generation, reason.clone())
    {
        warn!(
            "[notebook-sync] Initial materialization failed for {}: {}",
            load_path.display(),
            reason
        );
    }
}

/// Ownership token for one room source generation.
///
/// The token is created when a caller claims `Loading(g)`, before a fresh room
/// is published in the registry, and is moved into the spawned source task.
/// Dropping the token while the same generation is still loading turns that
/// generation into `Failed`. This covers cancellation as well as unwinding: a
/// room can never remain visibly `Loading` merely because its task disappeared.
pub(crate) struct RoomInitialLoadClaim {
    room: Arc<NotebookRoom>,
    generation: u64,
    load_path: PathBuf,
    armed: bool,
}

impl RoomInitialLoadClaim {
    fn new(room: &Arc<NotebookRoom>, generation: u64, load_path: PathBuf) -> Self {
        Self {
            room: Arc::clone(room),
            generation,
            load_path,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for RoomInitialLoadClaim {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        fail_initial_load(
            &self.room,
            self.generation,
            &self.load_path,
            "initial materialization task ended before completion".to_string(),
        );
    }
}

/// Claim the current source generation without spawning it yet.
///
/// Keeping claim and spawn separate lets room creation acquire this ownership
/// token before registry publication, then transfer it to the task immediately
/// after winning the registry insertion race.
pub(crate) fn claim_room_initial_load(
    room: &Arc<NotebookRoom>,
    load_path: PathBuf,
) -> Option<RoomInitialLoadClaim> {
    let RoomInitialLoadStart::Started { generation } = room.initial_load.begin() else {
        return None;
    };
    Some(RoomInitialLoadClaim::new(room, generation, load_path))
}

/// Transfer a claimed source generation into its supervised task.
pub(crate) fn spawn_claimed_room_initial_load(
    mut claim: RoomInitialLoadClaim,
    execution_store_dir: PathBuf,
) {
    let execution_store =
        runtimed_client::execution_store::ExecutionStore::new(execution_store_dir);
    let generation = claim.generation;
    let task_room = Arc::clone(&claim.room);
    let task_path = claim.load_path.clone();

    spawn_supervised(
        "room-initial-load",
        async move {
            match materialize_initial_load(
                &task_room,
                &task_path,
                generation,
                Some(&execution_store),
            )
            .await
            {
                Ok((cell_count, document_heads)) => {
                    if task_room.initial_load.complete_ready_with_heads(
                        generation,
                        cell_count,
                        document_heads,
                    ) {
                        task_room.clear_load_failed();
                        check_and_update_trust_state(&task_room).await;
                        info!(
                            "[notebook-sync] Initial materialization complete: {} cells from {} (generation {})",
                            cell_count,
                            task_path.display(),
                            generation
                        );
                    } else {
                        debug!(
                            "[notebook-sync] Ignoring stale initial-load success for room {} generation {}",
                            task_room.id, generation
                        );
                    }
                }
                Err(reason) => {
                    fail_initial_load(&task_room, generation, &task_path, reason);
                }
            }
            claim.disarm();
        },
        |_| {
            // `RoomInitialLoadClaim::drop` terminalizes this generation while
            // unwinding. The supervisor still records the panic centrally.
        },
    );
}

/// Finalize a matching recovered generation without regenerating its staged
/// Automerge changes. The same ownership lease terminalizes cancellation or
/// panic, so a registry-visible recovery cannot remain Loading forever.
pub(crate) fn spawn_claimed_room_recovery_finalize(
    mut claim: RoomInitialLoadClaim,
    execution_store_dir: Option<PathBuf>,
) {
    let execution_store =
        execution_store_dir.map(runtimed_client::execution_store::ExecutionStore::new);
    let generation = claim.generation;
    let task_room = Arc::clone(&claim.room);
    let task_path = claim.load_path.clone();

    spawn_supervised(
        "room-recovery-finalize",
        async move {
            match finalize_recovered_source(
                &task_room,
                &task_path,
                generation,
                execution_store.as_ref(),
            )
            .await
            {
                Ok((cell_count, document_heads)) => {
                    if task_room.initial_load.complete_ready_with_heads(
                        generation,
                        cell_count,
                        document_heads,
                    ) {
                        task_room.clear_load_failed();
                        check_and_update_trust_state(&task_room).await;
                        info!(
                            "[notebook-sync] Recovered source generation {} finalized for {}",
                            generation,
                            task_path.display()
                        );
                    }
                }
                Err(reason) => {
                    fail_initial_load(&task_room, generation, &task_path, reason);
                }
            }
            claim.disarm();
        },
        |_| {},
    );
}

/// Start or join this room's initial file materialization.
///
/// The spawned operation owns only the room and file path. Joining an
/// in-flight generation is a no-op; observers follow the room lifecycle via
/// `RoomInitialLoad::state`/`subscribe_authoritative`.
pub(crate) fn start_room_initial_load(
    room: &Arc<NotebookRoom>,
    load_path: PathBuf,
    execution_store_dir: PathBuf,
) {
    if let Some(claim) = claim_room_initial_load(room, load_path) {
        spawn_claimed_room_initial_load(claim, execution_store_dir);
    }
}

/// Retry a failed source generation only while the live notebook is pristine.
///
/// A non-pristine document may contain a partially published import or peer
/// edits. Replaying the file over either would turn recovery into an implicit
/// reconciliation policy, so those rooms remain failed until a watcher/save
/// establishes an explicit baseline. The document write guard closes the race
/// between the pristine check and claiming the retry generation.
pub(crate) async fn retry_failed_room_initial_load_if_safe(
    room: &Arc<NotebookRoom>,
    load_path: PathBuf,
    execution_store_dir: PathBuf,
) -> bool {
    if let Some(generation) = room.initial_load.resume_failed_staged_claimed() {
        let claim = RoomInitialLoadClaim::new(room, generation, load_path.clone());
        spawn_claimed_room_initial_load(claim, execution_store_dir);
        info!(
            "[notebook-sync] Resuming immutable staged import for {} (generation {})",
            load_path.display(),
            generation
        );
        return true;
    }

    let (claim, generation) = {
        let mut doc = room.doc.write().await;
        if !doc.is_pristine() {
            info!(
                "[notebook-sync] Not retrying failed initial materialization for {}: room contains live document changes",
                load_path.display()
            );
            return false;
        }

        let Some(generation) = room.initial_load.retry_failed_claimed() else {
            return false;
        };
        let claim = RoomInitialLoadClaim::new(room, generation, load_path.clone());
        (claim, generation)
    };
    debug_assert_eq!(claim.generation(), generation);
    spawn_claimed_room_initial_load(claim, execution_store_dir);

    info!(
        "[notebook-sync] Retrying initial materialization for {} (generation {})",
        load_path.display(),
        generation
    );
    true
}

#[derive(Debug, Clone)]
struct LoadedExecution {
    execution_id: String,
    state: runtime_doc::ExecutionState,
}

impl LoadedExecution {
    fn from_record(
        record: &runtimed_client::execution_store::ExecutionRecord,
        imported_outputs: &[serde_json::Value],
    ) -> Self {
        let mut state = record.execution_state();
        let policy = crate::extensions::replay_field_policy();
        // Pre-output-ID records can still match current file content. Preserve
        // every known ID and use the validated import's ID only when absent.
        for (output, imported) in state.outputs.iter_mut().zip(imported_outputs) {
            adopt_mutable_replay_payloads(output, imported, policy);
            if output
                .get("output_id")
                .and_then(|value| value.as_str())
                .is_none_or(str::is_empty)
            {
                if let (Some(object), Some(id)) =
                    (output.as_object_mut(), imported.get("output_id"))
                {
                    object.insert("output_id".into(), id.clone());
                }
            }
        }
        Self {
            execution_id: record.execution_id.clone(),
            state,
        }
    }

    fn synthetic(
        execution_id: String,
        execution_count: Option<i64>,
        outputs: &[serde_json::Value],
    ) -> Self {
        let success = !outputs.iter().any(|output| {
            output.get("output_type").and_then(|value| value.as_str()) == Some("error")
        });
        Self {
            execution_id,
            state: runtime_doc::ExecutionState {
                status: if success { "done" } else { "error" }.to_string(),
                execution_count,
                success: Some(success),
                outputs: outputs.to_vec(),
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        }
    }
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

async fn durable_or_synthetic_execution(
    durable_records: &[runtimed_client::execution_store::ExecutionRecord],
    blob_store: &BlobStore,
    claimed_execution_ids: &mut HashSet<String>,
    lookup: DurableExecutionLookup<'_>,
) -> LoadedExecution {
    for record in durable_records.iter().filter(|record| {
        !claimed_execution_ids.contains(&record.execution_id)
            && record.matches_notebook_cell_identity(
                lookup.context_id,
                lookup.notebook_path,
                lookup.cell_id,
                lookup.source,
                lookup.execution_count,
            )
    }) {
        if compare_outputs_with_policy(
            &record.outputs,
            lookup.outputs,
            |hash| async move { blob_store.get(&hash).await },
            crate::extensions::replay_field_policy(),
        )
        .await
            != OutputComparison::Equivalent
        {
            // Fresh imports have no journal identity requiring this record.
            // Unavailable content cannot establish provenance by content.
            continue;
        }
        claimed_execution_ids.insert(record.execution_id.clone());
        return LoadedExecution::from_record(record, lookup.outputs);
    }

    LoadedExecution::synthetic(
        uuid::Uuid::new_v4().to_string(),
        lookup.execution_count,
        lookup.outputs,
    )
}

/// Take the imported payload for MIMEs that declare mutable replay fields.
/// The caller compared the record with the import under the same policy, so
/// they differ only in those fields, which the record never carries (a saved
/// Bokeh `snapshot`); keeping the record's payload would drop them.
fn adopt_mutable_replay_payloads(
    output: &mut serde_json::Value,
    imported: &serde_json::Value,
    policy: &dyn runtimed_client::output_equivalence::ReplayFieldPolicy,
) {
    let (Some(data), Some(imported_data)) = (
        output
            .get_mut("data")
            .and_then(serde_json::Value::as_object_mut),
        imported.get("data").and_then(serde_json::Value::as_object),
    ) else {
        return;
    };
    for (mime, content) in data.iter_mut() {
        if policy.mutable_fields(mime).is_empty() {
            continue;
        }
        if let Some(imported_content) = imported_data.get(mime) {
            *content = imported_content.clone();
        }
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

/// Commit watcher-authored changes before releasing the document lock.
pub(crate) fn commit_file_watcher_changes(
    room: &NotebookRoom,
    doc: &mut NotebookDoc,
    baseline_heads: &[automerge::ChangeHash],
    rollback_snapshot: &[u8],
    rollback_actor: &str,
    source_revision: Option<&ExternalSourceRevision>,
) -> bool {
    super::durability::run_blocking_durability_boundary(|| {
        let changes = doc
            .doc_mut()
            .get_changes(baseline_heads)
            .into_iter()
            .collect::<Vec<_>>();
        if changes.is_empty() && source_revision.is_none() {
            return true;
        }
        let commit = match source_revision {
            Some(revision) => room.durability.commit_external_source_revision(
                changes,
                revision.fingerprint,
                revision.canonical_path.clone(),
                revision.save_sequence,
            ),
            None => room
                .durability
                .commit_peer_changes(admit_trusted_notebook_changes(
                    changes,
                    TrustedNotebookChangeSource::FileWatcher,
                )),
        };
        let committed_status = match commit {
            Ok(super::durability::DurableCommitOutcome::Committed(status))
            | Ok(super::durability::DurableCommitOutcome::AlreadyDurable(status)) => status,
            Err(error) => {
                let document_readable =
                    match NotebookDoc::load_with_actor(rollback_snapshot, rollback_actor) {
                        Ok(restored) => {
                            *doc = restored;
                            true
                        }
                        Err(_) => false,
                    };
                let document_heads = doc.get_heads_hex();
                let source_conflict = matches!(
                    &error,
                    super::durability::RoomDurabilityError::SourceConflict { .. }
                );
                // A source conflict is only SourceState when the rollback
                // restored the live document: disk plus journal then
                // reconstruct the same degraded lifecycle on reopen. If the
                // rollback snapshot failed to load, the live doc still holds
                // half-applied external changes, so the room must stay
                // resident for repair.
                let (kind, reason) = if source_conflict {
                    (
                        if document_readable {
                            super::durability::DegradationKind::SourceState
                        } else {
                            super::durability::DegradationKind::DurabilityBoundary
                        },
                        format!(
                            "source_conflict: external source changed while journal heads were not exported; both versions were preserved: {error}"
                        ),
                    )
                } else {
                    (
                        super::durability::DegradationKind::DurabilityBoundary,
                        format!(
                            "file watcher journal commit failed before external changes became visible: {error}"
                        ),
                    )
                };
                room.durability.mark_degraded(kind, reason.clone());
                if source_conflict {
                    room.lifecycle
                        .mark_source_conflict(reason.clone(), document_heads);
                } else {
                    room.lifecycle
                        .mark_degraded(reason.clone(), document_heads, document_readable);
                }
                let _ = room.state.with_doc(|state| {
                    let issue = if source_conflict {
                        runtime_doc::FileSourceIssue::Conflict {
                            reason: reason.clone(),
                        }
                    } else {
                        runtime_doc::FileSourceIssue::Degraded {
                            reason: reason.clone(),
                        }
                    };
                    state.set_file_source_issue(Some(&issue))
                });
                warn!("[notebook-watch] {reason}");
                return false;
            }
        };
        if let Some(revision) = source_revision {
            room.persistence
                .restore_file_checkpoint(super::file_checkpoint::FileCheckpoint {
                    path: revision.canonical_path.clone(),
                    exported_heads: room.durability.manifest().exported_heads,
                    file_fingerprint: revision.fingerprint,
                    save_sequence: revision.save_sequence,
                    saved_at: revision.saved_at,
                });
            debug_assert_eq!(
                committed_status.source_phase,
                super::recovery::RecoverySourcePhase::DurablyStaged
            );
        }
        true
    })
}

async fn complete_external_source_revision(
    room: &NotebookRoom,
    revision: Option<&ExternalSourceRevision>,
) -> bool {
    let Some(revision) = revision else {
        return true;
    };
    let status = room.durability.status();
    let exported_heads = status.exported_heads.clone();
    let sidecar = room.state.with_doc(|state| {
        state.set_file_checkpoint(&exported_heads, revision.save_sequence)?;
        state.set_file_source_issue(None)
    });
    if let Err(error) = sidecar {
        let reason = format!(
            "external source generation {} was staged but could not become Ready: {error}",
            status.source_generation
        );
        degrade_external_source_revision(
            room,
            super::durability::DegradationKind::SourceState,
            reason,
        );
        return false;
    }
    let projection = match super::projection::build_live_notebook_projection_for_generation(
        room,
        status.source_generation,
    )
    .await
    {
        Ok(projection) => Arc::new(projection),
        Err(error) => {
            let reason = format!(
                "external source generation {} could not build its bounded projection: {error:#}",
                status.source_generation
            );
            degrade_external_source_revision(
                room,
                super::durability::DegradationKind::SourceState,
                reason,
            );
            return false;
        }
    };
    if let Err(error) = room
        .durability
        .commit_source_ready(status.source_generation)
    {
        let reason = format!(
            "external source generation {} was staged but could not become Ready: {error}",
            status.source_generation
        );
        degrade_external_source_revision(
            room,
            super::durability::DegradationKind::DurabilityBoundary,
            reason,
        );
        return false;
    }
    room.lifecycle.complete_external_source_revision(
        status.source_generation,
        revision.fingerprint,
        projection.cells.len(),
        projection,
        status.durable_heads,
    );
    true
}

fn degrade_external_source_revision(
    room: &NotebookRoom,
    kind: super::durability::DegradationKind,
    reason: String,
) {
    let document_heads = room.durability.status().durable_heads;
    room.durability.mark_degraded(kind, reason.clone());
    room.lifecycle
        .mark_degraded(reason.clone(), document_heads, true);
    let _ = room.state.with_doc(|state| {
        state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
            reason: reason.clone(),
        }))
    });
    warn!("[notebook-watch] {reason}");
}

/// Faults a test can inject into the next external revision applied to a
/// room.
#[cfg(test)]
pub(crate) enum ExternalRevisionFault {
    /// Edit the live document after the file is prepared, just before the
    /// apply takes the document lock.
    EditBeforeLock(Box<dyn FnOnce(&mut NotebookDoc) + Send>),
    /// Fail the document transaction.
    Transaction,
    /// Fail the RuntimeStateDoc sidecar step after the journal commit.
    AfterCommit,
}

#[cfg(test)]
static EXTERNAL_REVISION_FAULTS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<uuid::Uuid, ExternalRevisionFault>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn inject_external_revision_fault_for_test(
    room_id: uuid::Uuid,
    fault: ExternalRevisionFault,
) {
    EXTERNAL_REVISION_FAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(room_id, fault);
}

#[cfg(test)]
fn take_external_revision_fault(
    room_id: uuid::Uuid,
    matches: impl Fn(&ExternalRevisionFault) -> bool,
) -> Option<ExternalRevisionFault> {
    let mut faults = EXTERNAL_REVISION_FAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if faults.get(&room_id).is_some_and(matches) {
        faults.remove(&room_id)
    } else {
        None
    }
}

/// Restore the pre-revision document after a transaction that could not
/// reproduce the file exactly.
fn reject_unreproducible_revision(
    doc: &mut NotebookDoc,
    rollback_snapshot: &[u8],
    rollback_actor: &str,
) {
    match NotebookDoc::load_with_actor(rollback_snapshot, rollback_actor) {
        Ok(restored) => *doc = restored,
        Err(error) => warn!(
            "[notebook-watch] Could not restore the document after rejecting a revision: {error}"
        ),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct AppliedIpynbChanges {
    pub(crate) cells_changed: bool,
    pub(crate) metadata_changed: bool,
    /// The revision could not be reproduced exactly (for example, duplicate
    /// cell ids on disk). The live document was rolled back and nothing was
    /// committed.
    pub(crate) rejected: bool,
    /// The replaced session content could not be saved first, so the
    /// revision was not applied.
    pub(crate) snapshot_failed: Option<String>,
    /// The revision's changes committed to the journal: the live document
    /// now equals the file, even if a later step failed.
    pub(crate) committed: bool,
    /// Committed, and the revision became the room's ready source
    /// generation. Only then may it become the autosave staleness baseline.
    pub(crate) reconciled: bool,
    /// Session content this revision replaced. Present only when the session
    /// held edits since its last file checkpoint that the file does not have.
    pub(crate) displaced: Option<DisplacedCapture>,
    /// The durable snapshot entry for `displaced`, written before the commit.
    /// Present only for a committed watcher revision; the caller publishes it.
    pub(crate) displaced_entry: Option<runtime_doc::DisplacedEdits>,
}

/// The live notebook as it was just before an external revision replaced
/// in-session edits.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DisplacedCapture {
    pub(crate) cells: Vec<CellSnapshot>,
    pub(crate) metadata: Option<NotebookMetadataSnapshot>,
    pub(crate) execution_ids: HashMap<String, Option<String>>,
    /// Cells the session added, deleted or changed whose live version differs
    /// from the file's.
    pub(crate) cell_ids: Vec<String>,
    /// The session changed notebook metadata and the file's differs.
    pub(crate) metadata_changed: bool,
    /// The session reordered cells and the file's order differs.
    pub(crate) order_changed: bool,
}

/// Cell identity, type and source in notebook order: what a reload must
/// reproduce exactly.
fn cell_shape(cells: &[CellSnapshot]) -> Vec<(&str, &str, &str)> {
    cells
        .iter()
        .map(|cell| {
            (
                cell.id.as_str(),
                cell.cell_type.as_str(),
                cell.source.as_str(),
            )
        })
        .collect()
}

/// Everything about one cell that a reload replaces, apart from outputs.
#[derive(PartialEq)]
struct CellContent<'a> {
    cell_type: &'a str,
    source: &'a str,
    metadata: &'a serde_json::Value,
    attachments: &'a AttachmentRefs,
}

impl<'a> CellContent<'a> {
    fn of(cell: &'a CellSnapshot) -> Self {
        Self::with_attachments(cell, &cell.attachments)
    }

    fn with_attachments(cell: &'a CellSnapshot, attachments: &'a AttachmentRefs) -> Self {
        Self {
            cell_type: cell.cell_type.as_str(),
            source: cell.source.as_str(),
            metadata: &cell.metadata,
            attachments,
        }
    }
}

fn ids_in_common_order<'a>(cells: &'a [CellSnapshot], other: &HashSet<&str>) -> Vec<&'a str> {
    cells
        .iter()
        .map(|cell| cell.id.as_str())
        .filter(|id| other.contains(id))
        .collect()
}

/// True when the live document is exactly the external revision's cells
/// (id, order, type, source) and, when the file carries any, its metadata.
pub(crate) fn live_matches_external(
    doc: &NotebookDoc,
    external_cells: &[CellSnapshot],
    external_metadata: Option<&NotebookMetadataSnapshot>,
) -> bool {
    cell_shape(&doc.get_cells()) == cell_shape(external_cells)
        && external_metadata.is_none_or(|metadata| doc.metadata_snapshot_matches(metadata))
}

/// What an external revision would put in the live document.
pub(crate) struct DisplacementInputs<'a> {
    /// Heads of the content the file last held from this room.
    pub(crate) exported_heads: &'a [[u8; 32]],
    pub(crate) external_cells: &'a [CellSnapshot],
    pub(crate) external_metadata: Option<&'a NotebookMetadataSnapshot>,
    /// The file's attachments per cell, as blob refs.
    pub(crate) external_attachments: &'a HashMap<String, AttachmentRefs>,
    /// The file's outputs per cell as manifest refs, when they replace live
    /// outputs (no kernel running). `None` keeps live outputs.
    pub(crate) external_outputs: Option<&'a HashMap<String, Vec<serde_json::Value>>>,
    /// Live outputs per cell as manifest refs.
    pub(crate) live_outputs: &'a HashMap<String, Vec<serde_json::Value>>,
}

/// Decide, under the NotebookDoc lock, whether making the live notebook match
/// an external revision discards edits the session made since its last file
/// checkpoint.
///
/// The baseline is the document at `exported_heads`: the content the file
/// last held from this room. A cell counts when the session changed it
/// relative to that baseline (type, source, cell metadata, attachments,
/// presence) and the live version differs from the file's. Outputs count when
/// the session re-ran the cell and the file's outputs replace different live
/// ones. Notebook metadata and cell order count the same way. Edits the file
/// already has (identical edits on both sides) never count. When the
/// exported heads are unknown to the document, every live difference from
/// the file counts.
pub(crate) fn capture_displaced_edits(
    doc: &mut NotebookDoc,
    inputs: &DisplacementInputs<'_>,
) -> Option<DisplacedCapture> {
    let no_attachments = AttachmentRefs::new();
    let no_outputs: Vec<serde_json::Value> = Vec::new();
    let external_cells = inputs.external_cells;
    let live_cells = doc.get_cells();
    let live_metadata = doc.get_metadata_snapshot();
    let metadata_differs = inputs
        .external_metadata
        .is_some_and(|metadata| !doc.metadata_snapshot_matches(metadata));

    let live_by_id: HashMap<&str, CellContent<'_>> = live_cells
        .iter()
        .map(|c| (c.id.as_str(), CellContent::of(c)))
        .collect();
    let disk_by_id: HashMap<&str, CellContent<'_>> = external_cells
        .iter()
        .map(|c| {
            let attachments = inputs
                .external_attachments
                .get(c.id.as_str())
                .unwrap_or(&no_attachments);
            (c.id.as_str(), CellContent::with_attachments(c, attachments))
        })
        .collect();
    let outputs_differ = |id: &str| {
        inputs.external_outputs.is_some_and(|external| {
            inputs.live_outputs.get(id).unwrap_or(&no_outputs)
                != external.get(id).unwrap_or(&no_outputs)
        })
    };
    let live_ids: HashSet<&str> = live_by_id.keys().copied().collect();
    let disk_ids: HashSet<&str> = disk_by_id.keys().copied().collect();
    let order_differs = ids_in_common_order(&live_cells, &disk_ids)
        != ids_in_common_order(external_cells, &live_ids);
    let content_differs = live_ids != disk_ids
        || live_ids
            .iter()
            .any(|id| live_by_id.get(id) != disk_by_id.get(id) || outputs_differ(id));
    if !content_differs && !metadata_differs && !order_differs {
        return None;
    }

    let heads: Vec<automerge::ChangeHash> = inputs
        .exported_heads
        .iter()
        .map(|head| automerge::ChangeHash(*head))
        .collect();
    let baseline_known = !heads.is_empty()
        && heads
            .iter()
            .all(|head| doc.doc_mut().get_change_by_hash(head).is_some());
    if baseline_known && doc.get_heads() == heads {
        return None;
    }

    // (id, content changed, re-ran) for every cell the session touched.
    let baseline_cells;
    let (session_cells, session_metadata, session_order): (Vec<(&str, bool, bool)>, bool, bool) =
        if baseline_known {
            baseline_cells = doc.get_cells_at_heads_with_content(&heads);
            let baseline_metadata = doc.get_metadata_snapshot_at_heads(&heads);
            let base_by_id: HashMap<&str, CellContent<'_>> = baseline_cells
                .iter()
                .map(|c| (c.id.as_str(), CellContent::of(c)))
                .collect();
            let base_ids: HashSet<&str> = base_by_id.keys().copied().collect();
            let mut changed: Vec<(&str, bool, bool)> = Vec::new();
            for cell in &live_cells {
                let id = cell.id.as_str();
                let reran = doc.get_execution_id(id) != doc.get_execution_id_at_heads(id, &heads);
                let content = base_by_id.get(id) != live_by_id.get(id);
                if content || reran {
                    changed.push((id, content, reran));
                }
            }
            changed.extend(
                baseline_cells
                    .iter()
                    .map(|c| c.id.as_str())
                    .filter(|id| !live_by_id.contains_key(id))
                    .map(|id| (id, true, false)),
            );
            let order = ids_in_common_order(&live_cells, &base_ids)
                != ids_in_common_order(&baseline_cells, &live_ids);
            (changed, live_metadata != baseline_metadata, order)
        } else {
            let mut all: Vec<(&str, bool, bool)> = live_cells
                .iter()
                .map(|c| (c.id.as_str(), true, true))
                .collect();
            all.extend(
                external_cells
                    .iter()
                    .map(|c| c.id.as_str())
                    .filter(|id| !live_by_id.contains_key(id))
                    .map(|id| (id, true, false)),
            );
            (all, true, true)
        };

    let cell_ids: Vec<String> = session_cells
        .into_iter()
        .filter(|(id, content_changed, reran)| {
            (*content_changed && live_by_id.get(id) != disk_by_id.get(id))
                || (*reran
                    && live_by_id.contains_key(id)
                    && disk_by_id.contains_key(id)
                    && outputs_differ(id))
        })
        .map(|(id, _, _)| id.to_string())
        .collect();
    let metadata_changed = session_metadata && metadata_differs;
    let order_changed = session_order && order_differs;
    if cell_ids.is_empty() && !metadata_changed && !order_changed {
        return None;
    }

    let execution_ids = live_cells
        .iter()
        .map(|cell| (cell.id.clone(), doc.get_execution_id(&cell.id)))
        .collect();
    Some(DisplacedCapture {
        cells: live_cells,
        metadata: live_metadata,
        execution_ids,
        cell_ids,
        metadata_changed,
        order_changed,
    })
}

#[derive(Clone)]
pub(crate) struct ExternalSourceRevision {
    pub(crate) fingerprint: super::recovery::SourceFingerprint,
    pub(crate) canonical_path: PathBuf,
    pub(crate) save_sequence: u64,
    pub(crate) saved_at: std::time::SystemTime,
}

impl AppliedIpynbChanges {
    #[cfg(test)]
    pub(crate) fn changed(&self) -> bool {
        self.cells_changed || self.metadata_changed
    }
}

/// Apply a file-watcher revision while causally binding every authored batch
/// to the exact source fingerprint it came from.
pub(crate) async fn apply_ipynb_changes_from_source(
    room: &NotebookRoom,
    external_cells: &[CellSnapshot],
    external_outputs: &HashMap<String, Vec<serde_json::Value>>,
    external_attachments: &HashMap<String, serde_json::Value>,
    external_metadata: Option<&NotebookMetadataSnapshot>,
    has_running_kernel: bool,
    source_revision: ExternalSourceRevision,
) -> AppliedIpynbChanges {
    apply_ipynb_changes_inner(
        room,
        external_cells,
        external_outputs,
        external_attachments,
        has_running_kernel,
        external_metadata,
        Some(&source_revision),
    )
    .await
}

/// Make the live Automerge doc match an external .ipynb revision.
///
/// The file wins: afterwards the live cells (id, order, type, source, cell
/// metadata) and notebook metadata equal the file's. Compares cells by ID
/// and:
/// - Adds cells the file has and the doc lacks
/// - Removes cells the doc has and the file lacks, including cells created in
///   this session
/// - Updates source, type, metadata, execution_count, and outputs
/// - Handles cell reordering by rebuilding the cell list
///
/// When a kernel is running, outputs and execution counts are preserved
/// to avoid losing in-progress execution results.
///
/// Session edits the revision replaces are reported in
/// [`AppliedIpynbChanges::displaced`]; recording them is the caller's job.
/// A revision the doc cannot reproduce exactly is rolled back and reported
/// as `rejected`.
///
/// A `None` source revision applies the changes without binding them to a
/// source fingerprint; production file-watcher ingest goes through
/// [`apply_ipynb_changes_from_source`] instead.
///
/// Reports changes only after changed NotebookDoc heads have a durable
/// journal marker. Journal failure rolls the live document back before
/// returning.
pub(crate) async fn apply_ipynb_changes_inner(
    room: &NotebookRoom,
    external_cells: &[CellSnapshot],
    external_outputs: &HashMap<String, Vec<serde_json::Value>>,
    external_attachments: &HashMap<String, serde_json::Value>,
    has_running_kernel: bool,
    external_metadata: Option<&NotebookMetadataSnapshot>,
    source_revision: Option<&ExternalSourceRevision>,
) -> AppliedIpynbChanges {
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
                    return AppliedIpynbChanges::default();
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

    // Asset/output preparation above is intentionally outside the document
    // lock and may be slow. Recheck the exact source revision immediately
    // before authoring it so stale prepared bytes never enter NotebookDoc.
    if let Some(revision) = source_revision {
        match tokio::fs::read(&revision.canonical_path).await {
            Ok(current)
                if super::recovery::source_fingerprint(&current) == revision.fingerprint => {}
            Ok(_) => {
                debug!(
                    "[notebook-watch] Source changed again while {:?} was being prepared",
                    revision.canonical_path
                );
                return AppliedIpynbChanges::default();
            }
            Err(error) => {
                debug!(
                    "[notebook-watch] Cannot re-read {:?} before commit: {}",
                    revision.canonical_path, error
                );
                return AppliedIpynbChanges::default();
            }
        }
    }

    let external_map: HashMap<&str, &CellSnapshot> =
        external_cells.iter().map(|c| (c.id.as_str(), c)).collect();
    let external_ids: Vec<&str> = external_cells.iter().map(|c| c.id.as_str()).collect();

    // RuntimeStateDoc writes collected inside the document transaction and
    // applied after the NotebookDoc lock is released.
    struct DeferredExecution<'a> {
        synthetic_eid: String,
        outputs: &'a [serde_json::Value],
        execution_count: Option<i64>,
    }

    #[cfg(test)]
    if let Some(ExternalRevisionFault::EditBeforeLock(edit)) =
        take_external_revision_fault(room.id, |fault| {
            matches!(fault, ExternalRevisionFault::EditBeforeLock(_))
        })
    {
        edit(&mut *room.doc.write().await);
    }

    // Everything that depends on the live document is read under the same
    // write lock the transaction runs under, so a concurrent edit cannot make
    // the diff stale. RuntimeStateDoc reads are synchronous and nothing that
    // holds the RuntimeStateDoc lock waits on the NotebookDoc lock.
    let mut doc = room.doc.write().await;
    let current_cells = doc.get_cells();
    let current_map: HashMap<&str, &CellSnapshot> =
        current_cells.iter().map(|c| (c.id.as_str(), c)).collect();
    let current_ids: Vec<&str> = current_cells.iter().map(|c| c.id.as_str()).collect();
    let order_changed = {
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
    // Wholesale file replacement: both sides have cells but share no ids.
    // Route through the rebuild path so the cell list is replaced atomically
    // instead of inferring an incremental edit script across unrelated ids.
    let no_common_cells = !current_ids.is_empty()
        && !external_ids.is_empty()
        && !current_ids.iter().any(|id| external_map.contains_key(id));
    let current_execution_ids: HashMap<String, String> = current_cells
        .iter()
        .filter_map(|cell| {
            doc.get_execution_id(&cell.id)
                .map(|execution_id| (cell.id.clone(), execution_id))
        })
        .collect();
    let current_execution_state: HashMap<String, (Vec<serde_json::Value>, Option<i64>)> =
        if has_running_kernel {
            HashMap::new()
        } else {
            room.state
                .read(|sd| {
                    current_execution_ids
                        .iter()
                        .map(|(cell_id, eid)| {
                            let ec = sd.get_execution(eid).and_then(|e| e.execution_count);
                            (cell_id.clone(), (sd.get_outputs(eid), ec))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
    let live_outputs: HashMap<String, Vec<serde_json::Value>> = current_execution_state
        .iter()
        .map(|(cell_id, (outputs, _))| (cell_id.clone(), outputs.clone()))
        .collect();

    let heads = doc.get_heads();
    let pre_heads_hex = doc.get_heads_hex();
    let exported_heads = room.durability.manifest().exported_heads;
    let displaced = capture_displaced_edits(
        &mut doc,
        &DisplacementInputs {
            exported_heads: &exported_heads,
            external_cells,
            external_metadata,
            external_attachments: &converted_attachments,
            external_outputs: (!has_running_kernel).then_some(&converted_outputs),
            live_outputs: &live_outputs,
        },
    );
    // A watcher revision saves what it replaces before it commits. Any
    // failure here leaves the document and the file untouched.
    let mut displaced_entry = None;
    if let (Some(capture), Some(revision)) = (displaced.as_ref(), source_revision) {
        match super::persist::prepare_displaced_snapshot(
            room,
            &revision.canonical_path,
            capture,
            pre_heads_hex,
        )
        .await
        {
            Ok(entry) => displaced_entry = Some(entry),
            Err(error) => {
                return AppliedIpynbChanges {
                    snapshot_failed: Some(error),
                    ..AppliedIpynbChanges::default()
                };
            }
        }
    }
    // Cells whose content this revision replaces. Edits concurrent with the
    // revision that land in these cells later are put back to the file's
    // version before the next save.
    let rewritten: HashSet<String> = current_cells
        .iter()
        .filter(|cell| {
            external_map
                .get(cell.id.as_str())
                .is_none_or(|ext| CellContent::of(cell) != CellContent::of(ext))
        })
        .map(|cell| cell.id.clone())
        .collect();

    let rollback_actor = doc.get_actor_id();
    let rollback_snapshot = doc.save();
    #[cfg(test)]
    let transaction_fault = take_external_revision_fault(room.id, |fault| {
        matches!(fault, ExternalRevisionFault::Transaction)
    })
    .is_some();
    #[cfg(not(test))]
    let transaction_fault = false;
    let rebuild = order_changed || no_common_cells;
    if rebuild {
        debug!(
            "[notebook-watch] {} — rebuilding cell list",
            if no_common_cells {
                "Wholesale file replacement detected (zero common cells)"
            } else {
                "Cell order changed"
            }
        );
    }

    let transaction = if rebuild {
        // Delete every current cell and re-add the file's in order, as one
        // document-owned transaction on the live document.
        doc.transact_at_heads_recovering(
            &heads,
            Some("runtimed:filesystem"),
            "file-watcher-order-transaction",
            |doc| {
                if transaction_fault {
                    return Err(automerge::AutomergeError::InvalidObjId(
                        "injected test fault".into(),
                    ));
                }
                for cell in &current_cells {
                    let _ = doc.delete_cell(&cell.id);
                }
                let mut deferred: Vec<DeferredExecution> = Vec::new();
                for (index, ext_cell) in external_cells.iter().enumerate() {
                    if doc
                        .add_cell(index, &ext_cell.id, &ext_cell.cell_type)
                        .is_err()
                    {
                        continue;
                    }
                    let _ = doc.update_source(&ext_cell.id, &ext_cell.source);
                    if ext_cell.metadata.as_object().is_some_and(|m| !m.is_empty()) {
                        let _ = doc.set_cell_metadata(&ext_cell.id, &ext_cell.metadata);
                    }
                    // A running kernel keeps an existing cell's execution
                    // pointer; outputs live in RuntimeStateDoc by execution.
                    let keep_live_execution =
                        has_running_kernel && current_map.contains_key(ext_cell.id.as_str());
                    if keep_live_execution {
                        if let Some(eid) = current_execution_ids.get(&ext_cell.id) {
                            let _ = doc.set_execution_id(&ext_cell.id, Some(eid.as_str()));
                        }
                    } else {
                        let ext_outputs = converted_outputs
                            .get(ext_cell.id.as_str())
                            .map(|v| v.as_slice())
                            .unwrap_or(&[]);
                        let parsed_ec: Option<i64> = ext_cell.execution_count.parse().ok();
                        if !ext_outputs.is_empty() || parsed_ec.is_some() {
                            let synthetic_eid = uuid::Uuid::new_v4().to_string();
                            let _ = doc.set_execution_id(&ext_cell.id, Some(&synthetic_eid));
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

                let metadata_changed = external_metadata
                    .is_some_and(|metadata| !doc.metadata_snapshot_matches(metadata));
                if let Some(metadata) = external_metadata.filter(|_| metadata_changed) {
                    doc.set_metadata_snapshot(metadata)?;
                }
                let verified = live_matches_external(doc, external_cells, external_metadata);
                Ok((None, metadata_changed, deferred, verified))
            },
        )
    } else {
        doc.transact_at_heads_recovering(
            &heads,
            Some("runtimed:filesystem"),
            "file-watcher-update-transaction",
            |doc| {
                if transaction_fault {
                    return Err(automerge::AutomergeError::InvalidObjId(
                        "injected test fault".into(),
                    ));
                }
                let mut changed = false;
                // The file wins: every live cell the file lacks goes,
                // including cells created in this session.
                for cell in &current_cells {
                    if !external_map.contains_key(cell.id.as_str()) {
                        debug!("[notebook-watch] Deleting cell: {}", cell.id);
                        if let Ok(true) = doc.delete_cell(&cell.id) {
                            changed = true;
                        }
                    }
                }

                let mut deferred: Vec<DeferredExecution> = Vec::new();
                let mut clear_execution_ids: Vec<&str> = Vec::new();
                for (index, ext_cell) in external_cells.iter().enumerate() {
                    let Some(current_cell) = current_map.get(ext_cell.id.as_str()) else {
                        debug!(
                            "[notebook-watch] Adding new cell at index {}: {}",
                            index, ext_cell.id
                        );
                        if doc
                            .add_cell(index, &ext_cell.id, &ext_cell.cell_type)
                            .is_err()
                        {
                            continue;
                        }
                        changed = true;
                        let _ = doc.update_source(&ext_cell.id, &ext_cell.source);
                        if ext_cell.metadata.as_object().is_some_and(|m| !m.is_empty()) {
                            let _ = doc.set_cell_metadata(&ext_cell.id, &ext_cell.metadata);
                        }
                        let ext_outputs = converted_outputs
                            .get(ext_cell.id.as_str())
                            .map(|v| v.as_slice())
                            .unwrap_or(&[]);
                        let parsed_ec: Option<i64> = ext_cell.execution_count.parse().ok();
                        if !ext_outputs.is_empty() || parsed_ec.is_some() {
                            let synthetic_eid = uuid::Uuid::new_v4().to_string();
                            let _ = doc.set_execution_id(&ext_cell.id, Some(&synthetic_eid));
                            deferred.push(DeferredExecution {
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
                        continue;
                    };

                    if current_cell.source != ext_cell.source {
                        debug!("[notebook-watch] Updating source for cell: {}", ext_cell.id);
                        if doc.update_source(&ext_cell.id, &ext_cell.source).is_ok() {
                            changed = true;
                        }
                    }
                    if current_cell.cell_type != ext_cell.cell_type {
                        if let Ok(true) = doc.set_cell_type(&ext_cell.id, &ext_cell.cell_type) {
                            changed = true;
                        }
                    }
                    if current_cell.metadata != ext_cell.metadata {
                        if let Ok(true) = doc.set_cell_metadata(&ext_cell.id, &ext_cell.metadata) {
                            changed = true;
                        }
                    }

                    // Outputs and execution_count follow the file unless a
                    // kernel is running.
                    if !has_running_kernel {
                        let ext_outputs = converted_outputs
                            .get(ext_cell.id.as_str())
                            .map(|v| v.as_slice())
                            .unwrap_or(&[]);
                        let parsed_ec: Option<i64> = ext_cell.execution_count.parse().ok();
                        let (current_outputs, current_ec) = current_execution_state
                            .get(ext_cell.id.as_str())
                            .cloned()
                            .unwrap_or((Vec::new(), None));
                        if current_outputs.as_slice() != ext_outputs || current_ec != parsed_ec {
                            if !ext_outputs.is_empty() || parsed_ec.is_some() {
                                let synthetic_eid = uuid::Uuid::new_v4().to_string();
                                let _ = doc.set_execution_id(&ext_cell.id, Some(&synthetic_eid));
                                deferred.push(DeferredExecution {
                                    synthetic_eid,
                                    outputs: ext_outputs,
                                    execution_count: parsed_ec,
                                });
                                changed = true;
                            } else if current_execution_ids.contains_key(&ext_cell.id) {
                                clear_execution_ids.push(&ext_cell.id);
                                changed = true;
                            }
                        }
                    }

                    let ext_assets = converted_assets
                        .get(ext_cell.id.as_str())
                        .unwrap_or(&empty_assets);
                    if current_cell.resolved_assets != *ext_assets {
                        if let Ok(true) = doc.set_cell_resolved_assets(&ext_cell.id, ext_assets) {
                            changed = true;
                        }
                    }
                    let ext_attachments = converted_attachments
                        .get(ext_cell.id.as_str())
                        .unwrap_or(&empty_attachments);
                    if current_cell.attachments != *ext_attachments {
                        if let Ok(true) = doc.set_cell_attachments(&ext_cell.id, ext_attachments) {
                            changed = true;
                        }
                    }
                }
                for cell_id in clear_execution_ids {
                    let _ = doc.set_execution_id(cell_id, None);
                }

                let metadata_changed = external_metadata
                    .is_some_and(|metadata| !doc.metadata_snapshot_matches(metadata));
                if let Some(metadata) = external_metadata.filter(|_| metadata_changed) {
                    doc.set_metadata_snapshot(metadata)?;
                }
                let verified = live_matches_external(doc, external_cells, external_metadata);
                Ok((Some(changed), metadata_changed, deferred, verified))
            },
        )
    };

    let (cells_changed, metadata_changed, deferred) = match transaction {
        Ok((cells_changed, metadata_changed, deferred, true)) => {
            let cells_changed = cells_changed.unwrap_or_else(|| doc.get_heads() != heads);
            if (cells_changed || metadata_changed || source_revision.is_some())
                && !commit_file_watcher_changes(
                    room,
                    &mut doc,
                    &heads,
                    &rollback_snapshot,
                    &rollback_actor,
                    source_revision,
                )
            {
                drop(doc);
                withdraw_displaced_entry(room, displaced_entry.as_ref()).await;
                return AppliedIpynbChanges::default();
            }
            (cells_changed, metadata_changed, deferred)
        }
        Ok(_) => {
            reject_unreproducible_revision(&mut doc, &rollback_snapshot, &rollback_actor);
            drop(doc);
            withdraw_displaced_entry(room, displaced_entry.as_ref()).await;
            return AppliedIpynbChanges {
                rejected: true,
                ..AppliedIpynbChanges::default()
            };
        }
        Err(error) => {
            warn!("[file-watcher] external revision transaction failed: {error}");
            drop(doc);
            withdraw_displaced_entry(room, displaced_entry.as_ref()).await;
            return AppliedIpynbChanges::default();
        }
    };
    let revision_heads = doc.get_heads();
    drop(doc);

    // Committed: the live document equals the file from here on, so the
    // displaced content is reported even if a later step fails.
    let mut applied = AppliedIpynbChanges {
        cells_changed,
        metadata_changed,
        committed: true,
        displaced,
        displaced_entry,
        ..AppliedIpynbChanges::default()
    };
    if let Some(revision) = source_revision {
        room.persistence
            .set_external_revision_guard(ExternalRevisionGuard {
                notebook_path: revision.canonical_path.clone(),
                pre_heads: heads,
                revision_heads,
                rewritten,
                applied_at: std::time::Instant::now(),
            });
    }

    #[cfg(test)]
    let sidecar_fault = take_external_revision_fault(room.id, |fault| {
        matches!(fault, ExternalRevisionFault::AfterCommit)
    })
    .is_some();
    #[cfg(not(test))]
    let sidecar_fault = false;
    if !deferred.is_empty() || sidecar_fault {
        let sidecars = room.state.with_doc(|sd| {
            if sidecar_fault {
                return Err(runtime_doc::RuntimeStateError::InvalidDisplacedEdits(
                    "injected test fault".to_string(),
                ));
            }
            for de in &deferred {
                sd.create_execution(&de.synthetic_eid)?;
                if !de.outputs.is_empty() {
                    sd.set_outputs(&de.synthetic_eid, de.outputs)?;
                }
                if let Some(ec) = de.execution_count {
                    sd.set_execution_count(&de.synthetic_eid, ec)?;
                }
                sd.set_execution_done(&de.synthetic_eid, true)?;
            }
            Ok(())
        });
        if let Err(error) = sidecars {
            degrade_external_source_revision(
                room,
                super::durability::DegradationKind::SourceState,
                format!("external source runtime sidecars failed: {error}"),
            );
            return applied;
        }
    }

    if !complete_external_source_revision(room, source_revision).await {
        return applied;
    }

    // Without a source revision there is no caller to record the save
    // baseline, so the external cells become it here.
    if applied.cells_changed && source_revision.is_none() {
        let mut saved = room.persistence.last_save_sources.write().await;
        saved.clear();
        for ext_cell in external_cells {
            saved.insert(ext_cell.id.clone(), ext_cell.source.clone());
        }
    }

    applied.reconciled = true;
    applied
}

async fn withdraw_displaced_entry(
    room: &NotebookRoom,
    entry: Option<&runtime_doc::DisplacedEdits>,
) {
    if let Some(entry) = entry {
        super::persist::abandon_displaced_snapshot(room, entry).await;
    }
}

/// How long after an external revision a save still checks for peer edits
/// made against the notebook from before it.
pub(crate) const EXTERNAL_REVISION_GUARD_WINDOW: std::time::Duration =
    std::time::Duration::from_secs(60);

/// What the last external revision replaced, kept so late concurrent edits
/// can be told apart from edits made after the reload.
#[derive(Clone, Debug)]
pub(crate) struct ExternalRevisionGuard {
    pub(crate) notebook_path: PathBuf,
    /// Document heads just before the revision.
    pub(crate) pre_heads: Vec<automerge::ChangeHash>,
    /// Document heads just after the revision committed.
    pub(crate) revision_heads: Vec<automerge::ChangeHash>,
    /// Cells whose content the revision replaced or removed.
    pub(crate) rewritten: HashSet<String>,
    pub(crate) applied_at: std::time::Instant,
}

/// Heads of `base` plus `changes`: every hash no change in `changes` depends on.
fn heads_of(
    base: &[automerge::ChangeHash],
    changes: &HashSet<automerge::ChangeHash>,
    deps: &HashMap<automerge::ChangeHash, Vec<automerge::ChangeHash>>,
) -> Vec<automerge::ChangeHash> {
    let depended: HashSet<automerge::ChangeHash> = changes
        .iter()
        .flat_map(|hash| deps.get(hash).into_iter().flatten().copied())
        .collect();
    let mut heads: Vec<automerge::ChangeHash> = base
        .iter()
        .chain(changes.iter())
        .filter(|hash| !depended.contains(hash))
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    heads.sort();
    heads
}

/// Put back the file's version of rewritten cells that a late concurrent
/// edit changed, after saving the session's version.
///
/// A peer can author an edit against the notebook from before an external
/// revision and sync it after the revision applied. Automerge then merges it
/// into the file's text: a pending `)` typed after `print(x` lands as
/// `y = 2)`. Changes made after the reload descend from the revision's heads
/// and are kept. Changes that do not are concurrent with it; where they touch
/// a cell the revision rewrote, the session's version (pre-revision heads
/// plus those changes) is snapshotted and recorded like any other displaced
/// edit, and the cell goes back to the file's version plus later edits.
///
/// Runs before every in-place save for [`EXTERNAL_REVISION_GUARD_WINDOW`]
/// after a revision. `Err` means the snapshot could not be written and the
/// save must wait.
pub(crate) async fn put_back_late_concurrent_edits(room: &NotebookRoom) -> Result<(), String> {
    let Some(guard) = room.persistence.external_revision_guard() else {
        return Ok(());
    };
    if guard.applied_at.elapsed() > EXTERNAL_REVISION_GUARD_WINDOW {
        room.persistence
            .clear_external_revision_guard(guard.applied_at);
        return Ok(());
    }

    let mut doc = room.doc.write().await;
    let since = doc.doc_mut().get_changes(&guard.revision_heads);
    if since.is_empty() {
        return Ok(());
    }
    let deps: HashMap<automerge::ChangeHash, Vec<automerge::ChangeHash>> = since
        .iter()
        .map(|change| (change.hash(), change.deps().to_vec()))
        .collect();

    // Topological order within `since`: dependencies first.
    let mut order: Vec<automerge::ChangeHash> = Vec::with_capacity(deps.len());
    {
        let mut pending: HashMap<automerge::ChangeHash, usize> = deps
            .iter()
            .map(|(hash, ds)| (*hash, ds.iter().filter(|d| deps.contains_key(d)).count()))
            .collect();
        let mut dependents: HashMap<automerge::ChangeHash, Vec<automerge::ChangeHash>> =
            HashMap::new();
        for (hash, ds) in &deps {
            for dep in ds.iter().filter(|d| deps.contains_key(d)) {
                dependents.entry(*dep).or_default().push(*hash);
            }
        }
        let mut ready: Vec<automerge::ChangeHash> = pending
            .iter()
            .filter(|(_, count)| **count == 0)
            .map(|(hash, _)| *hash)
            .collect();
        while let Some(hash) = ready.pop() {
            order.push(hash);
            for dependent in dependents.get(&hash).into_iter().flatten() {
                if let Some(count) = pending.get_mut(dependent) {
                    *count -= 1;
                    if *count == 0 {
                        ready.push(*dependent);
                    }
                }
            }
        }
    }

    // Which revision heads each change reaches through its dependencies.
    let revision: HashSet<automerge::ChangeHash> = guard.revision_heads.iter().copied().collect();
    let mut reaches: HashMap<automerge::ChangeHash, HashSet<automerge::ChangeHash>> =
        HashMap::new();
    for hash in &order {
        let mut reached = HashSet::new();
        for dep in &deps[hash] {
            if revision.contains(dep) {
                reached.insert(*dep);
            } else if let Some(inner) = reaches.get(dep) {
                reached.extend(inner.iter().copied());
            }
        }
        reaches.insert(*hash, reached);
    }
    // After the reload: descendants of every revision head, and what they
    // build on. Everything else in `since` is concurrent with the revision.
    let mut after: HashSet<automerge::ChangeHash> = order
        .iter()
        .filter(|hash| reaches[*hash] == revision)
        .copied()
        .collect();
    for hash in order.iter().rev() {
        if after.contains(hash) {
            for dep in deps[hash].iter().filter(|d| deps.contains_key(d)) {
                after.insert(*dep);
            }
        }
    }
    let concurrent: HashSet<automerge::ChangeHash> = order
        .iter()
        .filter(|hash| !after.contains(hash))
        .copied()
        .collect();
    if concurrent.is_empty() {
        return Ok(());
    }
    let mut session_changes = concurrent.clone();
    for hash in order.iter().rev() {
        if session_changes.contains(hash) {
            for dep in deps[hash].iter().filter(|d| deps.contains_key(d)) {
                session_changes.insert(*dep);
            }
        }
    }
    let session_heads = heads_of(&guard.pre_heads, &session_changes, &deps);
    let file_heads = heads_of(&guard.revision_heads, &after, &deps);

    let before_cells = doc.get_cells_at_heads_with_content(&guard.pre_heads);
    let session_cells = doc.get_cells_at_heads_with_content(&session_heads);
    let before_by_id: HashMap<&str, CellContent<'_>> = before_cells
        .iter()
        .map(|c| (c.id.as_str(), CellContent::of(c)))
        .collect();
    let session_by_id: HashMap<&str, CellContent<'_>> = session_cells
        .iter()
        .map(|c| (c.id.as_str(), CellContent::of(c)))
        .collect();
    let mut cell_ids: Vec<String> = session_cells
        .iter()
        .map(|c| c.id.as_str())
        .chain(before_cells.iter().map(|c| c.id.as_str()))
        .filter(|id| guard.rewritten.contains(*id))
        .filter(|id| before_by_id.get(id) != session_by_id.get(id))
        .map(str::to_string)
        .collect();
    let mut seen = HashSet::new();
    cell_ids.retain(|id| seen.insert(id.clone()));
    if cell_ids.is_empty() {
        return Ok(());
    }

    let capture = DisplacedCapture {
        execution_ids: session_cells
            .iter()
            .map(|cell| {
                (
                    cell.id.clone(),
                    doc.get_execution_id_at_heads(&cell.id, &session_heads),
                )
            })
            .collect(),
        metadata: doc.get_metadata_snapshot_at_heads(&session_heads),
        cells: session_cells.clone(),
        cell_ids: cell_ids.clone(),
        metadata_changed: false,
        order_changed: false,
    };
    let session_heads_hex = session_heads.iter().map(|hash| hash.to_string()).collect();
    let entry = super::persist::prepare_displaced_snapshot(
        room,
        &guard.notebook_path,
        &capture,
        session_heads_hex,
    )
    .await?;

    let file_cells = doc.get_cells_at_heads_with_content(&file_heads);
    let file_by_id: HashMap<&str, &CellSnapshot> =
        file_cells.iter().map(|c| (c.id.as_str(), c)).collect();
    let live_cells = doc.get_cells();
    let heads = doc.get_heads();
    let rollback_actor = doc.get_actor_id();
    let rollback_snapshot = doc.save();
    let put_back = doc.transact_at_heads_recovering(
        &heads,
        Some("runtimed:filesystem"),
        "file-watcher-late-edit-transaction",
        |doc| {
            for live in live_cells.iter().filter(|c| cell_ids.contains(&c.id)) {
                match file_by_id.get(live.id.as_str()) {
                    Some(file) => {
                        if live.source != file.source {
                            doc.update_source(&live.id, &file.source)?;
                        }
                        if live.cell_type != file.cell_type {
                            doc.set_cell_type(&live.id, &file.cell_type)?;
                        }
                        if live.metadata != file.metadata {
                            doc.set_cell_metadata(&live.id, &file.metadata)?;
                        }
                    }
                    None => {
                        doc.delete_cell(&live.id)?;
                    }
                }
            }
            Ok(())
        },
    );
    let committed = put_back.is_ok()
        && commit_file_watcher_changes(
            room,
            &mut doc,
            &heads,
            &rollback_snapshot,
            &rollback_actor,
            None,
        );
    drop(doc);
    if !committed {
        super::persist::abandon_displaced_snapshot(room, &entry).await;
        return Err("could not put back the file's version of late-edited cells".to_string());
    }
    super::persist::publish_displaced_edits(room, &guard.notebook_path, entry);
    let _ = room.broadcasts.changed_tx.send(());
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod source_trust_tests {
    use super::*;

    fn room_with_pep723_source(tmp: &tempfile::TempDir) -> (Arc<NotebookRoom>, PathBuf) {
        let path = tmp.path().join("pep723.ipynb");
        let source = "# /// script\n# dependencies = [\"approved\", \"payload @ https://example.test/payload.tar.gz\"]\n# ///\n";
        let notebook = serde_json::json!({
            "cells": [{
                "cell_type": "code",
                "id": "pep723-cell",
                "metadata": {},
                "source": [source],
                "outputs": [],
                "execution_count": null
            }],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        });
        std::fs::write(&path, serde_json::to_vec(&notebook).unwrap()).unwrap();
        let store =
            crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
                .unwrap();
        store.seed_defaults("pypi", &["approved"]).unwrap();
        let room = NotebookRoom::new_fresh_with_trusted_packages(
            uuid::Uuid::new_v4(),
            Some(path.clone()),
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
            store,
        )
        .unwrap();
        (Arc::new(room), path)
    }

    #[tokio::test]
    async fn partial_source_load_preserves_disk_pep723_trust() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (room, _path) = room_with_pep723_source(&tmp);
        {
            let trust = room.trust_state.read().await;
            assert_eq!(trust.status, runt_trust::TrustStatus::Untrusted);
            assert_eq!(trust.pep723_dependencies.len(), 2);
            write_trust_to_runtime_state(&room, &trust);
        }
        assert!(matches!(
            room.initial_load.begin(),
            RoomInitialLoadStart::Started { .. }
        ));

        // Model the first streaming batch: metadata and a harmless cell are
        // present, but the dependency-bearing cell has not arrived yet.
        {
            let mut doc = room.doc.write().await;
            let metadata = NotebookMetadataSnapshot::from_metadata_value(&serde_json::json!({
                "kernelspec": { "name": "python3", "display_name": "Python 3" }
            }));
            doc.set_metadata_snapshot(&metadata).unwrap();
            doc.add_cell(0, "early-cell", "code").unwrap();
            doc.update_source("early-cell", "print('loading')").unwrap();
            assert_eq!(
                verify_trust_from_doc(&doc, &room.trusted_packages).status,
                runt_trust::TrustStatus::NoDependencies
            );
        }
        check_and_update_trust_state(&room).await;

        let trust = room.trust_state.read().await;
        assert_eq!(trust.status, runt_trust::TrustStatus::Untrusted);
        assert_eq!(trust.pep723_dependencies.len(), 2);
        let projected = room.state.read(|sd| sd.read_state().trust).unwrap();
        assert_eq!(projected.status, "untrusted");
        assert!(projected.needs_approval);
        assert_eq!(projected.pep723_dependencies, trust.pep723_dependencies);
    }

    #[tokio::test]
    async fn completed_source_load_publishes_pep723_trust_without_peer_edits() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (room, path) = room_with_pep723_source(&tmp);
        let expected_dependencies = {
            let trust = room.trust_state.read().await;
            // Approval markers are enriched from the allowlist only after
            // the complete source is available in NotebookDoc.
            assert!(trust.info.approved_uv_dependencies.is_empty());
            trust.pep723_dependencies.clone()
        };
        let mut state_changed = room.state.subscribe();
        start_room_initial_load(&room, path, tmp.path().join("executions"));

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let projected = room.state.read(|sd| sd.read_state().trust).unwrap();
                if projected.pep723_dependencies == expected_dependencies
                    && projected.approved_uv_dependencies == ["approved"]
                {
                    assert_eq!(projected.status, "untrusted");
                    assert!(projected.needs_approval);
                    break;
                }
                match state_changed.recv().await {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(error) => panic!("room state notifications closed: {error}"),
                }
            }
        })
        .await
        .expect("completed load must publish trust without waiting for a peer edit");

        assert!(matches!(
            room.initial_load.state(),
            RoomInitialLoadState::Ready { cell_count: 1, .. }
        ));
        let trust = room.trust_state.read().await;
        assert_eq!(trust.pep723_dependencies, expected_dependencies);
        assert_eq!(trust.info.approved_uv_dependencies, ["approved"]);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod reconciliation_tests {
    use super::*;

    #[test]
    fn source_reconciliation_is_a_causal_replacement_with_stable_disk_ids() {
        let mut doc = NotebookDoc::new("source-reconciliation-test");
        doc.add_cell_full(
            "recovered-cell",
            "code",
            &loro_fractional_index::FractionalIndex::default().to_string(),
            "recovered = True",
            "null",
            &serde_json::json!({ "origin": "journal" }),
        )
        .unwrap();
        let recovered_heads = doc.get_heads();
        let disk_bytes = br##"{"cells":[{"cell_type":"markdown","id":"disk-cell","metadata":{"origin":"disk"},"source":["# Disk\n"]}],"metadata":{"custom":{"selected":true}},"nbformat":4,"nbformat_minor":5}"##
            .to_vec();
        let metadata = NotebookMetadataSnapshot::from_metadata_value(
            &serde_json::json!({ "custom": { "selected": true } }),
        );
        let position = loro_fractional_index::FractionalIndex::default().to_string();
        let prepared = PreparedSourceReconciliation {
            prepared: PreparedInitialImport {
                source_content: disk_bytes.clone(),
                fingerprint: super::super::recovery::source_fingerprint(&disk_bytes),
                cells: vec![PreparedInitialCell {
                    cell: StreamingCell {
                        id: "disk-cell".to_string(),
                        cell_type: "markdown".to_string(),
                        position,
                        source: "# Disk\n".to_string(),
                        execution_count: "null".to_string(),
                        outputs: Vec::new(),
                        metadata: serde_json::json!({ "origin": "disk" }),
                    },
                    output_refs: Vec::new(),
                    resolved_assets: ResolvedAssets::new(),
                    attachment_refs: AttachmentRefs::new(),
                    execution: None,
                }],
                metadata: Some(metadata),
                widget_comms: Vec::new(),
                loaded_sources: HashMap::from([("disk-cell".to_string(), "# Disk\n".to_string())]),
            },
        };

        let applied =
            apply_prepared_source_reconciliation(&mut doc, "runtimed:reconcile:test", prepared)
                .unwrap();

        let cells = doc.get_cells();
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].id, "disk-cell");
        assert_eq!(cells[0].source, "# Disk\n");
        assert_eq!(cells[0].metadata, serde_json::json!({ "origin": "disk" }));
        assert_eq!(
            doc.get_metadata_snapshot().unwrap().extras.get("custom"),
            Some(&serde_json::json!({ "selected": true }))
        );
        assert!(!applied.change_hashes.is_empty());
        assert_eq!(applied.heads, doc.get_heads());
        assert!(recovered_heads
            .iter()
            .all(|head| doc.doc_mut().get_change_by_hash(head).is_some()));
    }
}
