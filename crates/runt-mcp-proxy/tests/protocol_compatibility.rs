#![allow(clippy::unwrap_used, clippy::expect_used)]

mod fixtures;
#[path = "../../runt-mcp/tests/support/mod.rs"]
mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use runt_mcp_proxy::{McpProxy, ProxyConfig};
use serde_json::{json, Value};
use support::{
    assert_initialize, assert_unsupported, legacy_result, modern_meta, modern_requests, Wire,
    DEADLINE, LEGACY_VERSIONS,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::time::timeout;

#[test]
fn compatibility_child_process() {
    fixtures::run_child_if_requested();
}

fn isolated_proxy() -> (tempfile::TempDir, McpProxy, Arc<AtomicUsize>) {
    isolated_proxy_with_mode("legacy")
}

fn isolated_proxy_with_mode(mode: &str) -> (tempfile::TempDir, McpProxy, Arc<AtomicUsize>) {
    let dir = tempfile::tempdir().expect("isolated proxy directory");
    runt_mcp_proxy::tools::save_tool_cache(
        dir.path(),
        &[rmcp::model::Tool::new(
            "cached_compatibility_tool",
            "Cached fixture",
            serde_json::from_value::<serde_json::Map<String, Value>>(json!({"type": "object"}))
                .expect("tool schema"),
        )],
    );
    let executable = std::env::current_exe().expect("test executable");
    let resolves = Arc::new(AtomicUsize::new(0));
    let count = resolves.clone();
    let fail_resolution = dir.path().join("fail-resolution");
    let proxy = McpProxy::new(
        ProxyConfig {
            resolve_child_command: Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                if fail_resolution.exists() {
                    return Err("Fixture binary unavailable; restart your MCP session".into());
                }
                Ok(executable.clone())
            }),
            child_args: fixtures::child_args(),
            child_env: fixtures::child_env(dir.path(), mode),
            server_name: "compatibility-proxy".into(),
            cache_dir: Some(dir.path().to_path_buf()),
            monitor_poll_interval_ms: 60_000,
            recovery_hint: "Compatibility test fixture only".into(),
        },
        None,
    );
    (dir, proxy, resolves)
}

#[tokio::test]
async fn lost_mutation_response_is_not_replayed_even_with_read_only_hints() {
    for name in ["execute_cell", "future_mutation"] {
        let (dir, proxy, _) = isolated_proxy_with_mode("response-loss");
        proxy.init_child().await.expect("start response-loss child");
        let request = serde_json::from_value(json!({"name": name, "arguments": {}})).unwrap();
        let result = timeout(DEADLINE, proxy.forward_tool_call(request))
            .await
            .expect("bounded recovery")
            .expect("actionable tool result");
        assert_eq!(result.is_error, Some(true));
        let details = result
            .structured_content
            .as_ref()
            .expect("structured recovery guidance");
        assert_eq!(details["error"]["code"], "outcome_unknown");
        assert_eq!(details["error"]["retry_safe"], false);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("accepted-calls")).unwrap(),
            format!("{name}\n")
        );

        let read = serde_json::from_value(json!({"name": "get_results", "arguments": {}})).unwrap();
        let next = timeout(DEADLINE, proxy.forward_tool_call(read))
            .await
            .expect("recovered child responds")
            .expect("read recovered state");
        assert_ne!(next.is_error, Some(true));
        stop_child(&proxy).await;
    }
}

#[tokio::test]
async fn lost_read_response_is_retried_once() {
    let (dir, proxy, _) = isolated_proxy_with_mode("response-loss");
    proxy.init_child().await.expect("start response-loss child");
    let request = serde_json::from_value(json!({"name": "get_results", "arguments": {}})).unwrap();
    let result = timeout(DEADLINE, proxy.forward_tool_call(request))
        .await
        .expect("bounded recovery")
        .expect("read retry");
    assert_ne!(result.is_error, Some(true));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("accepted-calls")).unwrap(),
        "get_results\nget_results\n"
    );
    stop_child(&proxy).await;
}

