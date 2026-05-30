use super::*;
use base64::Engine as _;

pub(crate) const JUPYTER_WIDGET_TARGET: &str = "jupyter.widget";
pub(crate) const WIDGET_STATE_MIME: &str = "application/vnd.jupyter.widget-state+json";
const WIDGET_STATE_VERSION_MAJOR: i64 = 2;
const WIDGET_STATE_VERSION_MINOR: i64 = 0;

#[derive(Debug)]
pub(crate) enum SaveError {
    /// Transient / potentially recoverable (e.g. disk full, busy)
    Retryable(String),
    /// Permanent — retrying will never help (path is a directory, permission denied, invalid path)
    Unrecoverable(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Retryable(msg) | SaveError::Unrecoverable(msg) => f.write_str(msg),
        }
    }
}

/// Returns the absolute path where the notebook was written.
pub(crate) async fn save_notebook_to_disk(
    room: &NotebookRoom,
    target_path: Option<&str>,
) -> Result<String, SaveError> {
    // Diagnostic: log the call with the caller-supplied path and what the
    // room currently has as its path. Triangulates stray-file bugs by letting
    // us correlate saves against whoever fired them.
    debug!(
        "[save] save_notebook_to_disk entered: target_path={:?}, room.id={}, room.file_binding.path={:?}",
        target_path,
        room.id,
        room.file_binding.path().await.as_deref()
    );
    // Determine the actual save path
    let notebook_path = match target_path {
        Some(p) => {
            let path = PathBuf::from(p);

            // Reject relative paths - daemon CWD is unpredictable (could be / when running as launchd)
            // Clients (Tauri file dialog, Python SDK) should always provide absolute paths.
            if path.is_relative() {
                return Err(SaveError::Unrecoverable(format!(
                    "Relative paths are not supported for save: '{}'. Please provide an absolute path.",
                    p
                )));
            }

            // Ensure .ipynb extension
            if p.ends_with(".ipynb") {
                path
            } else {
                PathBuf::from(format!("{}.ipynb", p))
            }
        }
        None => match room.file_binding.path().await {
            Some(p) => p,
            None => {
                return Err(SaveError::Unrecoverable(
                    "Cannot save untitled notebook without a target path. \
                 Please provide an explicit save path."
                        .to_string(),
                ))
            }
        },
    };

    // Read existing .ipynb as raw bytes. Used for two things: the
    // content-hash guard further down (skip no-op writes), and the
    // `nbformat_minor` floor (not carried in the doc today).
    // We no longer read metadata from disk — the doc carries unknown
    // top-level keys as extras, so everything round-trips through
    // the snapshot.
    let existing_raw: Option<Vec<u8>> = match tokio::fs::read(&notebook_path).await {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            warn!(
                "[notebook-sync] Failed to read existing notebook {:?}: {}, \
                 will create new",
                notebook_path, e
            );
            None
        }
    };

    // Read cells, metadata, and per-cell execution_ids from the doc.
    let (cells, metadata_snapshot, cell_execution_ids) = {
        let doc = room.doc.write().await;
        let cells = doc.get_cells();
        let metadata_snapshot = doc.get_metadata_snapshot();
        // Collect execution_id for each cell (for output lookup in state doc)
        let eids: HashMap<String, Option<String>> = cells
            .iter()
            .map(|c| (c.id.clone(), doc.get_execution_id(&c.id)))
            .collect();
        (cells, metadata_snapshot, eids)
    };

    let previous_visible_execution_ids: HashMap<String, String> = cells
        .iter()
        .filter_map(|cell| {
            room.persistence
                .previous_visible_execution(&cell.id)
                .map(|execution_id| (cell.id.clone(), execution_id))
        })
        .collect();

    // Read outputs and execution_count from RuntimeStateDoc keyed by execution_id.
    //
    // NotebookDoc owns the cell -> execution pointer, while RuntimeStateDoc v2
    // stores executions without durable cell identity. Saves use the current
    // cell pointer directly except for the re-execution window where that
    // pointer already targets a queued/running execution with no outputs yet;
    // in that case daemon-local persistence hints preserve the previous
    // visible outputs on disk. Cleared cells (`execution_id = None`) still
    // write empty outputs.
    let (cell_outputs, cell_execution_counts): (
        HashMap<String, Vec<serde_json::Value>>,
        HashMap<String, Option<i64>>,
    ) = room
        .state
        .read(|sd| {
            let snapshot = sd.read_state();
            let mut outputs_map = HashMap::new();
            let mut ec_map = HashMap::new();
            for (cell_id, eid) in &cell_execution_ids {
                let Some(eid) = eid.as_ref() else { continue };
                let Some(exec) = snapshot.executions.get(eid) else {
                    continue;
                };
                let mut outputs = sd.get_outputs(eid);
                let mut execution_count = exec.execution_count;
                if outputs.is_empty() && matches!(exec.status.as_str(), "queued" | "running") {
                    if let Some(previous_execution_id) = previous_visible_execution_ids.get(cell_id)
                    {
                        if let Some(previous_exec) = snapshot.executions.get(previous_execution_id)
                        {
                            let previous_outputs = sd.get_outputs(previous_execution_id);
                            if !previous_outputs.is_empty()
                                || previous_exec.execution_count.is_some()
                            {
                                outputs = previous_outputs;
                                execution_count = previous_exec.execution_count;
                            }
                        }
                    }
                }
                if !outputs.is_empty() {
                    outputs_map.insert(cell_id.clone(), outputs);
                }
                ec_map.insert(cell_id.clone(), execution_count);
            }
            (outputs_map, ec_map)
        })
        .unwrap_or_default();

    let mut nbformat_attachments = HashMap::new();
    for cell in &cells {
        if cell.attachments.is_empty() {
            continue;
        }
        let attachments = attachment_refs_to_nbformat_value(&cell.attachments, &room.blob_store)
            .await
            .map_err(|e| match e {
                AttachmentResolveError::MissingBlob(_)
                | AttachmentResolveError::BlobReadFailed(_)
                | AttachmentResolveError::InvalidPayload(_) => SaveError::Unrecoverable(format!(
                    "Failed to resolve attachments for cell {}: {e}",
                    cell.id
                )),
            })?;
        nbformat_attachments.insert(cell.id.clone(), attachments);
    }

    // Resolve outputs from the blob store. `resolve_cell_output` returns
    // Jupyter-shape JSON (daemon-runtime shape: includes `output_id`, etc.).
    // The nbformat conversion layer strips runtime-only fields before
    // handing values to the typed v4 deserializer.
    let mut resolved_outputs_by_cell: HashMap<String, Vec<serde_json::Value>> =
        HashMap::with_capacity(cells.len());
    for cell in &cells {
        if cell.cell_type != "code" {
            continue;
        }
        let Some(outputs) = cell_outputs.get(&cell.id) else {
            continue;
        };
        let mut resolved = Vec::with_capacity(outputs.len());
        for output in outputs {
            let output_value = resolve_cell_output(output, &room.blob_store).await;
            resolved.push(output_value);
        }
        resolved_outputs_by_cell.insert(cell.id.clone(), resolved);
    }

    // Metadata comes entirely from the doc. No disk rescue; the
    // snapshot carries unknown keys as extras.
    let mut metadata = metadata_snapshot
        .as_ref()
        .map(|s| serde_json::to_value(s).unwrap_or_else(|_| serde_json::json!({})))
        .unwrap_or_else(|| serde_json::json!({}));
    let comms = room.state.read(|sd| sd.get_comms()).unwrap_or_default();
    match widget_state_metadata_from_comms(&comms, &room.blob_store).await {
        Ok(Some(widget_state)) => {
            insert_widget_state_metadata(&mut metadata, widget_state);
        }
        Ok(None) => {}
        Err(err) => {
            warn!(
                "[notebook-sync] Failed to materialize widget state metadata; \
                 preserving existing notebook metadata: {err}"
            );
        }
    }

    // We always write cell IDs, so nbformat_minor is at least 5.
    let existing_minor = existing_raw
        .as_ref()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
        .as_ref()
        .and_then(|nb| nb.get("nbformat_minor"))
        .and_then(|v| v.as_u64())
        .unwrap_or(5) as i32;
    let nbformat_minor = std::cmp::max(existing_minor, 5);

    // Build a typed v4::Notebook. The conversion layer enforces nbformat
    // schema invariants (cell id validity, output typing, metadata shape) —
    // structural bugs become compile/deserialize errors instead of silent
    // on-disk drift.
    let v4_notebook = build_v4_notebook(
        &cells,
        &resolved_outputs_by_cell,
        &cell_execution_counts,
        &nbformat_attachments,
        &metadata,
        nbformat_minor,
    )
    .map_err(|e| SaveError::Unrecoverable(format!("Failed to build v4 notebook: {e}")))?;
    let cell_count = v4_notebook.cells.len();

    // Zeroing guard (in-place saves). A failed/incomplete streaming load empties
    // the room doc (peer_session clears all cells on load failure). Writing that
    // empty room back to its own file overwrites a populated `.ipynb` and
    // destroys the notebook. Skip the write when the save is IN-PLACE, the
    // in-memory doc has 0 cells, the room was emptied by a failed load
    // (`load_failed`), and a non-empty file already exists on disk; return Ok so
    // the autosave debouncer keeps running (Unrecoverable would disable it).
    //
    // "In-place" = the save targets the room's current bound path. Desktop
    // autosave/teardown/Save pass `target_path = None`; MCP/Node/Python
    // `save(path)` pass `Some(current_path)`. BOTH are in-place and must be
    // protected — keying on `None` alone would let a same-path `Some` save zero
    // the file. Only a genuine Save As to a DIFFERENT path bypasses the guard
    // (the user is deliberately writing elsewhere). A failed-load room's in-place
    // save still reports success without writing; surfacing that to the client is
    // deferred to the honest-failure-messaging work (Step 1). A genuinely empty
    // doc over an empty/absent file still round-trips, and a brand-new untitled
    // notebook has no existing file to protect.
    //
    // `room.load_failed()` is what separates a failed load from a legitimate
    // emptying. The flag is set at exactly one production point — the
    // streaming-load Err branch in peer_session, co-located with the
    // `clear_all_cells()` that empties the room — and cleared on a fresh load
    // attempt (`try_start_loading` winning the claim). So a legitimately-empty
    // notebook reached via ANY init path (no failed load) is never flagged and
    // always saves: deleting the last cell or editing metadata on a loaded room
    // WRITES the empty state. Only a room emptied by a failed load over a
    // non-empty/corrupt file on disk is protected.
    //
    // The disk trigger is "disk has bytes," not "disk parses to >=1 cell." The
    // most common reason a streaming load fails is that the file is corrupt
    // (load.rs: jiter parse error, "not a JSON object", "'cells' is not an
    // array") — exactly the cases where a parse-and-count of the on-disk bytes
    // returns 0 and would let the empty doc through. Protecting on raw
    // non-whitespace content covers corrupt files, files whose `cells` key was
    // clobbered by a crashed prior write, and well-formed populated notebooks
    // alike. The only cost is that an unparseable file is never auto-overwritten
    // by an empty doc, which is the safe direction for a data-loss guard.
    let is_in_place_save = match target_path {
        None => true,
        Some(_) => {
            room.file_binding
                .path_matches(notebook_path.as_path())
                .await
        }
    };
    if is_in_place_save && cell_count == 0 && room.load_failed() {
        let disk_has_content = existing_raw
            .as_ref()
            .is_some_and(|bytes| bytes.iter().any(|b| !b.is_ascii_whitespace()));
        if disk_has_content {
            warn!(
                "[notebook-sync] Skipping save of empty doc over existing on-disk content for \
                 {:?} (room emptied by a failed load); preserving file. Save As to a new path \
                 still writes.",
                notebook_path
            );
            return Ok(notebook_path.to_string_lossy().to_string());
        }
    }

    // Collect raw-cell attachments (markdown attachments are already on the
    // typed v4::Cell::Markdown variant; raw cells lose theirs in typed
    // conversion and get re-injected during serialize).
    let raw_attachments: HashMap<String, serde_json::Value> = cells
        .iter()
        .filter(|c| c.cell_type == "raw")
        .filter_map(|c| {
            nbformat_attachments
                .get(&c.id)
                .map(|att| (c.id.clone(), att.clone()))
        })
        .collect();

    let content_with_newline = serialize_v4_notebook(&v4_notebook, &raw_attachments)
        .map_err(|e| SaveError::Retryable(format!("Failed to serialize notebook: {e}")))?;

    // Content-hash guard: skip the write if the serialized bytes match what is
    // already on disk. Prevents no-op autosaves from dirtying the working tree.
    if let Some(ref raw) = existing_raw {
        if raw.as_slice() == content_with_newline.as_bytes() {
            debug!(
                "[notebook-sync] Skipping write - content unchanged for {:?}",
                notebook_path
            );
            // Still update save baselines so the file watcher stays consistent.
            let is_primary_path = target_path.is_none()
                || room
                    .file_binding
                    .path_matches(notebook_path.as_path())
                    .await;
            if is_primary_path {
                let mut saved = HashMap::with_capacity(cells.len());
                for cell in &cells {
                    saved.insert(cell.id.clone(), cell.source.clone());
                }
                *room.persistence.last_save_sources.write().await = saved;
            }
            // Disk already matches the room, so any failed-load hazard is
            // resolved — clear the flag so a later legitimate empty save writes.
            room.clear_load_failed();
            return Ok(notebook_path.to_string_lossy().to_string());
        }
    }

    // Ensure parent directory exists (agents often construct paths programmatically)
    if let Some(parent) = notebook_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            SaveError::Unrecoverable(format!(
                "Failed to create directory '{}': {e}",
                parent.display()
            ))
        })?;
    }

    // Write to disk (async to avoid blocking the runtime)
    tokio::fs::write(&notebook_path, &content_with_newline)
        .await
        .map_err(|e| {
            let msg = format!("Failed to write notebook: {e}");
            match e.kind() {
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::IsADirectory => {
                    SaveError::Unrecoverable(msg)
                }
                _ => SaveError::Retryable(msg),
            }
        })?;

    // A successful write makes disk match the room, so any failed-load hazard is
    // resolved — clear the flag so later legitimate empty saves are not blocked.
    // (A still-failed empty room over existing content is skipped by the guard
    // above and never reaches here, so this only clears genuine recoveries:
    // Save As, or adding a cell to a failed-load room and saving.)
    room.clear_load_failed();

    // Update last_self_write timestamp so the file watcher skips our own write.
    // Applies to all rooms (including ephemeral that were just promoted to
    // file-backed via this save) - a watcher may start up right after
    // `finalize_untitled_promotion` and will consult this baseline.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    room.persistence
        .last_self_write
        .store(now, Ordering::Relaxed);

    // Snapshot cell sources at save time so the file watcher can distinguish
    // our own writes from genuine external changes. Only update when saving
    // to the primary path - saving to an alternate path (Save As) must not
    // corrupt the baseline for the file watcher.
    let is_primary_path = target_path.is_none()
        || room
            .file_binding
            .path_matches(notebook_path.as_path())
            .await;
    if is_primary_path {
        let mut saved = HashMap::with_capacity(cells.len());
        for cell in &cells {
            saved.insert(cell.id.clone(), cell.source.clone());
        }
        *room.persistence.last_save_sources.write().await = saved;
    }

    info!(
        "[notebook-sync] Saved notebook to disk: {:?} ({} cells)",
        notebook_path, cell_count
    );

    Ok(notebook_path.to_string_lossy().to_string())
}

