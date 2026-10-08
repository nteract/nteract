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

async fn selectively_lost_peer_retains_ownership_and_preserves_other_target(native: bool) {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("affected", "A before disconnect");
    let b = fixture.notebook("healthy", "B before disconnect");
    let mut wire = fixture.wire();
    if !native {
        wire.initialize("2025-11-25").await;
        wire.initialized().await;
    }
    let a1 = if native {
        open(&mut wire, 10, &a, true).await
    } else {
        let response = wire
            .request(
                10,
                "tools/call",
                Some(explicit_tool_params("connect_notebook", json!({"path":a}))),
            )
            .await;
        payload(&response)["notebook_handle"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    fixture.ready(&a1).await;
    fixture.synced(&a1).await;
    let a2 = if native {
        open(&mut wire, 11, &a, true).await
    } else {
        let response = wire
            .request(
                11,
                "tools/call",
                Some(explicit_tool_params("connect_notebook", json!({"path":a}))),
            )
            .await;
        payload(&response)["notebook_handle"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let b_handle = open(&mut wire, 12, &b, native).await;
    for handle in [&a1, &a2, &b_handle] {
        fixture.ready(handle).await;
        fixture.synced(handle).await;
    }
    let a_uris = [uri(&a1), uri(&a2)];
    let b_uri = uri(&b_handle);
    if native {
        listen(&mut wire, 70, &a_uris).await;
        listen(&mut wire, 71, std::slice::from_ref(&b_uri)).await;
    } else {
        for (id, uri) in [(70, &a_uris[0]), (71, &b_uri), (72, &a_uris[1])] {
            result(
                &wire
                    .request(id, "resources/subscribe", Some(json!({"uri":uri})))
                    .await,
            );
        }
    }
    let pool = runtimed_client::client::PoolClient::new(fixture.root.path().join("daemon.sock"));
    let daemon = pool.daemon_info().await.unwrap();
    let a_id = fixture.server.attachments().read_entries()[&a1]
        .session
        .notebook_id
        .clone();
    assert_eq!(
        pool.list_rooms()
            .await
            .unwrap()
            .iter()
            .find(|room| room.notebook_id == a_id)
            .unwrap()
            .active_peers,
        1,
        "both explicit A owners must share the one selected backing connection"
    );
    let original_docs = {
        let entries = fixture.server.attachments().read_entries();
        [
            entries[&a1].session.handle.clone(),
            entries[&a2].session.handle.clone(),
        ]
    };
    let marker = wire.notifications.len();
    fixture.close_sync_peer(&a).await;
    tokio::time::timeout(support::DEADLINE, async {
        while original_docs.iter().any(|doc| {
            doc.status().connection != notebook_sync::status::ConnectionState::Disconnected
        }) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("only A's shared sync backing must disconnect");
    pool.ping().await.unwrap();
    let still_same_daemon = pool.daemon_info().await.unwrap();
    assert_eq!(
        (daemon.pid, daemon.started_at),
        (still_same_daemon.pid, still_same_daemon.started_at)
    );
    assert_eq!(fixture.server.attachments().read_entries().len(), 3);

    // A dead peer still consumes both logical owner slots. Fill only test
    // reservations, then prove loss did not evict ownership or return capacity.
    let capacity = fixture.reserve_all_but(0);
    assert!(fixture.server.attachments().reserve().is_err());
    let refused = wire
        .request(
            20,
            "tools/call",
            Some(if native {
                tool_params("connect_notebook", json!({"path":a}), true)
            } else {
                explicit_tool_params("connect_notebook", json!({"path":a}))
            }),
        )
        .await;
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("attachment_limit"),
        "capacity refusal must be specific: {refused}"
    );
    result(&mutate(&mut wire, 21, &b_handle, "B after A disconnect", native).await);
    if native {
        update(&mut wire, marker, 71, &b_uri).await;
    } else {
        wire.notification_after(marker, |n| {
            n["method"] == "notifications/resources/updated" && n["params"]["uri"] == b_uri
        })
        .await;
    }
    fixture.synced(&b_handle).await;
    assert_eq!(
        read(&mut wire, 22, &b_handle, native).await["cells"][0]["source_preview"],
        "B after A disconnect"
    );

    let unavailable = wire
        .request(
            23,
            "resources/read",
            Some(if native {
                native_params(json!({"uri":a_uris[1]}))
            } else {
                json!({"uri":a_uris[1]})
            }),
        )
        .await;
    let duplicate_admission = if !native {
        Some(
            wire.request(24, "resources/subscribe", Some(json!({"uri":a_uris[1]})))
                .await,
        )
    } else {
        None
    };
    // Explicit release, rather than socket loss, frees exactly one slot.
    release(&mut wire, 25, &a1, native).await;
    let one_returned_slot = fixture.server.attachments().reserve().unwrap();
    assert!(fixture.server.attachments().reserve().is_err());
    drop(one_returned_slot);
    let fresh = if native {
        open(&mut wire, 26, &a, true).await
    } else {
        let response = wire
            .request(
                26,
                "tools/call",
                Some(explicit_tool_params("connect_notebook", json!({"path":a}))),
            )
            .await;
        payload(&response)["notebook_handle"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_ne!(fresh, a1);
    assert_ne!(fresh, a2);
    fixture.ready(&fresh).await;
    fixture.synced(&fresh).await;
    assert!(fixture.server.attachments().reserve().is_err());
    assert!(fixture
        .server
        .attachments()
        .read_entries()
        .contains_key(&a2));
    let fresh_uri = uri(&fresh);
    if native {
        listen(&mut wire, 73, std::slice::from_ref(&fresh_uri)).await;
    } else {
        result(
            &wire
                .request(73, "resources/subscribe", Some(json!({"uri":fresh_uri})))
                .await,
        );
    }
    let fresh_marker = wire.notifications.len();
    result(&mutate(&mut wire, 27, &fresh, "fresh A backing is live", native).await);
    if native {
        update(&mut wire, fresh_marker, 73, &fresh_uri).await;
    } else {
        wire.notification_after(fresh_marker, |n| {
            n["method"] == "notifications/resources/updated" && n["params"]["uri"] == fresh_uri
        })
        .await;
    }
    fixture.synced(&fresh).await;
    assert_eq!(
        read(&mut wire, 28, &fresh, native).await["cells"][0]["source_preview"],
        "fresh A backing is live"
    );
    assert_eq!(
        original_docs[1].status().connection,
        notebook_sync::status::ConnectionState::Disconnected
    );
    assert_eq!(
        original_docs[1].get_cell_source("sentinel").as_deref(),
        Some("A before disconnect")
    );
    eprintln!("selective A peer loss kept daemon identity, retained A2 ownership/capacity, healthy B listener, and acquired a distinct live A backing after explicit A1 release");

    // Assert terminal behavior before releasing the retained unavailable A2.
    if native {
        let completed = wire.response(70).await;
        assert_eq!(completed["result"]["resultType"], "complete");
    } else {
        let terminal = wire
            .notification_after(marker, |n| {
                n["params"]["uri"] == a_uris[1]
                    && n["params"]["_meta"]["io.nteract/attachmentUnavailable"]["code"]
                        == "attachment_unavailable"
            })
            .await;
        assert_eq!(
            terminal["params"]["_meta"]["io.nteract/attachmentUnavailable"]["notebook_handle"],
            a2
        );
        assert!(terminal["params"]["_meta"]
            .get("io.nteract/attachmentExpired")
            .is_none());
    }
    assert_eq!(unavailable["error"]["code"], -32603);
    let original_readiness: Value =
        serde_json::from_str(unavailable["error"]["message"].as_str().unwrap()).unwrap();
    assert_eq!(original_readiness["error"]["code"], "sync_failed");
    assert_eq!(original_readiness["session"]["document_ready"], false);
    assert_eq!(
        unavailable["error"]["data"]["code"], "attachment_unavailable",
        "retained disconnected handle needs truthful typed read error: {unavailable}"
    );
    assert_eq!(unavailable["error"]["data"]["notebook_handle"], a2);
    if let Some(rejected) = duplicate_admission {
        assert_eq!(rejected["error"]["data"]["code"], "attachment_unavailable");
        assert_eq!(rejected["error"]["data"]["notebook_handle"], a2);
    }
    release(&mut wire, 29, &a2, native).await;
    let expired = wire
        .request(
            30,
            "resources/read",
            Some(if native {
                native_params(json!({"uri":a_uris[1]}))
            } else {
                json!({"uri":a_uris[1]})
            }),
        )
        .await;
    assert_eq!(expired["error"]["data"]["code"], "attachment_expired");
    drop(capacity);
    if native {
        cancel(&mut wire, 71).await;
        cancel(&mut wire, 73).await;
    } else {
        for (id, uri) in [(90, b_uri), (91, fresh_uri)] {
            result(
                &wire
                    .request(id, "resources/unsubscribe", Some(json!({"uri":uri})))
                    .await,
            );
        }
    }
    fixture.stop(wire).await;
}

#[tokio::test]
async fn native_selective_sync_loss_finishes_listener_without_expiring_retained_owner() {
    selectively_lost_peer_retains_ownership_and_preserves_other_target(true).await;
}

#[tokio::test]
async fn legacy_selective_sync_loss_signals_unavailable_without_expiring_retained_owner() {
    selectively_lost_peer_retains_ownership_and_preserves_other_target(false).await;
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
async fn released_owner_rejects_admitted_mutation_completion_while_survivor_stays_live() {
    let fixture = Fixture::start().await;
    let path = fixture.notebook("shared", "baseline");
    let mut wire = fixture.wire();
    let a1 = open(&mut wire, 10, &path, true).await;
    let a2 = open(&mut wire, 11, &path, true).await;
    fixture.ready(&a1).await;
    fixture.ready(&a2).await;
    fixture.synced(&a1).await;
    fixture.synced(&a2).await;
    let survivor_uri = uri(&a2);
    listen(&mut wire, 70, std::slice::from_ref(&survivor_uri)).await;
    let docs = {
        let entries = fixture.server.attachments().read_entries();
        [
            entries[&a1].session.handle.clone(),
            entries[&a2].session.handle.clone(),
        ]
    };
    let admitted_edit = "A1 edit admitted before release";
    let mut gate = fixture.sync_gate(&path);
    wire.send_request(
        12,
        "tools/call",
        Some(tool_params(
            "set_cell",
            json!({"notebook_handle":a1,"cell_id":"sentinel","source":admitted_edit}),
            true,
        )),
    )
    .await;
    gate.reached().await;
    tokio::time::timeout(support::DEADLINE, async {
        while docs[0].get_cell_source("sentinel").as_deref() != Some(admitted_edit) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owner one must enter the captured mutation before release");
    release(&mut wire, 13, &a1, true).await;
    gate.release();
    let expired_completion = wire.response(12).await;
    // The admitted edit can reach the daemon. Expiry rejection must not imply
    // rollback; observe the edit through the surviving actual attachment.
    tokio::time::timeout(support::DEADLINE, async {
        while docs[1].get_cell_source("sentinel").as_deref() != Some(admitted_edit) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("admitted edit must remain visible through owner two");
    assert_eq!(
        read(&mut wire, 14, &a2, true).await["cells"][0]["source_preview"],
        admitted_edit
    );
    let marker = wire.notifications.len();
    result(&mutate(&mut wire, 15, &a2, "A2 edit after expired completion", true).await);
    update(&mut wire, marker, 70, &survivor_uri).await;
    fixture.synced(&a2).await;
    assert_eq!(
        read(&mut wire, 16, &a2, true).await["cells"][0]["source_preview"],
        "A2 edit after expired completion"
    );
    eprintln!("surviving A2 observed admitted A1 edit, mutated, synced, and delivered its fresh subscription update");
    assert!(
        expired_completion.get("error").is_some()
            || expired_completion["result"]["isError"] == true,
        "released owner must reject its post-await completion: error={:?}, isError={:?}",
        expired_completion.get("error"),
        expired_completion["result"]["isError"]
    );
    let expiry_code = expired_completion["error"]["data"]["code"]
        .as_str()
        .or_else(|| expired_completion["result"]["structuredContent"]["error"]["code"].as_str());
    assert_eq!(
        expiry_code,
        Some("attachment_expired"),
        "completion must identify the released attachment"
    );
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