#[tokio::test]
async fn mutation_can_run_once_when_the_stored_child_was_already_closed() {
    let (dir, proxy, _) = isolated_proxy_with_mode("response-loss");
    proxy.init_child().await.unwrap();
    let mut child = proxy.state.write().await.child_client.take().unwrap();
    child.close().await.unwrap();
    proxy.state.write().await.child_client = Some(child);
    // Disable the fault for the replacement: no request has been accepted.
    std::fs::write(dir.path().join("accepted-calls"), "").unwrap();
    let request = serde_json::from_value(json!({"name":"execute_cell","arguments":{}})).unwrap();
    let result = timeout(DEADLINE, proxy.forward_tool_call(request))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(result.is_error, Some(true));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("accepted-calls")).unwrap(),
        "execute_cell\n"
    );
    stop_child(&proxy).await;
}

#[tokio::test]
async fn definitive_protocol_error_is_preserved_without_restarting() {
    let (dir, proxy, resolves) = isolated_proxy_with_mode("response-loss");
    proxy.init_child().await.unwrap();
    let request =
        serde_json::from_value(json!({"name":"definitive_error","arguments":{}})).unwrap();
    let error = proxy.forward_tool_call(request).await.unwrap_err();
    assert_eq!(error.code, rmcp::model::ErrorCode::INVALID_PARAMS);
    assert_eq!(error.message, "Definitive fixture rejection");
    assert_eq!(resolves.load(Ordering::SeqCst), 1);
    assert!(!dir.path().join("accepted-calls").exists());
    stop_child(&proxy).await;
}

#[tokio::test]
async fn unknown_outcome_includes_failed_recovery_in_text() {
    let (dir, proxy, _) = isolated_proxy_with_mode("response-loss");
    proxy.init_child().await.unwrap();
    std::fs::write(dir.path().join("fail-resolution"), "fail").unwrap();
    let request = serde_json::from_value(json!({"name":"execute_cell","arguments":{}})).unwrap();
    let result = proxy.forward_tool_call(request).await.unwrap();
    assert_eq!(
        result.structured_content.as_ref().unwrap()["error"]["code"],
        "outcome_unknown"
    );
    let contents = serde_json::to_value(&result.content).unwrap();
    assert!(contents[0]["text"]
        .as_str()
        .unwrap()
        .contains("restart your MCP session"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("accepted-calls")).unwrap(),
        "execute_cell\n"
    );
    stop_child(&proxy).await;
}

#[tokio::test]
async fn lost_disconnect_response_does_not_restore_the_release_target() {
    let (dir, proxy, _) = isolated_proxy_with_mode("response-loss");
    proxy.init_child().await.unwrap();
    proxy.state.write().await.last_notebook_id = Some("released-notebook".into());
    let request =
        serde_json::from_value(json!({"name":"disconnect_notebook","arguments":{}})).unwrap();
    let result = proxy.forward_tool_call(request).await.unwrap();
    assert_eq!(
        result.structured_content.as_ref().unwrap()["error"]["code"],
        "outcome_unknown"
    );
    assert!(proxy.state.read().await.last_notebook_id.is_none());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("accepted-calls")).unwrap(),
        "disconnect_notebook\n"
    );
    stop_child(&proxy).await;
}

#[tokio::test]
async fn mutation_sent_after_initial_child_recovery_still_reports_lost_response() {
    let (dir, proxy, _) = isolated_proxy_with_mode("response-loss");
    // No previously advertised catalog: exercise startup, not incompatible
    // replacement of the deliberately unrelated optimistic test cache.
    proxy.state.write().await.cached_tools = None;
    let request = serde_json::from_value(json!({"name": "execute_cell", "arguments": {}})).unwrap();
    let result = timeout(DEADLINE, proxy.forward_tool_call(request))
        .await
        .expect("bounded startup")
        .expect("actionable result");
    assert_eq!(
        result.structured_content.unwrap()["error"]["code"],
        "outcome_unknown"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("accepted-calls")).unwrap(),
        "execute_cell\n"
    );
    stop_child(&proxy).await;
}