/// Transitions an untitled room to file-backed: claims path in path_index,
/// updates room.file_binding.path, cleans up the stale `.automerge` persist file, spawns
/// the `.ipynb` file watcher and autosave debouncer, clears ephemeral markers,
/// and stamps the new path on the runtime-state doc (peers see it via sync).
///
/// Returns `Ok(())` on success, or `Err(SaveErrorKind::PathAlreadyOpen)` if
/// another room is already serving this canonical path.  On error the caller's
/// room state is NOT mutated.
/// Canonicalize a path that may not yet exist on disk.
///
/// `tokio::fs::canonicalize` requires the target to exist. For pre-write
/// collision checks, we canonicalize the parent directory and append the
/// filename. Falls back to the raw path if even the parent is unresolvable.
pub(crate) async fn canonical_target_path(target: &Path) -> PathBuf {
    if let Ok(c) = tokio::fs::canonicalize(target).await {
        return c;
    }
    if let (Some(parent), Some(name)) = (target.parent(), target.file_name()) {
        if let Ok(canonical_parent) = tokio::fs::canonicalize(parent).await {
            return canonical_parent.join(name);
        }
    }
    target.to_path_buf()
}

/// Try to claim a path in the path index for a given room. Returns the
/// structured `PathAlreadyOpen` error if another room already holds it.
pub(crate) async fn try_claim_path(
    rooms: &NotebookRooms,
    canonical: &Path,
    uuid: uuid::Uuid,
) -> Result<(), notebook_protocol::protocol::SaveErrorKind> {
    match rooms.bind_path(uuid, canonical.to_path_buf()).await {
        Ok(()) => Ok(()),
        Err(path_index::PathIndexError::PathAlreadyOpen { uuid, path: p }) => Err(
            notebook_protocol::protocol::SaveErrorKind::PathAlreadyOpen {
                uuid: uuid.to_string(),
                path: p.to_string_lossy().into_owned(),
            },
        ),
    }
}

