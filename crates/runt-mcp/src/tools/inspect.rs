//! Bounded notebook reads and change observation for tool-only hosts.

use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::observation::{ChangeOutcome, ChangeRead};
use crate::NteractMcp;

const MAX_CELLS: usize = 100;
const SOURCE_BUDGET: usize = 32_768;
const MAX_SOURCE_CHARS: usize = 8_192;
const MAX_OUTPUTS: usize = 8;

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InspectNotebookParams {
    /// Optional cell IDs to read, in notebook order. At most 100.
    pub cell_ids: Option<Vec<String>>,
    /// First matching cell, zero-based. Default 0.
    pub start: Option<usize>,
    /// Cells to return, 1–100. Default 25.
    pub count: Option<usize>,
    /// Include source chunks instead of previews. Chunks remain bounded.
    pub full_source: Option<bool>,
    /// Character offset into each cell's source. Default 0.
    pub source_start: Option<usize>,
    /// Characters per cell, 1–8192; default 160, or 8192 with full_source.
    pub source_chars: Option<usize>,
    /// Cursor from an earlier inspection/resource read. Changes are notebook-wide.
    pub after: Option<String>,
    /// Wait up to 0–50 seconds after the cursor. Default 0; no cursor returns a baseline immediately.
    pub timeout_secs: Option<f64>,
}

impl InspectNotebookParams {
    fn validate(&self) -> Result<Duration, McpError> {
        if !(1..=MAX_CELLS).contains(&self.count.unwrap_or(25)) {
            return Err(McpError::invalid_params(
                "count must be between 1 and 100",
                None,
            ));
        }
        if !(1..=MAX_SOURCE_CHARS).contains(&self.source_limit()) {
            return Err(McpError::invalid_params(
                "source_chars must be between 1 and 8192",
                None,
            ));
        }
        if self.cell_ids.as_ref().is_some_and(|ids| {
            ids.len() > MAX_CELLS || ids.iter().any(|id| id.is_empty() || id.len() > 256)
        }) {
            return Err(McpError::invalid_params(
                "cell_ids must contain at most 100 nonempty IDs of at most 256 bytes",
                None,
            ));
        }
        if self.after.as_ref().is_some_and(|cursor| cursor.len() > 256) {
            return Err(McpError::invalid_params(
                "after must be at most 256 bytes",
                None,
            ));
        }
        super::observation::bounded_timeout(self.timeout_secs, 0.0)
    }

    fn source_limit(&self) -> usize {
        self.source_chars
            .unwrap_or(if self.full_source.unwrap_or(false) {
                MAX_SOURCE_CHARS
            } else {
                160
            })
    }
}

