#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Exercise live private-child admission without a daemon or desktop app.
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use rmcp::model::*;
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData, ServerHandler, ServiceExt};
use runt_mcp_proxy::{McpProxy, ProxyConfig};
use serde_json::{json, Value};

const CHILD_ROOT: &str = "NTERACT_ID_ADMISSION_FIXTURE_ROOT";
const NOTEBOOK: &str = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_NOTEBOOK: &str = "a1b2c3d4-e5f6-4789-9abc-0123456789ab";
const DEADLINE: Duration = Duration::from_secs(15);

fn catalog(mode: &str) -> Vec<Tool> {
    let mut tools = ["create_cell", "set_cell", "resolve_notebook_launch"]
        .into_iter()
        .map(|name| {
            Tool::new(
                name,
                "Private notebook-routing admission fixture",
                json!({"type":"object","properties":{}})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
        })
        .collect::<Vec<_>>();
    match mode {
        "ids" => mcp_transport::notebook_target_tool_schemas(&mut tools),
        "handles" => mcp_transport::attachment_tool_schemas(&mut tools),
        "implicit" => {}
        // A version marker alone is not the promised exclusive target contract.
        "marker-only" => {
            for tool in &mut tools {
                std::sync::Arc::make_mut(&mut tool.input_schema)
                    .insert("x-nteract-notebook-target-version".into(), json!(1));
            }
        }
        other => panic!("unknown fixture catalog: {other}"),
    }
    tools
}

struct Child {
    root: PathBuf,
}

impl ServerHandler for Child {
    fn get_info(&self) -> ServerInfo {
        serde_json::from_value(json!({
            "protocolVersion":"2025-11-25",
            "capabilities":{"tools":{}},
            "serverInfo":{"name":"notebook-id-admission-fixture","version":"1"}
        }))
        .unwrap()
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mode = std::fs::read_to_string(self.root.join("catalog")).unwrap();
        Ok(ListToolsResult::with_all_items(catalog(&mode)))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        // Record every dispatch, even an unsupported target. A permissive old
        // worker would otherwise silently perform the wrong implicit effect.
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join("calls.jsonl"))
            .unwrap();
        writeln!(log, "{}", serde_json::to_string(&request).unwrap()).unwrap();
        let payload = if request.name == "resolve_notebook_launch" {
            serde_json::from_slice(&std::fs::read(self.root.join("launch.json")).unwrap()).unwrap()
        } else {
            json!({"name":request.name,"arguments":request.arguments})
        };
        let mut result = CallToolResult::success(vec![ContentBlock::text(payload.to_string())]);
        result.structured_content = Some(payload);
        Ok(result.into())
    }
}

#[test]
fn notebook_id_admission_child_process() {
    let Some(root) = std::env::var_os(CHILD_ROOT) else {
        return;
    };
    let root = PathBuf::from(root);
    assert_eq!(
        std::env::var_os("RUNTIMED_SOCKET_PATH"),
        Some(root.join("unused.sock").into())
    );
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            Child { root }
                .serve(rmcp::transport::stdio())
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap();
        });
    std::process::exit(0);
}

struct Fixture {
    root: tempfile::TempDir,
    proxy: McpProxy,
}