/// Finalize the untitled-to-file-backed transition AFTER the .ipynb has been
/// written and path_index already holds the claim. `NotebookFileBinding` owns
/// the path, watcher/autosave lifecycle, runtime-state path write, and project
/// context refresh; this helper only handles the stale untitled Automerge file
/// and notebook metadata transition around that binding update.
pub(crate) async fn finalize_untitled_promotion(room: &Arc<NotebookRoom>, canonical: PathBuf) {
    // NOTE: We don't actually stop the .automerge persist debouncer here —
    // stopping it would require taking ownership of room.persist_tx, which
    // the current struct definition doesn't support (it's a plain
    // Option<Sender<...>>). A subsequent AutomergeSync frame may resurrect
    // the .automerge file we delete below. That's OK because:
    //   - The file is keyed by SHA256(uuid), so it never collides with a
    //     different room.
    //   - Future open_notebook calls for the .ipynb go through a path key,
    //     not the UUID — the orphaned .automerge is never consulted.
    //   - The debouncer task dies when NotebookRoom is dropped on eviction.
    // TODO(followup): make persist_tx: Mutex<Option<...>> so .take() can
    // properly drop the sender and close the channel.
    if room.identity.persist_path.exists() {
        if let Err(e) = tokio::fs::remove_file(&room.identity.persist_path).await {
            warn!(
                "[notebook-sync] Failed to remove stale persist file {:?}: {}",
                room.identity.persist_path, e
            );
        }
    }

    NotebookFileBinding::promote_after_save(room, canonical.clone()).await;

    // Clear the document-level ephemeral marker after the binding is file-backed.
    {
        let mut doc = room.doc.write().await;
        let _ = doc.delete_metadata("ephemeral");
    }

    info!(
        "[notebook-sync] Promoted untitled room {} to file-backed path {:?}",
        room.id, canonical
    );
}

