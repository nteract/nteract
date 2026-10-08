#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "../../runt-mcp/tests/support/attachments.rs"]
mod attachments;
#[path = "../../runt-mcp/tests/support/explicit_targets.rs"]
mod explicit;
#[allow(dead_code)] // This executable only uses the real-child startup helpers.
mod fixtures;
#[path = "../../runt-mcp/tests/support/mod.rs"]
mod support;

use attachments::*;
use runt_mcp_proxy::{McpProxy, ProxyConfig};
use serde_json::{json, Value};
use support::Wire;

#[test]
fn compatibility_child_process() {
    fixtures::run_child_if_requested();
}

fn uri(handle: &str) -> String {
    format!("nteract://sessions/{handle}/cells")
}
async fn listen(wire: &mut Wire, id: u64, uris: &[String]) {
    let marker = wire.notifications.len();
    wire.send_request(
        id,
        "subscriptions/listen",
        Some(native_params(
            json!({"notifications":{"resourceSubscriptions":uris}}),
        )),
    )
    .await;
    let ack = wire
        .notification_after(marker, |n| {
            n["method"] == "notifications/subscriptions/acknowledged"
                && n["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"] == id
        })
        .await;
    assert_eq!(
        ack["params"]["notifications"]["resourceSubscriptions"],
        json!(uris)
    );
}
async fn update(wire: &mut Wire, marker: usize, id: u64, uri: &str) -> Value {
    wire.notification_after(marker, |n| {
        n["method"] == "notifications/resources/updated"
            && n["params"]["uri"] == uri
            && n["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"] == id
    })
    .await
}

async fn ready(wire: &mut Wire, handle: &str, first_id: u64, native: bool) {
    tokio::time::timeout(support::DEADLINE, async {
        let mut id = first_id;
        loop {
            let response = wire
                .request(
                    id,
                    "tools/call",
                    Some(tool_params(
                        "get_cell",
                        json!({"notebook_handle":handle,"cell_id":"sentinel"}),
                        native,
                    )),
                )
                .await;
            id += 1;
            let result = result(&response);
            // get_cell returns readiness with a bounded projection until the
            // replica is interactive, then its ordinary full document result.
            if result["structuredContent"].get("readiness").is_none() {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("real private-child replica must become interactive before mutation");
}

#[tokio::test]
async fn same_daemon_peer_loss_retires_only_affected_proxy_uri_and_keeps_ownership() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("affected", "proxy A");
    let b = fixture.notebook("healthy", "proxy B");
    let proxy = real_proxy(&fixture);
    let mut wire = Wire::start(proxy.clone());
    let a_handle = open(&mut wire, 10, &a, true).await;
    let b_handle = open(&mut wire, 11, &b, true).await;
    ready(&mut wire, &a_handle, 1000, true).await;
    ready(&mut wire, &b_handle, 2000, true).await;
    // Successful actual sync-confirmed tools establish baseline source health.
    result(&mutate(&mut wire, 12, &a_handle, "proxy A", true).await);
    result(&mutate(&mut wire, 13, &b_handle, "proxy B", true).await);
    let a_uri = uri(&a_handle);
    let b_uri = uri(&b_handle);
    listen(&mut wire, 70, &[a_uri.clone(), b_uri.clone()]).await;
    listen(&mut wire, 71, std::slice::from_ref(&a_uri)).await;
    let pool = runtimed_client::client::PoolClient::new(fixture.root.path().join("daemon.sock"));
    let daemon = pool.daemon_info().await.unwrap();
    let marker = wire.notifications.len();
    fixture.close_sync_peer(&a).await;
    pool.ping().await.unwrap();
    let same_daemon = pool.daemon_info().await.unwrap();
    assert_eq!(
        (daemon.pid, daemon.started_at),
        (same_daemon.pid, same_daemon.started_at)
    );
    result(&mutate(&mut wire, 20, &b_handle, "B after proxy A peer loss", true).await);
    update(&mut wire, marker, 70, &b_uri).await;
    assert_eq!(
        read(&mut wire, 21, &b_handle, true).await["cells"][0]["source_preview"],
        "B after proxy A peer loss"
    );

    let unavailable = wire
        .request(
            22,
            "resources/read",
            Some(native_params(json!({"uri":a_uri}))),
        )
        .await;
    // Native catalog intentionally filters individual attachment resources;
    // inspect the actual private child's legacy catalog through its public API.
    let resources = proxy.child_resources(None).await;
    assert!(
        resources.resources.iter().any(|r| r.uri == a_uri),
        "unavailable ownership must stay listed by the child until deliberate release"
    );
    let fresh = open(&mut wire, 24, &a, true).await;
    assert_ne!(fresh, a_handle);
    let fresh_uri = uri(&fresh);
    ready(&mut wire, &fresh, 3000, true).await;
    result(
        &mutate(
            &mut wire,
            25,
            &fresh,
            "proxy fresh A source is healthy",
            true,
        )
        .await,
    );
    assert_eq!(
        read(&mut wire, 26, &fresh, true).await["cells"][0]["source_preview"],
        "proxy fresh A source is healthy"
    );
    assert_eq!(
        proxy.restart_count().await,
        0,
        "socket loss must not be masked by child restart"
    );
    eprintln!("real proxy child retained unavailable A ownership, daemon identity and healthy mixed-listener B; a fresh distinct A backing reads/mutates without child restart");

    for id in [70, 71] {
        let terminal = wire
            .notification_after(marker, |n| {
                n["params"]["uri"] == a_uri
                    && n["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"] == id
                    && n["params"]["_meta"]["io.nteract/attachmentUnavailable"]["code"]
                        == "attachment_unavailable"
            })
            .await;
        assert_eq!(
            terminal["params"]["_meta"]["io.nteract/attachmentUnavailable"]["notebook_handle"],
            a_handle
        );
        assert!(terminal["params"]["_meta"]
            .get("io.nteract/attachmentExpired")
            .is_none());
    }
    let completed = wire.response(71).await;
    assert_eq!(completed["result"]["resultType"], "complete");
    assert_eq!(
        unavailable["error"]["data"]["code"],
        "attachment_unavailable"
    );
    assert_eq!(unavailable["error"]["data"]["notebook_handle"], a_handle);
    // A fresh listener must revalidate the actual private child even when an
    // older mixed listen previously held the same URI reference.
    let rejected = wire
        .request(
            72,
            "subscriptions/listen",
            Some(native_params(
                json!({"notifications":{"resourceSubscriptions":[a_uri]}}),
            )),
        )
        .await;
    assert_eq!(rejected["error"]["data"]["code"], "attachment_unavailable");
    assert_eq!(rejected["error"]["data"]["notebook_handle"], a_handle);
    listen(&mut wire, 73, std::slice::from_ref(&fresh_uri)).await;
    release(&mut wire, 27, &a_handle, true).await;
    let expired = wire
        .request(
            28,
            "resources/read",
            Some(native_params(json!({"uri":a_uri}))),
        )
        .await;
    assert_eq!(expired["error"]["data"]["code"], "attachment_expired");
    let after_terminal = wire.notifications.len();
    result(
        &mutate(
            &mut wire,
            29,
            &b_handle,
            "B listener after A URI retirement",
            true,
        )
        .await,
    );
    update(&mut wire, after_terminal, 70, &b_uri).await;
    result(
        &mutate(
            &mut wire,
            30,
            &fresh,
            "fresh A listener after old A release",
            true,
        )
        .await,
    );
    update(&mut wire, after_terminal, 73, &fresh_uri).await;
    for id in [70, 73] {
        wire.send(
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}}),
        )
        .await;
    }
    result(
        &wire
            .request(40, "tools/list", Some(native_params(json!({}))))
            .await,
    );
    let child = { proxy.state.write().await.child_client.take() };
    if let Some(child) = child {
        tokio::time::timeout(support::DEADLINE, child.cancel())
            .await
            .unwrap()
            .unwrap();
    }
    fixture.stop(wire).await;
}

