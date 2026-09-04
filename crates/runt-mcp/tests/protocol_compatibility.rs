#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use runt_mcp::NteractMcp;
use serde_json::json;
use support::{
    assert_initialize, assert_unsupported, legacy_result, modern_meta, modern_requests, Wire,
};

fn isolated_server() -> (tempfile::TempDir, Arc<NteractMcp>) {
    let dir = tempfile::tempdir().expect("isolated MCP directory");
    let server = NteractMcp::new_no_show(
        dir.path().join("daemon.sock"),
        None,
        Some(dir.path().join("blobs")),
    )
    .with_execution_store_path(Some(dir.path().join("executions")));
    (dir, Arc::new(server))
}

async fn legacy_wire(version: &str) {
    let (_dir, server) = isolated_server();
    let mut wire = Wire::start(server.clone());
    let ping = wire.request(0, "ping", None).await;
    assert_eq!(legacy_result(&ping), &json!({}));
    assert_initialize(&wire.initialize(version).await, version, "nteract");

    let response = wire.request(2, "tools/list", None).await;
    let tools = legacy_result(&response)["tools"]
        .as_array()
        .expect("tool list");
    assert!(tools.iter().any(|tool| tool["name"] == "create_notebook"));
    assert!(!tools.iter().any(|tool| tool["name"] == "show_notebook"));
    assert!(tools
        .iter()
        .all(|tool| tool["inputSchema"]["type"] == "object"));
    assert!(server.session().read().await.is_none());
    assert_eq!(server.session_intent_epoch().load(Ordering::Acquire), 0);

    wire.initialized().await;
    let response = wire.request(3, "resources/list", None).await;
    let resources = legacy_result(&response)["resources"]
        .as_array()
        .expect("resource list");
    assert!(resources
        .iter()
        .any(|resource| resource["uri"] == "ui://nteract/output.html"));
    let response = wire.request(4, "resources/templates/list", None).await;
    assert!(legacy_result(&response)["resourceTemplates"]
        .as_array()
        .is_some_and(|templates| !templates.is_empty()));

    let response = wire
        .request(
            5,
            "resources/read",
            Some(json!({"uri": "ui://nteract/output.html"})),
        )
        .await;
    let contents = legacy_result(&response)["contents"]
        .as_array()
        .expect("legacy resource contents");
    assert_eq!(contents.len(), 1);
    assert_eq!(contents[0]["uri"], "ui://nteract/output.html");
    assert_eq!(contents[0]["mimeType"], "text/html;profile=mcp-app");
    assert!(!contents[0]["text"].as_str().expect("HTML text").is_empty());
    assert_eq!(contents[0]["_meta"]["ui"]["prefersBorder"], false);

    let response = wire
        .request(
            6,
            "tools/call",
            Some(json!({"name": "disconnect_notebook", "arguments": {}})),
        )
        .await;
    let result = legacy_result(&response);
    assert_eq!(result["isError"], true);
    assert_eq!(result["content"][0]["type"], "text");
    assert!(result["content"][0]["text"]
        .as_str()
        .expect("tool error text")
        .contains("No active session"));
    assert_eq!(server.session_intent_epoch().load(Ordering::Acquire), 1);

    let response = wire
        .request(
            7,
            "resources/read",
            Some(json!({"uri": "missing://compatibility"})),
        )
        .await;
    assert_eq!(response["error"]["code"], -32002);
    let response = wire
        .request(
            8,
            "tools/call",
            Some(json!({"name": "missing_compatibility_tool", "arguments": {}})),
        )
        .await;
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(
        legacy_result(&wire.request(9, "ping", None).await),
        &json!({})
    );
    assert!(server.session().read().await.is_none());
    assert!(wire.finish().await);
}

macro_rules! legacy_test {
    ($name:ident, $version:literal) => {
        #[tokio::test]
        async fn $name() {
            legacy_wire($version).await;
        }
    };
}

legacy_test!(legacy_2024_11_05_newline_wire, "2024-11-05");
legacy_test!(legacy_2025_03_26_newline_wire, "2025-03-26");
legacy_test!(legacy_2025_06_18_newline_wire, "2025-06-18");
legacy_test!(legacy_2025_11_25_newline_wire, "2025-11-25");

async fn reject_modern_without_handshake(anonymous: bool) {
    for version in ["2026-07-28", "2099-01-01"] {
        for (method, mut params) in modern_requests() {
            let (dir, server) = isolated_server();
            let label = server.peer_label_shared().read().await.clone();
            let operator = server.operator_shared().read().await.clone();
            let mut wire = Wire::start(server.clone());
            params["_meta"] = modern_meta(version, anonymous);
            let response = wire.request(42, method, Some(params)).await;
            assert_unsupported(&response, version);
            assert!(server.session().read().await.is_none(), "{method}");
            assert!(server.parked_sessions().read().await.is_empty(), "{method}");
            assert!(
                server.last_session_drop().read().await.is_none(),
                "{method}"
            );
            assert_eq!(
                server.session_intent_epoch().load(Ordering::Acquire),
                0,
                "{method}"
            );
            assert_eq!(*server.peer_label_shared().read().await, label, "{method}");
            assert_eq!(*server.operator_shared().read().await, operator, "{method}");
            assert_eq!(
                std::fs::read_dir(dir.path())
                    .expect("isolated directory")
                    .count(),
                0
            );
            assert!(wire.finish().await);
        }
    }
}

