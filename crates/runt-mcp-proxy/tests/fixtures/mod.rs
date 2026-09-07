use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use rmcp_legacy::model::{
    CallToolRequestParams, CallToolResult, ClientInfo, ListResourceTemplatesResult,
    ListResourcesResult, ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams,
    ReadResourceResult, ServerInfo,
};
use rmcp_legacy::service::{NotificationContext, RequestContext, RoleServer};
use rmcp_legacy::{ClientHandler, ErrorData, ServerHandler};
use serde_json::json;

pub const CHILD_MODE: &str = "NTERACT_COMPATIBILITY_CHILD";
pub const READY: &str = "nteract-compatibility-fixture-ready";

pub fn child_args() -> Vec<String> {
    [
        "--exact",
        "compatibility_child_process",
        "--nocapture",
        "--quiet",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

pub fn child_env(dir: &Path, mode: &str) -> HashMap<String, String> {
    HashMap::from([
        (CHILD_MODE.into(), mode.into()),
        (
            "NTERACT_COMPATIBILITY_ROOT".into(),
            dir.to_string_lossy().into_owned(),
        ),
        ("HOME".into(), dir.to_string_lossy().into_owned()),
        ("USERPROFILE".into(), dir.to_string_lossy().into_owned()),
        (
            "XDG_CACHE_HOME".into(),
            dir.join("cache").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CONFIG_HOME".into(),
            dir.join("config").to_string_lossy().into_owned(),
        ),
        (
            "XDG_DATA_HOME".into(),
            dir.join("data").to_string_lossy().into_owned(),
        ),
        ("TMPDIR".into(), dir.to_string_lossy().into_owned()),
        ("TEMP".into(), dir.to_string_lossy().into_owned()),
        ("TMP".into(), dir.to_string_lossy().into_owned()),
        ("RUNTIMED_DEV".into(), "0".into()),
        (
            "RUNTIMED_WORKSPACE_PATH".into(),
            dir.to_string_lossy().into_owned(),
        ),
        (
            "RUNTIMED_SOCKET_PATH".into(),
            dir.join("daemon.sock").to_string_lossy().into_owned(),
        ),
        ("NTERACT_MCP_REJOIN_NOTEBOOK".into(), String::new()),
        (
            "NTERACT_MCP_OPERATOR_CLIENT".into(),
            "compatibility-client".into(),
        ),
        (
            "NTERACT_MCP_OPERATOR_SESSION".into(),
            "compatibility-session".into(),
        ),
    ])
}

pub struct LegacyClient(pub &'static str);

impl ClientHandler for LegacyClient {
    fn get_info(&self) -> ClientInfo {
        serde_json::from_value(json!({
            "protocolVersion": self.0,
            "capabilities": {},
            "clientInfo": {"name": "rmcp-1.5-client", "version": "1.5.0", "title": "Legacy Client"}
        }))
        .expect("legacy client info")
    }
}

struct LegacyChild {
    initialized: std::sync::atomic::AtomicBool,
}

impl ServerHandler for LegacyChild {
    fn get_info(&self) -> ServerInfo {
        serde_json::from_value(json!({
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "rmcp-1.5-child", "version": "1.5.0"}
        }))
        .expect("legacy child server info")
    }

    async fn on_initialized(&self, _context: NotificationContext<RoleServer>) {
        self.initialized
            .store(true, std::sync::atomic::Ordering::Release);
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(serde_json::from_value(json!({
            "tools": [{"name": "compatibility_echo", "description": "Pinned SDK fixture", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}}}]
        })).expect("legacy tool definitions"))
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(serde_json::from_value(json!({
            "resources": [{"uri": "compatibility://resource", "name": "legacy-resource", "mimeType": "text/plain"}]
        })).expect("legacy resource definitions"))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(serde_json::from_value(json!({
            "resourceTemplates": [{"uriTemplate": "compatibility://{id}", "name": "legacy-template"}]
        })).expect("legacy resource templates"))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        if request.uri != "compatibility://resource" {
            return Err(ErrorData::resource_not_found(
                "Missing fixture resource",
                None,
            ));
        }
        Ok(serde_json::from_value(json!({
            "contents": [{"uri": request.uri, "mimeType": "text/plain", "text": "legacy resource\nλ", "_meta": {"compatibility/preserved": true}}]
        })).expect("legacy resource result"))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if request.name != "compatibility_echo" {
            return Err(ErrorData::invalid_params("Unknown fixture tool", None));
        }
        let info = context
            .peer
            .peer_info()
            .expect("legacy child must have initialized peer info");
        let payload = json!({
            "arguments": request.arguments,
            "clientInfo": info.client_info,
            "protocolVersion": info.protocol_version,
            "capabilities": info.capabilities,
            "operatorSession": std::env::var("NTERACT_MCP_OPERATOR_SESSION").expect("operator session"),
            "operatorClient": std::env::var("NTERACT_MCP_OPERATOR_CLIENT").expect("operator client"),
            "initialized": self.initialized.load(std::sync::atomic::Ordering::Acquire)
        });
        Ok(serde_json::from_value(json!({
            "content": [{"type": "text", "text": payload.to_string()}],
            "structuredContent": payload,
            "isError": false,
            "_meta": {"compatibility/preserved": true}
        }))
        .expect("legacy tool result"))
    }
}

pub fn run_child_if_requested() {
    let Ok(mode) = std::env::var(CHILD_MODE) else {
        return;
    };
    let root = std::path::PathBuf::from(
        std::env::var("NTERACT_COMPATIBILITY_ROOT").expect("controlled child root"),
    );
    assert_eq!(
        std::env::var_os("HOME").expect("controlled HOME"),
        root.as_os_str()
    );
    assert_eq!(
        std::env::var_os("RUNTIMED_SOCKET_PATH").expect("controlled socket"),
        root.join("daemon.sock").as_os_str()
    );
    assert_eq!(
        std::env::var("NTERACT_MCP_REJOIN_NOTEBOOK").expect("controlled rejoin"),
        ""
    );
    std::fs::write(root.join("child-started"), std::process::id().to_string())
        .expect("record fixture spawn");
    println!("{READY}");
    std::io::stdout()
        .flush()
        .expect("flush fixture readiness marker");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("fixture runtime");
    runtime.block_on(async {
        match mode.as_str() {
            "legacy" => {
                use rmcp_legacy::ServiceExt;
                LegacyChild {
                    initialized: std::sync::atomic::AtomicBool::new(false),
                }
                .serve(rmcp_legacy::transport::stdio())
                .await
                .expect("serve pinned legacy child")
                .waiting()
                .await
                .expect("legacy child service");
            }
            "new" => {
                use rmcp::ServiceExt;
                runt_mcp::NteractMcp::new_no_show(
                    root.join("daemon.sock"),
                    None,
                    Some(root.join("blobs")),
                )
                .with_execution_store_path(Some(root.join("executions")))
                .serve(rmcp::transport::stdio())
                .await
                .expect("serve production new child")
                .waiting()
                .await
                .expect("new child service");
            }
            _ => panic!("unknown compatibility fixture mode"),
        }
    });
    std::process::exit(0);
}
