//! MCP resource serving (output.html, notebook cells, status).

use rmcp::model::{
    Annotated, ListResourceTemplatesResult, ListResourcesResult, Meta, RawResource,
    RawResourceTemplate, ReadResourceRequestParams, ReadResourceResult, ResourceContents,
};
use rmcp::ErrorData as McpError;

use crate::NteractMcp;

const OUTPUT_RESOURCE_URI: &str = "ui://nteract/output.html";
const OUTPUT_MIME_TYPE: &str = "text/html;profile=mcp-app";
const NOTEBOOKS_RESOURCE_URI: &str = "nteract://notebooks";
const NOTEBOOKS_MIME_TYPE: &str = "application/json";
const CELLS_MIME_TYPE: &str = "application/json";

/// The compiled output renderer HTML, built by `apps/mcp-app/build-html.js`.
/// Build with: `cd apps/mcp-app && pnpm build`
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
/// assets. It is also needed in `frameDomains` so the MCP App can host shared
/// isolated output iframes from `{blob_base_url}/output-frame` instead of
/// depending on host-specific `srcdoc` CSP behavior. `resourceDomains` keeps
/// the daemon origin available for static sidecars and host implementations
/// that treat iframe resource loads conservatively.
///
/// Claude Desktop requires `localhost` (not `127.0.0.1`) for domain allowlists.
fn resource_ui_meta(blob_base_url: &Option<String>) -> Meta {
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
    Meta(meta)
}

/// List available MCP resources.
pub async fn list_resources(server: &NteractMcp) -> Result<ListResourcesResult, McpError> {
    let mut resources = Vec::new();
    resources.push(resource(
        OUTPUT_RESOURCE_URI,
        "nteract output",
        "Interactive output renderer for notebook cells",
        OUTPUT_MIME_TYPE,
        Some(resource_ui_meta(&server.blob_base_url)),
    ));
    resources.push(resource(
        NOTEBOOKS_RESOURCE_URI,
        "nteract notebooks",
        "Active notebook rooms visible to this MCP server",
        NOTEBOOKS_MIME_TYPE,
        None,
    ));

    for (notebook_id, handle) in known_session_handles(server).await {
        resources.push(resource(
            notebook_cells_uri(&notebook_id),
            format!("nteract cells {notebook_id}"),
            "Ordered cell list for a connected or parked notebook session",
            CELLS_MIME_TYPE,
            None,
        ));
        for cell in handle.get_cells() {
            resources.push(resource(
                notebook_cell_uri(&notebook_id, &cell.id),
                format!("nteract cell {}", cell.id),
                "Notebook cell snapshot for a connected or parked notebook session",
                CELLS_MIME_TYPE,
                None,
            ));
        }
    }

    Ok(ListResourcesResult {
        resources,
        next_cursor: None,
        meta: None,
    })
}

/// List available dynamic MCP resource templates.
pub fn list_resource_templates() -> ListResourceTemplatesResult {
    let templates = vec![
        resource_template(
            "nteract://notebooks/{notebook_id}/cells",
            "nteract notebook cells",
            "Ordered cell list for a connected or parked notebook session",
            CELLS_MIME_TYPE,
        ),
        resource_template(
            "nteract://notebooks/{notebook_id}/cells/{cell_id}",
            "nteract notebook cell",
            "Notebook cell snapshot for a connected or parked notebook session",
            CELLS_MIME_TYPE,
        ),
    ];

    ListResourceTemplatesResult {
        resource_templates: templates,
        next_cursor: None,
        meta: None,
    }
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
                meta: Some(resource_ui_meta(&server.blob_base_url)),
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
            let handle = handle_for_notebook(server, &notebook_id).await?;
            let text = cells_json(&notebook_id, &handle);
            Ok(ReadResourceResult::new(vec![json_resource(uri, text)]))
        }
        NotebookResourceUri::Cell {
            notebook_id,
            cell_id,
        } => {
            let handle = handle_for_notebook(server, &notebook_id).await?;
            let text = cell_json(&notebook_id, &handle, &cell_id)?;
            Ok(ReadResourceResult::new(vec![json_resource(uri, text)]))
        }
    }
}