pub async fn inspect_notebook(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let params: InspectNotebookParams =
        serde_json::from_value(Value::Object(request.arguments.clone().unwrap_or_default()))
            .map_err(|error| McpError::invalid_params(error.to_string(), None))?;
    let timeout = params.validate()?;
    let _permit = if !timeout.is_zero() && params.after.is_some() {
        Some(super::observation::wait_permit(server)?)
    } else {
        None
    };
    let access = require_session_access!(server, ProjectionRead);
    let handle = access.notebook_handle.clone();
    let Ok(mut expiration) = super::observation::expiration(server, &handle) else {
        return Ok(unavailable(&access.notebook_id, &handle));
    };
    if !access.readiness.interactive {
        let Some(projection) = access.projection.as_ref() else {
            return super::tool_error("Notebook projection is not available yet");
        };
        let mut entries = Vec::new();
        let mut budget = SOURCE_BUDGET;
        let selected: Vec<_> = projection
            .cells
            .iter()
            .filter(|cell| {
                params
                    .cell_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&cell.id))
            })
            .collect();
        for cell in selected
            .iter()
            .skip(params.start.unwrap_or(0))
            .take(params.count.unwrap_or(25))
        {
            let preview: String = cell
                .source_preview
                .chars()
                .skip(params.source_start.unwrap_or(0))
                .take(params.source_limit().min(budget))
                .collect();
            budget = budget.saturating_sub(preview.chars().count());
            entries.push(json!({
                "cell_id":cell.id, "cell_type":cell.cell_type,
                "uri":crate::resources::attachment_cell_uri(&handle, &cell.id),
                "source_preview":preview, "source_complete":false,
                "source_truncated":true, "source_available":false,
                "source_start":params.source_start.unwrap_or(0), "source_chars":preview.chars().count(),
                "execution_id":cell.execution_id, "status":cell.execution_status,
                "execution_count":cell.execution_count,
            }));
        }
        let mut payload = json!({
            "outcome":if params.after.is_some() { "resync_required" } else { "baseline" },
            "notebook_id":access.notebook_id, "notebook_handle":handle, "cursor":null,
            "cells":entries, "readiness":access.readiness,
            "projection":{"heads":projection.projection_heads,"complete":projection.projection_complete,"source_previews_only":true},
            "changes":null, "observation_scope":"notebook", "source_budget_exhausted":budget == 0,
        });
        payload["pagination"] = pagination(
            &params,
            selected.len(),
            payload["cells"].as_array().map_or(0, Vec::len),
        );
        if super::observation::is_expired(&expiration) {
            return Ok(unavailable(&access.notebook_id, &handle));
        }
        return Ok(result(payload, &handle));
    }
    let Some((_, observer)) = server.observer_for_handle(&handle).await? else {
        return Ok(unavailable(&access.notebook_id, &handle));
    };
    let change = tokio::select! {
        change = super::observation::read_or_wait(&observer, params.after.as_deref(), timeout) => change?,
        _ = super::observation::expired(&mut expiration) => return Ok(unavailable(&access.notebook_id, &handle)),
    };
    if change.outcome == ChangeOutcome::Unavailable || super::observation::is_expired(&expiration) {
        return Ok(unavailable(&access.notebook_id, &handle));
    }
    let mut payload = snapshot_payload(&access.notebook_id, &handle, &params, &change);
    payload["readiness"] = serde_json::to_value(access.readiness)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(result(payload, &handle))
}

fn unavailable(notebook_id: &str, handle: &str) -> CallToolResult {
    CallToolResult::structured(
        json!({"outcome":"unavailable","notebook_id":notebook_id,"notebook_handle":handle,"cursor":null,"message":"Notebook observation ended; acquire the intended notebook again before continuing."}),
    )
}

fn result(mut payload: Value, handle: &str) -> CallToolResult {
    let cells = crate::resources::attachment_cells_uri(handle);
    payload["readiness_scope"] = json!("admission");
    payload["resources"] = json!({"cells":cells,"cell_template":format!("{cells}/{{cell_id}}"),"comments":format!("nteract://sessions/{handle}/comments")});
    let mut result = CallToolResult::success(vec![
        crate::formatting::assistant_text(payload.to_string()),
        ContentBlock::resource_link(crate::resources::attachment_cells_resource_link(handle)),
    ]);
    result.structured_content = Some(payload);
    result
}

fn pagination(params: &InspectNotebookParams, total: usize, returned: usize) -> Value {
    let start = params.start.unwrap_or(0).min(total);
    let end = start.saturating_add(returned).min(total);
    json!({"start":start,"returned":returned,"total":total,"next_start":(end < total).then_some(end),"truncated":end < total})
}

