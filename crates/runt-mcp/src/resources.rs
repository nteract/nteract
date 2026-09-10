//! MCP resource serving (output.html, notebook cells, status).

use rmcp::model::{
    Annotations, ListResourceTemplatesResult, ListResourcesResult, MetaObject,
    ReadResourceRequestParams, ReadResourceResult, Resource, ResourceContents, ResourceTemplate,
    Role,
};
use rmcp::ErrorData as McpError;

use crate::icons::{self, IconKind};
use crate::observation::{ChangeOutcome, ChangeRead, ObservationReader, ObservedNotebook};
use crate::NteractMcp;

const OUTPUT_RESOURCE_URI: &str = "ui://nteract/output.html";
const OUTPUT_MIME_TYPE: &str = "text/html;profile=mcp-app";
const NOTEBOOKS_RESOURCE_URI: &str = "nteract://notebooks";
const NOTEBOOKS_MIME_TYPE: &str = "application/json";
const CELLS_MIME_TYPE: &str = "application/json";
// Assistant-facing notebook JSON is high-value context, but the UI app resource
// remains the host-facing renderer entrypoint.
const NOTEBOOK_CONTEXT_PRIORITY: f32 = 0.8;

/// The compiled output renderer HTML, built by `apps/mcp-app/build-html.js`.
/// Build with: `cargo xtask artifacts ensure mcp-widget`
/// The build script copies the file to `crates/runt-mcp/assets/_output.html`.
const OUTPUT_HTML: &str = include_str!("../assets/_output.html");

/// Build `_meta` for the output widget resource.
///
/// MCP Apps spec CSP fields (from ext-apps specification):
/// - `resourceDomains` → `img-src`, `script-src`, `style-src`, `font-src`, `media-src`
/// - `connectDomains`  → `connect-src` (fetch/XHR/WebSocket)
/// - `frameDomains`    → `frame-src` (nested output iframe shell)
///
/// `prefersBorder: false` asks hosts to avoid adding an extra host-provided
/// border/background around the renderer. The output surface already owns its
/// visual boundary and needs to align with notebook output width.
///
/// The daemon's blob HTTP server URL is needed in `connectDomains` for
/// `fetch()` calls to resolve blob-stored output data and raw renderer plugin
/// assets. `resourceDomains` keeps the daemon origin available for static
/// sidecars and host implementations that treat iframe resource loads
/// conservatively.
///
/// `frameDomains` declares that the same daemon origin is available if a host
/// needs to grant the MCP app permission to create nested output iframes. The
/// current MCP app still defaults to the inline isolated shell that works in
/// Claude Desktop; advertising this metadata is only the host permission layer.
///
/// Claude Desktop requires `localhost` (not `127.0.0.1`) for domain allowlists.
fn resource_ui_meta(blob_base_url: &Option<String>) -> MetaObject {
    let mut ui = serde_json::Map::new();
    ui.insert("prefersBorder".to_string(), serde_json::json!(false));

    if let Some(url) = blob_base_url.as_ref() {
        ui.insert(
            "csp".to_string(),
            serde_json::json!({
                "resourceDomains": [url],
                "connectDomains": [url],
                "frameDomains": [url]
            }),
        );
    }

    let mut meta = serde_json::Map::new();
    meta.insert("ui".to_string(), serde_json::Value::Object(ui));
    MetaObject(meta)
}

/// List available MCP resources.
#[cfg(test)]
pub async fn list_resources(server: &NteractMcp) -> Result<ListResourcesResult, McpError> {
    list_resources_for_mode(server, false).await
}

pub(crate) async fn list_resources_for_mode(
    server: &NteractMcp,
    native: bool,
) -> Result<ListResourcesResult, McpError> {
    let mut resources = Vec::new();
    resources.push(resource(
        OUTPUT_RESOURCE_URI,
        "nteract output",
        "Interactive output renderer for notebook cells",
        OUTPUT_MIME_TYPE,
        IconKind::GetResults,
        Some(resource_ui_meta(&server.blob_base_url())),
    ));
    resources.push(assistant_resource(
        NOTEBOOKS_RESOURCE_URI,
        "nteract notebooks",
        "Active notebook rooms visible to this MCP server",
        NOTEBOOKS_MIME_TYPE,
        IconKind::ListActiveNotebooks,
        NOTEBOOK_CONTEXT_PRIORITY,
    ));

    let notebook_ids = if native {
        Vec::new()
    } else {
        known_session_notebook_ids(server).await
    };
    for notebook_id in notebook_ids {
        resources.push(assistant_resource(
            notebook_cells_uri(&notebook_id),
            format!("nteract cells {notebook_id}"),
            "Ordered cell list for a connected or parked notebook session",
            CELLS_MIME_TYPE,
            IconKind::ListActiveNotebooks,
            NOTEBOOK_CONTEXT_PRIORITY,
        ));
    }

    Ok(ListResourcesResult::with_all_items(resources))
}