fn resource(
    uri: impl Into<String>,
    name: impl Into<String>,
    description: impl Into<String>,
    mime_type: impl Into<String>,
    meta: Option<Meta>,
) -> Annotated<RawResource> {
    let mut raw = RawResource::new(uri, name);
    raw.description = Some(description.into());
    raw.mime_type = Some(mime_type.into());
    raw.meta = meta;
    Annotated {
        raw,
        annotations: None,
    }
}

fn resource_template(
    uri_template: impl Into<String>,
    name: impl Into<String>,
    description: impl Into<String>,
    mime_type: impl Into<String>,
) -> Annotated<RawResourceTemplate> {
    let mut raw = RawResourceTemplate::new(uri_template, name);
    raw.description = Some(description.into());
    raw.mime_type = Some(mime_type.into());
    Annotated {
        raw,
        annotations: None,
    }
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

async fn known_session_handles(
    server: &NteractMcp,
) -> Vec<(String, notebook_sync::handle::DocHandle)> {
    let mut handles = Vec::new();
    if let Some(session) = server.session.read().await.as_ref() {
        handles.push((session.notebook_id.clone(), session.handle.clone()));
    }
    for (notebook_id, session) in server.parked_sessions.read().await.iter() {
        if !handles.iter().any(|(known_id, _)| known_id == notebook_id) {
            handles.push((notebook_id.clone(), session.handle.clone()));
        }
    }
    handles
}

async fn handle_for_notebook(
    server: &NteractMcp,
    notebook_id: &str,
) -> Result<notebook_sync::handle::DocHandle, McpError> {
    if let Some(session) = server.session.read().await.as_ref() {
        if session.notebook_id == notebook_id {
            return Ok(session.handle.clone());
        }
    }
    if let Some(session) = server.parked_sessions.read().await.get(notebook_id) {
        return Ok(session.handle.clone());
    }
    Err(McpError::resource_not_found(
        format!(
            "Notebook resource requires a connected or parked session for notebook_id {notebook_id}. \
             Call connect_notebook first."
        ),
        None,
    ))
}

fn json_resource(uri: &str, text: String) -> ResourceContents {
    ResourceContents::TextResourceContents {
        uri: uri.into(),
        mime_type: Some("application/json".into()),
        text,
        meta: None,
    }
}

fn cells_json(notebook_id: &str, handle: &notebook_sync::handle::DocHandle) -> String {
    let status_by_cell = crate::tools::cell_read::build_cell_status_map(handle);
    let execution_count_by_cell = crate::tools::cell_read::build_cell_execution_count_map(handle);
    let outputs_by_cell = handle.get_all_outputs();
    let cells: Vec<_> = handle
        .get_cells()
        .into_iter()
        .map(|cell| {
            let execution_id = handle.get_cell_execution_id(&cell.id);
            let status = status_by_cell.get(&cell.id).cloned().or_else(|| {
                (cell.cell_type == "code" && execution_id.is_none()).then(|| "never_run".into())
            });
            serde_json::json!({
                "cell_id": cell.id,
                "uri": notebook_cell_uri(notebook_id, &cell.id),
                "cell_type": cell.cell_type,
                "position": cell.position,
                "source_preview": source_preview(&cell.source, 160),
                "execution_id": execution_id,
                "execution_count": execution_count_by_cell.get(&cell.id),
                "status": status,
                "outputs": summarize_outputs(outputs_by_cell.get(&cell.id).map(Vec::as_slice).unwrap_or(&[])),
            })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({
        "notebook_id": notebook_id,
        "cells": cells,
    }))
    .unwrap_or_else(|_| "{}".into())
}

fn cell_json(
    notebook_id: &str,
    handle: &notebook_sync::handle::DocHandle,
    cell_id: &str,
) -> Result<String, McpError> {
    let cell = handle
        .get_cell(cell_id)
        .ok_or_else(|| McpError::resource_not_found(format!("Cell not found: {cell_id}"), None))?;
    let execution_id = handle.get_cell_execution_id(cell_id);
    let execution_count =
        crate::tools::cell_read::get_cell_execution_count_from_runtime(handle, cell_id);
    let status_by_cell = crate::tools::cell_read::build_cell_status_map(handle);
    let status = status_by_cell.get(cell_id).cloned().or_else(|| {
        (cell.cell_type == "code" && execution_id.is_none()).then(|| "never_run".into())
    });
    let outputs = handle.get_cell_outputs(cell_id).unwrap_or_default();
    let execution_count = (!execution_count.is_empty()).then_some(execution_count);

    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "notebook_id": notebook_id,
        "cell": {
            "cell_id": cell.id,
            "uri": notebook_cell_uri(notebook_id, cell_id),
            "cell_type": cell.cell_type,
            "position": cell.position,
            "source": cell.source,
            "metadata": cell.metadata,
            "tags": cell.tags(),
            "source_hidden": cell.is_source_hidden(),
            "outputs_hidden": cell.is_outputs_hidden(),
            "collapsed": cell.is_collapsed(),
            "execution_id": execution_id,
            "execution_count": execution_count,
            "status": status,
            "outputs": summarize_outputs(&outputs),
        }
    }))
    .unwrap_or_else(|_| "{}".into()))
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
enum NotebookResourceUri {
    Notebooks,
    Cells {
        notebook_id: String,
    },
    Cell {
        notebook_id: String,
        cell_id: String,
    },
}

