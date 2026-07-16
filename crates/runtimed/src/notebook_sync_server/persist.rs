use super::*;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

pub(crate) const JUPYTER_WIDGET_TARGET: &str = "jupyter.widget";
pub(crate) const WIDGET_STATE_MIME: &str = "application/vnd.jupyter.widget-state+json";
const WIDGET_STATE_VERSION_MAJOR: i64 = 2;
const WIDGET_STATE_VERSION_MINOR: i64 = 0;
const AUTOSAVE_OWNER_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub(crate) enum SaveError {
    /// Transient / potentially recoverable (e.g. disk full, busy)
    Retryable(String),
    /// Permanent — retrying will never help (path is a directory, permission denied, invalid path)
    Unrecoverable(String),
    /// The checkpoint coordinator rejected completion without advancing file
    /// or runtime-state save metadata.
    CheckpointBlocked {
        save_sequence: Option<u64>,
        reason: notebook_protocol::protocol::SaveBlockedReason,
    },
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Retryable(msg) | SaveError::Unrecoverable(msg) => f.write_str(msg),
            SaveError::CheckpointBlocked { reason, .. } => write!(f, "{reason:?}"),
        }
    }
}

/// A successful causal save request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FileSaveOutcome {
    /// Atomic replacement completed and advanced the file checkpoint.
    Saved {
        path: String,
        exported_heads: Vec<String>,
        save_sequence: u64,
    },
    /// The same path, heads, and serialized bytes were already checkpointed.
    AlreadyCurrent {
        path: String,
        exported_heads: Vec<String>,
        save_sequence: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileSaveIntent {
    Ordinary,
    /// The owner explicitly chose recovered Automerge state over the bound
    /// source. This is the only path allowed to bypass degraded-source and
    /// external-disk staleness guards for an in-place replacement. The
    /// generation is committed in the same journal record as the checkpoint.
    Reconcile {
        source_generation: u64,
        expected_source_fingerprint: Option<super::recovery::SourceFingerprint>,
    },
}

fn commit_file_checkpoint_for_intent(
    durability: &super::durability::RoomDurability,
    lifecycle: &super::lifecycle::RoomLifecycle,
    runtime_state: &runtime_doc::RuntimeStateHandle,
    checkpoint: &super::file_checkpoint::FileCheckpoint,
    intent: FileSaveIntent,
) -> Result<(), String> {
    let commit = match intent {
        FileSaveIntent::Ordinary => durability.commit_file_checkpoint(
            checkpoint.path.clone(),
            checkpoint.file_fingerprint,
            checkpoint.exported_heads.clone(),
            checkpoint.save_sequence,
        ),
        FileSaveIntent::Reconcile {
            source_generation, ..
        } => durability.commit_reconciled_file_checkpoint(
            checkpoint.path.clone(),
            checkpoint.file_fingerprint,
            checkpoint.exported_heads.clone(),
            checkpoint.save_sequence,
            source_generation,
        ),
    };

    commit.map(|_| ()).map_err(|error| {
        let reason =
            format!("file replacement completed but recovery journal checkpoint failed: {error}");
        degrade_file_checkpoint(
            durability,
            lifecycle,
            runtime_state,
            &checkpoint.exported_heads,
            reason,
        )
    })
}

fn prepare_file_checkpoint_for_intent(
    durability: &super::durability::RoomDurability,
    lifecycle: &super::lifecycle::RoomLifecycle,
    runtime_state: &runtime_doc::RuntimeStateHandle,
    preparation: &super::file_checkpoint::FileCheckpointPreparation,
    intent: FileSaveIntent,
) -> Result<(), String> {
    let source_generation = match intent {
        FileSaveIntent::Ordinary => None,
        FileSaveIntent::Reconcile {
            source_generation, ..
        } => Some(source_generation),
    };
    durability
        .prepare_file_checkpoint(
            preparation.path.clone(),
            preparation.file_fingerprint,
            preparation.exported_heads.clone(),
            preparation.save_sequence,
            source_generation,
        )
        .map(|_| ())
        .map_err(|error| {
            degrade_file_checkpoint(
                durability,
                lifecycle,
                runtime_state,
                &preparation.exported_heads,
                format!("recovery journal checkpoint intent failed before replacement: {error}"),
            )
        })
}

fn abort_file_checkpoint_intent(
    durability: &super::durability::RoomDurability,
    lifecycle: &super::lifecycle::RoomLifecycle,
    runtime_state: &runtime_doc::RuntimeStateHandle,
    preparation: &super::file_checkpoint::FileCheckpointPreparation,
) -> Result<(), String> {
    durability
        .abort_file_checkpoint(preparation.save_sequence)
        .map(|_| ())
        .map_err(|error| {
            degrade_file_checkpoint(
                durability,
                lifecycle,
                runtime_state,
                &preparation.exported_heads,
                format!("recovery journal checkpoint intent abort failed: {error}"),
            )
        })
}

fn degrade_file_checkpoint(
    durability: &super::durability::RoomDurability,
    lifecycle: &super::lifecycle::RoomLifecycle,
    runtime_state: &runtime_doc::RuntimeStateHandle,
    exported_heads: &[[u8; 32]],
    reason: String,
) -> String {
    durability.mark_degraded(
        super::durability::DegradationKind::DurabilityBoundary,
        reason.clone(),
    );
    lifecycle.mark_degraded(reason.clone(), checkpoint_heads_hex(exported_heads), true);
    let _ = runtime_state.with_doc(|state| {
        state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
            reason: reason.clone(),
        }))
    });
    reason
}

impl FileSaveOutcome {
    pub(crate) fn path(&self) -> &str {
        match self {
            Self::Saved { path, .. } | Self::AlreadyCurrent { path, .. } => path,
        }
    }
}

impl std::fmt::Display for FileSaveOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.path())
    }
}

impl AsRef<Path> for FileSaveOutcome {
    fn as_ref(&self) -> &Path {
        Path::new(self.path())
    }
}

/// Claim save order immediately, before asynchronous formatting or
/// serialization, then save the exact heads observed by this request.
pub(crate) async fn save_notebook_to_disk(
    room: &NotebookRoom,
    target_path: Option<&str>,
) -> Result<FileSaveOutcome, SaveError> {
    let claim =
        room.persistence
            .claim_file_checkpoint()
            .map_err(|_| SaveError::CheckpointBlocked {
                save_sequence: None,
                reason: notebook_protocol::protocol::SaveBlockedReason::SequenceExhausted,
            })?;
    save_notebook_to_disk_with_claim_and_intent(room, target_path, claim, FileSaveIntent::Ordinary)
        .await
}