/// List available dynamic MCP resource templates.
pub fn list_resource_templates() -> ListResourceTemplatesResult {
    let mut templates = vec![
        assistant_resource_template(
            "nteract://notebooks/{notebook_id}/cells",
            "nteract notebook cells",
            "Ordered cell list for a connected or parked notebook session",
            CELLS_MIME_TYPE,
            IconKind::ListActiveNotebooks,
            NOTEBOOK_CONTEXT_PRIORITY,
        ),
        assistant_resource_template(
            "nteract://notebooks/{notebook_id}/cells/{cell_id}",
            "nteract notebook cell",
            "Notebook cell snapshot for a connected or parked notebook session",
            CELLS_MIME_TYPE,
            IconKind::ReadCell,
            NOTEBOOK_CONTEXT_PRIORITY,
        ),
        assistant_resource_template(
            "nteract://notebooks/{notebook_id}/comments",
            "nteract notebook comments",
            "Comment threads for a connected or parked notebook session",
            "application/json",
            IconKind::ListActiveNotebooks,
            NOTEBOOK_CONTEXT_PRIORITY,
        ),
    ];

    let attachment_templates: Vec<_> = templates
        .iter()
        .cloned()
        .map(|mut template| {
            template.uri_template = template
                .uri_template
                .replace("notebooks/{notebook_id}", "sessions/{notebook_handle}");
            template.name = format!("{} by attachment", template.name);
            template
        })
        .collect();
    templates.extend(attachment_templates);
    ListResourceTemplatesResult::with_all_items(templates)
}

/// Read an MCP resource by URI.
pub async fn read_resource(
    server: &NteractMcp,
    request: &ReadResourceRequestParams,
) -> Result<ReadResourceResult, McpError> {
    let uri = request.uri.as_str();

    if uri == OUTPUT_RESOURCE_URI {
        return Ok(ReadResourceResult::new(vec![
            ResourceContents::TextResourceContents {
                uri: OUTPUT_RESOURCE_URI.into(),
                mime_type: Some(OUTPUT_MIME_TYPE.into()),
                text: OUTPUT_HTML.to_string(),
                meta: Some(resource_ui_meta(&server.blob_base_url())),
            },
        ]));
    }

    match parse_notebook_resource_uri(uri).map_err(|message| {
        McpError::resource_not_found(message, Some(serde_json::json!({ "uri": uri })))
    })? {
        NotebookResourceUri::Notebooks => {
            let text = active_notebooks_json(server).await?;
            Ok(ReadResourceResult::new(vec![json_resource(uri, text)]))
        }
        NotebookResourceUri::Cells { notebook_id } => {
            let (notebook_id, handle_id, _handle, observer) =
                resource_session(server, &notebook_id, uri.starts_with("nteract://sessions/"))
                    .await?;
            let snapshot = observed_read(&observer)?;
            let text = cells_json(&notebook_id, &snapshot.snapshot, &handle_id);
            observed_resource(uri, text, &handle_id, &snapshot)
        }
        NotebookResourceUri::Cell {
            notebook_id,
            cell_id,
        } => {
            let (notebook_id, handle_id, _handle, observer) =
                resource_session(server, &notebook_id, uri.starts_with("nteract://sessions/"))
                    .await?;
            let snapshot = observed_read(&observer)?;
            let text = cell_json(&notebook_id, &snapshot.snapshot, &cell_id, &handle_id)?;
            observed_resource(uri, text, &handle_id, &snapshot)
        }
        NotebookResourceUri::Comments { notebook_id } => {
            let (_notebook_id, handle_id, handle, observer) =
                resource_session(server, &notebook_id, uri.starts_with("nteract://sessions/"))
                    .await?;
            // Settle pending comments/state frames so a read right after join
            // does not race the daemon's initial CommentsDocSync.
            let _ = handle.confirm_state_sync().await;
            let snapshot = observed_read(&observer)?;
            let projection =
                snapshot.snapshot.comments.as_ref().ok_or_else(|| {
                    McpError::internal_error("Comments are not available yet", None)
                })?;
            let text = serde_json::to_string_pretty(&projection)
                .map_err(|e| McpError::internal_error(format!("serialize comments: {e}"), None))?;
            observed_resource(uri, text, &handle_id, &snapshot)
        }
    }
}

fn resource(
    uri: impl Into<String>,
    name: impl Into<String>,
    description: impl Into<String>,
    mime_type: impl Into<String>,
    icon: IconKind,
    meta: Option<MetaObject>,
) -> Resource {
    let mut raw = Resource::new(uri, name);
    raw.description = Some(description.into());
    raw.mime_type = Some(mime_type.into());
    raw.icons = Some(icons::icons(icon));
    raw.meta = meta;
    raw
}