fn snapshot_payload(
    notebook_id: &str,
    handle: &str,
    params: &InspectNotebookParams,
    change: &ChangeRead,
) -> Value {
    let cells = change.snapshot.notebook.cells();
    let selected: Vec<_> = cells
        .iter()
        .enumerate()
        .filter(|(_, cell)| {
            params
                .cell_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&cell.id))
        })
        .collect();
    let mut budget = SOURCE_BUDGET;
    let entries: Vec<_> = selected
        .iter()
        .skip(params.start.unwrap_or(0))
        .take(params.count.unwrap_or(25))
        .map(|(index, cell)| {
            let mut value = crate::resources::observed_cell_summary(
                &change.snapshot,
                handle,
                *index,
                0,
                Some(MAX_OUTPUTS),
            );
            let start = params.source_start.unwrap_or(0);
            let total = cell.source.chars().count();
            let source: String = cell
                .source
                .chars()
                .skip(start)
                .take(params.source_limit().min(budget))
                .collect();
            let len = source.chars().count();
            budget = budget.saturating_sub(len);
            let end = start.min(total).saturating_add(len);
            if let Some(summary) = value.as_object_mut() {
                summary.remove("source_preview");
            }
            let key = if params.full_source.unwrap_or(false) {
                "source"
            } else {
                "source_preview"
            };
            value[key] = json!(source);
            value["source_start"] = json!(start.min(total));
            value["source_chars"] = json!(len);
            value["source_total_chars"] = json!(total);
            value["source_complete"] = json!(start == 0 && end == total);
            value["source_truncated"] = json!(start > 0 || end < total);
            value["source_next_start"] = json!((end < total).then_some(end));
            value
        })
        .collect();
    let missing: Vec<_> = params
        .cell_ids
        .iter()
        .flatten()
        .filter(|id| !cells.iter().any(|cell| &cell.id == *id))
        .collect();
    json!({
        "outcome":change.outcome,"notebook_id":notebook_id,"notebook_handle":handle,"cursor":change.cursor,
        "pagination":pagination(params, selected.len(), entries.len()),"cells":entries,"missing_cell_ids":missing,
        "changes":{
            "kinds":change.changes.kinds,
            "cell_ids":change.changes.cell_ids.iter().take(MAX_CELLS).collect::<Vec<_>>(),
            "execution_ids":change.changes.execution_ids.iter().take(MAX_CELLS).collect::<Vec<_>>(),
            "comment_thread_ids":change.changes.comment_thread_ids.iter().take(MAX_CELLS).collect::<Vec<_>>(),
            "truncated":change.changes.cell_ids.len()>MAX_CELLS || change.changes.execution_ids.len()>MAX_CELLS || change.changes.comment_thread_ids.len()>MAX_CELLS,
        },
        "observation_scope":"notebook","source_budget_exhausted":budget == 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observation::tests::{edited, fixture};

    #[tokio::test]
    async fn inspect_keeps_snapshot_cursor_source_and_execution_together() {
        let fixture = fixture();
        fixture.notebook.send_replace(edited("old source"));
        let observer = fixture.owner.reader();
        let captured = observer.read(None).unwrap();
        fixture.notebook.send_replace(edited("new source"));
        let params = InspectNotebookParams {
            full_source: Some(true),
            ..Default::default()
        };
        let data = snapshot_payload("notebook", "handle", &params, &captured);
        assert_eq!(data["cursor"], captured.cursor);
        assert_eq!(data["cells"][0]["source"], "old source");
        assert_eq!(
            data["cells"][0]["uri"],
            "nteract://sessions/handle/cells/cell-1"
        );
        assert_eq!(
            observer.read(Some(&captured.cursor)).unwrap().outcome,
            ChangeOutcome::Changed
        );
    }

    #[tokio::test]
    async fn inspect_paginates_source_by_unicode_characters_with_explicit_truncation() {
        let fixture = fixture();
        fixture.notebook.send_replace(edited("a🦀bc"));
        let read = fixture.owner.reader().read(None).unwrap();
        let params = InspectNotebookParams {
            full_source: Some(true),
            source_start: Some(1),
            source_chars: Some(2),
            ..Default::default()
        };
        let data = snapshot_payload("notebook", "handle", &params, &read);
        assert_eq!(data["cells"][0]["source"], "🦀b");
        assert_eq!(data["cells"][0]["source_next_start"], 3);
        assert_eq!(data["cells"][0]["source_total_chars"], 4);
        assert_eq!(data["cells"][0]["source_truncated"], true);
    }

    #[tokio::test]
    async fn inspect_wait_and_resource_reads_share_the_same_cursor() {
        let fixture = fixture();
        let reader = fixture.owner.reader();
        let initial =
            super::super::observation::read_or_wait(&reader, None, Duration::from_secs(50))
                .await
                .unwrap();
        fixture.notebook.send_replace(edited("changed"));
        let next =
            super::super::observation::read_or_wait(&reader, Some(&initial.cursor), Duration::ZERO)
                .await
                .unwrap();
        assert_eq!(next.outcome, ChangeOutcome::Changed);
        assert_eq!(next.cursor, reader.read(None).unwrap().cursor);
        let overflow =
            super::super::observation::read_or_wait(&reader, Some("foreign:1"), Duration::ZERO)
                .await
                .unwrap();
        assert_eq!(overflow.outcome, ChangeOutcome::ResyncRequired);
    }

    #[test]
    fn inspect_rejects_unbounded_parameters() {
        for params in [
            InspectNotebookParams {
                count: Some(101),
                ..Default::default()
            },
            InspectNotebookParams {
                source_chars: Some(8193),
                ..Default::default()
            },
            InspectNotebookParams {
                timeout_secs: Some(51.0),
                ..Default::default()
            },
            InspectNotebookParams {
                timeout_secs: Some(f64::NAN),
                ..Default::default()
            },
        ] {
            assert!(params.validate().is_err());
        }
    }
    #[tokio::test]
    async fn inspect_bounds_cell_source_output_and_change_pages() {
        let fixture = fixture();
        let mut doc = notebook_doc::NotebookDoc::new("bounds");
        for index in 0..30 {
            let id = format!("cell-{index}");
            let previous = (index > 0).then(|| format!("cell-{}", index - 1));
            doc.add_cell_after(&id, "code", previous.as_deref())
                .unwrap();
            doc.update_source(&id, &"x".repeat(10_000)).unwrap();
        }
        let mut snapshot = notebook_sync::NotebookSnapshot::from_doc(&doc.into_inner());
        std::sync::Arc::make_mut(&mut snapshot.execution_pointers)
            .insert("cell-0".into(), "run".into());
        fixture.notebook.send_replace(snapshot);
        let data: serde_json::Map<String, Value> = (0..20)
            .map(|n| (format!("{n:02}{}", "m".repeat(150)), Value::Null))
            .collect();
        fixture.runtime.send_modify(|state| { state.executions.insert("run".into(),serde_json::from_value(json!({"status":"done","outputs":vec![json!({"output_type":"display_data","data":data});20]})).unwrap()); });
        let read = fixture.owner.reader().read(None).unwrap();
        let params = InspectNotebookParams {
            count: Some(8),
            full_source: Some(true),
            ..Default::default()
        };
        let data = snapshot_payload("notebook", "handle", &params, &read);
        let cells = data["cells"].as_array().unwrap();
        assert_eq!(cells.len(), 8);
        assert_eq!(data["pagination"]["next_start"], 8);
        assert_eq!(data["pagination"]["total"], 30);
        assert_eq!(
            cells
                .iter()
                .map(|cell| cell["source"].as_str().unwrap().chars().count())
                .sum::<usize>(),
            SOURCE_BUDGET
        );
        assert_eq!(data["source_budget_exhausted"], true);
        assert_eq!(cells[4]["source_next_start"], 0);
        assert_eq!(cells[0]["outputs"].as_array().unwrap().len(), MAX_OUTPUTS);
        assert_eq!(cells[0]["outputs_truncated"], true);
        assert_eq!(cells[0]["output_count"], 20);
        assert_eq!(
            cells[0]["outputs"][0]["mime_types"]
                .as_array()
                .unwrap()
                .len(),
            16
        );
        assert_eq!(cells[0]["outputs"][0]["truncated"], true);
        assert_eq!(
            cells[0]["outputs"][0]["mime_types"][0]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            128
        );
        let next = snapshot_payload(
            "notebook",
            "handle",
            &InspectNotebookParams {
                start: Some(29),
                ..Default::default()
            },
            &read,
        );
        assert_eq!(next["cells"][0]["cell_id"], "cell-29");
        assert_eq!(next["pagination"]["next_start"], Value::Null);
        let filtered = snapshot_payload(
            "notebook",
            "handle",
            &InspectNotebookParams {
                cell_ids: Some(vec!["missing".into(), "cell-29".into()]),
                ..Default::default()
            },
            &read,
        );
        assert_eq!(filtered["cells"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["missing_cell_ids"], json!(["missing"]));
    }

    #[tokio::test]
    async fn inspect_without_a_selected_notebook_never_creates_a_peer() {
        let server = NteractMcp::new("nonexistent.sock".into(), None, None);
        let request = CallToolRequestParams::new("inspect_notebook");
        let result = inspect_notebook(&server, &request).await.unwrap();
        assert_eq!(result.is_error, Some(true));
        assert!(server.attachments.read_entries().is_empty());
        assert!(server.parked_sessions.read().await.is_empty());
        assert!(server.session.read().await.is_none());
    }
}
