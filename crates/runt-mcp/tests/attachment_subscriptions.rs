#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/attachments.rs"]
mod attachments;
mod support;
use attachments::*;
use serde_json::{json, Value};
use support::Wire;

fn uri(handle: &str) -> String {
    format!("nteract://sessions/{handle}/cells")
}
fn subscription_id(message: &Value) -> &Value {
    &message["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"]
}
fn expiration(message: &Value) -> &Value {
    &message["params"]["_meta"]["io.nteract/attachmentExpired"]
}
async fn listen(wire: &mut Wire, id: u64, uris: &[String]) {
    let after = wire.notifications.len();
    wire.send_request(
        id,
        "subscriptions/listen",
        Some(native_params(
            json!({"notifications":{"resourceSubscriptions":uris}}),
        )),
    )
    .await;
    let ack = wire
        .notification_after(after, |n| {
            n["method"] == "notifications/subscriptions/acknowledged" && subscription_id(n) == id
        })
        .await;
    assert_eq!(
        ack["params"]["notifications"]["resourceSubscriptions"],
        json!(uris)
    );
}
async fn update(wire: &mut Wire, after: usize, id: u64, uri: &str) {
    wire.notification_after(after, |n| {
        n["method"] == "notifications/resources/updated"
            && subscription_id(n) == id
            && n["params"]["uri"] == uri
    })
    .await;
}
async fn cancel(wire: &mut Wire, id: u64) {
    wire.send(
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}}),
    )
    .await;
    // Cancelled request responses are suppressed by rmcp. A later request
    // establishes that the peer pump has processed the cancellation token.
    let response = wire
        .request(10000 + id, "tools/list", Some(native_params(json!({}))))
        .await;
    result(&response);
}

#[tokio::test]
async fn native_multi_resource_listener_survives_one_attachment_release() {
    // Same-notebook owners are the important edge: a shared observer lifetime
    // must not let releasing one attachment retire another's resource watch.
    let fixture = Fixture::start().await;
    let path = fixture.notebook("shared", "baseline");
    let mut wire = fixture.wire();
    let a1 = open(&mut wire, 10, &path, true).await;
    let a2 = open(&mut wire, 11, &path, true).await;
    assert_ne!(a1, a2);
    fixture.ready(&a1).await;
    fixture.ready(&a2).await;
    let uris = [uri(&a1), uri(&a2)];
    listen(&mut wire, 70, &uris).await;
    let marker = wire.notifications.len();
    release(&mut wire, 12, &a1, true).await;
    update(&mut wire, marker, 70, &uris[0]).await;
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 13, &a2, "after owner one release", true).await);
    update(&mut wire, marker, 70, &uris[1]).await;
    assert_eq!(
        read(&mut wire, 14, &a2, true).await["cells"][0]["source_preview"],
        "after owner one release"
    );
    let marker = wire.notifications.len();
    wire.send_request(
        71,
        "subscriptions/listen",
        Some(native_params(
            json!({"notifications":{"resourceSubscriptions":[uris[0]]}}),
        )),
    )
    .await;
    let rejected = wire.response(71).await;
    assert!(rejected.get("error").is_some(), "{rejected}");
    assert!(!wire.notifications.iter().skip(marker).any(|n| n["method"]
        == "notifications/subscriptions/acknowledged"
        && subscription_id(n) == 71));
    // Another real edit establishes continuing liveness after stale admission.
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 15, &a2, "still watching survivor", true).await);
    update(&mut wire, marker, 70, &uris[1]).await;
    cancel(&mut wire, 70).await;
    fixture.stop(wire).await;
}

#[tokio::test]
async fn cancelling_one_native_listener_keeps_other_listener_and_notebook_live() {
    let fixture = Fixture::start().await;
    let path_a = fixture.notebook("a", "A baseline");
    let path_b = fixture.notebook("b", "B baseline");
    let mut wire = fixture.wire();
    let a = open(&mut wire, 10, &path_a, true).await;
    let b = open(&mut wire, 11, &path_b, true).await;
    fixture.ready(&a).await;
    fixture.ready(&b).await;
    let a_uri = uri(&a);
    let b_uri = uri(&b);
    listen(&mut wire, 70, std::slice::from_ref(&b_uri)).await;
    listen(&mut wire, 71, std::slice::from_ref(&b_uri)).await;
    listen(&mut wire, 72, std::slice::from_ref(&a_uri)).await;
    cancel(&mut wire, 70).await;
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 12, &b, "B with surviving listener", true).await);
    update(&mut wire, marker, 71, &b_uri).await;
    result(&mutate(&mut wire, 13, &a, "A unaffected", true).await);
    update(&mut wire, marker, 72, &a_uri).await;
    // The cancellation's discovery barrier preceded both edits; the processing barriers
    // and fresh survivor updates make this stronger than a silence timeout.
    assert!(!wire
        .notifications
        .iter()
        .skip(marker)
        .any(|n| n["method"] == "notifications/resources/updated" && subscription_id(n) == 70));
    assert_eq!(
        read(&mut wire, 14, &a, true).await["cells"][0]["source_preview"],
        "A unaffected"
    );
    assert_eq!(
        read(&mut wire, 15, &b, true).await["cells"][0]["source_preview"],
        "B with surviving listener"
    );
    cancel(&mut wire, 71).await;
    cancel(&mut wire, 72).await;
    fixture.stop(wire).await;
}

