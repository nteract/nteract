use automerge::ReadDoc;
use chrono::Utc;

use runtimed_client::protocol::{
    NotebookAvailabilityPhase, NotebookAvailabilityProjection, NotebookCapabilities,
    NotebookCellProjection, NotebookProjection, NotebookReadiness, NotebookRuntimeProjection,
    NotebookSourcePhase, NotebookSourceProgress, NotebookSourceProjectionState,
    NotebookSourceRetry, NOTEBOOK_PROJECTION_SCHEMA_VERSION,
};

use super::{
    NotebookRoom, RoomAvailability, RoomSourceFingerprint, RoomSourceRetry as InternalSourceRetry,
    RoomSourceState,
};

const SOURCE_PREVIEW_CHARS: usize = 120;

#[derive(Debug, thiserror::Error)]
pub(crate) enum NotebookProjectionBuildError {
    #[error(
        "source generation {generation} has no retained projection (document_readable={document_readable}): {reason}"
    )]
    NotRetained {
        generation: u64,
        document_readable: bool,
        reason: String,
    },
    #[error(transparent)]
    Capture(#[from] anyhow::Error),
}

/// Read the compact, generation-owned view retained by the authoritative room.
///
/// Unmanaged in-memory rooms may synthesize a bounded view because they have no
/// file-source lifecycle. File-backed or otherwise lifecycle-managed rooms
/// never fall back to the live document: absence is a typed state, not
/// permission to invent new projection provenance.
pub(crate) async fn build_notebook_projection(
    room: &NotebookRoom,
    load_generation: u64,
) -> Result<NotebookProjection, NotebookProjectionBuildError> {
    if let Some(projection) = room.lifecycle.projection(load_generation) {
        let mut projection = (*projection).clone();
        decorate_projection_lifecycle(room, &mut projection);
        return Ok(projection);
    }

    let availability = room.lifecycle.availability();
    if matches!(availability, RoomAvailability::Degraded(_)) {
        if let Some(projection) = room.lifecycle.latest_projection() {
            let mut projection = (*projection).clone();
            decorate_projection_lifecycle(room, &mut projection);
            return Ok(projection);
        }
    }

    let source = room.lifecycle.source_state();
    let file_backed = room.file_binding.path().await.is_some();
    let unmanaged_live_room = matches!(
        &source,
        RoomSourceState::Ready(status)
            if status.generation == 0
                && matches!(status.fingerprint, RoomSourceFingerprint::NotApplicable)
    );
    if file_backed || !unmanaged_live_room {
        let availability = room.lifecycle.availability();
        return Err(NotebookProjectionBuildError::NotRetained {
            generation: source.generation(),
            document_readable: availability.status().capabilities.read_document,
            reason: availability.status().reason.clone().unwrap_or_else(|| {
                "the room has document state but no generation-owned projection artifact"
                    .to_string()
            }),
        });
    }

    build_live_notebook_projection_for_generation(room, load_generation)
        .await
        .map_err(NotebookProjectionBuildError::Capture)
}

/// Capture a new generation-owned projection from the live document.
///
/// This is deliberately separate from [`build_notebook_projection`]. Only
/// source/checkpoint transitions may call it, immediately before installing
/// the result in `RoomLifecycle`; ordinary reads must never synthesize a new
/// artifact and thereby lose its causal provenance.
pub(crate) async fn build_live_notebook_projection_for_generation(
    room: &NotebookRoom,
    load_generation: u64,
) -> anyhow::Result<NotebookProjection> {
    let (cells, dependencies, notebook_heads) = {
        let mut doc = room.doc.write().await;
        capture_notebook_document_projection(&mut doc)
    };
    finish_notebook_projection(room, load_generation, cells, dependencies, notebook_heads).await
}

/// Build the generation-owned projection from the immutable staged document.
/// No live NotebookDoc lock is acquired on this path.
pub(crate) async fn build_staged_notebook_projection(
    room: &NotebookRoom,
    staged: &mut notebook_doc::NotebookDoc,
    load_generation: u64,
) -> anyhow::Result<NotebookProjection> {
    let (cells, dependencies, notebook_heads) = capture_notebook_document_projection(staged);
    finish_notebook_projection(room, load_generation, cells, dependencies, notebook_heads).await
}

type ProjectedDocumentCell = (String, String, String, Option<String>);