impl Fixture {
    async fn start(mode: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("catalog"), mode).unwrap();
        let executable = std::env::current_exe().unwrap();
        // Deliberately seed a capable disk cache even for incapable workers.
        runt_mcp_proxy::tools::save_tool_cache(root.path(), &catalog("ids"));
        let root_string = root.path().to_string_lossy().into_owned();
        let proxy = McpProxy::new(
            ProxyConfig {
                resolve_child_command: Box::new(move || Ok(executable.clone())),
                child_args: [
                    "--exact",
                    "notebook_id_admission_child_process",
                    "--nocapture",
                    "--quiet",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
                child_env: HashMap::from([
                    (CHILD_ROOT.into(), root_string.clone()),
                    ("HOME".into(), root_string.clone()),
                    ("USERPROFILE".into(), root_string.clone()),
                    ("TMPDIR".into(), root_string.clone()),
                    ("RUNTIMED_DEV".into(), "0".into()),
                    ("RUNTIMED_WORKSPACE_PATH".into(), root_string),
                    (
                        "RUNTIMED_SOCKET_PATH".into(),
                        root.path()
                            .join("unused.sock")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    ("NTERACT_MCP_REJOIN_NOTEBOOK".into(), String::new()),
                ]),
                server_name: "notebook-id-admission-proxy".into(),
                cache_dir: Some(root.path().to_path_buf()),
                monitor_poll_interval_ms: 60_000,
                recovery_hint: "Isolated routing fixture".into(),
            },
            None,
        );
        assert!(proxy
            .state
            .read()
            .await
            .cached_tools
            .as_ref()
            .unwrap()
            .iter()
            .any(mcp_transport::tool_supports_notebook_ids));
        tokio::time::timeout(DEADLINE, proxy.init_child())
            .await
            .unwrap()
            .unwrap();
        Self { root, proxy }
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    async fn forward(&self, arguments: Value) -> Result<CallToolResult, ErrorData> {
        tokio::time::timeout(
            DEADLINE,
            self.proxy.forward_tool_call(request("set_cell", arguments)),
        )
        .await
        .expect("bounded proxy dispatch")
    }

    fn launch_result(&self, payload: Value) {
        std::fs::write(
            self.root.path().join("launch.json"),
            serde_json::to_vec(&payload).unwrap(),
        )
        .unwrap();
    }

    async fn stop(self) {
        self.proxy.shutdown_child().await;
    }
}

fn request(name: &str, arguments: Value) -> CallToolRequestParams {
    CallToolRequestParams::new(name.to_owned())
        .with_arguments(arguments.as_object().unwrap().clone())
}

fn assert_unsupported(result: Result<CallToolResult, ErrorData>) {
    match result {
        Err(error) => assert_eq!(
            error.data.as_ref().unwrap()["code"],
            "unsupported_notebook_target"
        ),
        Ok(result) => {
            assert_eq!(result.is_error, Some(true));
            assert_eq!(
                result.structured_content.as_ref().unwrap()["error"]["code"],
                "unsupported_notebook_target"
            );
        }
    }
}

#[tokio::test]
async fn capable_live_child_receives_ids_domains_and_exact_handles_unchanged() {
    let fixture = Fixture::start("ids").await;
    for arguments in [
        json!({"notebook_id":NOTEBOOK,"cell_id":"same-cell","source":"local"}),
        json!({"notebook_id":"hosted-id","domain":"https://configured.example","cell_id":"same-cell","source":"hosted"}),
        json!({"notebook_handle":"exact-owner","cell_id":"same-cell","source":"handle"}),
    ] {
        let result = fixture.forward(arguments.clone()).await.unwrap();
        assert_ne!(result.is_error, Some(true));
        assert_eq!(result.structured_content.unwrap()["arguments"], arguments);
    }
    assert_eq!(fixture.calls().len(), 3);
    assert_eq!(fixture.proxy.restart_count().await, 0);
    fixture.stop().await;
}

#[tokio::test]
async fn old_handle_child_rejects_ids_before_dispatch_but_keeps_handle_compatibility() {
    let fixture = Fixture::start("handles").await;
    assert_unsupported(
        fixture
            .forward(json!({"notebook_id":NOTEBOOK,"source":"must not run"}))
            .await,
    );
    assert!(fixture.calls().is_empty());
    let arguments = json!({"notebook_handle":"retained-owner","source":"allowed"});
    let result = fixture.forward(arguments.clone()).await.unwrap();
    assert_ne!(result.is_error, Some(true));
    assert_eq!(fixture.calls()[0]["arguments"], arguments);
    assert_eq!(fixture.proxy.restart_count().await, 0);
    fixture.stop().await;
}

#[tokio::test]
async fn cached_or_rewritten_catalog_cannot_authorize_an_implicit_child() {
    let fixture = Fixture::start("implicit").await;
    for advertised_mode in ["ids", "handles"] {
        // This is the proxy's published/cache state, never the private peer's
        // live tools/list result. Both kinds of optimistic rewrite are unsafe
        // as admission proof for this worker.
        fixture.proxy.state.write().await.cached_tools = Some(catalog(advertised_mode));
        for arguments in [
            json!({"notebook_id":NOTEBOOK}),
            json!({"notebook_handle":"owner"}),
        ] {
            assert_unsupported(fixture.forward(arguments).await);
        }
    }
    assert!(fixture.calls().is_empty());
    assert_eq!(fixture.proxy.restart_count().await, 0);
    fixture.stop().await;
}

#[tokio::test]
async fn admission_rechecks_live_contract_after_catalog_changes_and_rejects_marker_only() {
    let fixture = Fixture::start("ids").await;
    assert_ne!(
        fixture
            .forward(json!({"notebook_id":NOTEBOOK}))
            .await
            .unwrap()
            .is_error,
        Some(true)
    );
    for mode in ["implicit", "marker-only"] {
        std::fs::write(fixture.root.path().join("catalog"), mode).unwrap();
        fixture.proxy.state.write().await.cached_tools = Some(catalog("ids"));
        assert_unsupported(fixture.forward(json!({"notebook_id":NOTEBOOK})).await);
    }
    assert_eq!(
        fixture.calls().len(),
        1,
        "only the initial admitted call reached the worker"
    );
    assert_eq!(fixture.proxy.restart_count().await, 0);
    fixture.stop().await;
}

fn valid_launch() -> Value {
    json!({"notebook_id":NOTEBOOK,"notebook_handle":"address-owner","source":"local","socket_path":std::env::temp_dir().join("id-admission-fixture.sock"),"has_display":false})
}

#[tokio::test]
async fn launch_accepts_matching_canonical_local_id_and_captures_returned_owner() {
    let fixture = Fixture::start("ids").await;
    fixture.launch_result(valid_launch());
    for domain in [None, Some("local"), Some(" Desktop ")] {
        let mut arguments = json!({"notebook_id":NOTEBOOK.to_uppercase()});
        if let Some(domain) = domain {
            arguments["domain"] = json!(domain);
        }
        let mut launched = false;
        let result = fixture
            .proxy
            .admit_notebook_launch(request("show_notebook", arguments), |identity| {
                launched = true;
                assert_eq!(identity.notebook_id, NOTEBOOK);
                assert_eq!(identity.notebook_handle, "address-owner");
                assert_eq!(
                    identity.socket_path,
                    std::env::temp_dir().join("id-admission-fixture.sock")
                );
                assert!(!identity.has_display);
                Ok(CallToolResult::success(vec![]))
            })
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true));
        assert!(launched);
    }
    assert!(fixture
        .calls()
        .iter()
        .all(|call| call["name"] == "resolve_notebook_launch"));
    fixture.stop().await;
}