/// Resolve a single cell output — handles both manifest hashes and raw JSON.
async fn resolve_cell_output(
    output: &serde_json::Value,
    blob_store: &BlobStore,
) -> serde_json::Value {
    // If the output is a string, it's a legacy format (hash or raw JSON string)
    if let Some(s) = output.as_str() {
        // Check if it's a manifest hash (64-char hex string)
        if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            if let Ok(Some(manifest_bytes)) = blob_store.get(s).await {
                if let Ok(manifest_json) = String::from_utf8(manifest_bytes) {
                    if let Ok(manifest) =
                        serde_json::from_str::<crate::output_store::OutputManifest>(&manifest_json)
                    {
                        if let Ok(resolved) =
                            crate::output_store::resolve_manifest(&manifest, blob_store).await
                        {
                            return resolved;
                        }
                    }
                }
            }
            warn!(
                "[notebook-sync] Failed to resolve legacy output manifest: {}",
                &s[..8]
            );
            return serde_json::json!({"output_type": "stream", "name": "stderr", "text": ["[output could not be resolved]"]});
        }
        // Raw JSON string — parse it
        match serde_json::from_str(s) {
            Ok(value) => return value,
            Err(e) => {
                warn!("[notebook-sync] Invalid JSON in raw output string: {}", e);
                return serde_json::json!({
                    "output_type": "stream",
                    "name": "stderr",
                    "text": ["[invalid output JSON]"]
                });
            }
        }
    }

    // Structured manifest/output object — resolve any blob refs
    match serde_json::from_value::<crate::output_store::OutputManifest>(output.clone()) {
        Ok(manifest) => match crate::output_store::resolve_manifest(&manifest, blob_store).await {
            Ok(resolved) => resolved,
            Err(_) => output.clone(),
        },
        Err(_) => output.clone(),
    }
}

async fn widget_state_metadata_from_comms(
    comms: &HashMap<String, runtime_doc::CommDocEntry>,
    blob_store: &BlobStore,
) -> Result<Option<serde_json::Value>, String> {
    let mut entries: Vec<_> = comms
        .iter()
        .filter(|(_, entry)| entry.target_name == JUPYTER_WIDGET_TARGET)
        .collect();
    entries.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut state = serde_json::Map::new();
    for (comm_id, entry) in entries {
        let Some(model_name) = widget_model_field(&entry.model_name, &entry.state, "_model_name")
        else {
            warn!(
                "[notebook-sync] Skipping widget comm {} with missing model_name",
                comm_id
            );
            continue;
        };
        let Some(model_module) =
            widget_model_field(&entry.model_module, &entry.state, "_model_module")
        else {
            warn!(
                "[notebook-sync] Skipping widget comm {} with missing model_module",
                comm_id
            );
            continue;
        };

        let (resolved_state, buffers) = match resolve_widget_state_content_refs(
            entry.state.clone(),
            blob_store,
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(err) => {
                warn!(
                        "[notebook-sync] Skipping widget comm {} while materializing widget state metadata: {err}",
                        comm_id
                    );
                continue;
            }
        };
        let mut model = serde_json::Map::new();
        model.insert(
            "model_name".to_string(),
            serde_json::Value::String(model_name),
        );
        model.insert(
            "model_module".to_string(),
            serde_json::Value::String(model_module),
        );
        if let Some(model_module_version) =
            widget_model_field("", &entry.state, "_model_module_version")
        {
            model.insert(
                "model_module_version".to_string(),
                serde_json::Value::String(model_module_version),
            );
        }
        model.insert("state".to_string(), resolved_state);
        if !buffers.is_empty() {
            model.insert("buffers".to_string(), serde_json::Value::Array(buffers));
        }
        state.insert(comm_id.clone(), serde_json::Value::Object(model));
    }

    if state.is_empty() {
        return Ok(None);
    }

    Ok(Some(serde_json::json!({
        "version_major": WIDGET_STATE_VERSION_MAJOR,
        "version_minor": WIDGET_STATE_VERSION_MINOR,
        "state": state,
    })))
}