fn capture_notebook_document_projection(
    doc: &mut notebook_doc::NotebookDoc,
) -> (Vec<ProjectedDocumentCell>, Vec<String>, Vec<String>) {
    // Read only fields carried by the control-plane projection. In
    // particular, do not call `get_cells()`: that clones every complete
    // source, metadata value, resolved-asset map, and attachment map only
    // for this path to discard almost all of it.
    let cells = doc
        .get_cell_ids()
        .into_iter()
        .map(|id| {
            let cell_type = doc.get_cell_type(&id).unwrap_or_default();
            let source_preview = bounded_cell_source_preview(doc, &id);
            let execution_id = doc.get_execution_id(&id);
            (id, cell_type, source_preview, execution_id)
        })
        .collect::<Vec<_>>();
    let dependencies = doc.get_uv_dependencies();
    let notebook_heads = doc.get_heads_hex();
    (cells, dependencies, notebook_heads)
}

async fn finish_notebook_projection(
    room: &NotebookRoom,
    load_generation: u64,
    cells: Vec<ProjectedDocumentCell>,
    dependencies: Vec<String>,
    notebook_heads: Vec<String>,
) -> anyhow::Result<NotebookProjection> {
    let notebook_path = room
        .file_binding
        .path()
        .await
        .map(|path| path.to_string_lossy().into_owned());

    let (runtime_state, runtime_state_heads) = room.state.with_doc(|state_doc| {
        let runtime_state = state_doc.read_state();
        let runtime_state_heads = state_doc
            .get_heads()
            .into_iter()
            .map(|head| head.to_string())
            .collect::<Vec<_>>();
        Ok((runtime_state, runtime_state_heads))
    })?;

    let projected_cells = cells
        .into_iter()
        .map(|(id, cell_type, source_preview, execution_id)| {
            let (execution_status, execution_count) = execution_id
                .as_deref()
                .map(|execution_id| {
                    let status = if runtime_state
                        .queue
                        .executing
                        .as_ref()
                        .is_some_and(|entry| entry.execution_id == execution_id)
                    {
                        Some("running".to_string())
                    } else if runtime_state
                        .queue
                        .queued
                        .iter()
                        .any(|entry| entry.execution_id == execution_id)
                    {
                        Some("queued".to_string())
                    } else {
                        runtime_state
                            .executions
                            .get(execution_id)
                            .map(|execution| execution.status.clone())
                    };
                    let count = runtime_state
                        .executions
                        .get(execution_id)
                        .and_then(|execution| execution.execution_count);
                    (status, count)
                })
                .unwrap_or((None, None));

            NotebookCellProjection {
                id,
                cell_type,
                source_preview,
                execution_id,
                execution_status,
                execution_count,
            }
        })
        .collect();

    let runtime_ready = matches!(
        runtime_state.kernel.lifecycle,
        runtime_doc::RuntimeLifecycle::Running(_)
    );
    let mut projection = NotebookProjection {
        schema_version: NOTEBOOK_PROJECTION_SCHEMA_VERSION,
        load_generation,
        notebook_id: room.id.to_string(),
        notebook_path,
        cells: projected_cells,
        dependencies,
        runtime: NotebookRuntimeProjection {
            kernel: runtime_state.kernel,
            env: runtime_state.env,
            trust: runtime_state.trust,
            project_context: runtime_state.project_context,
        },
        source_state: NotebookSourceProjectionState::default(),
        availability: NotebookAvailabilityProjection {
            phase: NotebookAvailabilityPhase::Attached,
            generation: load_generation,
            document_heads: Vec::new(),
            projection_heads: Vec::new(),
            capabilities: NotebookCapabilities {
                read: false,
                mutate: false,
                execute: false,
            },
            reason: None,
        },
        readiness: NotebookReadiness {
            projection: false,
            document: false,
            runtime: runtime_ready,
        },
        projection_complete: true,
        projection_heads: notebook_heads.clone(),
        notebook_heads,
        runtime_state_heads,
        captured_at: Utc::now(),
    };
    decorate_projection_lifecycle(room, &mut projection);
    Ok(projection)
}