pub(crate) async fn save_notebook_to_disk_with_claim_and_intent(
    room: &NotebookRoom,
    target_path: Option<&str>,
    save_claim: super::file_checkpoint::SaveSequenceClaim,
    intent: FileSaveIntent,
) -> Result<FileSaveOutcome, SaveError> {
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

    // Whether this save targets the room's bound path. Baseline bookkeeping
    // (last_save_sources, the disk-hash staleness guard) applies only to the
    // primary path — saving to an alternate path (Save As) must not corrupt
    // the baselines for the file watcher. A targeted save on a room with no
    // bound path is the binding save (untitled promotion): there is no other
    // primary to corrupt, and the file watcher armed right after promotion
    // needs this write recorded as the disk baseline, or its first event
    // treats our own bytes as an external edit.
    let is_primary_path = target_path.is_none()
        || room
            .file_binding
            .path_matches(notebook_path.as_path())
            .await
        || room.file_binding.path().await.is_none();

    // A degraded room preserves recovered Automerge truth and its divergent
    // source file until the caller chooses an explicit reconciliation path.
    // In-place save/autosave must not silently turn that state into a winner.
    // Save As to a genuinely different path remains the safe
    // "save recovered elsewhere" operation and does not clear the conflict.
    if is_primary_path && matches!(intent, FileSaveIntent::Ordinary) {
        if let RoomAvailability::Degraded(availability) = room.lifecycle.availability() {
            let source = room.lifecycle.source_state();
            let message = availability.reason.unwrap_or_else(|| {
                "room source is degraded; explicit reconciliation is required".to_string()
            });
            let reason = match source
                .status()
                .error
                .as_ref()
                .map(|error| error.code.as_str())
            {
                Some("source_conflict") => {
                    notebook_protocol::protocol::SaveBlockedReason::SourceConflict { message }
                }
                _ => notebook_protocol::protocol::SaveBlockedReason::SourceDegraded { message },
            };
            return Err(SaveError::CheckpointBlocked {
                save_sequence: Some(save_claim.sequence()),
                reason,
            });
        }
    }

    // Read existing .ipynb as raw bytes. Used for three things: the staleness
    // guard below, the content-hash guard further down (skip no-op writes),
    // and the `nbformat_minor` floor (not carried in the doc today).
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

    // Staleness guard: refuse to overwrite a file that changed since this
    // daemon last read or wrote it. Another writer (a second daemon on the
    // same path, `git pull`, an external editor) owns the bytes on disk and
    // the file watcher has not reconciled them into the doc yet — writing now
    // would silently discard that writer's content (#2285). `Retryable` keeps
    // the autosave debouncer armed: the watcher merges the external content
    // and refreshes the baseline, and the next tick saves the merged state.
    // A missing file with a recorded baseline falls through and is recreated
    // (deletion is not a merge conflict). The read above and the write below
    // are not atomic, so a writer landing inside this call can still race us;
    // this guard shrinks the window from "since our last save" to one call.
    if is_primary_path && matches!(intent, FileSaveIntent::Ordinary) {
        if let Some(ref raw) = existing_raw {
            if room.persistence.disk_content_diverged(raw) {
                warn!(
                    "[notebook-sync] Refusing to save {:?}: on-disk content changed \
                     since this daemon last read it (external writer?). Will retry \
                     after the file watcher reconciles.",
                    notebook_path
                );
                return Err(SaveError::Retryable(format!(
                    "on-disk content of '{}' changed externally; deferring save",
                    notebook_path.display()
                )));
            }
        }
    }

    if is_primary_path {
        if let Some(parent) = notebook_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                SaveError::Unrecoverable(format!(
                    "Failed to create directory '{}': {e}",
                    parent.display()
                ))
            })?;
        }
        claim_autosave_owner(&notebook_path).await?;
    }

    // Read cells, metadata, and per-cell execution_ids from the doc.
    let (cells, metadata_snapshot, cell_execution_ids, exported_heads) = {
        let mut doc = room.doc.write().await;
        let cells = doc.get_cells();
        let metadata_snapshot = doc.get_metadata_snapshot();
        // Collect execution_id for each cell (for output lookup in state doc)
        let eids: HashMap<String, Option<String>> = cells
            .iter()
            .map(|c| (c.id.clone(), doc.get_execution_id(&c.id)))
            .collect();
        let heads = doc.get_heads();
        (cells, metadata_snapshot, eids, heads)
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
    let mut comms = room.state.read(|sd| sd.get_comms()).unwrap_or_default();
    let comm_states = room.comms.read(|cd| cd.get_comms()).unwrap_or_default();
    for (comm_id, comm_state) in comm_states {
        if let Some(entry) = comms.get_mut(&comm_id) {
            entry.state = comm_state;
        }
    }
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

    // Failed-source guard (in-place saves). Initial materialization publishes
    // batches progressively and deliberately does not erase them on failure:
    // another room source may already have authored concurrent document truth.
    // That partial room must not overwrite its source `.ipynb`. Reject the
    // write whenever initial load failed and a non-empty file exists on disk;
    // a retryable error keeps autosave armed without claiming a save occurred.
    //
    // "In-place" = the save targets the room's current bound path. Desktop
    // autosave/teardown/Save pass `target_path = None`; MCP/Node/Python
    // `save(path)` pass `Some(current_path)`. BOTH are in-place and must be
    // protected — keying on `None` alone would let a same-path `Some` save zero
    // the file. Only a genuine Save As to a DIFFERENT path bypasses the guard
    // (the user is deliberately writing elsewhere). A failed-load room's
    // in-place save reports an error and never emits `NotebookSaved`. A
    // genuinely empty doc over an empty/absent file still round-trips, and a
    // brand-new untitled notebook has no existing file to protect.
    //
    // `room.load_failed()` separates failed source materialization from a
    // legitimately partial or empty notebook. It is cleared only when a source
    // generation completes successfully, the watcher reconciles the file, or
    // an explicit save establishes a new baseline.
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
            // Recognize an in-place save even when the caller spells the bound
            // path differently (symlink, `..`, etc.): compare canonical forms,
            // falling back to raw equality when canonicalization fails (e.g. a
            // genuine Save As to a not-yet-existing path — correctly NOT in-place,
            // since it does not target the bound file).
            match room.file_binding.path().await {
                Some(bound) => match (
                    tokio::fs::canonicalize(notebook_path.as_path()).await,
                    tokio::fs::canonicalize(&bound).await,
                ) {
                    (Ok(a), Ok(b)) => a == b,
                    _ => bound == notebook_path,
                },
                None => false,
            }
        }
    };
    if is_in_place_save && room.load_failed() && matches!(intent, FileSaveIntent::Ordinary) {
        let disk_has_content = existing_raw
            .as_ref()
            .is_some_and(|bytes| bytes.iter().any(|b| !b.is_ascii_whitespace()));
        if disk_has_content {
            warn!(
                "[notebook-sync] Skipping save of partially loaded doc over existing on-disk content for \
                 {:?} (initial materialization failed); preserving file. Save As to a new path \
                 still writes.",
                notebook_path
            );
            return Err(SaveError::Retryable(format!(
                "Cannot save {} in place because its initial file load failed; the existing file was preserved. Retry after the file is reconciled, or save to a different path.",
                notebook_path.display()
            )));
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

    let content_bytes = content_with_newline.into_bytes();
    let checkpoint_heads: Vec<[u8; 32]> = exported_heads.iter().map(|head| head.0).collect();
    let mut checkpoint_target = super::file_checkpoint::FileCheckpointTarget::for_content(
        notebook_path.clone(),
        checkpoint_heads,
        &content_bytes,
    );
    if is_in_place_save {
        if let FileSaveIntent::Reconcile {
            expected_source_fingerprint: Some(expected),
            ..
        } = intent
        {
            checkpoint_target = checkpoint_target.requiring_existing_fingerprint(expected);
        }
    }
    let checkpoint_coordinator = room.persistence.file_checkpoint_coordinator();
    let durability = Arc::clone(&room.durability);
    let prepare_durability = Arc::clone(&durability);
    let abort_durability = Arc::clone(&durability);
    let lifecycle = Arc::clone(&room.lifecycle);
    let prepare_lifecycle = Arc::clone(&lifecycle);
    let abort_lifecycle = Arc::clone(&lifecycle);
    let runtime_state = room.state.clone();
    let prepare_runtime_state = runtime_state.clone();
    let abort_runtime_state = runtime_state.clone();
    let (checkpoint_outcome, content_bytes) = tokio::task::spawn_blocking(move || {
        let outcome = checkpoint_coordinator.complete_reserved_with_durable_intent(
            save_claim,
            checkpoint_target,
            &content_bytes,
            |preparation| {
                prepare_file_checkpoint_for_intent(
                    &prepare_durability,
                    &prepare_lifecycle,
                    &prepare_runtime_state,
                    preparation,
                    intent,
                )
            },
            |preparation| {
                abort_file_checkpoint_intent(
                    &abort_durability,
                    &abort_lifecycle,
                    &abort_runtime_state,
                    preparation,
                )
            },
            |checkpoint| {
                commit_file_checkpoint_for_intent(
                    &durability,
                    &lifecycle,
                    &runtime_state,
                    checkpoint,
                    intent,
                )
            },
        );
        (outcome, content_bytes)
    })
    .await
    .map_err(|error| {
        SaveError::Retryable(format!(
            "file checkpoint worker failed before completion: {error}"
        ))
    })?;

    let checkpoint = match checkpoint_outcome {
        super::file_checkpoint::SaveOutcome::Saved { checkpoint } => checkpoint,
        super::file_checkpoint::SaveOutcome::AlreadyCurrent { checkpoint, .. } => {
            // The coordinator skips its commit callback for an already-current
            // file. Reconciliation still has new durable meaning: commit the
            // selected source generation before restoring capabilities.
            if matches!(intent, FileSaveIntent::Reconcile { .. }) {
                commit_file_checkpoint_for_intent(
                    &room.durability,
                    &room.lifecycle,
                    &room.state,
                    &checkpoint,
                    intent,
                )
                .map_err(SaveError::Retryable)?;
            }
            let exported_heads = checkpoint_heads_hex(&checkpoint.exported_heads);
            debug!(
                "[notebook-sync] File checkpoint already current for {:?} at sequence {}",
                notebook_path, checkpoint.save_sequence
            );
            return Ok(FileSaveOutcome::AlreadyCurrent {
                path: notebook_path.to_string_lossy().to_string(),
                exported_heads,
                save_sequence: checkpoint.save_sequence,
            });
        }
        super::file_checkpoint::SaveOutcome::Blocked {
            save_sequence,
            reason,
        } => {
            return Err(SaveError::CheckpointBlocked {
                save_sequence,
                reason: checkpoint_blocked_reason(reason),
            });
        }
    };

    // A successful write makes disk match the room, so any failed-load hazard is
    // resolved — clear the flag so later legitimate empty saves are not blocked.
    // (A still-failed empty room over existing content is skipped by the guard
    // above and never reaches here, so this only clears genuine recoveries:
    // Save As, or adding a cell to a failed-load room and saving.)
    let source_conflict = room
        .lifecycle
        .source_state()
        .status()
        .error
        .as_ref()
        .is_some_and(|error| error.code == "source_conflict");
    // Explicit reconciliation owns a later, generation-bearing lifecycle
    // transition. Do not let this lower-level save helper re-enable mutation
    // capabilities between the file/journal commit and that final transition.
    if matches!(intent, FileSaveIntent::Ordinary) && !source_conflict {
        if let Err(error) = room.mark_load_recovered(cell_count).await {
            let reason = format!(
                "file checkpoint committed, but its recovered projection could not be retained: {error:#}"
            );
            room.durability.mark_degraded(
                super::durability::DegradationKind::SourceState,
                reason.clone(),
            );
            room.lifecycle.mark_degraded(
                reason.clone(),
                checkpoint_heads_hex(&checkpoint.exported_heads),
                true,
            );
            let _ = room.state.with_doc(|state| {
                state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                    reason: reason.clone(),
                }))
            });
        }
    }

    // Snapshot cell sources at save time so the file watcher can distinguish
    // our own writes from genuine external changes. Only update when saving
    // to the primary path - saving to an alternate path (Save As) must not
    // corrupt the baseline for the file watcher.
    if is_primary_path {
        let mut saved = HashMap::with_capacity(cells.len());
        for cell in &cells {
            saved.insert(cell.id.clone(), cell.source.clone());
        }
        if !room
            .persistence
            .note_primary_save_baseline(checkpoint.save_sequence, saved, &content_bytes)
            .await
        {
            debug!(
                "[notebook-sync] Skipping stale primary-path baseline for checkpoint {}",
                checkpoint.save_sequence
            );
        }
    }

    let exported_heads = checkpoint_heads_hex(&checkpoint.exported_heads);
    let saved_at = chrono::DateTime::<chrono::Utc>::from(checkpoint.saved_at).to_rfc3339();
    if let Err(error) = room.state.with_doc(|state_doc| {
        if state_doc.set_file_checkpoint(&exported_heads, checkpoint.save_sequence)? {
            state_doc.set_last_saved(Some(&saved_at))?;
        }
        Ok(())
    }) {
        warn!(
            "[notebook-sync] File checkpoint committed for {:?}, but runtime-state projection failed: {}",
            notebook_path, error
        );
    }

    info!(
        "[notebook-sync] Saved notebook to disk: {:?} ({} cells, checkpoint {})",
        notebook_path, cell_count, checkpoint.save_sequence
    );

    Ok(FileSaveOutcome::Saved {
        path: notebook_path.to_string_lossy().to_string(),
        exported_heads,
        save_sequence: checkpoint.save_sequence,
    })
}