fn widget_model_field(
    entry_value: &str,
    state: &serde_json::Value,
    state_key: &str,
) -> Option<String> {
    if !entry_value.is_empty() {
        return Some(entry_value.to_string());
    }
    state
        .get(state_key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn insert_widget_state_metadata(metadata: &mut serde_json::Value, widget_state: serde_json::Value) {
    if !metadata.is_object() {
        *metadata = serde_json::json!({});
    }
    let Some(metadata_obj) = metadata.as_object_mut() else {
        return;
    };
    let widgets = metadata_obj
        .entry("widgets".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !widgets.is_object() {
        *widgets = serde_json::json!({});
    }
    if let Some(widgets_obj) = widgets.as_object_mut() {
        widgets_obj.insert(WIDGET_STATE_MIME.to_string(), widget_state);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum WidgetStatePathSegment {
    Key(String),
    Index(usize),
}

impl WidgetStatePathSegment {
    fn to_widget_path_value(&self) -> serde_json::Value {
        match self {
            Self::Key(key) => serde_json::Value::String(key.clone()),
            Self::Index(index) => serde_json::json!(*index),
        }
    }
}

#[derive(Clone, Debug)]
struct WidgetStateContentRef {
    path: Vec<WidgetStatePathSegment>,
    blob: String,
    media_type: Option<String>,
}

async fn resolve_widget_state_content_refs(
    mut state: serde_json::Value,
    blob_store: &BlobStore,
) -> Result<(serde_json::Value, Vec<serde_json::Value>), String> {
    let mut refs = Vec::new();
    collect_widget_state_content_refs(&state, &mut Vec::new(), &mut refs);

    let mut buffers = Vec::new();
    for content_ref in refs {
        let bytes = blob_store
            .get(&content_ref.blob)
            .await
            .map_err(|err| {
                format!(
                    "failed to read widget state blob {}: {err}",
                    content_ref.blob
                )
            })?
            .ok_or_else(|| format!("widget state blob {} not found", content_ref.blob))?;

        if widget_state_ref_is_binary(content_ref.media_type.as_deref()) {
            remove_widget_state_value_for_buffer(&mut state, &content_ref.path)?;
            buffers.push(serde_json::json!({
                "encoding": "base64",
                "path": content_ref
                    .path
                    .iter()
                    .map(WidgetStatePathSegment::to_widget_path_value)
                    .collect::<Vec<_>>(),
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }));
        } else {
            let replacement =
                widget_state_blob_to_json_value(&bytes, content_ref.media_type.as_deref())?;
            set_widget_state_value_at_path(&mut state, &content_ref.path, replacement)?;
        }
    }

    Ok((state, buffers))
}

fn collect_widget_state_content_refs(
    value: &serde_json::Value,
    path: &mut Vec<WidgetStatePathSegment>,
    refs: &mut Vec<WidgetStateContentRef>,
) {
    if let Some((blob, media_type)) = widget_state_content_ref(value) {
        refs.push(WidgetStateContentRef {
            path: path.clone(),
            blob,
            media_type,
        });
        return;
    }

    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                path.push(WidgetStatePathSegment::Key(key.clone()));
                collect_widget_state_content_refs(child, path, refs);
                path.pop();
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                path.push(WidgetStatePathSegment::Index(index));
                collect_widget_state_content_refs(child, path, refs);
                path.pop();
            }
        }
        _ => {}
    }
}

fn widget_state_content_ref(value: &serde_json::Value) -> Option<(String, Option<String>)> {
    let object = value.as_object()?;
    let blob = object.get("blob")?.as_str()?.to_string();
    let has_size = object.get("size").is_some_and(serde_json::Value::is_number);
    if !has_size {
        return None;
    }
    let media_type = object
        .get("media_type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Some((blob, media_type))
}

fn widget_state_ref_is_binary(media_type: Option<&str>) -> bool {
    match media_type {
        Some(media_type) => notebook_doc::mime::is_binary_mime(media_type),
        None => true,
    }
}

fn widget_state_blob_to_json_value(
    bytes: &[u8],
    media_type: Option<&str>,
) -> Result<serde_json::Value, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|err| format!("widget state text blob is not valid UTF-8: {err}"))?;
    if media_type.is_some_and(|mime| mime == "application/json" || mime.ends_with("+json")) {
        serde_json::from_str(text)
            .map_err(|err| format!("widget state JSON blob is invalid: {err}"))
    } else {
        Ok(serde_json::Value::String(text.to_string()))
    }
}

fn set_widget_state_value_at_path(
    state: &mut serde_json::Value,
    path: &[WidgetStatePathSegment],
    replacement: serde_json::Value,
) -> Result<(), String> {
    let Some((last, parent_path)) = path.split_last() else {
        *state = replacement;
        return Ok(());
    };
    let parent = widget_state_value_mut_at_path(state, parent_path)?;
    match (parent, last) {
        (serde_json::Value::Object(map), WidgetStatePathSegment::Key(key)) => {
            map.insert(key.clone(), replacement);
            Ok(())
        }
        (serde_json::Value::Array(items), WidgetStatePathSegment::Index(index)) => {
            let Some(item) = items.get_mut(*index) else {
                return Err(format!("widget state array index {index} out of bounds"));
            };
            *item = replacement;
            Ok(())
        }
        _ => Err("widget state content ref path shape changed while resolving".to_string()),
    }
}

fn remove_widget_state_value_for_buffer(
    state: &mut serde_json::Value,
    path: &[WidgetStatePathSegment],
) -> Result<(), String> {
    let Some((last, parent_path)) = path.split_last() else {
        *state = serde_json::Value::Null;
        return Ok(());
    };
    let parent = widget_state_value_mut_at_path(state, parent_path)?;
    match (parent, last) {
        (serde_json::Value::Object(map), WidgetStatePathSegment::Key(key)) => {
            map.remove(key);
            Ok(())
        }
        (serde_json::Value::Array(items), WidgetStatePathSegment::Index(index)) => {
            let Some(item) = items.get_mut(*index) else {
                return Err(format!("widget state array index {index} out of bounds"));
            };
            *item = serde_json::Value::Null;
            Ok(())
        }
        _ => Err("widget state buffer path shape changed while resolving".to_string()),
    }
}

fn widget_state_value_mut_at_path<'a>(
    mut value: &'a mut serde_json::Value,
    path: &[WidgetStatePathSegment],
) -> Result<&'a mut serde_json::Value, String> {
    for segment in path {
        value = match (value, segment) {
            (serde_json::Value::Object(map), WidgetStatePathSegment::Key(key)) => map
                .get_mut(key)
                .ok_or_else(|| format!("widget state object key {key:?} missing"))?,
            (serde_json::Value::Array(items), WidgetStatePathSegment::Index(index)) => items
                .get_mut(*index)
                .ok_or_else(|| format!("widget state array index {index} out of bounds"))?,
            _ => {
                return Err(
                    "widget state content ref path shape changed while resolving".to_string(),
                )
            }
        };
    }
    Ok(value)
}

/// Configuration for the persist debouncer timing.
#[derive(Clone, Copy)]
pub(crate) struct PersistDebouncerConfig {
    /// How long to wait after last update before flushing (debounce window)
    pub(crate) debounce_ms: u64,
    /// Maximum time between flushes during continuous updates
    pub(crate) max_interval_ms: u64,
    /// How often to check if we should flush
    pub(crate) check_interval_ms: u64,
}

impl Default for PersistDebouncerConfig {
    fn default() -> Self {
        Self {
            debounce_ms: 500,
            max_interval_ms: 5000,
            check_interval_ms: 100,
        }
    }
}

/// Request to force the persist debouncer to flush pending data immediately.
/// The debouncer replies on the oneshot with `true` if the write succeeded
/// (or if there were no pending bytes to write), `false` on I/O error. Used
/// by room eviction to guarantee the persisted file reflects the latest doc
/// state *before* the room is removed from the map; a `false` reply tells
/// the caller the file on disk is still stale.
pub(crate) type FlushRequest = oneshot::Sender<bool>;

/// Spawn a debounced persistence task that coalesces writes.
///
/// Uses a `watch` channel for "latest value" semantics - new values replace old ones,
/// so we always persist the most recent state. No backpressure issues.
///
/// Persistence strategy:
/// - **Debounce (500ms)**: Wait 500ms after last update before writing
/// - **Max interval (5s)**: During continuous output, flush at least every 5s
/// - **Flush request**: Force an immediate write and ack (used by eviction)
/// - **Shutdown flush**: Persist any pending data when channel closes
///
/// This reduces disk I/O during rapid output while ensuring durability.
pub(crate) fn spawn_persist_debouncer(
    persist_rx: watch::Receiver<Option<Vec<u8>>>,
    flush_rx: mpsc::UnboundedReceiver<FlushRequest>,
    persist_path: PathBuf,
) {
    spawn_persist_debouncer_with_config(
        persist_rx,
        flush_rx,
        persist_path,
        PersistDebouncerConfig::default(),
    );
}