fn decorate_projection_lifecycle(room: &NotebookRoom, projection: &mut NotebookProjection) {
    let source = room.lifecycle.source_state();
    let source_status = source.status();
    projection.source_state = NotebookSourceProjectionState {
        phase: match source {
            RoomSourceState::Preparing(_) => NotebookSourcePhase::Preparing,
            RoomSourceState::Publishing(_) => NotebookSourcePhase::Publishing,
            RoomSourceState::Ready(_) => NotebookSourcePhase::Ready,
            RoomSourceState::Failed(_) => NotebookSourcePhase::Failed,
        },
        generation: source_status.generation,
        fingerprint: match source_status.fingerprint {
            RoomSourceFingerprint::Content(fingerprint) => Some(fingerprint.to_hex()),
            RoomSourceFingerprint::NotApplicable | RoomSourceFingerprint::Pending => None,
        },
        progress: NotebookSourceProgress {
            completed: source_status.progress.completed,
            total: source_status.progress.total,
        },
        error_code: source_status.error.as_ref().map(|error| error.code.clone()),
        error_message: source_status
            .error
            .as_ref()
            .map(|error| error.message.clone()),
        retry: match source_status.retry {
            InternalSourceRetry::NotNeeded => NotebookSourceRetry::NotNeeded,
            InternalSourceRetry::RegenerateIfPristine => NotebookSourceRetry::RegenerateIfPristine,
            InternalSourceRetry::ResumeStaged => NotebookSourceRetry::ResumeStaged,
            InternalSourceRetry::ExplicitReconciliation => {
                NotebookSourceRetry::ExplicitReconciliation
            }
        },
    };

    let availability = room.lifecycle.availability();
    let status = availability.status();
    projection.availability = NotebookAvailabilityProjection {
        phase: match availability {
            RoomAvailability::Attached(_) => NotebookAvailabilityPhase::Attached,
            RoomAvailability::ProjectionReady(_) => NotebookAvailabilityPhase::ProjectionReady,
            RoomAvailability::Interactive(_) => NotebookAvailabilityPhase::Interactive,
            RoomAvailability::Degraded(_) => NotebookAvailabilityPhase::Degraded,
        },
        generation: status.generation,
        document_heads: status.document_heads.clone(),
        projection_heads: status.projection_heads.clone(),
        capabilities: NotebookCapabilities {
            read: status.capabilities.read_projection || status.capabilities.read_document,
            mutate: status.capabilities.mutate,
            execute: status.capabilities.execute,
        },
        reason: status.reason.clone(),
    };
    let runtime_ready = projection.readiness.runtime;
    projection.readiness = NotebookReadiness {
        projection: status.capabilities.read_projection,
        document: status.capabilities.read_document,
        runtime: runtime_ready && status.capabilities.execute,
    };
    projection.projection_complete = true;
    if projection.availability.projection_heads.is_empty() {
        projection.availability.projection_heads = projection.projection_heads.clone();
    }
}

/// Read at most `SOURCE_PREVIEW_CHARS + 1` sequence positions from a cell's
/// Automerge text object. `ReadDoc::list_range` bounds traversal before text is
/// materialized, unlike `NotebookDoc::get_cell_source`, which builds the full
/// source string first.
fn bounded_cell_source_preview(doc: &notebook_doc::NotebookDoc, cell_id: &str) -> String {
    let Some(cell_obj) = doc.cell_obj_for(cell_id) else {
        return String::new();
    };
    let raw = doc.doc();
    let Some((automerge::Value::Object(automerge::ObjType::Text), source_obj)) =
        raw.get(&cell_obj, "source").ok().flatten()
    else {
        return String::new();
    };

    let source_len = raw.length(&source_obj);
    let read_end = source_len.min(SOURCE_PREVIEW_CHARS.saturating_add(1));
    let mut preview = String::new();
    let mut char_count = 0usize;
    for item in raw.list_range(&source_obj, 0..read_end) {
        let automerge::ValueRef::Scalar(automerge::ScalarValueRef::Str(fragment)) = item.value
        else {
            continue;
        };
        for ch in fragment.chars() {
            if char_count == SOURCE_PREVIEW_CHARS {
                break;
            }
            preview.push(ch);
            char_count += 1;
        }
        if char_count == SOURCE_PREVIEW_CHARS {
            break;
        }
    }
    if source_len > SOURCE_PREVIEW_CHARS {
        preview.push('…');
    }
    preview
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_preview_is_utf8_safe_and_bounded() {
        let mut doc = notebook_doc::NotebookDoc::new("projection-test");
        doc.add_cell(0, "cell-1", "code").unwrap();
        let source = "🐍".repeat(SOURCE_PREVIEW_CHARS + 1);
        doc.update_source("cell-1", &source).unwrap();
        let preview = bounded_cell_source_preview(&doc, "cell-1");
        assert_eq!(preview.chars().count(), SOURCE_PREVIEW_CHARS + 1);
        assert!(preview.ends_with('…'));
        assert_eq!(
            preview
                .chars()
                .take(SOURCE_PREVIEW_CHARS)
                .collect::<String>(),
            "🐍".repeat(SOURCE_PREVIEW_CHARS)
        );
    }

    #[test]
    fn short_source_preview_is_unchanged() {
        let mut doc = notebook_doc::NotebookDoc::new("projection-test");
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "x = 1\n").unwrap();
        assert_eq!(bounded_cell_source_preview(&doc, "cell-1"), "x = 1\n");
    }
}