#[tokio::test]
async fn launch_rejects_other_notebook_or_hosted_authority_before_callback() {
    let fixture = Fixture::start("ids").await;
    for (arguments, field, bad_value) in [
        (
            json!({"notebook_id":NOTEBOOK}),
            "notebook_id",
            json!(OTHER_NOTEBOOK),
        ),
        (json!({"notebook_id":NOTEBOOK}), "source", json!("hosted")),
        (
            json!({"notebook_id":NOTEBOOK}),
            "notebook_handle",
            json!(""),
        ),
        (
            json!({"notebook_id":NOTEBOOK}),
            "socket_path",
            json!("relative.sock"),
        ),
        (
            json!({"notebook_id":NOTEBOOK,"domain":"https://configured.example"}),
            "source",
            json!("local"),
        ),
        (
            json!({"notebook_handle":"different-owner"}),
            "notebook_handle",
            json!("address-owner"),
        ),
    ] {
        let mut payload = valid_launch();
        payload[field] = bad_value;
        fixture.launch_result(payload);
        let mut launched = false;
        let result = fixture
            .proxy
            .admit_notebook_launch(request("show_notebook", arguments), |_| {
                launched = true;
                Ok(CallToolResult::success(vec![]))
            })
            .await;
        assert!(result.is_err(), "mismatched {field} must reject launch");
        assert!(!launched, "mismatched {field} reached desktop callback");
    }
    fixture.stop().await;
}