#[tokio::test]
async fn legacy_expiry_signals_name_captured_owner_without_retiring_other_watches() {
    let fixture = Fixture::start().await;
    let path = fixture.notebook("shared", "baseline");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let first_response = wire
        .request(
            10,
            "tools/call",
            Some(explicit_tool_params(
                "connect_notebook",
                json!({"path":path}),
            )),
        )
        .await;
    let first = payload(&first_response);
    let first_handle = first["notebook_handle"].as_str().unwrap();
    fixture.ready(first_handle).await;
    let first_uri = uri(first_handle);
    let id_uri = format!(
        "nteract://notebooks/{}/cells",
        first["notebook_id"].as_str().unwrap()
    );
    for (id, uri) in [(20, &first_uri), (21, &id_uri)] {
        result(
            &wire
                .request(id, "resources/subscribe", Some(json!({"uri":uri})))
                .await,
        );
    }
    let second_response = wire
        .request(
            11,
            "tools/call",
            Some(explicit_tool_params(
                "connect_notebook",
                json!({"path":path}),
            )),
        )
        .await;
    let second = payload(&second_response);
    let second_handle = second["notebook_handle"].as_str().unwrap();
    assert_ne!(first_handle, second_handle);
    fixture.ready(second_handle).await;
    let second_uri = uri(second_handle);
    result(
        &wire
            .request(22, "resources/subscribe", Some(json!({"uri":second_uri})))
            .await,
    );
    let missing_cell = wire
        .request(
            23,
            "resources/read",
            Some(json!({"uri":format!("nteract://sessions/{second_handle}/cells/missing")})),
        )
        .await;
    assert!(missing_cell.get("error").is_some());
    assert_ne!(missing_cell["error"]["data"]["code"], "attachment_expired");
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 24, second_handle, "ordinary edit", false).await);
    let ordinary = wire
        .notification_after(marker, |n| {
            n["method"] == "notifications/resources/updated" && n["params"]["uri"] == id_uri
        })
        .await;
    assert!(expiration(&ordinary).is_null());
    let marker = wire.notifications.len();
    release(&mut wire, 25, first_handle, false).await;
    for uri in [&first_uri, &id_uri] {
        let terminal = wire
            .notification_after(marker, |n| {
                n["method"] == "notifications/resources/updated"
                    && n["params"]["uri"] == *uri
                    && expiration(n)["notebook_handle"] == first_handle
            })
            .await;
        assert_eq!(
            expiration(&terminal),
            &json!({"code":"attachment_expired","notebook_handle":first_handle})
        );
    }
    let marker = wire.notifications.len();
    result(
        &mutate(
            &mut wire,
            26,
            second_handle,
            "survivor still watched",
            false,
        )
        .await,
    );
    let surviving = wire
        .notification_after(marker, |n| {
            n["method"] == "notifications/resources/updated" && n["params"]["uri"] == second_uri
        })
        .await;
    assert!(expiration(&surviving).is_null());
    // An ID subscription captured owner one. Reading the now-unambiguous ID
    // can address owner two, but that must not silently rebind the old watch.
    let by_id = wire
        .request(27, "resources/read", Some(json!({"uri":id_uri})))
        .await;
    result(&by_id);
    assert_eq!(
        read(&mut wire, 28, second_handle, false).await["cells"][0]["source_preview"],
        "survivor still watched"
    );
    assert!(!wire
        .notifications
        .iter()
        .skip(marker)
        .any(|n| n["method"] == "notifications/resources/updated" && n["params"]["uri"] == id_uri));
    result(
        &wire
            .request(29, "resources/subscribe", Some(json!({"uri":id_uri})))
            .await,
    );
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 30, second_handle, "fresh ID subscription", false).await);
    let fresh = wire
        .notification_after(marker, |n| {
            n["method"] == "notifications/resources/updated" && n["params"]["uri"] == id_uri
        })
        .await;
    assert!(expiration(&fresh).is_null());
    let marker = wire.notifications.len();
    release(&mut wire, 31, second_handle, false).await;
    let terminal = wire
        .notification_after(marker, |n| {
            n["method"] == "notifications/resources/updated"
                && n["params"]["uri"] == id_uri
                && expiration(n)["notebook_handle"] == second_handle
        })
        .await;
    assert_eq!(expiration(&terminal)["code"], "attachment_expired");
    fixture.stop(wire).await;
}

#[tokio::test]
async fn legacy_unsubscribe_and_release_keep_unrelated_attachment_notifications_live() {
    let fixture = Fixture::start().await;
    let path_a = fixture.notebook("a", "A baseline");
    let path_b = fixture.notebook("b", "B baseline");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let a = open(&mut wire, 10, &path_a, false).await;
    let b = open(&mut wire, 11, &path_b, false).await;
    fixture.ready(&a).await;
    fixture.ready(&b).await;
    let a_uri = uri(&a);
    let b_uri = uri(&b);
    for (id, uri) in [(20, &a_uri), (21, &b_uri)] {
        let response = wire
            .request(id, "resources/subscribe", Some(json!({"uri":uri})))
            .await;
        result(&response);
    }
    let response = wire
        .request(22, "resources/unsubscribe", Some(json!({"uri":a_uri})))
        .await;
    result(&response);
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 23, &b, "B after unsubscribe", false).await);
    wire.notification_after(marker, |n| {
        n["method"] == "notifications/resources/updated" && n["params"]["uri"] == b_uri
    })
    .await;
    release(&mut wire, 24, &a, false).await;
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 25, &b, "B after other release", false).await);
    wire.notification_after(marker, |n| {
        n["method"] == "notifications/resources/updated" && n["params"]["uri"] == b_uri
    })
    .await;
    let response = wire
        .request(26, "resources/subscribe", Some(json!({"uri":a_uri})))
        .await;
    assert!(response.get("error").is_some(), "{response}");
    assert_eq!(
        read(&mut wire, 27, &b, false).await["cells"][0]["source_preview"],
        "B after other release"
    );
    let response = wire
        .request(28, "resources/unsubscribe", Some(json!({"uri":b_uri})))
        .await;
    result(&response);
    fixture.stop(wire).await;
}