fn assistant_resource(
    uri: impl Into<String>,
    name: impl Into<String>,
    description: impl Into<String>,
    mime_type: impl Into<String>,
    icon: IconKind,
    priority: f32,
) -> Resource {
    resource(uri, name, description, mime_type, icon, None).with_annotations(
        Annotations::default()
            .with_audience(vec![Role::Assistant])
            .with_priority(priority),
    )
}

fn resource_template(
    uri_template: impl Into<String>,
    name: impl Into<String>,
    description: impl Into<String>,
    mime_type: impl Into<String>,
    icon: IconKind,
) -> ResourceTemplate {
    let mut raw = ResourceTemplate::new(uri_template, name);
    raw.description = Some(description.into());
    raw.mime_type = Some(mime_type.into());
    raw.icons = Some(icons::icons(icon));
    raw
}

fn assistant_resource_template(
    uri_template: impl Into<String>,
    name: impl Into<String>,
    description: impl Into<String>,
    mime_type: impl Into<String>,
    icon: IconKind,
    priority: f32,
) -> ResourceTemplate {
    resource_template(uri_template, name, description, mime_type, icon).with_annotations(
        Annotations::default()
            .with_audience(vec![Role::Assistant])
            .with_priority(priority),
    )
}

async fn active_notebooks_json(server: &NteractMcp) -> Result<String, McpError> {
    let client = runtimed_client::client::PoolClient::new(server.socket_path.clone());
    let rooms = client
        .list_rooms()
        .await
        .map_err(|e| McpError::internal_error(format!("Failed to list notebooks: {e}"), None))?;
    let visible: Vec<_> = rooms
        .into_iter()
        .filter(|r| !matches!(r.state, runtimed_client::protocol::RoomState::Inactive))
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({ "notebooks": visible }))
        .map_err(|e| McpError::internal_error(format!("Failed to serialize notebooks: {e}"), None))
}

async fn known_session_notebook_ids(server: &NteractMcp) -> Vec<String> {
    let mut notebook_ids = Vec::new();
    if let Some(session) = server.session.read().await.as_ref() {
        notebook_ids.push(session.notebook_id.clone());
    }
    for notebook_id in server.parked_sessions.read().await.keys() {
        if !notebook_ids.iter().any(|known_id| known_id == notebook_id) {
            notebook_ids.push(notebook_id.clone());
        }
    }
    notebook_ids
}

pub(crate) async fn resource_session(
    server: &NteractMcp,
    notebook_id: &str,
    by_handle: bool,
) -> Result<
    (
        String,
        String,
        notebook_sync::handle::DocHandle,
        ObservationReader,
    ),
    McpError,
> {
    let capture = |session: &crate::session::NotebookSession| {
        let access = session
            .access(crate::session::SessionRequirement::DocumentRead)
            .map_err(resource_session_access_error)?;
        let observer = session
            .observer()
            .map_err(|error| McpError::internal_error(error, None))?;
        Ok((
            session.notebook_id.clone(),
            session.notebook_handle.clone(),
            access.handle,
            observer,
        ))
    };
    let matches = |session: &crate::session::NotebookSession| {
        if by_handle {
            session.notebook_handle == notebook_id
        } else {
            session.notebook_id == notebook_id
        }
    };
    let mut found = {
        let active = server.session.read().await;
        active
            .as_ref()
            .filter(|session| matches(session))
            .map(capture)
            .transpose()?
    };
    {
        let parked = server.parked_sessions.read().await;
        for session in parked.values().filter(|session| matches(session)) {
            if let Some((_, handle, _, _)) = &found {
                if *handle == session.notebook_handle {
                    continue;
                }
                return Err(McpError::invalid_params("Ambiguous notebook ID; read its nteract://sessions/{notebook_handle} resource instead", None));
            }
            found = Some(capture(session)?);
        }
    }
    if let Some(found) = found {
        return Ok(found);
    }
    Err(McpError::resource_not_found(
        format!(
            "Notebook resource requires a connected or parked session for notebook_id {notebook_id}. \
             Call connect_notebook first."
        ),
        None,
    ))
}

fn observed_read(observer: &ObservationReader) -> Result<ChangeRead, McpError> {
    let read = observer
        .read(None)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    if read.outcome == ChangeOutcome::Unavailable {
        return Err(McpError::resource_not_found(
            "Notebook attachment is no longer available",
            None,
        ));
    }
    Ok(read)
}