/// Rebuild the exact primary-path watcher baseline from a committed file
/// checkpoint before a new watcher is installed for promotion or Save As.
///
/// A later checkpoint or an external edit may land while the async save
/// continuation is resuming. In either case the manifest/fingerprint check
/// refuses to relabel those bytes as this save's baseline.
pub(crate) async fn refresh_primary_baseline_from_checkpoint(
    room: &NotebookRoom,
    path: &Path,
    save_sequence: u64,
) -> bool {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!(
                "[notebook-sync] Could not refresh file watcher baseline from {}: {}",
                path.display(),
                error
            );
            return false;
        }
    };
    let manifest = room.durability.manifest();
    if manifest.file_save_sequence != Some(save_sequence)
        || manifest.source_fingerprint != super::recovery::source_fingerprint(&bytes)
        || manifest.canonical_path.as_deref() != Some(path)
    {
        debug!(
            "[notebook-sync] Skipping stale or externally changed watcher baseline for checkpoint {}",
            save_sequence
        );
        return false;
    }
    let parsed = match parse_notebook_jiter_for_notebook(&bytes, room.id) {
        Ok(parsed) => parsed,
        Err(error) => {
            warn!(
                "[notebook-sync] Committed checkpoint {} could not rebuild its watcher baseline: {}",
                save_sequence, error
            );
            return false;
        }
    };
    let sources = parsed
        .cells
        .into_iter()
        .map(|cell| (cell.id, cell.source))
        .collect();
    room.persistence
        .note_primary_save_baseline(save_sequence, sources, &bytes)
        .await
}