/// Spawn debouncer with custom timing configuration (for testing).
pub(crate) fn spawn_persist_debouncer_with_config(
    mut persist_rx: watch::Receiver<Option<Vec<u8>>>,
    mut flush_rx: mpsc::UnboundedReceiver<FlushRequest>,
    persist_path: PathBuf,
    config: PersistDebouncerConfig,
) {
    spawn_supervised(
        "persist-debouncer",
        async move {
            use std::time::Duration;
            use tokio::time::{interval, Instant, MissedTickBehavior};

            let debounce_duration = Duration::from_millis(config.debounce_ms);
            let max_flush_interval = Duration::from_millis(config.max_interval_ms);

            let mut last_receive: Option<Instant> = None;
            let mut last_flush: Option<Instant> = None;

            // Persistent interval - fires regularly regardless of how often changed() fires.
            // This ensures we always check debounce/max-interval even during rapid updates.
            let mut check_interval = interval(Duration::from_millis(config.check_interval_ms));
            check_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    result = persist_rx.changed() => {
                        if result.is_err() {
                            // Channel closed - flush any pending data and exit
                            let bytes = persist_rx.borrow().clone();
                            if let Some(data) = bytes {
                                do_persist(&data, &persist_path);
                            }
                            break;
                        }
                        last_receive = Some(Instant::now());
                    }
                    maybe_req = flush_rx.recv() => {
                        match maybe_req {
                            Some(ack) => {
                                // Eviction (or another caller) wants a synchronous flush.
                                // Write the latest doc bytes, then ack with the write
                                // result so the caller knows whether the file is
                                // current. No pending bytes = nothing to write = ack true
                                // (the file either doesn't exist or already reflects
                                // the latest state).
                                let bytes = persist_rx.borrow().clone();
                                let ok = if let Some(data) = bytes {
                                    let write_ok = do_persist(&data, &persist_path);
                                    if write_ok {
                                        last_flush = Some(Instant::now());
                                        last_receive = None;
                                    }
                                    write_ok
                                } else {
                                    true
                                };
                                // Receiver may have dropped (eviction timed out); ignore.
                                let _ = ack.send(ok);
                            }
                            None => {
                                // All flush senders dropped. The room is being torn
                                // down; the watch receiver will close next and we'll
                                // hit the shutdown flush on the persist_rx.changed()
                                // Err arm. Break defensively to avoid hot-looping if
                                // that somehow doesn't fire (we still want to flush
                                // any pending bytes first).
                                let bytes = persist_rx.borrow().clone();
                                if let Some(data) = bytes {
                                    do_persist(&data, &persist_path);
                                }
                                break;
                            }
                        }
                    }
                    _ = check_interval.tick() => {
                        // Check if we should flush based on debounce or max interval
                        let should_flush = if let Some(recv) = last_receive {
                            // Debounce: 500ms quiet period since last receive
                            let debounce_ready = recv.elapsed() >= debounce_duration;
                            // Max interval: 5s since last flush (or since first receive)
                            let max_interval_ready = last_flush
                                .map(|f| f.elapsed() >= max_flush_interval)
                                .unwrap_or(recv.elapsed() >= max_flush_interval);
                            debounce_ready || max_interval_ready
                        } else {
                            false
                        };

                        if should_flush {
                            let bytes = persist_rx.borrow().clone();
                            if let Some(data) = bytes {
                                do_persist(&data, &persist_path);
                                last_flush = Some(Instant::now());
                                last_receive = None;
                            }
                        }
                    }
                }
            }
        },
        |_| {
            trigger_global_shutdown();
        },
    );
}

/// Configuration for the autosave debouncer (testable).
struct AutosaveDebouncerConfig {
    /// Quiet period: flush only after no changes for this long.
    debounce_ms: u64,
    /// Max interval: flush even during continuous changes after this long.
    max_interval_ms: u64,
    /// How often to check whether a flush is due.
    check_interval_ms: u64,
}

impl Default for AutosaveDebouncerConfig {
    fn default() -> Self {
        Self {
            debounce_ms: 2_000,
            max_interval_ms: 10_000,
            check_interval_ms: 500,
        }
    }
}

pub(crate) type AutosaveShutdownRequest = oneshot::Sender<bool>;

/// Spawn a debounced autosave task that writes the `.ipynb` file to disk
/// whenever serialized notebook content changes. Only for saved (non-untitled)
/// notebooks. Does NOT format cells — formatting is reserved for explicit saves.
///
/// NotebookDoc edits arrive on `changed_tx`; runtime changes that can affect
/// `.ipynb` bytes, such as outputs and execution counts, arrive on
/// `file_dirty_tx`. Generic RuntimeStateDoc broadcasts are intentionally not
/// autosave triggers because they also carry session/UI fields like
/// `last_saved`, lifecycle, path, and project context.
pub(crate) fn spawn_autosave_debouncer(
    notebook_id: String,
    room: Arc<NotebookRoom>,
) -> mpsc::UnboundedSender<AutosaveShutdownRequest> {
    spawn_autosave_debouncer_with_config(notebook_id, room, AutosaveDebouncerConfig::default())
}

/// Request one final autosave and stop the `.ipynb` autosave task.
///
/// The task owns a room `Arc`, so room eviction cannot rely on broadcast
/// channels closing to signal shutdown. This helper consumes the stored
/// lifecycle channel and waits for an explicit save acknowledgement.
pub(crate) async fn shutdown_autosave_debouncer(
    room: &NotebookRoom,
    notebook_id: &str,
    timeout: std::time::Duration,
) -> bool {
    room.file_binding
        .shutdown_autosave(notebook_id, timeout)
        .await
}

