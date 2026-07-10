use chrono::Utc;

use runtimed_client::protocol::{
    NotebookCellProjection, NotebookProjection, NotebookRuntimeProjection,
    NOTEBOOK_PROJECTION_SCHEMA_VERSION,
};

use super::NotebookRoom;

const SOURCE_PREVIEW_CHARS: usize = 120;

/// Capture the compact initial view from the authoritative room.
///
/// NotebookDoc and RuntimeStateDoc are distinct Automerge documents. Each
/// projection is captured with its own causal heads under the corresponding
/// short document lock; callers must not infer a cross-document transaction.
pub(crate) async fn build_notebook_projection(
    room: &NotebookRoom,
    load_generation: u64,
) -> anyhow::Result<NotebookProjection> {
    let notebook_path = room
        .file_binding
        .path()
        .await
        .map(|path| path.to_string_lossy().into_owned());

    let (cells, execution_ids, dependencies, notebook_heads) = {
        let mut doc = room.doc.write().await;
        let cells = doc.get_cells();
        let execution_ids = cells
            .iter()
            .map(|cell| doc.get_execution_id(&cell.id))
            .collect::<Vec<_>>();
        let dependencies = doc
            .get_metadata_snapshot()
            .and_then(|metadata| metadata.runt.uv)
            .map(|uv| uv.dependencies)
            .unwrap_or_default();
        let notebook_heads = doc.get_heads_hex();
        (cells, execution_ids, dependencies, notebook_heads)
    };

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
        .zip(execution_ids)
        .map(|(cell, execution_id)| {
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
                id: cell.id,
                cell_type: cell.cell_type,
                source_preview: bounded_source_preview(&cell.source),
                execution_id,
                execution_status,
                execution_count,
            }
        })
        .collect();

    Ok(NotebookProjection {
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
        notebook_heads,
        runtime_state_heads,
        captured_at: Utc::now(),
    })
}

fn bounded_source_preview(source: &str) -> String {
    let mut chars = source.chars();
    let mut preview = chars
        .by_ref()
        .take(SOURCE_PREVIEW_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        preview.push('…');
    }
    preview
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_preview_is_utf8_safe_and_bounded() {
        let source = "🐍".repeat(SOURCE_PREVIEW_CHARS + 1);
        let preview = bounded_source_preview(&source);
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
        assert_eq!(bounded_source_preview("x = 1\n"), "x = 1\n");
    }
}
