#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/attachments.rs"]
mod attachments;
mod support;
use attachments::*;
use serde_json::json;

fn notebook_id(fixture: &Fixture, handle: &str) -> String {
    fixture.server.attachments().read_entries()[handle]
        .session
        .notebook_id
        .clone()
}

#[tokio::test]
async fn id_retention_preserves_legacy_alias_owner_and_subscription_lifetime() {
    let fixture = Fixture::start().await;
    let path = fixture.notebook("legacy-alias", "before ID retention");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let explicit = open(&mut wire, 10, &path, false).await;
    fixture.ready(&explicit).await;
    fixture.synced(&explicit).await;
    let id = notebook_id(&fixture, &explicit);
    let inspected = payload(
        &wire
            .request(
                11,
                "tools/call",
                Some(tool_params(
                    "inspect_notebook",
                    json!({"notebook_id":id}),
                    false,
                )),
            )
            .await,
    );
    let address = inspected["target"]["notebook_handle"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(address, explicit);
    assert_eq!(fixture.server.attachments().read_entries().len(), 2);
    let uri = format!("nteract://notebooks/{id}/cells");

    let read = wire
        .request(12, "resources/read", Some(json!({"uri":uri})))
        .await;
    let snapshot: serde_json::Value =
        serde_json::from_str(result(&read)["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["notebook_handle"], explicit);
    assert_eq!(
        snapshot["cells"][0]["source_preview"],
        "before ID retention"
    );
    result(
        &wire
            .request(13, "resources/subscribe", Some(json!({"uri":uri})))
            .await,
    );

    // The alias watch captures the Explicit owner, not the redundant Address
    // owner. Releasing that exact handle must end this watch even though the
    // replica and the Address owner's independently retained alias survive.
    let marker = wire.notifications.len();
    release(&mut wire, 14, &explicit, false).await;
    wire.notification_after(marker, |notification| {
        notification["method"] == "notifications/resources/updated"
            && notification["params"]["uri"] == uri
            && notification["params"]["_meta"]["io.nteract/attachmentExpired"]["notebook_handle"]
                == explicit
    })
    .await;

    let read = wire
        .request(15, "resources/read", Some(json!({"uri":uri})))
        .await;
    let snapshot: serde_json::Value =
        serde_json::from_str(result(&read)["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["notebook_handle"], address);
    assert_eq!(
        snapshot["cells"][0]["source_preview"],
        "before ID retention"
    );
    result(
        &wire
            .request(16, "resources/subscribe", Some(json!({"uri":uri})))
            .await,
    );
    let marker = wire.notifications.len();
    result(
        &mutate(
            &mut wire,
            17,
            &address,
            "Address owner remains writable",
            false,
        )
        .await,
    );
    let update = wire
        .notification_after(marker, |notification| {
            notification["method"] == "notifications/resources/updated"
                && notification["params"]["uri"] == uri
        })
        .await;
    assert!(update["params"]["_meta"]["io.nteract/attachmentExpired"].is_null());
    let read = wire
        .request(18, "resources/read", Some(json!({"uri":uri})))
        .await;
    let snapshot: serde_json::Value =
        serde_json::from_str(result(&read)["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["notebook_handle"], address);
    assert_eq!(
        snapshot["cells"][0]["source_preview"],
        "Address owner remains writable"
    );
    let marker = wire.notifications.len();
    release(&mut wire, 19, &address, false).await;
    wire.notification_after(marker, |notification| {
        notification["method"] == "notifications/resources/updated"
            && notification["params"]["uri"] == uri
            && notification["params"]["_meta"]["io.nteract/attachmentExpired"]["notebook_handle"]
                == address
    })
    .await;
    fixture.stop(wire).await;
}

#[tokio::test]
async fn overlapping_same_cell_ids_stay_in_their_notebook_during_another_open() {
    for native in [false, true] {
        let fixture = Fixture::start().await;
        let (a, b, c) = (
            fixture.notebook("a", "A"),
            fixture.notebook("b", "B"),
            fixture.notebook("c", "C"),
        );
        let mut wire = fixture.wire();
        if !native {
            wire.initialize("2025-11-25").await;
            wire.initialized().await;
        }
        let ah = open(&mut wire, 1, &a, native).await;
        let bh = open(&mut wire, 2, &b, native).await;
        fixture.ready(&ah).await;
        fixture.ready(&bh).await;
        fixture.synced(&ah).await;
        fixture.synced(&bh).await;
        let (aid, bid) = (notebook_id(&fixture, &ah), notebook_id(&fixture, &bh));
        let mut opening = fixture.gate(&c);
        wire.send_request(
            3,
            "tools/call",
            Some(tool_params("connect_notebook", json!({"path":c}), native)),
        )
        .await;
        opening.reached().await;
        let mut ag = fixture.sync_gate(&a);
        let mut bg = fixture.sync_gate(&b);
        wire.send_request(
            4,
            "tools/call",
            Some(tool_params(
                "set_cell",
                json!({"notebook_id":aid,"cell_id":"sentinel","source":"A edited"}),
                native,
            )),
        )
        .await;
        wire.send_request(
            5,
            "tools/call",
            Some(tool_params(
                "set_cell",
                json!({"notebook_id":bid,"cell_id":"sentinel","source":"B edited"}),
                native,
            )),
        )
        .await;
        ag.reached().await;
        bg.reached().await;
        ag.release();
        bg.release();
        assert_eq!(
            payload(&wire.response(4).await)["target"]["notebook_id"],
            aid
        );
        assert_eq!(
            payload(&wire.response(5).await)["target"]["notebook_id"],
            bid
        );
        opening.release();
        let ch = payload(&wire.response(3).await)["notebook_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        fixture.ready(&ch).await;
        assert_eq!(
            read(&mut wire, 6, &ah, native).await["cells"][0]["source_preview"],
            "A edited"
        );
        assert_eq!(
            read(&mut wire, 7, &bh, native).await["cells"][0]["source_preview"],
            "B edited"
        );
        assert_eq!(
            read(&mut wire, 8, &ch, native).await["cells"][0]["source_preview"],
            "C"
        );
        fixture.stop(wire).await;
    }
}

#[tokio::test]
async fn id_retention_survives_explicit_release_and_inflight_release_preserves_result() {
    let fixture = Fixture::start().await;
    let path = fixture.notebook("retention", "before");
    let mut wire = fixture.wire();
    let handle = open(&mut wire, 1, &path, true).await;
    fixture.ready(&handle).await;
    fixture.synced(&handle).await;
    let id = notebook_id(&fixture, &handle);
    let inspected = payload(
        &wire
            .request(
                2,
                "tools/call",
                Some(tool_params(
                    "inspect_notebook",
                    json!({"notebook_id":id}),
                    true,
                )),
            )
            .await,
    );
    let owner = inspected["target"]["notebook_handle"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(owner, handle);
    assert_eq!(fixture.server.attachments().read_entries().len(), 2);
    release(&mut wire, 3, &handle, true).await;
    let mut gate = fixture.sync_gate(&path);
    wire.send_request(
        4,
        "tools/call",
        Some(tool_params(
            "set_cell",
            json!({"notebook_id":id,"cell_id":"sentinel","source":"after release"}),
            true,
        )),
    )
    .await;
    gate.reached().await;
    let captured = fixture.server.attachments().read_entries()[&owner]
        .session
        .handle
        .clone();
    release(&mut wire, 5, &owner, true).await;
    gate.release();
    let completed = payload(&wire.response(4).await);
    assert_eq!(completed["target"]["notebook_id"], id);
    assert_eq!(
        captured.get_cell_source("sentinel").as_deref(),
        Some("after release")
    );
    let unavailable = wire
        .request(
            6,
            "tools/call",
            Some(tool_params(
                "inspect_notebook",
                json!({"notebook_id":id}),
                true,
            )),
        )
        .await;
    support::assert_target_tool_error(&unavailable, "notebook_not_connected");
    let expired = wire
        .request(
            7,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"notebook_handle":owner,"cell_id":"sentinel"}),
                true,
            )),
        )
        .await;
    support::assert_target_tool_error(&expired, "attachment_expired");
    fixture.stop(wire).await;
}

#[tokio::test]
async fn concurrent_id_reads_share_one_owner_and_capacity_never_evicts() {
    let fixture = Fixture::start().await;
    let path = fixture.notebook("capacity", "source");
    let mut wire = fixture.wire();
    let handle = open(&mut wire, 1, &path, true).await;
    fixture.ready(&handle).await;
    let id = notebook_id(&fixture, &handle);
    let reservations = fixture.reserve_all_but(0);
    let denied = wire
        .request(
            2,
            "tools/call",
            Some(tool_params(
                "inspect_notebook",
                json!({"notebook_id":id}),
                true,
            )),
        )
        .await;
    support::assert_target_tool_error(&denied, "attachment_limit");
    assert!(fixture
        .server
        .attachments()
        .read_entries()
        .contains_key(&handle));
    drop(reservations);
    for request in 3..11 {
        wire.send_request(
            request,
            "tools/call",
            Some(tool_params(
                "inspect_notebook",
                json!({"notebook_id":id}),
                true,
            )),
        )
        .await;
    }
    let mut owner = None;
    for request in 3..11 {
        let response = payload(&wire.response(request).await);
        let actual = response["target"]["notebook_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(owner.get_or_insert(actual.clone()), &actual);
    }
    assert_eq!(fixture.server.attachments().read_entries().len(), 2);
    release(&mut wire, 11, owner.as_ref().unwrap(), true).await;
    assert_eq!(
        read(&mut wire, 12, &handle, true).await["cells"][0]["source_preview"],
        "source"
    );
    fixture.stop(wire).await;
}

#[tokio::test]
async fn cold_unknown_and_wrong_authority_ids_never_open_a_peer() {
    let fixture = Fixture::start().await;
    let path = fixture.notebook("known", "source");
    let mut wire = fixture.wire();
    let handle = open(&mut wire, 1, &path, true).await;
    fixture.ready(&handle).await;
    let id = notebook_id(&fixture, &handle);
    let before = fixture.server.attachments().read_entries().len();
    let unknown = wire.request(2, "tools/call", Some(tool_params("set_cell", json!({"notebook_id":uuid::Uuid::new_v4().to_string(),"cell_id":"sentinel","source":"wrong"}), true))).await;
    support::assert_target_tool_error(&unknown, "notebook_not_connected");
    let remote = wire.request(3, "tools/call", Some(tool_params("set_cell", json!({"notebook_id":id,"domain":"https://unconfigured.invalid","cell_id":"sentinel","source":"wrong"}), true))).await;
    support::assert_target_tool_error(&remote, "notebook_authority_unavailable");
    assert_eq!(fixture.server.attachments().read_entries().len(), before);
    assert_eq!(
        read(&mut wire, 4, &handle, true).await["cells"][0]["source_preview"],
        "source"
    );
    let client = runtimed_client::client::PoolClient::new(fixture.root.path().join("daemon.sock"));
    let rooms = client.list_rooms().await.unwrap();
    assert_eq!(rooms.len(), 1);
    assert_eq!(rooms[0].active_peers, 1);
    fixture.stop(wire).await;
}
