//! MCP resource serving (output.html, notebook cells, status).

use rmcp::model::{
    Annotated, ListResourcesResult, Meta, RawResource, ReadResourceRequestParams,
    ReadResourceResult, ResourceContents,
};
use rmcp::ErrorData as McpError;

use crate::NteractMcp;

const OUTPUT_RESOURCE_URI: &str = "ui://nteract/output.html";
const OUTPUT_MIME_TYPE: &str = "text/html;profile=mcp-app";

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
    let mut raw = RawResource::new(OUTPUT_RESOURCE_URI, "nteract output");
    raw.description = Some("Interactive output renderer for notebook cells".into());
    raw.mime_type = Some(OUTPUT_MIME_TYPE.into());
    raw.meta = Some(resource_ui_meta(&server.blob_base_url));

    let resources = vec![Annotated {
        raw,
        annotations: None,
    }];

    Ok(ListResourcesResult {
        resources,
        next_cursor: None,
        meta: None,
    })
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

    Err(McpError::resource_not_found(
        format!("Unknown resource: {}", uri),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rmcp::model::Meta;

    use super::{list_resources, resource_ui_meta, OUTPUT_RESOURCE_URI};
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
}