async fn assert_no_child(proxy: &McpProxy, resolves: &AtomicUsize, dir: &std::path::Path) {
    let state = proxy.state.read().await;
    assert!(state.child_client.is_none());
    assert_eq!(state.child_generation, 0);
    assert_eq!(state.restart_count, 0);
    assert!(state.child_spawn_time.is_none());
    assert!(state.last_restart_time.is_none());
    assert!(state.last_notebook_id.is_none());
    assert!(state.reconnection_message.is_none());
    assert!(!state.should_exit);
    assert_eq!(resolves.load(Ordering::SeqCst), 0);
    assert!(!dir.join("child-started").exists());
}

async fn stop_child(proxy: &McpProxy) {
    let child = {
        let mut state = proxy.state.write().await;
        state.child_client.take()
    };
    if let Some(child) = child {
        timeout(DEADLINE, child.cancel())
            .await
            .expect("child cancellation timed out")
            .expect("cancel child");
    }
}

#[tokio::test]
async fn stalled_subscription_does_not_block_later_watches() {
    let (_dir, proxy, _) = isolated_proxy();
    proxy.init_child().await.unwrap();
    let mut wire = Wire::start(proxy.clone());
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let response = wire
        .request(
            2,
            "resources/subscribe",
            Some(json!({"uri":"compatibility://stalled"})),
        )
        .await;
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("timed out"));
    assert_eq!(
        legacy_result(
            &wire
                .request(
                    3,
                    "resources/subscribe",
                    Some(json!({"uri":"compatibility://resource"}))
                )
                .await
        ),
        &json!({})
    );
    stop_child(&proxy).await;
    wire.finish().await;
}