fn observed_resource(
    uri: &str,
    text: String,
    handle: &str,
    read: &ChangeRead,
) -> Result<ReadResourceResult, McpError> {
    let mut data: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    data["cursor"] = serde_json::json!(read.cursor);
    data["notebook_handle"] = serde_json::json!(handle);
    Ok(
        ReadResourceResult::new(vec![json_resource(uri, data.to_string())])
            .with_ttl_ms(0)
            .with_cache_scope(rmcp::model::CacheScope::Private),
    )
}

pub(crate) fn resource_session_access_error(error: crate::session::SessionAccessError) -> McpError {
    McpError::internal_error(
        serde_json::json!({
            "error": {
                "code": error.code,
                "message": error.message,
            },
            "session": error.readiness,
        })
        .to_string(),
        None,
    )
}

fn json_resource(uri: &str, text: String) -> ResourceContents {
    ResourceContents::TextResourceContents {
        uri: uri.into(),
        mime_type: Some("application/json".into()),
        text,
        meta: None,
    }
}

fn cells_json(notebook_id: &str, view: &ObservedNotebook, notebook_handle: &str) -> String {
    let cells = view.notebook.cells();
    let cell_entries: Vec<_> = cells
        .iter()
        .enumerate()
        .map(|(index, cell)| {
            let execution_id = view.notebook.execution_pointers.get(&cell.id);
            let execution = execution_id.and_then(|id| view.runtime.executions.get(id));
            let status = observed_cell_status(view, cell);
            serde_json::json!({
                "cell_id": cell.id,
                "uri": attachment_cell_uri(notebook_handle, &cell.id),
                "cell_type": cell.cell_type,
                "previous_cell_id": previous_cell_id(cells, index),
                "next_cell_id": next_cell_id(cells, index),
                "source_preview": source_preview(&cell.source, 160),
                "execution_id": execution_id,
                "execution_count": execution.and_then(|entry| entry.execution_count).map(|count| count.to_string()),
                "status": status,
                "outputs": summarize_outputs(execution.map(|entry| entry.outputs.as_slice()).unwrap_or(&[])),
            })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({
        "notebook_id": notebook_id,
        "cells": cell_entries,
    }))
    .unwrap_or_else(|_| "{}".into())
}

fn previous_cell_id(cells: &[notebook_doc::CellSnapshot], index: usize) -> Option<&str> {
    index
        .checked_sub(1)
        .and_then(|previous| cells.get(previous))
        .map(|cell| cell.id.as_str())
}

fn next_cell_id(cells: &[notebook_doc::CellSnapshot], index: usize) -> Option<&str> {
    cells.get(index + 1).map(|cell| cell.id.as_str())
}

fn cell_json(
    notebook_id: &str,
    view: &ObservedNotebook,
    cell_id: &str,
    notebook_handle: &str,
) -> Result<String, McpError> {
    let cell = view
        .notebook
        .get_cell(cell_id)
        .ok_or_else(|| McpError::resource_not_found(format!("Cell not found: {cell_id}"), None))?;
    let execution_id = view.notebook.execution_pointers.get(cell_id);
    let execution = execution_id.and_then(|id| view.runtime.executions.get(id));
    let execution_count = execution
        .and_then(|entry| entry.execution_count)
        .map(|count| count.to_string());
    let status = observed_cell_status(view, cell);
    let outputs = execution
        .map(|entry| entry.outputs.as_slice())
        .unwrap_or(&[]);
    let cells = view.notebook.cells();
    let cell_index = cells.iter().position(|candidate| candidate.id == cell_id);
    let previous_cell_id = cell_index.and_then(|index| previous_cell_id(cells, index));
    let next_cell_id = cell_index.and_then(|index| next_cell_id(cells, index));

    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "notebook_id": notebook_id,
        "cell": {
            "cell_id": cell.id,
            "uri": attachment_cell_uri(notebook_handle, cell_id),
            "cell_type": cell.cell_type,
            "previous_cell_id": previous_cell_id,
            "next_cell_id": next_cell_id,
            "source": cell.source,
            "metadata": cell.metadata,
            "tags": cell.tags(),
            "source_hidden": cell.is_source_hidden(),
            "outputs_hidden": cell.is_outputs_hidden(),
            "collapsed": cell.is_collapsed(),
            "execution_id": execution_id,
            "execution_count": execution_count,
            "status": status,
            "outputs": summarize_outputs(outputs),
        }
    }))
    .unwrap_or_else(|_| "{}".into()))
}

fn observed_cell_status<'a>(
    view: &'a ObservedNotebook,
    cell: &notebook_doc::CellSnapshot,
) -> Option<&'a str> {
    let Some(id) = view.notebook.execution_pointers.get(&cell.id) else {
        return (cell.cell_type == "code").then_some("never_run");
    };
    if view
        .runtime
        .queue
        .executing
        .as_ref()
        .is_some_and(|entry| &entry.execution_id == id)
    {
        return Some("running");
    }
    if view
        .runtime
        .queue
        .queued
        .iter()
        .any(|entry| &entry.execution_id == id)
    {
        return Some("queued");
    }
    view.runtime
        .executions
        .get(id)
        .map(|entry| entry.status.as_str())
        .filter(|status| matches!(*status, "done" | "error" | "cancelled"))
}