/// Spawn autosave debouncer with custom timing configuration (for testing).
fn spawn_autosave_debouncer_with_config(
    notebook_id: String,
    room: Arc<NotebookRoom>,
    config: AutosaveDebouncerConfig,
) -> mpsc::UnboundedSender<AutosaveShutdownRequest> {
    let mut changed_rx = room.broadcasts.changed_tx.subscribe();
    let mut file_dirty_rx = room.broadcasts.file_dirty_tx.subscribe();
    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<AutosaveShutdownRequest>();
    spawn_supervised(
        "autosave-debouncer",
        async move {
            use std::time::Duration;
            use tokio::time::{interval, Instant, MissedTickBehavior};

            let debounce_duration = Duration::from_millis(config.debounce_ms);
            let max_flush_interval = Duration::from_millis(config.max_interval_ms);

            let mut last_receive: Option<Instant> = None;
            let mut last_flush: Option<Instant> = None;

            let mut check_interval = interval(Duration::from_millis(config.check_interval_ms));
            check_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    result = changed_rx.recv() => {
                        match result {
                            Ok(()) => {
                                last_receive = Some(Instant::now());
                            }
                            Err(broadcast::error::RecvError::Closed) => {
                                break;
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                // Missed some updates, treat as a change
                                debug!("[autosave] Lagged {} messages", n);
                                last_receive = Some(Instant::now());
                            }
                        }
                    }
                    file_dirty_result = file_dirty_rx.recv() => {
                        match file_dirty_result {
                            Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                                last_receive = Some(Instant::now());
                            }
                            Err(broadcast::error::RecvError::Closed) => {
                                // Room teardown is already represented by
                                // changed_rx closing. Stop watching this
                                // auxiliary signal if it disappears first.
                                let (_tx, rx) = broadcast::channel(1);
                                file_dirty_rx = rx;
                            }
                        }
                    }
                    Some(ack_tx) = shutdown_rx.recv() => {
                        let ok = if room.is_loading() {
                            warn!(
                                "[autosave] Final save on shutdown skipped while {} is loading",
                                notebook_id
                            );
                            false
                        } else if !is_untitled_notebook(&notebook_id) {
                            match save_notebook_to_disk(&room, None).await {
                                Ok(path) => {
                                    info!("[autosave] Final save on shutdown: {}", path);
                                    let now = chrono::Utc::now().to_rfc3339();
                                    if let Err(e) = room.state.with_doc(|sd| {
                                        sd.set_last_saved(Some(&now))
                                    }) {
                                        warn!(
                                            "[autosave] set_last_saved failed during shutdown: {}",
                                            e
                                        );
                                    }
                                    true
                                }
                                Err(e) => {
                                    warn!("[autosave] Final save on shutdown failed: {}", e);
                                    false
                                }
                            }
                        } else {
                            true
                        };
                        let _ = ack_tx.send(ok);
                        break;
                    }
                    _ = check_interval.tick() => {
                        let should_flush = if let Some(recv) = last_receive {
                            let debounce_ready = recv.elapsed() >= debounce_duration;
                            let max_interval_ready = last_flush
                                .map(|f| f.elapsed() >= max_flush_interval)
                                .unwrap_or(recv.elapsed() >= max_flush_interval);
                            debounce_ready || max_interval_ready
                        } else {
                            false
                        };

                        if should_flush {
                            // Skip during initial load. Also clear last_receive
                            // so load-time change notifications don't trigger a
                            // save the moment loading completes.
                            if room.is_loading() {
                                last_receive = None;
                                continue;
                            }

                            match save_notebook_to_disk(&room, None).await {
                                Ok(path) => {
                                    debug!("[autosave] Saved {}", path);
                                    last_flush = Some(Instant::now());

                                    // Check if changes arrived during the save. If so,
                                    // keep last_receive set so we flush again soon —
                                    // don't stamp last_saved while the file is stale.
                                    let changed_during_save =
                                        matches!(changed_rx.try_recv(), Ok(()) | Err(broadcast::error::TryRecvError::Lagged(_)));
                                    let file_dirty_during_save =
                                        matches!(file_dirty_rx.try_recv(), Ok(()) | Err(broadcast::error::TryRecvError::Lagged(_)));
                                    if changed_during_save || file_dirty_during_save {
                                        last_receive = Some(Instant::now());
                                    } else {
                                        last_receive = None;
                                        // Stamp last_saved on the runtime-state doc.
                                        // Frontends compute dirty = local_edit_at > last_saved.
                                        let now = chrono::Utc::now().to_rfc3339();
                                        if let Err(e) = room.state.with_doc(|sd| {
                                            sd.set_last_saved(Some(&now))
                                        }) {
                                            warn!("[autosave] set_last_saved failed: {}", e);
                                        }
                                    }
                                }
                                Err(ref e @ SaveError::Unrecoverable(_)) => {
                                    error!(
                                        "[autosave] Unrecoverable save error, disabling autosave for {}: {}",
                                        notebook_id, e
                                    );
                                    break;
                                }
                                Err(e) => {
                                    warn!("[autosave] Failed to save: {}", e);
                                    // Keep last_receive set so we retry on next interval
                                    last_flush = Some(Instant::now());
                                }
                            }
                        }
                    }
                }
            }
        },
        |_| {
            trigger_global_shutdown();
        },
    );
    shutdown_tx
}

/// Actually persist bytes to disk, logging if it takes too long.
/// Returns `true` on success, `false` on I/O error.
fn do_persist(data: &[u8], path: &Path) -> bool {
    let start = std::time::Instant::now();
    let ok = persist_notebook_bytes(data, path);
    let elapsed = start.elapsed();
    if elapsed > std::time::Duration::from_millis(500) {
        warn!(
            "[persist-debouncer] Slow write: {:?} took {:?}",
            path, elapsed
        );
    }
    ok
}

/// Persist pre-serialized notebook bytes to disk.
///
/// Returns `true` on success, `false` on I/O error. Callers that need to
/// know whether the bytes actually hit disk (e.g. eviction's flush-and-ack
/// path) must check the return value; earlier call sites that only care
/// about best-effort debounced writes can ignore it.
pub(crate) fn persist_notebook_bytes(data: &[u8], path: &Path) -> bool {
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            warn!(
                "[notebook-sync] Failed to create parent dir for {:?}: {}",
                path, e
            );
            return false;
        }
    }
    if let Err(e) = std::fs::write(path, data) {
        warn!("[notebook-sync] Failed to save notebook doc: {}", e);
        return false;
    }
    true
}

// =============================================================================
// Notebook File Watching
// =============================================================================
//
// Watch .ipynb files for external changes (git, VS Code, other editors).
// When changes are detected, merge them into the Automerge doc and broadcast.

/// Time window (ms) to skip file change events after our own writes.
pub(crate) const SELF_WRITE_SKIP_WINDOW_MS: u64 = 600;