fn checkpoint_heads_hex(heads: &[[u8; 32]]) -> Vec<String> {
    heads
        .iter()
        .map(|head| automerge::ChangeHash(*head).to_string())
        .collect()
}

fn checkpoint_blocked_reason(
    reason: super::file_checkpoint::SaveBlockedReason,
) -> notebook_protocol::protocol::SaveBlockedReason {
    use super::file_checkpoint::SaveBlockedReason as CheckpointReason;
    use notebook_protocol::protocol::SaveBlockedReason as ProtocolReason;

    match reason {
        CheckpointReason::SequenceExhausted => ProtocolReason::SequenceExhausted,
        CheckpointReason::Superseded { latest_sequence } => {
            ProtocolReason::Superseded { latest_sequence }
        }
        CheckpointReason::ContentFingerprintMismatch { declared, actual } => ProtocolReason::Io {
            message: format!(
                "checkpoint content fingerprint mismatch (declared {}, actual {})",
                declared.to_hex(),
                actual.to_hex()
            ),
        },
        CheckpointReason::ExistingContentChanged { expected, actual } => {
            ProtocolReason::SourceConflict {
                message: format!(
                    "source changed during reconciliation (expected {}, observed {}); retry against the new disk revision",
                    expected.to_hex(),
                    actual
                        .map(super::recovery::SourceFingerprint::to_hex)
                        .unwrap_or_else(|| "missing".to_string())
                ),
            }
        }
        CheckpointReason::Io { stage, message } => ProtocolReason::Io {
            message: format!("checkpoint {stage:?} failed: {message}"),
        },
        CheckpointReason::Commit { message } => ProtocolReason::SourceDegraded { message },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AutosaveOwnerMarker {
    pub(crate) schema_version: u32,
    pub(crate) daemon_id: String,
    pub(crate) pid: u32,
    pub(crate) notebook_path: PathBuf,
    pub(crate) claimed_at_unix_ms: u64,
}

impl AutosaveOwnerMarker {
    fn current(notebook_path: &Path) -> Self {
        Self {
            schema_version: AUTOSAVE_OWNER_SCHEMA_VERSION,
            daemon_id: current_autosave_owner_id().to_string(),
            pid: std::process::id(),
            notebook_path: notebook_path.to_path_buf(),
            claimed_at_unix_ms: unix_now_ms(),
        }
    }

    fn is_current_daemon(&self) -> bool {
        self.pid == std::process::id() && self.daemon_id == current_autosave_owner_id()
    }
}

fn current_autosave_owner_id() -> &'static str {
    static OWNER_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    OWNER_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn autosave_owner_marker_path(notebook_path: &Path) -> PathBuf {
    let file_name = notebook_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "notebook.ipynb".to_string());
    notebook_path.with_file_name(format!("{file_name}.runtlock"))
}

async fn claim_autosave_owner(notebook_path: &Path) -> Result<(), SaveError> {
    let marker_path = autosave_owner_marker_path(notebook_path);
    loop {
        let marker = AutosaveOwnerMarker::current(notebook_path);
        let marker_bytes = serde_json::to_vec_pretty(&marker).map_err(|e| {
            SaveError::Retryable(format!("failed to serialize autosave owner: {e}"))
        })?;

        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)
            .await
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(&marker_bytes).await {
                    let _ = tokio::fs::remove_file(&marker_path).await;
                    return Err(save_error_for_owner_io(
                        "write autosave owner marker",
                        &marker_path,
                        e,
                    ));
                }
                if let Err(e) = file.write_all(b"\n").await {
                    let _ = tokio::fs::remove_file(&marker_path).await;
                    return Err(save_error_for_owner_io(
                        "write autosave owner marker",
                        &marker_path,
                        e,
                    ));
                }
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => {
                return Err(save_error_for_owner_io(
                    "create autosave owner marker",
                    &marker_path,
                    e,
                ));
            }
        }

        let existing = match read_autosave_owner_marker(&marker_path).await {
            Ok(marker) => marker,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                warn!(
                    "[notebook-sync] Reclaiming unreadable autosave owner marker {:?}: {}",
                    marker_path, e
                );
                remove_stale_autosave_owner_marker(&marker_path).await?;
                continue;
            }
        };

        if existing.is_current_daemon() {
            write_autosave_owner_marker(&marker_path, notebook_path).await?;
            return Ok(());
        }

        if autosave_owner_process_is_live(existing.pid) {
            error!(
                "[notebook-sync] Refusing to save {:?}: autosave owner marker {:?} belongs to live daemon pid={} daemon_id={}. Stop that daemon or reconnect through it before saving this path.",
                notebook_path,
                marker_path,
                existing.pid,
                existing.daemon_id
            );
            return Err(SaveError::Unrecoverable(format!(
                "notebook '{}' is owned by live daemon pid {} (marker '{}')",
                notebook_path.display(),
                existing.pid,
                marker_path.display()
            )));
        }

        warn!(
            "[notebook-sync] Taking over stale autosave owner marker {:?} for {:?} from pid={} daemon_id={}",
            marker_path, notebook_path, existing.pid, existing.daemon_id
        );
        remove_stale_autosave_owner_marker(&marker_path).await?;
    }
}