#[tokio::test]
async fn subscriptions_wait_for_startup_and_rebind_after_child_replacement() {
    let (_dir, proxy, resolves) = isolated_proxy();
    let mut wire = Wire::start(proxy.clone());
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let uri = "compatibility://resource";
    assert_eq!(
        legacy_result(
            &wire
                .request(2, "resources/subscribe", Some(json!({"uri":uri})))
                .await
        ),
        &json!({})
    );
    wire.notification("notifications/resources/updated").await;
    wire.notifications.clear();
    proxy.restart_child().await.unwrap();
    assert_eq!(
        legacy_result(
            &wire
                .request(3, "resources/subscribe", Some(json!({"uri":uri})))
                .await
        ),
        &json!({})
    );
    assert_eq!(resolves.load(Ordering::SeqCst), 2);
    // The new child's subscribe emits an update before its acknowledgment.
    // Checking its call log distinguishes this from the old child's invalidation.
    assert_eq!(
        std::fs::read_to_string(_dir.path().join("subscription-calls"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    stop_child(&proxy).await;
    wire.finish().await;
}

#[tokio::test]
async fn resource_subscriptions_relay_early_notifications_and_invalidate_on_child_loss() {
    let (_dir, proxy, _) = isolated_proxy();
    proxy.init_child().await.unwrap();
    let mut wire = Wire::start(proxy.clone());
    let info = wire.initialize("2025-11-25").await;
    assert_eq!(
        legacy_result(&info)["capabilities"]["resources"]["subscribe"],
        true
    );
    wire.initialized().await;
    let uri = "compatibility://resource";
    let subscribed = wire
        .request(2, "resources/subscribe", Some(json!({"uri":uri})))
        .await;
    assert_eq!(legacy_result(&subscribed), &json!({}));
    wire.notification("notifications/resources/updated").await;
    assert!(wire
        .notifications
        .iter()
        .any(|notification| notification["params"]["uri"] == uri));
    wire.notifications.clear();
    let duplicate = wire
        .request(3, "resources/subscribe", Some(json!({"uri":uri})))
        .await;
    assert_eq!(legacy_result(&duplicate), &json!({}));
    let rejected = wire
        .request(
            4,
            "resources/subscribe",
            Some(json!({"uri":"compatibility://missing"})),
        )
        .await;
    assert_eq!(rejected["error"]["code"], -32002);
    stop_child(&proxy).await;
    wire.notification("notifications/resources/updated").await;
    assert!(wire
        .notifications
        .iter()
        .any(|notification| notification["params"]["uri"] == uri));
    let unsubscribed = wire
        .request(5, "resources/unsubscribe", Some(json!({"uri":uri})))
        .await;
    assert_eq!(legacy_result(&unsubscribed), &json!({}));
    wire.finish().await;
}

async fn legacy_proxy_wire(version: &str) {
    let (dir, proxy, resolves) = isolated_proxy();
    proxy
        .set_upstream_identity(
            "compatibility-client".into(),
            Some("Compatibility Client".into()),
        )
        .await;
    let mut wire = Wire::start(proxy.clone());
    assert_eq!(
        legacy_result(&wire.request(0, "ping", None).await),
        &json!({})
    );
    let initialized = wire.request(1, "initialize", Some(json!({
        "protocolVersion": version,
        "capabilities": {"roots": {"listChanged": true}},
        "clientInfo": {"name": "compatibility-client", "title": "Compatibility Client", "version": "1"}
    }))).await;
    assert_initialize(&initialized, version, "compatibility-proxy");

    let response = wire.request(2, "tools/list", None).await;
    let tools = legacy_result(&response)["tools"]
        .as_array()
        .expect("cached tool list");
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["name"], "cached_compatibility_tool");
    assert_eq!(tools[1]["name"], "reconnect");
    assert!(tools
        .iter()
        .all(|tool| tool["inputSchema"]["type"] == "object"));
    assert_eq!(
        legacy_result(&wire.request(3, "resources/list", None).await)["resources"],
        json!([])
    );
    assert_eq!(
        legacy_result(&wire.request(4, "resources/templates/list", None).await)
            ["resourceTemplates"],
        json!([])
    );
    assert_no_child(&proxy, &resolves, dir.path()).await;
    assert!(wire.notifications.is_empty());

    wire.initialized().await;
    wire.notification("notifications/tools/list_changed").await;
    wire.notification("notifications/resources/list_changed")
        .await;
    assert_eq!(resolves.load(Ordering::SeqCst), 1);
    assert!(dir.path().join("child-started").exists());

    let response = wire.request(5, "tools/list", None).await;
    let tools = legacy_result(&response)["tools"]
        .as_array()
        .expect("live old SDK tools");
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "compatibility_echo"));
    assert!(!tools
        .iter()
        .any(|tool| tool["name"] == "cached_compatibility_tool"));
    assert!(tools.iter().any(|tool| tool["name"] == "reconnect"));

    let response = wire.request(6, "tools/call", Some(json!({"name": "compatibility_echo", "arguments": {"message": "new proxy → old child\nλ"}}))).await;
    let result = legacy_result(&response);
    assert_eq!(result["isError"], false);
    assert_eq!(result["_meta"]["compatibility/preserved"], true);
    let payload: Value = serde_json::from_str(
        result["content"][0]["text"]
            .as_str()
            .expect("legacy text content"),
    )
    .expect("fixture payload");
    assert_eq!(payload, result["structuredContent"]);
    assert_eq!(payload["arguments"]["message"], "new proxy → old child\nλ");
    assert_eq!(payload["clientInfo"]["name"], "compatibility-client");
    assert_eq!(payload["clientInfo"]["title"], "Compatibility Client");
    assert_eq!(payload["protocolVersion"], "2025-11-25");
    assert_eq!(payload["initialized"], true);
    assert_eq!(payload["capabilities"], json!({}));
    assert_eq!(payload["operatorClient"], "compatibility-client");
    assert!(!payload["operatorSession"]
        .as_str()
        .expect("operator session")
        .is_empty());

    let response = wire.request(7, "resources/list", None).await;
    assert_eq!(
        legacy_result(&response)["resources"][0]["uri"],
        "compatibility://resource"
    );
    let response = wire.request(8, "resources/templates/list", None).await;
    assert_eq!(
        legacy_result(&response)["resourceTemplates"][0]["uriTemplate"],
        "compatibility://{id}"
    );
    let response = wire
        .request(
            9,
            "resources/read",
            Some(json!({"uri": "compatibility://resource"})),
        )
        .await;
    let result = legacy_result(&response);
    assert_eq!(result["contents"][0]["text"], "legacy resource\nλ");
    assert_eq!(
        result["contents"][0]["_meta"]["compatibility/preserved"],
        true
    );
    let response = wire
        .request(
            10,
            "resources/read",
            Some(json!({"uri": "compatibility://missing"})),
        )
        .await;
    assert_eq!(response["error"]["code"], -32603);
    assert!(response["error"]["message"]
        .as_str()
        .expect("forwarded resource error")
        .contains("Missing fixture resource"));

    wire.initialized().await;
    assert_eq!(
        legacy_result(&wire.request(11, "ping", None).await),
        &json!({})
    );
    assert_eq!(resolves.load(Ordering::SeqCst), 1);
    timeout(DEADLINE, proxy.restart_child())
        .await
        .expect("restart timed out")
        .expect("restart legacy child");
    let response = wire
        .request(
            12,
            "tools/call",
            Some(json!({"name": "compatibility_echo", "arguments": {"message": "after restart"}})),
        )
        .await;
    let restarted = legacy_result(&response);
    assert_eq!(
        restarted["structuredContent"]["operatorSession"],
        payload["operatorSession"]
    );
    assert_eq!(
        restarted["structuredContent"]["operatorClient"],
        payload["operatorClient"]
    );
    assert_eq!(
        restarted["structuredContent"]["clientInfo"],
        payload["clientInfo"]
    );
    assert_eq!(restarted["structuredContent"]["capabilities"], json!({}));
    assert_eq!(resolves.load(Ordering::SeqCst), 2);
    let child_peer = {
        let state = proxy.state.read().await;
        state
            .child_client
            .as_ref()
            .expect("restarted child")
            .peer()
            .clone()
    };
    assert!(!child_peer.response_cache_config().await.enabled);
    assert!(wire.finish().await);
    stop_child(&proxy).await;
}