fn parse_notebook_resource_uri(uri: &str) -> Result<NotebookResourceUri, String> {
    if uri == NOTEBOOKS_RESOURCE_URI {
        return Ok(NotebookResourceUri::Notebooks);
    }

    let Some(rest) = uri.strip_prefix("nteract://notebooks/") else {
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
        _ => Err(format!("Unknown nteract resource URI: {uri}")),
    }
}

fn notebook_cells_uri(notebook_id: &str) -> String {
    format!(
        "{NOTEBOOKS_RESOURCE_URI}/{}/cells",
        encode_segment(notebook_id)
    )
}

fn notebook_cell_uri(notebook_id: &str, cell_id: &str) -> String {
    format!(
        "{}/{}",
        notebook_cells_uri(notebook_id),
        encode_segment(cell_id)
    )
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

    use rmcp::model::{Meta, ReadResourceRequestParams};

    use super::*;
    use crate::NteractMcp;

    fn ui_meta(meta: &Meta) -> &serde_json::Value {
        meta.0.get("ui").expect("ui metadata")
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
        let meta = resource.raw.meta.as_ref().expect("resource metadata");
        let ui = ui_meta(meta);

        assert_eq!(resource.raw.uri, OUTPUT_RESOURCE_URI);
        assert_eq!(ui.get("prefersBorder"), Some(&serde_json::json!(false)));
        assert!(ui.get("csp").is_some());
    }

    #[tokio::test]
    async fn list_resources_includes_notebook_collection_resource() {
        let server = NteractMcp::new(PathBuf::from("/tmp/missing.sock"), None, None);

        let result = list_resources(&server).await.expect("list resources");

        assert!(result
            .resources
            .iter()
            .any(|resource| resource.raw.uri == NOTEBOOKS_RESOURCE_URI));
    }

    #[test]
    fn list_resource_templates_exposes_notebook_cell_templates() {
        let result = list_resource_templates();

        let templates: Vec<_> = result
            .resource_templates
            .iter()
            .map(|template| template.raw.uri_template.as_str())
            .collect();

        assert!(templates.contains(&"nteract://notebooks/{notebook_id}/cells"));
        assert!(templates.contains(&"nteract://notebooks/{notebook_id}/cells/{cell_id}"));
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

    #[test]
    fn unknown_notebook_resource_uri_is_rejected() {
        let params = ReadResourceRequestParams::new("nteract://notebooks/nb-1/outputs");

        let error = parse_notebook_resource_uri(params.uri.as_str()).expect_err("invalid uri");

        assert!(error.contains("Unknown nteract resource URI"));
    }
}