async fn read_autosave_owner_marker(path: &Path) -> std::io::Result<AutosaveOwnerMarker> {
    let bytes = tokio::fs::read(path).await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

pub(crate) async fn release_autosave_owner_marker_for_path(notebook_path: &Path) {
    let marker_path = autosave_owner_marker_path(notebook_path);
    match read_autosave_owner_marker(&marker_path).await {
        Ok(marker) if marker.is_current_daemon() => {
            if let Err(e) = tokio::fs::remove_file(&marker_path).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    warn!(
                        "[notebook-sync] Failed to release autosave owner marker {:?}: {}",
                        marker_path, e
                    );
                }
            }
        }
        Ok(_) | Err(_) => {}
    }
}

async fn write_autosave_owner_marker(
    marker_path: &Path,
    notebook_path: &Path,
) -> Result<(), SaveError> {
    let marker = AutosaveOwnerMarker::current(notebook_path);
    let mut bytes = serde_json::to_vec_pretty(&marker)
        .map_err(|e| SaveError::Retryable(format!("failed to serialize autosave owner: {e}")))?;
    bytes.push(b'\n');
    write_file_atomic(marker_path, &bytes)
        .await
        .map_err(|e| save_error_for_owner_io("refresh autosave owner marker", marker_path, e))
}

async fn remove_stale_autosave_owner_marker(marker_path: &Path) -> Result<(), SaveError> {
    match tokio::fs::remove_file(marker_path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(save_error_for_owner_io(
            "remove stale autosave owner marker",
            marker_path,
            e,
        )),
    }
}

fn save_error_for_owner_io(action: &str, path: &Path, e: std::io::Error) -> SaveError {
    let msg = format!("{action} '{}': {e}", path.display());
    match e.kind() {
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::IsADirectory => {
            SaveError::Unrecoverable(msg)
        }
        _ => SaveError::Retryable(msg),
    }
}

#[cfg(test)]
pub(crate) async fn write_autosave_owner_marker_for_test(
    notebook_path: &Path,
    daemon_id: &str,
    pid: u32,
) {
    let marker = AutosaveOwnerMarker {
        schema_version: AUTOSAVE_OWNER_SCHEMA_VERSION,
        daemon_id: daemon_id.to_string(),
        pid,
        notebook_path: notebook_path.to_path_buf(),
        claimed_at_unix_ms: unix_now_ms(),
    };
    let marker_path = autosave_owner_marker_path(notebook_path);
    let mut bytes = serde_json::to_vec_pretty(&marker).unwrap();
    bytes.push(b'\n');
    tokio::fs::write(marker_path, bytes).await.unwrap();
}

#[cfg(test)]
pub(crate) async fn read_autosave_owner_marker_for_test(
    notebook_path: &Path,
) -> AutosaveOwnerMarker {
    read_autosave_owner_marker(&autosave_owner_marker_path(notebook_path))
        .await
        .unwrap()
}

#[cfg(test)]
pub(crate) fn current_autosave_owner_id_for_test() -> String {
    current_autosave_owner_id().to_string()
}

#[cfg(test)]
pub(crate) struct AutosaveOwnerLivenessOverrideGuard {
    pid: u32,
}

#[cfg(test)]
impl Drop for AutosaveOwnerLivenessOverrideGuard {
    fn drop(&mut self) {
        if let Some(overrides) = AUTOSAVE_OWNER_LIVENESS_OVERRIDES.get() {
            if let Ok(mut overrides) = overrides.lock() {
                overrides.remove(&self.pid);
            }
        }
    }
}

#[cfg(test)]
static AUTOSAVE_OWNER_LIVENESS_OVERRIDES: std::sync::OnceLock<
    std::sync::Mutex<HashMap<u32, bool>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn override_autosave_owner_liveness_for_test(
    pid: u32,
    live: bool,
) -> AutosaveOwnerLivenessOverrideGuard {
    let overrides =
        AUTOSAVE_OWNER_LIVENESS_OVERRIDES.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    overrides.lock().unwrap().insert(pid, live);
    AutosaveOwnerLivenessOverrideGuard { pid }
}

fn autosave_owner_process_is_live(pid: u32) -> bool {
    #[cfg(test)]
    if let Some(overrides) = AUTOSAVE_OWNER_LIVENESS_OVERRIDES.get() {
        if let Ok(overrides) = overrides.lock() {
            if let Some(live) = overrides.get(&pid) {
                return *live;
            }
        }
    }

    platform_process_exists(pid)
}