fn real_proxy(fixture: &Fixture) -> McpProxy {
    let executable = std::env::current_exe().unwrap();
    McpProxy::new(
        ProxyConfig {
            resolve_child_command: Box::new(move || Ok(executable.clone())),
            child_args: fixtures::child_args(),
            child_env: fixtures::child_env(fixture.root.path(), "new-relay"),
            server_name: "isolated-real-attachment-proxy".into(),
            cache_dir: Some(fixture.root.path().join("proxy-cache")),
            monitor_poll_interval_ms: 60_000,
            recovery_hint: "Isolated attachment fixture only".into(),
        },
        None,
    )
}

#[tokio::test]
async fn ordinary_legacy_actual_proxy_routes_two_chats_and_rejects_missing_handles() {
    for version in support::LEGACY_VERSIONS {
        let fixture = Fixture::start().await;
        let paths = [
            fixture.notebook("chat-a", "original A"),
            fixture.notebook("chat-b", "original B"),
        ];
        let proxy = real_proxy(&fixture);
        let mut wire = Wire::start(proxy.clone());
        wire.initialize(version).await;
        wire.initialized().await;
        let a = open(&mut wire, 10, &paths[0], false).await;
        let b = open(&mut wire, 11, &paths[1], false).await;
        ready(&mut wire, &a, 1000, false).await;
        ready(&mut wire, &b, 2000, false).await;
        explicit::interleaved_chats(&mut wire, &a, &b, [&paths[0], &paths[1]], 100).await;
        let private_version = {
            let state = proxy.state.read().await;
            state
                .child_client
                .as_ref()
                .unwrap()
                .peer_info()
                .unwrap()
                .protocol_version
                .to_string()
        };
        assert_eq!(
            private_version, "2025-11-25",
            "upstream version must not change the actual capable child's private protocol"
        );
        let repeated = open(&mut wire, 20, &paths[0], false).await;
        assert_ne!(
            repeated, a,
            "shared legacy proxy must retain independent same-target owners"
        );
        ready(&mut wire, &repeated, 3000, false).await;
        release(&mut wire, 21, &repeated, false).await;
        assert_eq!(
            read(&mut wire, 22, &a, false).await["cells"][0]["source_preview"],
            "chat A final"
        );
        let expired = wire
            .request(23, "resources/read", Some(json!({"uri":uri(&repeated)})))
            .await;
        assert_eq!(expired["error"]["data"]["code"], "attachment_expired");
        let responses = explicit::missing_targets(&mut wire, 300).await;
        explicit::assert_missing_targets(&responses);
        assert_eq!(
            read(&mut wire, 400, &a, false).await["cells"][0]["source_preview"],
            "chat A final"
        );
        assert_eq!(
            read(&mut wire, 401, &b, false).await["cells"][0]["source_preview"],
            "chat B source"
        );
        let child = { proxy.state.write().await.child_client.take() };
        if let Some(child) = child {
            tokio::time::timeout(support::DEADLINE, child.cancel())
                .await
                .unwrap()
                .unwrap();
        }
        fixture.stop(wire).await;
    }
}