fn summarize_outputs(outputs: &[serde_json::Value]) -> Vec<serde_json::Value> {
    outputs
        .iter()
        .map(|output| {
            let mime_types = output
                .get("data")
                .and_then(|data| data.as_object())
                .map(|data| {
                    let mut keys: Vec<_> = data.keys().cloned().collect();
                    keys.sort();
                    keys
                })
                .unwrap_or_default();
            serde_json::json!({
                "output_id": output.get("output_id").and_then(|value| value.as_str()),
                "output_type": output.get("output_type").and_then(|value| value.as_str()),
                "mime_types": mime_types,
            })
        })
        .collect()
}

fn source_preview(source: &str, max_chars: usize) -> String {
    let mut preview: String = source.chars().take(max_chars).collect();
    if source.chars().count() > max_chars {
        preview.push_str("...");
    }
    preview
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NotebookResourceUri {
    Notebooks,
    Cells {
        notebook_id: String,
    },
    Cell {
        notebook_id: String,
        cell_id: String,
    },
    Comments {
        notebook_id: String,
    },
}

pub(crate) fn parse_notebook_resource_uri(uri: &str) -> Result<NotebookResourceUri, String> {
    if uri == NOTEBOOKS_RESOURCE_URI {
        return Ok(NotebookResourceUri::Notebooks);
    }

    let Some(rest) = uri
        .strip_prefix("nteract://notebooks/")
        .or_else(|| uri.strip_prefix("nteract://sessions/"))
    else {
        return Err(format!("Unknown nteract resource URI: {uri}"));
    };
    let parts: Vec<&str> = rest.split('/').collect();
    match parts.as_slice() {
        [notebook_id, "cells"] => Ok(NotebookResourceUri::Cells {
            notebook_id: decode_segment(notebook_id)?,
        }),
        [notebook_id, "cells", cell_id] => Ok(NotebookResourceUri::Cell {
            notebook_id: decode_segment(notebook_id)?,
            cell_id: decode_segment(cell_id)?,
        }),
        [notebook_id, "comments"] => Ok(NotebookResourceUri::Comments {
            notebook_id: decode_segment(notebook_id)?,
        }),
        _ => Err(format!("Unknown nteract resource URI: {uri}")),
    }
}

pub(crate) fn attachment_cells_uri(notebook_handle: &str) -> String {
    format!(
        "nteract://sessions/{}/cells",
        encode_segment(notebook_handle)
    )
}

pub(crate) fn attachment_cells_resource_link(notebook_handle: &str) -> Resource {
    let mut resource = notebook_cells_resource_link(notebook_handle);
    resource.uri = attachment_cells_uri(notebook_handle);
    resource
}

pub(crate) fn attachment_cell_resource_link(notebook_handle: &str, cell_id: &str) -> Resource {
    let mut resource = notebook_cell_resource_link(notebook_handle, cell_id);
    resource.uri = attachment_cell_uri(notebook_handle, cell_id);
    resource
}

fn attachment_cell_uri(notebook_handle: &str, cell_id: &str) -> String {
    format!(
        "{}/{}",
        attachment_cells_uri(notebook_handle),
        encode_segment(cell_id)
    )
}

pub(crate) fn notebook_cells_uri(notebook_id: &str) -> String {
    format!(
        "{NOTEBOOKS_RESOURCE_URI}/{}/cells",
        encode_segment(notebook_id)
    )
}

pub(crate) fn notebook_cell_uri(notebook_id: &str, cell_id: &str) -> String {
    format!(
        "{}/{}",
        notebook_cells_uri(notebook_id),
        encode_segment(cell_id)
    )
}

pub(crate) fn notebook_resources_json(notebook_id: &str) -> serde_json::Value {
    serde_json::json!({
        "cells": notebook_cells_uri(notebook_id),
        "cell_template": format!("{}/{{cell_id}}", notebook_cells_uri(notebook_id)),
    })
}

pub(crate) fn notebook_cells_resource_link(notebook_id: &str) -> Resource {
    let mut resource = Resource::new(
        notebook_cells_uri(notebook_id),
        format!("nteract cells {notebook_id}"),
    );
    resource.description = Some("Ordered cell list for the notebook session".into());
    resource.mime_type = Some(CELLS_MIME_TYPE.into());
    resource.icons = Some(icons::icons(IconKind::ListActiveNotebooks));
    resource
}

pub(crate) fn notebook_cell_resource_link(notebook_id: &str, cell_id: &str) -> Resource {
    let mut resource = Resource::new(
        notebook_cell_uri(notebook_id, cell_id),
        format!("nteract cell {cell_id}"),
    );
    resource.description = Some("Notebook cell snapshot".into());
    resource.mime_type = Some(CELLS_MIME_TYPE.into());
    resource.icons = Some(icons::icons(IconKind::ReadCell));
    resource
}

fn encode_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn decode_segment(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(format!(
                    "Invalid percent encoding in resource URI segment: {value}"
                ));
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| {
                format!("Invalid percent encoding in resource URI segment: {value}")
            })?;
            let byte = u8::from_str_radix(hex, 16).map_err(|_| {
                format!("Invalid percent encoding in resource URI segment: {value}")
            })?;
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded)
        .map_err(|_| format!("Invalid UTF-8 in resource URI segment: {value}"))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rmcp::model::{
        Annotations, CallToolResult, ContentBlock, MetaObject, ReadResourceRequestParams, Role,
    };

    use super::*;
    use crate::NteractMcp;

    fn ui_meta(meta: &MetaObject) -> &serde_json::Value {
        meta.0.get("ui").expect("ui metadata")
    }

    fn assert_assistant_context_annotations(annotations: &Annotations) {
        assert_eq!(annotations.audience.as_ref(), Some(&vec![Role::Assistant]));
        assert_eq!(annotations.priority, Some(NOTEBOOK_CONTEXT_PRIORITY));
        assert!(annotations.last_modified.is_none());
    }

    fn assert_light_dark_icons(icons: &[rmcp::model::Icon]) {
        assert_eq!(icons.len(), 2);
        assert!(icons
            .iter()
            .all(|icon| icon.src.starts_with("data:image/png;base64,")));
        assert!(icons.iter().any(|icon| {
            icon.theme == Some(rmcp::model::IconTheme::Light)
                && icon.mime_type.as_deref() == Some("image/png")
        }));
        assert!(icons.iter().any(|icon| {
            icon.theme == Some(rmcp::model::IconTheme::Dark)
                && icon.mime_type.as_deref() == Some("image/png")
        }));
    }

    #[test]
    fn output_resource_meta_includes_blob_domains_for_mcp_ui_csp() {
        let meta = resource_ui_meta(&Some("https://outputs.example.test".into()));
        let ui = ui_meta(&meta);
        let csp = ui.get("csp").expect("csp metadata");

        assert_eq!(ui.get("prefersBorder"), Some(&serde_json::json!(false)));
        assert_eq!(
            csp.get("resourceDomains")
                .and_then(|value| value.as_array())
                .expect("resource domains")[0],
            "https://outputs.example.test"
        );
        assert_eq!(
            csp.get("connectDomains")
                .and_then(|value| value.as_array())
                .expect("connect domains")[0],
            "https://outputs.example.test"
        );
        assert_eq!(
            csp.get("frameDomains")
                .and_then(|value| value.as_array())
                .expect("frame domains")[0],
            "https://outputs.example.test"
        );
    }

    #[test]
    fn output_resource_meta_omits_csp_without_blob_base_url() {
        let meta = resource_ui_meta(&None);
        let ui = ui_meta(&meta);

        assert_eq!(ui.get("prefersBorder"), Some(&serde_json::json!(false)));
        assert!(ui.get("csp").is_none());
    }

    #[tokio::test]
    async fn list_resources_exposes_output_resource_ui_meta() {
        let server = NteractMcp::new(
            PathBuf::from("/tmp/missing.sock"),
            Some("https://outputs.example.test".into()),
            None,
        );

        let result = list_resources(&server).await.expect("list resources");
        let resource = result.resources.first().expect("output resource");
        let meta = resource.meta.as_ref().expect("resource metadata");
        let ui = ui_meta(meta);

        assert_eq!(resource.uri, OUTPUT_RESOURCE_URI);
        assert!(resource.annotations.is_none());
        assert_light_dark_icons(resource.icons.as_deref().expect("resource icons"));
        assert_eq!(ui.get("prefersBorder"), Some(&serde_json::json!(false)));
        assert!(ui.get("csp").is_some());
    }

    #[tokio::test]
    async fn resource_list_round_trips_flat_descriptors() {
        let server = NteractMcp::new(PathBuf::from("/tmp/missing.sock"), None, None);
        let result = list_resources(&server).await.expect("list resources");
        let wire = serde_json::to_value(&result).expect("serialize resource list");
        assert!(wire.get("nextCursor").is_none());
        assert!(wire.get("ttlMs").is_none());
        assert!(wire.get("cacheScope").is_none());
        assert_eq!(
            wire.pointer("/resources/0/_meta/ui/prefersBorder"),
            Some(&serde_json::json!(false))
        );
        assert_eq!(
            wire.pointer("/resources/1/annotations/audience"),
            Some(&serde_json::json!(["assistant"]))
        );
        assert_eq!(
            wire.pointer("/resources/1/annotations/priority"),
            Some(&serde_json::json!(NOTEBOOK_CONTEXT_PRIORITY))
        );
        assert!(wire.pointer("/resources/0/raw").is_none());
        let decoded: ListResourcesResult =
            serde_json::from_value(wire).expect("deserialize resource list");
        assert_eq!(decoded, result);
    }

    #[tokio::test]
    async fn read_output_resource_serializes_standard_mcp_apps_csp() {
        let server = NteractMcp::new(
            PathBuf::from("/tmp/missing.sock"),
            Some("http://localhost:47820".into()),
            None,
        );

        let result = read_resource(
            &server,
            &ReadResourceRequestParams::new(OUTPUT_RESOURCE_URI),
        )
        .await
        .expect("read output resource");
        let expected = serde_json::to_value(&result).expect("serialize resource result");
        let response: rmcp::model::ReadResourceResponse = result.into();
        let wire = serde_json::to_value(rmcp::model::ServerResult::from(response))
            .expect("serialize resource response");
        assert_eq!(wire, expected);
        let content = wire
            .pointer("/contents/0")
            .expect("serialized output resource content");

        assert_eq!(
            content.get("uri"),
            Some(&serde_json::json!(OUTPUT_RESOURCE_URI))
        );
        assert_eq!(
            content.get("mimeType"),
            Some(&serde_json::json!(OUTPUT_MIME_TYPE))
        );
        assert_eq!(
            content.pointer("/_meta/ui/csp"),
            Some(&serde_json::json!({
                "connectDomains": ["http://localhost:47820"],
                "resourceDomains": ["http://localhost:47820"],
                "frameDomains": ["http://localhost:47820"]
            }))
        );
        assert!(content
            .get("_meta")
            .and_then(|meta| meta.get("openai/widgetCSP"))
            .is_none());
    }

    #[tokio::test]
    async fn list_resources_includes_notebook_collection_resource() {
        let server = NteractMcp::new(PathBuf::from("/tmp/missing.sock"), None, None);

        let result = list_resources(&server).await.expect("list resources");

        let resource = result
            .resources
            .iter()
            .find(|resource| resource.uri == NOTEBOOKS_RESOURCE_URI)
            .expect("notebook collection resource");

        assert_assistant_context_annotations(
            resource
                .annotations
                .as_ref()
                .expect("notebook resource annotations"),
        );
        assert_light_dark_icons(resource.icons.as_deref().expect("resource icons"));
    }

    #[test]
    fn list_resource_templates_exposes_notebook_cell_templates() {
        let result = list_resource_templates();

        let templates: Vec<_> = result
            .resource_templates
            .iter()
            .map(|template| template.uri_template.as_str())
            .collect();

        assert!(templates.contains(&"nteract://notebooks/{notebook_id}/cells"));
        assert!(templates.contains(&"nteract://notebooks/{notebook_id}/cells/{cell_id}"));

        for template in &result.resource_templates {
            assert_assistant_context_annotations(
                template
                    .annotations
                    .as_ref()
                    .expect("notebook resource template annotations"),
            );
            assert_light_dark_icons(template.icons.as_deref().expect("template icons"));
        }
    }

    #[test]
    fn list_resource_templates_serialize_with_mcp_field_names() {
        let value = serde_json::to_value(list_resource_templates()).expect("serialize templates");
        let templates = value
            .get("resourceTemplates")
            .and_then(serde_json::Value::as_array)
            .expect("MCP resourceTemplates field");

        assert!(value.get("resource_templates").is_none());

        let cells_template = templates
            .iter()
            .find(|template| {
                template.get("uriTemplate")
                    == Some(&serde_json::json!(
                        "nteract://notebooks/{notebook_id}/cells"
                    ))
            })
            .expect("cells resource template");

        assert!(cells_template.get("uri_template").is_none());
        assert_eq!(
            cells_template.get("mimeType"),
            Some(&serde_json::json!(CELLS_MIME_TYPE))
        );
        assert_eq!(
            cells_template
                .get("annotations")
                .and_then(|annotations| annotations.get("audience")),
            Some(&serde_json::json!(["assistant"]))
        );
        assert_eq!(
            cells_template
                .get("annotations")
                .and_then(|annotations| annotations.get("priority")),
            Some(&serde_json::json!(NOTEBOOK_CONTEXT_PRIORITY))
        );
    }

    #[test]
    fn notebook_resource_uri_round_trips_percent_encoded_segments() {
        let uri = notebook_cell_uri("nb 1", "cell/with/slash");

        assert_eq!(
            parse_notebook_resource_uri(&uri).expect("parse uri"),
            NotebookResourceUri::Cell {
                notebook_id: "nb 1".to_string(),
                cell_id: "cell/with/slash".to_string()
            }
        );
    }

    #[tokio::test]
    async fn resource_body_keeps_its_snapshot_cursor_and_execution_pointer() {
        let fixture = crate::observation::tests::fixture();
        fixture
            .notebook
            .send_replace(crate::observation::tests::edited("old source"));
        fixture.notebook.send_modify(|notebook| {
            std::sync::Arc::make_mut(&mut notebook.execution_pointers)
                .insert("cell-1".into(), "run-1".into());
        });
        fixture.runtime.send_modify(|runtime| {
            runtime.executions.insert("run-1".into(), serde_json::from_value(serde_json::json!({"status":"done","execution_count":3,"outputs":[{"output_type":"stream","text":{"inline":"old output"}}]})).unwrap());
            runtime.executions.insert("run-2".into(), serde_json::from_value(serde_json::json!({"status":"running","execution_count":4,"outputs":[]})).unwrap());
        });
        let observer = fixture.owner.reader();
        let selected = observed_read(&observer).unwrap();
        fixture
            .notebook
            .send_replace(crate::observation::tests::edited("new source"));
        let uri = attachment_cell_uri("attachment", "cell-1");
        let body = cell_json("notebook", &selected.snapshot, "cell-1", "attachment").unwrap();
        let resource = observed_resource(&uri, body, "attachment", &selected).unwrap();
        let data = serde_json::to_value(resource).unwrap();
        let body: serde_json::Value =
            serde_json::from_str(data["contents"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["cursor"], selected.cursor);
        assert_eq!(body["cell"]["source"], "old source");
        assert_eq!(body["cell"]["execution_id"], "run-1");
        assert_eq!(body["cell"]["execution_count"], "3");
        assert_eq!(body["cell"]["status"], "done");
        assert_eq!(body["cell"]["outputs"].as_array().unwrap().len(), 1);
        assert_eq!(
            observer.read(Some(&selected.cursor)).unwrap().outcome,
            ChangeOutcome::Changed
        );
    }

    #[test]
    fn notebook_resources_json_points_to_encoded_cell_resources() {
        let resources = notebook_resources_json("nb 1");

        assert_eq!(
            resources.get("cells"),
            Some(&serde_json::json!("nteract://notebooks/nb%201/cells"))
        );
        assert_eq!(
            resources.get("cell_template"),
            Some(&serde_json::json!(
                "nteract://notebooks/nb%201/cells/{cell_id}"
            ))
        );
    }

    #[test]
    fn notebook_cell_resource_link_uses_encoded_uri() {
        let resource = notebook_cell_resource_link("nb 1", "cell/with/slash");

        assert_eq!(
            resource.uri,
            "nteract://notebooks/nb%201/cells/cell%2Fwith%2Fslash"
        );
        assert_eq!(resource.mime_type.as_deref(), Some(CELLS_MIME_TYPE));
        assert_light_dark_icons(resource.icons.as_deref().expect("resource icons"));
    }

    #[test]
    fn notebook_resource_link_content_round_trips_mcp_wire_format() {
        let expected_uri = "nteract://notebooks/nb%201/cells/cell%2Fwith%2Fslash";
        let result = CallToolResult::success(vec![ContentBlock::resource_link(
            notebook_cell_resource_link("nb 1", "cell/with/slash"),
        )]);
        let value = serde_json::to_value(&result).expect("serialize resource link");
        let content = value
            .get("content")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .expect("first content item");

        assert_eq!(
            content.get("type"),
            Some(&serde_json::json!("resource_link"))
        );
        assert_eq!(content.get("uri"), Some(&serde_json::json!(expected_uri)));
        assert_eq!(
            content.get("mimeType"),
            Some(&serde_json::json!(CELLS_MIME_TYPE))
        );
        assert!(content.get("mime_type").is_none());

        let decoded: CallToolResult =
            serde_json::from_value(value).expect("deserialize resource link");
        let link = decoded.content[0]
            .as_resource_link()
            .expect("resource link content");
        assert_eq!(link.uri, expected_uri);
        assert_eq!(link.mime_type.as_deref(), Some(CELLS_MIME_TYPE));
    }

    #[test]
    fn unknown_notebook_resource_uri_is_rejected() {
        let params = ReadResourceRequestParams::new("nteract://notebooks/nb-1/outputs");

        let error = parse_notebook_resource_uri(params.uri.as_str()).expect_err("invalid uri");

        assert!(error.contains("Unknown nteract resource URI"));
    }
}