#[cfg(unix)]
fn platform_process_exists(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

#[cfg(windows)]
fn platform_process_exists(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(any(unix, windows)))]
fn platform_process_exists(_pid: u32) -> bool {
    false
}

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
) -> Result<(), notebook_protocol::protocol::SaveBlockedReason> {
    match rooms.bind_path(uuid, canonical.to_path_buf()).await {
        Ok(()) => Ok(()),
        Err(path_index::PathIndexError::PathAlreadyOpen { uuid, path: p }) => Err(
            notebook_protocol::protocol::SaveBlockedReason::PathAlreadyOpen {
                uuid: uuid.to_string(),
                path: p.to_string_lossy().into_owned(),
            },
        ),
        Err(path_index::PathIndexError::RegistryFrozen) => {
            Err(notebook_protocol::protocol::SaveBlockedReason::Io {
                message: "notebook room publication is frozen for clean shutdown".to_string(),
            })
        }
    }
}

/// Finalize the untitled-to-file-backed transition AFTER the .ipynb has been
/// written and path_index already holds the claim. `NotebookFileBinding` owns
/// the path, watcher/autosave lifecycle, runtime-state path write, and project
/// context refresh; this helper only handles the stale untitled Automerge file
/// and notebook metadata transition around that binding update.
pub(crate) async fn finalize_untitled_promotion(
    room: &Arc<NotebookRoom>,
    canonical: PathBuf,
) -> Result<(), String> {
    let recovery_journal = super::recovery::RecoveryJournal::new(
        room.identity.persist_path.with_extension("recovery"),
    );
    if let Err(error) = room.durability.promote_to_journal(recovery_journal) {
        let reason =
            format!("saved file checkpoint could not establish its recovery journal: {error}");
        room.durability.mark_degraded(
            super::durability::DegradationKind::DurabilityBoundary,
            reason.clone(),
        );
        let document_heads = room.durability.status().durable_heads;
        room.lifecycle
            .mark_degraded(reason.clone(), document_heads, true);
        let _ = room.state.with_doc(|state| {
            state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                reason: reason.clone(),
            }))
        });
        return Err(reason);
    }
    let durability = room.durability.status();
    let cell_count = room.doc.read().await.cell_count();
    let mut projection = match super::projection::build_live_notebook_projection_for_generation(
        room,
        durability.source_generation,
    )
    .await
    {
        Ok(projection) => projection,
        Err(error) => {
            let reason = format!(
                "saved file checkpoint could not retain its generation-owned projection: {error:#}"
            );
            room.durability.mark_degraded(
                super::durability::DegradationKind::SourceState,
                reason.clone(),
            );
            room.lifecycle
                .mark_degraded(reason.clone(), durability.durable_heads.clone(), true);
            let _ = room.state.with_doc(|state| {
                state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                    reason: reason.clone(),
                }))
            });
            return Err(reason);
        }
    };
    projection.notebook_path = Some(canonical.to_string_lossy().into_owned());
    room.lifecycle.promote_file_backed_checkpoint(
        durability.source_generation,
        durability.source_fingerprint,
        cell_count,
        Arc::new(projection),
        durability.durable_heads.clone(),
    );
    let _ = room
        .state
        .with_doc(|state| state.set_file_source_issue(None));

    // A later AutomergeSync frame may recreate this `.automerge` file. That is
    // harmless: the file is keyed by SHA256(uuid), and path-keyed opens consult
    // the `.ipynb` path and recovery journal rather than this untitled mirror.
    if room.identity.persist_path.exists() {
        if let Err(e) = tokio::fs::remove_file(&room.identity.persist_path).await {
            warn!(
                "[notebook-sync] Failed to remove stale persist file {:?}: {}",
                room.identity.persist_path, e
            );
        }
    }

    NotebookFileBinding::promote_after_save(room, canonical.clone()).await;

    info!(
        "[notebook-sync] Promoted untitled room {} to file-backed path {:?}",
        room.id, canonical
    );
    Ok(())
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
pub(crate) struct AutosaveDebouncerConfig {
    /// Quiet period: flush only after no changes for this long.
    pub(crate) debounce_ms: u64,
    /// Max interval: flush even during continuous changes after this long.
    pub(crate) max_interval_ms: u64,
    /// How often to check whether a flush is due.
    pub(crate) check_interval_ms: u64,
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
pub(crate) fn spawn_autosave_debouncer_with_config(
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
                                Ok(outcome) => {
                                    info!("[autosave] Final save on shutdown: {}", outcome);
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
                                Ok(outcome) => {
                                    debug!("[autosave] Save outcome for {}: {:?}", notebook_id, outcome);
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
                                    }
                                }
                                Err(ref e @ SaveError::Unrecoverable(_)) => {
                                    error!(
                                        "[autosave] Unrecoverable save error, disabling autosave for {}: {}",
                                        notebook_id, e
                                    );
                                    break;
                                }
                                Err(ref e @ SaveError::CheckpointBlocked {
                                    reason:
                                        notebook_protocol::protocol::SaveBlockedReason::SourceConflict { .. }
                                        | notebook_protocol::protocol::SaveBlockedReason::SourceDegraded { .. },
                                    ..
                                }) => {
                                    warn!(
                                        "[autosave] Autosave paused for {} until explicit source reconciliation: {}",
                                        notebook_id, e
                                    );
                                    // A source conflict/degradation cannot heal on a
                                    // timer. Clear this trigger so we do not reserve a
                                    // new save sequence and emit the same warning every
                                    // check tick. A genuinely new document/file-dirty
                                    // event may make one fresh attempt; reconciliation
                                    // itself restarts normal checkpointing.
                                    last_receive = None;
                                    last_flush = Some(Instant::now());
                                }
                                Err(ref e @ SaveError::CheckpointBlocked {
                                    reason: notebook_protocol::protocol::SaveBlockedReason::SequenceExhausted,
                                    ..
                                }) => {
                                    error!(
                                        "[autosave] Save sequence exhausted, disabling autosave for {}: {}",
                                        notebook_id, e
                                    );
                                    break;
                                }
                                Err(SaveError::CheckpointBlocked {
                                    reason: notebook_protocol::protocol::SaveBlockedReason::Superseded { .. },
                                    ..
                                }) => {
                                    // A newer checkpoint already owns the file. There
                                    // is no older completion to retry.
                                    last_receive = None;
                                    last_flush = Some(Instant::now());
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
    match write_file_atomic_sync(path, data) {
        Ok(()) => true,
        Err(e) => {
            warn!(
                "[notebook-sync] Failed to save notebook doc {:?}: {}",
                path, e
            );
            false
        }
    }
}

/// A unique same-directory temp path for atomically replacing `path`.
/// Same-directory keeps the final `rename` on one filesystem (cross-device
/// renames fail), and the pid + counter make concurrent saves from this
/// process collision-free.
fn sibling_temp_path(path: &Path) -> PathBuf {
    static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "notebook".to_string());
    path.with_file_name(format!(".{file_name}.{}-{n}.tmp", std::process::id()))
}

/// Atomic-write core for the non-durable convenience tier (persisted
/// notebook doc mirrors, autosave owner markers, comments sidecar docs).
///
/// Creates the parent directory, writes `bytes` to a same-directory temp
/// file, preserves the destination's permissions when it already exists,
/// and renames into place, removing the temp file on failure. A reader
/// never observes a torn/partial file: the path always holds either the
/// previous complete content or the new complete content.
///
/// Tier split: this core deliberately does not fsync. The durable fsync
/// tier (`recovery.rs::replace_file_atomically` and
/// `file_checkpoint.rs::RealCheckpointIo::replace_temp`) carries the
/// crash-durability guarantees for journals and file checkpoints and must
/// stay separate; do not merge it into this convenience helper.
pub(crate) fn write_file_atomic_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = sibling_temp_path(path);
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Async adapter over [`write_file_atomic_sync`] for callers already on the
/// async save path; the blocking file I/O runs on the blocking pool.
async fn write_file_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let path = path.to_path_buf();
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || write_file_atomic_sync(&path, &bytes))
        .await
        .map_err(std::io::Error::other)?
}