#[tokio::test]
async fn modern_named_requests_rejected_without_handshake_or_notebook_side_effects() {
    reject_modern_without_handshake(false).await;
}

#[tokio::test]
async fn modern_anonymous_requests_rejected_without_handshake_or_notebook_side_effects() {
    reject_modern_without_handshake(true).await;
}

#[tokio::test]
async fn missing_modern_metadata_rejected_before_notebook_dispatch() {
    for params in [
        json!({"name": "disconnect_notebook", "arguments": {}}),
        json!({"name": "disconnect_notebook", "arguments": {}, "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}),
        json!({"name": "disconnect_notebook", "arguments": {}, "_meta": {"protocolVersion": "2026-07-28", "clientCapabilities": {}}}),
    ] {
        let (_dir, server) = isolated_server();
        let mut wire = Wire::start(server.clone());
        let response = wire.request(1, "tools/call", Some(params)).await;
        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(server.session_intent_epoch().load(Ordering::Acquire), 0);
        assert!(server.session().read().await.is_none());
        assert!(!wire.finish().await);
    }
}

#[tokio::test]
async fn modern_metadata_cannot_upgrade_a_legacy_session() {
    let (_dir, server) = isolated_server();
    let mut wire = Wire::start(server.clone());
    assert_initialize(
        &wire.initialize("2025-11-25").await,
        "2025-11-25",
        "nteract",
    );
    wire.initialized().await;
    let response = wire.request(2, "tools/call", Some(json!({
        "name": "disconnect_notebook", "arguments": {}, "_meta": modern_meta("2026-07-28", true)
    }))).await;
    assert_unsupported(&response, "2026-07-28");
    assert_eq!(server.session_intent_epoch().load(Ordering::Acquire), 0);
    let response = wire.request(3, "tools/list", None).await;
    assert!(legacy_result(&response)["tools"].is_array());
    assert!(wire.finish().await);
}

#[tokio::test]
async fn repeated_initialize_cannot_change_notebook_protocol_or_identity() {
    for version in support::LEGACY_VERSIONS {
        let (_dir, server) = isolated_server();
        let mut wire = Wire::start(server.clone());
        assert_initialize(&wire.initialize(version).await, version, "nteract");
        support::assert_reinitialize_preserves_legacy_peer(&mut wire, version).await;
        let response = wire
            .request(
                121,
                "tools/call",
                Some(json!({"name": "disconnect_notebook", "arguments": {}})),
            )
            .await;
        assert_eq!(legacy_result(&response)["isError"], true);
        assert_eq!(
            *server.peer_label_shared().read().await,
            "Compatibility Client"
        );
        assert!(server
            .operator_shared()
            .read()
            .await
            .starts_with("agent:compatibility-client:"));
        assert!(wire.finish().await);
    }
}

#[tokio::test]
async fn legacy_inline_metadata_cannot_bypass_notebook_handshake() {
    for anonymous in [false, true] {
        let (dir, server) = isolated_server();
        let label = server.peer_label_shared().read().await.clone();
        let operator = server.operator_shared().read().await.clone();
        let mut wire = Wire::start(server.clone());
        let response = wire
            .request(
                1,
                "tools/list",
                Some(json!({"_meta": modern_meta("2025-11-25", anonymous)})),
            )
            .await;
        assert_eq!(response["error"]["code"], -32600);
        wire.initialized().await;
        for (index, (method, mut params)) in modern_requests().into_iter().enumerate() {
            params["_meta"] = modern_meta("2025-11-25", anonymous);
            let response = wire.request(index as u64 + 2, method, Some(params)).await;
            assert!(response.get("error").is_some(), "{response}");
            assert_eq!(server.session_intent_epoch().load(Ordering::Acquire), 0);
            assert!(server.session().read().await.is_none());
            assert!(server.parked_sessions().read().await.is_empty());
            assert_eq!(*server.peer_label_shared().read().await, label);
            assert_eq!(*server.operator_shared().read().await, operator);
            assert_eq!(
                std::fs::read_dir(dir.path())
                    .expect("isolated directory")
                    .count(),
                0
            );
            assert!(wire.notifications.is_empty());
        }
        assert!(wire.finish().await);
    }
}

#[tokio::test]
async fn initialize_never_negotiates_a_modern_no_handshake_revision() {
    for version in ["2026-07-28", "2099-01-01"] {
        let (_dir, server) = isolated_server();
        let mut wire = Wire::start(server);
        assert_initialize(&wire.initialize(version).await, "2025-11-25", "nteract");
        let response = wire.request(2, "tools/list", None).await;
        assert!(legacy_result(&response)["tools"].is_array());
        assert!(wire.finish().await);
    }
}