macro_rules! legacy_test {
    ($name:ident, $version:literal) => {
        #[tokio::test]
        async fn $name() {
            legacy_proxy_wire($version).await;
        }
    };
}

legacy_test!(version_skew_new_proxy_to_old_child_2024_11_05, "2024-11-05");
legacy_test!(version_skew_new_proxy_to_old_child_2025_03_26, "2025-03-26");
legacy_test!(version_skew_new_proxy_to_old_child_2025_06_18, "2025-06-18");
legacy_test!(version_skew_new_proxy_to_old_child_2025_11_25, "2025-11-25");

async fn reject_modern_without_handshake(anonymous: bool) {
    for version in ["2026-07-28", "2099-01-01"] {
        for (method, mut params) in modern_requests() {
            let (dir, proxy, resolves) = isolated_proxy();
            let cached = std::fs::read(dir.path().join("tool-cache.json")).expect("cached tools");
            let mut wire = Wire::start(proxy.clone());
            params["_meta"] = modern_meta(version, anonymous);
            assert_unsupported(&wire.request(42, method, Some(params)).await, version);
            assert_no_child(&proxy, &resolves, dir.path()).await;
            assert_eq!(proxy.state.read().await.upstream_name, "unknown");
            assert_eq!(
                std::fs::read(dir.path().join("tool-cache.json")).expect("unchanged cache"),
                cached
            );
            assert!(wire.notifications.is_empty());
            assert!(wire.finish().await);
        }
    }
}

#[tokio::test]
async fn modern_named_requests_rejected_without_handshake_or_child_side_effects() {
    reject_modern_without_handshake(false).await;
}

#[tokio::test]
async fn modern_anonymous_requests_rejected_without_handshake_or_child_side_effects() {
    reject_modern_without_handshake(true).await;
}