// =============================================================================
// Notebook File Watching
// =============================================================================
//
// Watch .ipynb files for external changes (git, VS Code, other editors).
// When changes are detected, merge them into the Automerge doc and broadcast.

/// One debounced watcher observation, reduced to the side-effect-free reads
/// that decide skip versus ingest. Captured once per event so the decision
/// can be exercised as a pure function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WatcherObservation {
    /// Fingerprint of the bytes currently on disk at the watched path.
    pub(crate) observed: super::recovery::SourceFingerprint,
    /// Disk baseline recorded by saves and watcher merges
    /// ([`RoomPersistence::known_disk_hash`]). `None` disables that guard.
    pub(crate) known_disk_hash: Option<[u8; 32]>,
    /// Committed source fingerprint from the durability manifest, advanced
    /// at journal-commit time under the checkpoint coordinator lock.
    pub(crate) manifest_fingerprint: super::recovery::SourceFingerprint,
    /// Fingerprint of a prepared-but-uncommitted file checkpoint. Present
    /// only inside the rename-to-commit window of an in-flight save, when
    /// the new bytes are visible on disk but the manifest still names the
    /// previous source fingerprint.
    pub(crate) pending_checkpoint_fingerprint: Option<super::recovery::SourceFingerprint>,
}

/// Which guard suppressed a watcher observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatcherSkipReason {
    /// Bytes match the disk baseline recorded by saves and watcher merges.
    KnownDiskContent,
    /// Bytes match the committed manifest source fingerprint.
    ManifestFingerprint,
    /// Bytes match a prepared checkpoint whose journal commit has not
    /// landed yet (the rename-to-commit window).
    PendingCheckpoint,
}

/// The watcher's skip/ingest decision for one debounced observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatcherIngestDecision {
    Skip(WatcherSkipReason),
    Ingest,
}

/// Decide whether a debounced file event carries new disk truth.
///
/// Pure over the captured observation: bytes already reconciled carry no new
/// disk truth, and skipping them is load-bearing on Linux where inotify
/// reports reads (IN_ACCESS): a poller merely reading the file would
/// otherwise re-run the merge on every debounce window, churning the journal,
/// resetting the autosave debounce, and bumping the source generation for
/// content the room already ingested. Three fingerprint sources of "already
/// known": the disk baseline recorded by saves and watcher merges, the
/// manifest fingerprint recorded at journal-commit time (which also covers
/// the initial load, which never sets the save baseline), and the pending
/// checkpoint fingerprint covering the rename-to-commit window of an
/// in-flight save. Anything else is genuine external truth to ingest.
pub(crate) fn classify_watcher_observation(
    observation: &WatcherObservation,
) -> WatcherIngestDecision {
    if observation.known_disk_hash == Some(*observation.observed.as_bytes()) {
        return WatcherIngestDecision::Skip(WatcherSkipReason::KnownDiskContent);
    }
    if observation.observed == observation.manifest_fingerprint {
        return WatcherIngestDecision::Skip(WatcherSkipReason::ManifestFingerprint);
    }
    if observation.pending_checkpoint_fingerprint == Some(observation.observed) {
        return WatcherIngestDecision::Skip(WatcherSkipReason::PendingCheckpoint);
    }
    WatcherIngestDecision::Ingest
}

/// Preserve both disk and journal truth when an external file revision races
/// unsaved causal heads. This transition is shared by the watcher and tests so
/// the structured `source_conflict` state cannot drift from the detection
/// predicate.
pub(crate) async fn mark_external_source_conflict_if_needed(
    room: &NotebookRoom,
    notebook_path: &Path,
    source_content: &[u8],
) -> bool {
    let durable = room.durability.status();
    let external_fingerprint = super::recovery::source_fingerprint(source_content);
    let manifest = room.durability.manifest();
    if !durable.has_durable_record
        || durable.durable_heads == durable.exported_heads
        || external_fingerprint == manifest.source_fingerprint
    {
        return false;
    }

    let reason = format!(
        "source_conflict: {} changed on disk while journal heads were not exported; both versions were preserved",
        notebook_path.display()
    );
    // Both versions are preserved and the journal stays healthy, so this
    // degradation must not pin the room resident through shutdown or reaping.
    room.durability.mark_degraded(
        super::durability::DegradationKind::SourceState,
        reason.clone(),
    );
    let document_heads = {
        let mut doc = room.doc.write().await;
        doc.get_heads_hex()
    };
    room.lifecycle
        .mark_source_conflict(reason.clone(), document_heads);
    if let Err(error) = room.state.with_doc(|state| {
        state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Conflict {
            reason: reason.clone(),
        }))
    }) {
        warn!(
            "[notebook-watch] Failed to publish source conflict state: {}",
            error
        );
    }
    warn!("[notebook-watch] {reason}");
    true
}

