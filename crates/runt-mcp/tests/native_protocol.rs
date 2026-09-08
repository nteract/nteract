#![allow(clippy::unwrap_used, clippy::expect_used)]
mod support;
use rmcp::model::*;
use rmcp::service::{RequestContext, RoleServer, SubscriptionContext};
use rmcp::{ErrorData, ServerHandler};
use serde_json::json;
use support::{modern_meta, Wire};

struct FirstRequest;
impl ServerHandler for FirstRequest {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_resources_subscribe()
                .build(),
        )
    }
    async fn discover(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, ErrorData> {
        mcp_transport::discover(&context, self.get_info())
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        Some(requested.clone())
    }
    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        mcp_transport::acknowledge(context.request_context()).await?;
        context
            .sink()
            .notify_resource_updated("fixture://resource")
            .await
            .unwrap();
        mcp_transport::cancelled(context.request_context()).await;
        Ok(())
    }
    async fn call_tool(
        &self,
        _: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let token = context.meta.get_progress_token().unwrap();
        context
            .peer
            .notify_progress(ProgressNotificationParam::new(token, 0.0))
            .await
            .unwrap();
        Ok(CallToolResult::success(vec![ContentBlock::text("completed")]).into())
    }
}

#[tokio::test]
async fn first_native_listen_acknowledges_without_discovery_and_closes_on_cancel() {
    let mut wire = Wire::start(FirstRequest);
    wire.send(json!({"jsonrpc":"2.0","id":7,"method":"subscriptions/listen","params":{"_meta":modern_meta("2026-07-28",false),"notifications":{"resourceSubscriptions":["fixture://resource"]}}})).await;
    wire.notification("notifications/subscriptions/acknowledged")
        .await;
    wire.notification("notifications/resources/updated").await;
    for notification in &wire.notifications {
        assert_eq!(
            notification["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"],
            7
        );
    }
    wire.send(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}))
        .await;
    assert!(wire.finish().await);
}

#[tokio::test]
async fn first_native_tool_can_send_progress_before_its_result() {
    let mut wire = Wire::start(FirstRequest);
    let mut meta = modern_meta("2026-07-28", false);
    meta["progressToken"] = json!("first-tool");
    let response = wire
        .request(
            8,
            "tools/call",
            Some(json!({"name":"fixture","_meta":meta})),
        )
        .await;
    assert_eq!(response["result"]["resultType"], "complete");
    assert_eq!(
        wire.notifications[0]["params"]["progressToken"],
        "first-tool"
    );
    assert!(wire.finish().await);
}

#[tokio::test]
async fn actual_notebook_server_supports_native_first_reads_and_expired_waits() {
    for (method, mut params) in [
        ("server/discover", json!({})),
        ("tools/list", json!({})),
        ("resources/list", json!({})),
        ("resources/templates/list", json!({})),
        (
            "tools/call",
            json!({"name":"wait_for_notebook_change","arguments":{"notebook_handle":"expired"}}),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let server = runt_mcp::NteractMcp::new_no_show(
            dir.path().join("daemon.sock"),
            None,
            Some(dir.path().join("blobs")),
        );
        let mut wire = Wire::start(server);
        params["_meta"] = modern_meta("2026-07-28", false);
        let response = wire.request(1, method, Some(params)).await;
        assert!(response.get("error").is_none(), "{method}: {response}");
        assert_eq!(response["result"]["resultType"], "complete", "{response}");
        if [
            "server/discover",
            "tools/list",
            "resources/list",
            "resources/templates/list",
        ]
        .contains(&method)
        {
            assert_eq!(response["result"]["ttlMs"], 0, "{response}");
            assert_eq!(response["result"]["cacheScope"], "private", "{response}");
        }
        assert!(wire.finish().await);
    }
}
#[tokio::test]
async fn native_requires_handles_and_rejects_expired_subscriptions_before_ack() {
    let dir = tempfile::tempdir().unwrap();
    let server = runt_mcp::NteractMcp::new_no_show(dir.path().join("daemon.sock"), None, None);
    let mut wire = Wire::start(server);
    for (id, method, mut params) in [
        (
            1,
            "tools/call",
            json!({"name":"create_cell","arguments":{"source":"must not run"}}),
        ),
        (
            2,
            "tools/call",
            json!({"name":"get_all_cells","arguments":{"notebook_handle":"expired"}}),
        ),
        (
            3,
            "resources/read",
            json!({"uri":"nteract://notebooks/old/cells"}),
        ),
        (
            4,
            "subscriptions/listen",
            json!({"notifications":{"resourceSubscriptions":["nteract://sessions/expired/cells"]}}),
        ),
    ] {
        params["_meta"] = modern_meta("2026-07-28", false);
        let response = wire.request(id, method, Some(params)).await;
        assert!(response.get("error").is_some(), "{response}");
    }
    assert!(!wire
        .notifications
        .iter()
        .any(|n| n["method"] == "notifications/subscriptions/acknowledged"));
    assert!(wire.finish().await);
}