#[tokio::test]
async fn missing_modern_metadata_rejected_before_child_dispatch() {
    for params in [
        json!({"name": "reconnect", "arguments": {}}),
        json!({"name": "reconnect", "arguments": {}, "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}),
        json!({"name": "reconnect", "arguments": {}, "_meta": {"protocolVersion": "2026-07-28", "clientCapabilities": {}}}),
    ] {
        let (dir, proxy, resolves) = isolated_proxy();
        let mut wire = Wire::start(proxy.clone());
        assert_eq!(
            wire.request(1, "tools/call", Some(params)).await["error"]["code"],
            -32602
        );
        assert_no_child(&proxy, &resolves, dir.path()).await;
        assert!(!wire.finish().await);
    }
}

#[tokio::test]
async fn modern_metadata_cannot_upgrade_legacy_proxy_or_trigger_reconnect() {
    let (dir, proxy, resolves) = isolated_proxy();
    let mut wire = Wire::start(proxy.clone());
    assert_initialize(
        &wire.initialize("2025-11-25").await,
        "2025-11-25",
        "compatibility-proxy",
    );
    let response = wire.request(2, "tools/call", Some(json!({"name": "reconnect", "arguments": {}, "_meta": modern_meta("2026-07-28", true)}))).await;
    assert_unsupported(&response, "2026-07-28");
    let response = wire.request(3, "tools/list", None).await;
    assert_eq!(
        legacy_result(&response)["tools"][0]["name"],
        "cached_compatibility_tool"
    );
    assert_no_child(&proxy, &resolves, dir.path()).await;
    assert!(wire.finish().await);
}

#[tokio::test]
async fn initialize_never_negotiates_a_modern_no_handshake_revision() {
    for version in ["2026-07-28", "2099-01-01"] {
        let (dir, proxy, resolves) = isolated_proxy();
        let mut wire = Wire::start(proxy.clone());
        assert_initialize(
            &wire.initialize(version).await,
            "2025-11-25",
            "compatibility-proxy",
        );
        let response = wire.request(2, "tools/list", None).await;
        assert!(legacy_result(&response)["tools"].is_array());
        assert_no_child(&proxy, &resolves, dir.path()).await;
        assert!(wire.finish().await);
    }
}

#[tokio::test]
async fn repeated_initialize_cannot_change_proxy_protocol_or_identity() {
    for version in LEGACY_VERSIONS {
        let (dir, proxy, resolves) = isolated_proxy();
        let mut wire = Wire::start(proxy.clone());
        assert_initialize(
            &wire.initialize(version).await,
            version,
            "compatibility-proxy",
        );
        support::assert_reinitialize_preserves_legacy_peer(&mut wire, version).await;
        assert_no_child(&proxy, &resolves, dir.path()).await;
        assert!(wire.finish().await);
    }
}

#[tokio::test]
async fn legacy_inline_metadata_and_initialized_notification_cannot_start_a_child() {
    for anonymous in [false, true] {
        for version in ["2025-11-25", "2026-07-28"] {
            let (dir, proxy, resolves) = isolated_proxy();
            let mut wire = Wire::start(proxy.clone());
            let response = wire
                .request(
                    1,
                    "tools/list",
                    Some(json!({"_meta": modern_meta(version, anonymous)})),
                )
                .await;
            assert_eq!(
                response["error"]["code"],
                if version == "2025-11-25" {
                    -32600
                } else {
                    -32022
                }
            );
            wire.initialized().await;
            for (index, (method, mut params)) in modern_requests().into_iter().enumerate() {
                params["_meta"] = modern_meta("2025-11-25", anonymous);
                let response = wire.request(index as u64 + 2, method, Some(params)).await;
                assert!(response.get("error").is_some(), "{response}");
                assert_no_child(&proxy, &resolves, dir.path()).await;
                assert!(wire.notifications.is_empty());
            }
            assert!(wire.finish().await);
        }
    }
}

#[tokio::test]
async fn version_skew_old_rmcp_client_to_new_production_child() {
    use rmcp_legacy::ServiceExt;
    use std::process::Stdio;

    for version in LEGACY_VERSIONS {
        let dir = tempfile::tempdir().expect("isolated new child directory");
        let mut child =
            tokio::process::Command::new(std::env::current_exe().expect("test executable"))
                .args(fixtures::child_args())
                .env_clear()
                .envs(fixtures::child_env(dir.path(), "new"))
                .current_dir(dir.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .kill_on_drop(true)
                .spawn()
                .expect("spawn production child fixture");
        let stdin = child.stdin.take().expect("child stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        timeout(DEADLINE, async {
            loop {
                let mut line = String::new();
                assert_ne!(
                    stdout
                        .read_line(&mut line)
                        .await
                        .expect("fixture readiness line"),
                    0,
                    "fixture exited before readiness"
                );
                if line.trim() == fixtures::READY {
                    break;
                }
            }
        })
        .await
        .expect("fixture startup timed out");
        let client = timeout(
            DEADLINE,
            fixtures::LegacyClient(version).serve((stdout, stdin)),
        )
        .await
        .expect("legacy client handshake timed out")
        .expect("pinned rmcp 1.5 handshake with new child");
        assert_eq!(
            client
                .peer_info()
                .expect("server info")
                .protocol_version
                .as_str(),
            version
        );
        assert_eq!(
            client.peer_info().expect("server info").server_info.name,
            "nteract"
        );

        let tools = timeout(DEADLINE, client.list_tools(None))
            .await
            .expect("tools timeout")
            .expect("legacy tools/list");
        assert!(tools
            .tools
            .iter()
            .any(|tool| tool.name == "create_notebook"));
        assert!(!tools.tools.iter().any(|tool| tool.name == "show_notebook"));
        let resources = timeout(DEADLINE, client.list_resources(None))
            .await
            .expect("resources timeout")
            .expect("legacy resources/list");
        assert!(resources
            .resources
            .iter()
            .any(|resource| resource.uri == "ui://nteract/output.html"));
        let templates = timeout(DEADLINE, client.list_resource_templates(None))
            .await
            .expect("templates timeout")
            .expect("legacy templates/list");
        assert!(!templates.resource_templates.is_empty());
        let read = serde_json::from_value(json!({"uri": "ui://nteract/output.html"}))
            .expect("legacy read params");
        let resource = timeout(DEADLINE, client.read_resource(read))
            .await
            .expect("read timeout")
            .expect("legacy resource content");
        let resource = serde_json::to_value(resource).expect("resource JSON");
        assert!(!resource["contents"][0]["text"]
            .as_str()
            .expect("HTML resource")
            .is_empty());
        let call = serde_json::from_value(json!({"name": "disconnect_notebook", "arguments": {}}))
            .expect("legacy tool params");
        let result = timeout(DEADLINE, client.call_tool(call))
            .await
            .expect("call timeout")
            .expect("legacy tool result");
        assert_eq!(result.is_error, Some(true));
        let result = serde_json::to_value(result).expect("tool JSON");
        assert!(result["content"][0]["text"]
            .as_str()
            .expect("legacy text content")
            .contains("No active session"));
        timeout(DEADLINE, client.cancel())
            .await
            .expect("client cancellation timeout")
            .expect("cancel legacy client");
        assert!(timeout(DEADLINE, child.wait())
            .await
            .expect("new child exit timeout")
            .expect("reap new child")
            .success());
        assert!(!dir.path().join("daemon.sock").exists());
        assert!(!dir.path().join("executions").exists());
    }
}

#[tokio::test]
async fn version_skew_production_spawn_child_pins_legacy_and_reaps_old_sdk_child() {
    let dir = tempfile::tempdir().expect("isolated old child directory");
    let spawned = timeout(
        DEADLINE,
        runt_mcp_proxy::child::spawn_child(
            &std::env::current_exe().expect("test executable"),
            &fixtures::child_args(),
            &fixtures::child_env(dir.path(), "legacy"),
            "spawn-child-client",
            Some("Spawn Child Client"),
        ),
    )
    .await
    .expect("spawn child timeout")
    .expect("production spawn_child initializes pinned old SDK");
    assert!(!spawned.client.peer().response_cache_config().await.enabled);
    let info = spawned.client.peer_info().expect("old child info");
    assert_eq!(info.protocol_version.as_str(), "2025-11-25");
    assert_eq!(
        info.server_info.as_ref().expect("old server identity").name,
        "rmcp-1.5-child"
    );
    let mut exit_status = spawned.exit_status;
    timeout(DEADLINE, spawned.client.cancel())
        .await
        .expect("child cancellation timeout")
        .expect("cancel old child");
    timeout(DEADLINE, async {
        loop {
            if exit_status.borrow().is_some() {
                break;
            }
            exit_status
                .changed()
                .await
                .expect("child exit owner remained alive");
        }
    })
    .await
    .expect("production child owner did not reap the old SDK fixture");
}