/// Handle one debounced watcher event for `notebook_path`: read the file,
/// classify the observation against the room's skip baselines, and ingest
/// genuine external truth. Extracted from the watcher loop so tests can
/// drive the classifier and ingest seams directly instead of through real
/// filesystem notifications.
pub(crate) async fn process_watcher_event(room: &NotebookRoom, notebook_path: &Path) {
    // Read and parse the file
    let contents = match tokio::fs::read_to_string(notebook_path).await {
        Ok(c) => c,
        Err(e) => {
            // File may be deleted or being written
            debug!("[notebook-watch] Cannot read {:?}: {}", notebook_path, e);
            return;
        }
    };
    let manifest = room.durability.manifest();
    let observation = WatcherObservation {
        observed: super::recovery::source_fingerprint(contents.as_bytes()),
        known_disk_hash: room.persistence.known_disk_hash(),
        manifest_fingerprint: manifest.source_fingerprint,
        pending_checkpoint_fingerprint: manifest
            .pending_file_checkpoint
            .map(|pending| pending.file_fingerprint),
    };
    let observed_fingerprint = observation.observed;
    match classify_watcher_observation(&observation) {
        WatcherIngestDecision::Skip(reason) => {
            debug!(
                "[notebook-watch] Skipping event for {:?} ({:?})",
                notebook_path, reason
            );
            return;
        }
        WatcherIngestDecision::Ingest => {}
    }

    // A journal with heads newer than its causal file
    // checkpoint represents unsaved collaborative
    // truth. If disk changed to different bytes, keep
    // both versions and require explicit reconciliation
    // instead of merging or choosing a winner.
    if mark_external_source_conflict_if_needed(room, notebook_path, contents.as_bytes()).await {
        return;
    }

    // Parse the .ipynb with the shared notebook parser. `Err` covers a
    // partial write (invalid JSON), a non-object root, and a missing or
    // non-array `cells` key alike: none of them is an ingestable notebook
    // revision, so skip and wait for the next event. A genuine empty
    // notebook still has `cells: []` and parses successfully.
    let ParsedStreamingNotebook {
        cells: streaming_cells,
        metadata: external_metadata,
        attachments: external_attachments,
        metadata_value: _,
    } = match parse_notebook_jiter_for_notebook(contents.as_bytes(), room.id) {
        Ok(parsed) => parsed,
        Err(e) => {
            warn!(
                "[notebook-watch] Cannot parse cells from {:?} - skipping: {}",
                notebook_path, e
            );
            return;
        }
    };
    let (external_cells, external_outputs) = streaming_cells_into_snapshots(streaming_cells);

    // Check if kernel is running (to preserve outputs)
    let has_kernel = room.has_kernel().await;
    let source_claim = match room.persistence.claim_file_checkpoint() {
        Ok(claim) => claim,
        Err(_) => {
            let reason = "external source checkpoint sequence exhausted".to_string();
            room.durability.mark_degraded(
                super::durability::DegradationKind::DurabilityBoundary,
                reason.clone(),
            );
            let heads = room.durability.status().durable_heads;
            room.lifecycle.mark_degraded(reason.clone(), heads, true);
            return;
        }
    };
    let source_save_sequence = source_claim.sequence();
    let source_revision = ExternalSourceRevision {
        fingerprint: observed_fingerprint,
        canonical_path: notebook_path.to_path_buf(),
        save_sequence: source_save_sequence,
        saved_at: std::fs::metadata(notebook_path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
    };

    // Apply the complete cell+metadata revision under
    // one NotebookDoc lock and one journal marker.
    let applied = apply_ipynb_changes_from_source(
        room,
        &external_cells,
        &external_outputs,
        &external_attachments,
        external_metadata.as_ref(),
        has_kernel,
        source_revision,
    )
    .await;
    let cells_changed = applied.cells_changed;
    let metadata_changed = applied.metadata_changed;

    // Close the remaining window between the
    // pre-document revision check and baseline
    // publication. If a newer edit landed, leave the
    // prior baseline intact so it cannot be mistaken
    // for exported content.
    match tokio::fs::read(notebook_path).await {
        Ok(current) if super::recovery::source_fingerprint(&current) == observed_fingerprint => {}
        Ok(_) | Err(_) => return,
    }

    if room.durability.status().is_degraded() {
        // `apply_ipynb_changes_inner` rolls the NotebookDoc
        // back when its journal marker fails. Do not
        // apply metadata, advance source baselines, or
        // publish a recovery over that terminal state.
        return;
    }

    // Recovery is published only after cells and metadata
    // both reconcile successfully below. Until then the
    // Failed generation and persistence guard remain
    // authoritative.
    let cells_reconciled = room.doc.read().await.cell_count() == external_cells.len();

    if cells_reconciled {
        room.clear_load_failed();
        // Only a fully reconciled and journaled source
        // revision becomes the autosave staleness
        // baseline. Failed or partial application keeps
        // the prior baseline so a later save cannot
        // silently overwrite unobserved disk truth.
        let sources = external_cells
            .iter()
            .map(|cell| (cell.id.clone(), cell.source.clone()))
            .collect();
        let _ = room
            .persistence
            .note_primary_save_baseline(source_save_sequence, sources, contents.as_bytes())
            .await;
    }

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
        check_and_update_trust_state(room).await;
    }
}

pub(crate) fn spawn_notebook_file_watcher(
    notebook_path: PathBuf,
    room: Arc<NotebookRoom>,
) -> oneshot::Sender<()> {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

    spawn_best_effort("notebook-file-watcher", async move {
        // Watch the parent directory, not the file itself. Saves replace the
        // file via tempfile + rename (ours and most editors'), and an inotify
        // watch on the file follows the old inode — it goes silent after the
        // first rename-over. A directory watch survives replacement; the
        // event loop below filters to `notebook_path`.
        let watch_path = match notebook_path.parent() {
            Some(parent) if parent.exists() => parent.to_path_buf(),
            _ => {
                warn!(
                    "[notebook-watch] Parent dir doesn't exist for {:?}",
                    notebook_path
                );
                return;
            }
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
                            process_watcher_event(&room, &notebook_path).await;
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