pub(crate) fn spawn_notebook_file_watcher(
    notebook_path: PathBuf,
    room: Arc<NotebookRoom>,
) -> oneshot::Sender<()> {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

    spawn_best_effort("notebook-file-watcher", async move {
        // Determine what path to watch
        let watch_path = if notebook_path.exists() {
            notebook_path.clone()
        } else if let Some(parent) = notebook_path.parent() {
            // Watch parent directory if file doesn't exist yet
            if !parent.exists() {
                warn!(
                    "[notebook-watch] Parent dir doesn't exist for {:?}",
                    notebook_path
                );
                return;
            }
            parent.to_path_buf()
        } else {
            warn!(
                "[notebook-watch] Cannot determine watch path for {:?}",
                notebook_path
            );
            return;
        };

        // Create tokio mpsc channel to bridge from notify callback thread
        let (tx, mut rx) = tokio::sync::mpsc::channel::<DebounceEventResult>(16);

        // Create debouncer with 500ms window (same as settings.json)
        let debouncer_result = notify_debouncer_mini::new_debouncer(
            std::time::Duration::from_millis(500),
            move |res: DebounceEventResult| {
                let _ = tx.blocking_send(res);
            },
        );

        let mut debouncer = match debouncer_result {
            Ok(d) => d,
            Err(e) => {
                error!(
                    "[notebook-watch] Failed to create file watcher for {:?}: {}",
                    notebook_path, e
                );
                return;
            }
        };

        if let Err(e) = debouncer
            .watcher()
            .watch(&watch_path, notify::RecursiveMode::NonRecursive)
        {
            error!("[notebook-watch] Failed to watch {:?}: {}", watch_path, e);
            return;
        }

        info!(
            "[notebook-watch] Watching {:?} for external changes",
            notebook_path
        );

        loop {
            tokio::select! {
                Some(result) = rx.recv() => {
                    match result {
                        Ok(events) => {
                            // Check if any event is for our notebook file
                            let relevant = events.iter().any(|e| e.path == notebook_path);
                            if !relevant {
                                continue;
                            }

                            // Check if this is a self-write (within skip window of our last save).
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            let last_write = room.persistence.last_self_write.load(Ordering::Relaxed);
                            if now.saturating_sub(last_write) < SELF_WRITE_SKIP_WINDOW_MS {
                                debug!(
                                    "[notebook-watch] Skipping self-write event for {:?}",
                                    notebook_path
                                );
                                continue;
                            }

                            // Read and parse the file
                            let contents = match tokio::fs::read_to_string(&notebook_path).await {
                                Ok(c) => c,
                                Err(e) => {
                                    // File may be deleted or being written
                                    debug!(
                                        "[notebook-watch] Cannot read {:?}: {}",
                                        notebook_path, e
                                    );
                                    continue;
                                }
                            };

                            let json: serde_json::Value = match serde_json::from_str(&contents) {
                                Ok(j) => j,
                                Err(e) => {
                                    // Partial write or invalid JSON - try again next event
                                    debug!(
                                        "[notebook-watch] Cannot parse {:?}: {}",
                                        notebook_path, e
                                    );
                                    continue;
                                }
                            };

                            // Parse cells from the .ipynb
                            // None = parse failure (missing cells key), Some([]) = valid empty notebook
                            let ParsedIpynbCells {
                                cells: external_cells,
                                outputs_by_cell: external_outputs,
                                attachments: external_attachments,
                            } = match parse_cells_from_ipynb(&json) {
                                Some(parsed) => parsed,
                                None => {
                                    warn!(
                                        "[notebook-watch] Cannot parse cells from {:?} - skipping",
                                        notebook_path
                                    );
                                    continue;
                                }
                            };
                            let external_metadata = parse_metadata_from_ipynb(&json);

                            // Check if kernel is running (to preserve outputs)
                            let has_kernel = room.has_kernel().await;

                            // Apply cell changes to Automerge doc
                            let cells_changed = apply_ipynb_changes(
                                &room,
                                &external_cells,
                                &external_outputs,
                                &external_attachments,
                                has_kernel,
                            )
                            .await;

                            // The file watcher is a recovery path that does not go
                            // through `try_start_loading`. Clear the failed-load
                            // hazard once the watcher has actually reconciled the
                            // file into the doc — i.e. the doc now matches the
                            // parsed file's cell count. This clears on a valid
                            // reload whether the file is empty (`cells: []`) or
                            // populated, but NOT when apply failed (e.g. on bad
                            // attachments) and left the doc out of sync, which
                            // keeps the on-disk file protected.
                            if room.doc.read().await.cell_count() == external_cells.len() {
                                room.clear_load_failed();
                            }

                            // Apply metadata changes to Automerge doc.
                            // Only update when the external file has a metadata
                            // object — a missing key means "no metadata info",
                            // not "clear metadata".
                            let metadata_changed = if let Some(ref meta) = external_metadata {
                                let current = {
                                    let doc = room.doc.read().await;
                                    doc.get_metadata_snapshot()
                                };
                                let changed = Some(meta) != current.as_ref();
                                if changed {
                                    let mut doc = room.doc.write().await;
                                    if let Err(e) = doc.set_metadata_snapshot(meta) {
                                        warn!("[notebook-watch] Failed to set metadata: {}", e);
                                    }
                                }
                                changed
                            } else {
                                false
                            };

                            if cells_changed || metadata_changed {
                                info!(
                                    "[notebook-watch] Applied external changes from {:?} (cells={}, metadata={})",
                                    notebook_path, cells_changed, metadata_changed,
                                );

                                // Notify peers of the change — actual data
                                // arrives via Automerge sync frames
                                let _ = room.broadcasts.changed_tx.send(());
                            }

                            // Re-verify trust after external metadata edits.
                            // External edits via uv/editor (e.g. `uv add numpy`
                            // + save) rewrite metadata.runt.*.dependencies,
                            // and the cached trust state was computed against
                            // the old dep list. Trust lives in metadata, so
                            // gate on metadata_changed — cell-only edits
                            // can't affect dependency names.
                            // check_and_update_trust_state only writes when
                            // the status actually flipped and emits
                            // state_changed_tx so the frontend banner reacts.
                            if metadata_changed {
                                check_and_update_trust_state(&room).await;
                            }
                        }
                        Err(errs) => {
                            warn!("[notebook-watch] Watch error for {:?}: {:?}", notebook_path, errs);
                        }
                    }
                }
                _ = &mut shutdown_rx => {
                    info!("[notebook-watch] Shutting down watcher for {:?}", notebook_path);
                    break;
                }
            }
        }
    });

    shutdown_tx
}
