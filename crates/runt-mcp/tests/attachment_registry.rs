#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/attachments.rs"]
mod attachments;
mod support;
use attachments::*;
use serde_json::json;

#[tokio::test]
async fn admitted_wait_becomes_unavailable_when_its_exact_handle_is_released() {
    use std::future::Future;
    use std::task::Poll;

    for native in [false, true] {
        let fixture = Fixture::start().await;
        let path = fixture.notebook("wait-release", "retained source");
        let mut wire = fixture.wire();
        if !native {
            wire.initialize("2025-11-25").await;
            wire.initialized().await;
        }
        let handle = open(&mut wire, 10, &path, native).await;
        let retained = open(&mut wire, 11, &path, native).await;
        fixture.ready(&handle).await;
        fixture.ready(&retained).await;
        fixture.synced(&handle).await;
        let baseline = payload(
            &wire
                .request(
                    12,
                    "tools/call",
                    Some(tool_params(
                        "wait_for_notebook_change",
                        json!({"notebook_handle":handle}),
                        native,
                    )),
                )
                .await,
        );
        let request = rmcp::model::CallToolRequestParams::new("wait_for_notebook_change")
            .with_arguments(
                json!({"notebook_handle":handle,"after":baseline["cursor"],"timeout_secs":50})
                    .as_object()
                    .unwrap()
                    .clone(),
            );
        {
            let wait = runt_mcp::tools::dispatch(&fixture.server, &request);
            tokio::pin!(wait);
            // Poll the full tool entry point to pending before release, rather
            // than relying on scheduling or sleeping to assume admission.
            std::future::poll_fn(|context| {
                assert!(wait.as_mut().poll(context).is_pending());
                Poll::Ready(())
            })
            .await;
            release(&mut wire, 13, &handle, native).await;
            let waited = tokio::time::timeout(support::DEADLINE, wait)
                .await
                .expect("released ownership must end the admitted wait")
                .unwrap();
            assert_ne!(waited.is_error, Some(true));
            let data = waited.structured_content.unwrap();
            assert_eq!(data["outcome"], "unavailable");
            assert_eq!(data["notebook_handle"], handle);
        }
        // The retained owner keeps the backing peer available: this wait ended
        // because its logical handle was released, not because the peer died.
        assert_eq!(
            read(&mut wire, 14, &retained, native).await["cells"][0]["source_preview"],
            "retained source"
        );
        let expired = wire
            .request(
                15,
                "tools/call",
                Some(tool_params(
                    "wait_for_notebook_change",
                    json!({"notebook_handle":handle}),
                    native,
                )),
            )
            .await;
        support::assert_target_tool_error(&expired, "attachment_expired");
        fixture.stop(wire).await;
    }
}

#[tokio::test]
async fn native_distinct_opens_finish_independently_in_both_orders() {
    for reverse in [false, true] {
        let fixture = Fixture::start().await;
        let a = fixture.notebook("a", "source A");
        let b = fixture.notebook("b", "source B");
        let mut gate_a = Some(fixture.gate(&a));
        let mut gate_b = Some(fixture.gate(&b));
        let mut wire = fixture.wire();
        wire.send_request(
            10,
            "tools/call",
            Some(tool_params("connect_notebook", json!({"path":a}), true)),
        )
        .await;
        gate_a.as_mut().unwrap().reached().await;
        wire.send_request(
            11,
            "tools/call",
            Some(tool_params("connect_notebook", json!({"path":b}), true)),
        )
        .await;
        gate_b.as_mut().unwrap().reached().await;
        let (first_id, second_id) = if reverse { (10, 11) } else { (11, 10) };
        if reverse {
            gate_a.take().unwrap().release();
        } else {
            gate_b.take().unwrap().release();
        }
        let first = payload(&wire.response(first_id).await);
        if reverse {
            gate_b.take().unwrap().release();
        } else {
            gate_a.take().unwrap().release();
        }
        let second = payload(&wire.response(second_id).await);
        let (a_result, b_result) = if reverse {
            (first, second)
        } else {
            (second, first)
        };
        let a_handle = a_result["notebook_handle"].as_str().unwrap();
        let b_handle = b_result["notebook_handle"].as_str().unwrap();
        assert_ne!(a_handle, b_handle);
        assert_ne!(a_result["notebook_id"], b_result["notebook_id"]);
        fixture.ready(a_handle).await;
        fixture.ready(b_handle).await;
        assert_eq!(
            read(&mut wire, 12, a_handle, true).await["cells"][0]["source_preview"],
            "source A"
        );
        assert_eq!(
            read(&mut wire, 13, b_handle, true).await["cells"][0]["source_preview"],
            "source B"
        );
        fixture.stop(wire).await;
    }
}

#[tokio::test]
async fn explicit_a_mutation_remains_on_a_while_b_is_opening() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("a", "source A");
    let b = fixture.notebook("b", "source B");
    let mut wire = fixture.wire();
    let a_handle = open(&mut wire, 10, &a, true).await;
    fixture.ready(&a_handle).await;
    let mut gate = fixture.gate(&b);
    wire.send_request(
        11,
        "tools/call",
        Some(tool_params("connect_notebook", json!({"path":b}), true)),
    )
    .await;
    gate.reached().await;
    // This result must arrive while B's actual daemon connection is blocked.
    let changed = mutate(&mut wire, 12, &a_handle, "edited A", true).await;
    assert_eq!(
        result(&changed)["content"][1]["uri"],
        format!("nteract://sessions/{a_handle}/cells/sentinel")
    );
    gate.release();
    let response = payload(&wire.response(11).await);
    let b_handle = response["notebook_handle"].as_str().unwrap();
    fixture.ready(b_handle).await;
    assert_eq!(
        read(&mut wire, 13, &a_handle, true).await["cells"][0]["source_preview"],
        "edited A"
    );
    assert_eq!(
        read(&mut wire, 14, b_handle, true).await["cells"][0]["source_preview"],
        "source B"
    );
    // Native reads still require an explicit handle after these acquisitions.
    let response = wire
        .request(
            15,
            "tools/call",
            Some(tool_params("get_cell", json!({"cell_id":"sentinel"}), true)),
        )
        .await;
    support::assert_target_tool_error(&response, "missing_notebook_handle");
    fixture.stop(wire).await;
}

#[tokio::test]
async fn in_flight_a_mutation_finishes_on_a_after_b_is_published() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("a", "source A");
    let b = fixture.notebook("b", "source B");
    let mut wire = fixture.wire();
    let a_handle = open(&mut wire, 10, &a, true).await;
    fixture.ready(&a_handle).await;
    fixture.synced(&a_handle).await;
    let mut sync_gate = fixture.sync_gate(&a);
    wire.send_request(11, "tools/call", Some(tool_params("set_cell", json!({"notebook_handle":a_handle,"cell_id":"sentinel","source":"A across B publication"}), true))).await;
    // A has changed its captured peer and is waiting for the daemon to accept
    // its real sync frame. Keep that await pending while B publishes.
    sync_gate.reached().await;
    let a_doc = {
        let entries = fixture.server.attachments().read_entries();
        entries[&a_handle].session.handle.clone()
    };
    tokio::time::timeout(support::DEADLINE, async {
        while a_doc.get_cell_source("sentinel").as_deref() != Some("A across B publication") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("A must enter its captured mutation before B publishes");
    let b_handle = open(&mut wire, 12, &b, true).await;
    fixture.ready(&b_handle).await;
    sync_gate.release();
    let changed = wire.response(11).await;
    assert_eq!(
        result(&changed)["content"][1]["uri"],
        format!("nteract://sessions/{a_handle}/cells/sentinel")
    );
    assert_eq!(
        read(&mut wire, 13, &a_handle, true).await["cells"][0]["source_preview"],
        "A across B publication"
    );
    assert_eq!(
        read(&mut wire, 14, &b_handle, true).await["cells"][0]["source_preview"],
        "source B"
    );
    fixture.synced(&a_handle).await;
    fixture.stop(wire).await;
}

#[tokio::test]
async fn same_notebook_opens_have_independent_handles_and_release() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("a", "shared source");
    let capacity = fixture.reserve_all_but(2);
    let mut gate = fixture.gate(&a);
    let mut wire = fixture.wire();
    wire.send_request(
        10,
        "tools/call",
        Some(tool_params("connect_notebook", json!({"path":a}), true)),
    )
    .await;
    gate.reached().await;
    wire.send_request(
        11,
        "tools/call",
        Some(tool_params("connect_notebook", json!({"path":a}), true)),
    )
    .await;
    fixture.wait_for_reserved_capacity().await;
    drop(capacity);
    gate.release();
    let first = payload(&wire.response(10).await);
    let second = payload(&wire.response(11).await);
    let first_handle = first["notebook_handle"].as_str().unwrap();
    let second_handle = second["notebook_handle"].as_str().unwrap();
    assert_ne!(first_handle, second_handle);
    assert_eq!(first["notebook_id"], second["notebook_id"]);
    fixture.ready(first_handle).await;
    fixture.ready(second_handle).await;
    release(&mut wire, 12, first_handle, true).await;
    result(&mutate(&mut wire, 13, second_handle, "surviving owner", true).await);
    assert_eq!(
        read(&mut wire, 14, second_handle, true).await["cells"][0]["source_preview"],
        "surviving owner"
    );
    let stale = wire
        .request(
            15,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"notebook_handle":first_handle,"cell_id":"sentinel"}),
                true,
            )),
        )
        .await;
    support::assert_target_tool_error(&stale, "attachment_expired");
    let third_response = wire
        .request(
            16,
            "tools/call",
            Some(tool_params(
                "connect_notebook",
                json!({"notebook_id":first["notebook_id"]}),
                true,
            )),
        )
        .await;
    let third = payload(&third_response);
    let third_handle = third["notebook_handle"].as_str().unwrap();
    assert_ne!(third_handle, first_handle);
    assert_ne!(third_handle, second_handle);
    fixture.ready(third_handle).await;
    assert_eq!(
        read(&mut wire, 17, third_handle, true).await["cells"][0]["source_preview"],
        "surviving owner"
    );
    let stale_read = wire
        .request(
            18,
            "resources/read",
            Some(native_params(
                json!({"uri":format!("nteract://sessions/{first_handle}/cells")}),
            )),
        )
        .await;
    assert!(stale_read.get("error").is_some(), "{stale_read}");
    assert_eq!(stale_read["error"]["code"], -32602);
    assert_eq!(
        stale_read["error"]["data"],
        json!({"code":"attachment_expired","notebook_handle":first_handle})
    );
    let stale_wait = wire
        .request(
            19,
            "tools/call",
            Some(tool_params(
                "wait_for_notebook_change",
                json!({"notebook_handle":first_handle,"timeout_secs":0}),
                true,
            )),
        )
        .await;
    support::assert_target_tool_error(&stale_wait, "attachment_expired");
    fixture.stop(wire).await;
}

#[tokio::test]
async fn legacy_acquisition_churn_keeps_retained_attachments_usable() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("a", "retained A");
    let b = fixture.notebook("b", "selected B");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let a_handle = open(&mut wire, 10, &a, false).await;
    fixture.ready(&a_handle).await;
    let mut gate = fixture.gate(&b);
    wire.send_request(
        11,
        "tools/call",
        Some(tool_params("connect_notebook", json!({"path":b}), false)),
    )
    .await;
    gate.reached().await;
    result(&mutate(&mut wire, 12, &a_handle, "A during selection", false).await);
    gate.release();
    let b_response = payload(&wire.response(11).await);
    let b_handle = b_response["notebook_handle"].as_str().unwrap();
    fixture.ready(b_handle).await;
    let selected = wire
        .request(
            13,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"notebook_handle":b_handle,"cell_id":"sentinel"}),
                false,
            )),
        )
        .await;
    assert!(
        result(&selected).to_string().contains("selected B"),
        "{selected}"
    );
    // Exceed the old eight-entry parked-peer cache through retained acquisitions.
    let mut last_handle = String::new();
    for index in 0..10 {
        let path = fixture.notebook(&format!("churn-{index}"), &format!("churn {index}"));
        let handle = open(&mut wire, 20 + index, &path, false).await;
        fixture.ready(&handle).await;
        last_handle = handle;
    }
    assert_eq!(
        read(&mut wire, 40, &a_handle, false).await["cells"][0]["source_preview"],
        "A during selection"
    );
    result(&mutate(&mut wire, 41, &a_handle, "A after cache pressure", false).await);
    let selected = wire
        .request(
            42,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"notebook_handle":last_handle,"cell_id":"sentinel"}),
                false,
            )),
        )
        .await;
    assert!(
        result(&selected).to_string().contains("churn 9"),
        "{selected}"
    );
    fixture.stop(wire).await;
}

#[tokio::test]
async fn ordinary_legacy_acquisitions_retain_independent_owners() {
    let fixture = Fixture::start().await;
    let selected_path = fixture.notebook("selected", "legacy selection");
    let a = fixture.notebook("a", "explicit source");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let selected_handle = open(&mut wire, 10, &selected_path, false).await;
    fixture.ready(&selected_handle).await;
    let capacity = fixture.reserve_all_but(2);
    let mut gate = fixture.gate(&a);
    wire.send_request(
        11,
        "tools/call",
        Some(tool_params("connect_notebook", json!({"path":a}), false)),
    )
    .await;
    gate.reached().await;
    wire.send_request(
        12,
        "tools/call",
        Some(tool_params("connect_notebook", json!({"path":a}), false)),
    )
    .await;
    fixture.wait_for_reserved_capacity().await;
    drop(capacity);
    gate.release();
    let first = payload(&wire.response(11).await);
    let second = payload(&wire.response(12).await);
    let first_handle = first["notebook_handle"].as_str().unwrap();
    let second_handle = second["notebook_handle"].as_str().unwrap();
    assert_ne!(first_handle, second_handle);
    assert_eq!(first["notebook_id"], second["notebook_id"]);
    fixture.ready(first_handle).await;
    fixture.ready(second_handle).await;
    let missing = wire
        .request(
            13,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"cell_id":"sentinel"}),
                false,
            )),
        )
        .await;
    support::assert_target_tool_error(&missing, "missing_notebook_handle");
    let selected = wire
        .request(
            14,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"notebook_handle":selected_handle,"cell_id":"sentinel"}),
                false,
            )),
        )
        .await;
    assert!(
        result(&selected).to_string().contains("legacy selection"),
        "{selected}"
    );
    let id_uri = format!(
        "nteract://notebooks/{}/cells",
        first["notebook_id"].as_str().unwrap()
    );
    let ambiguous = wire
        .request(15, "resources/read", Some(json!({"uri":id_uri})))
        .await;
    assert_eq!(ambiguous["error"]["code"], -32602);
    assert!(ambiguous["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Ambiguous notebook ID"));
    assert_eq!(
        read(&mut wire, 16, first_handle, false).await["cells"][0]["source_preview"],
        "explicit source"
    );
    release(&mut wire, 17, first_handle, false).await;
    let stale = wire
        .request(
            18,
            "resources/read",
            Some(json!({"uri":format!("nteract://sessions/{first_handle}/cells")})),
        )
        .await;
    assert_eq!(
        stale["error"]["data"],
        json!({"code":"attachment_expired","notebook_handle":first_handle})
    );
    let by_id = wire
        .request(19, "resources/read", Some(json!({"uri":id_uri})))
        .await;
    result(&by_id);
    let changed = wire.request(20, "tools/call", Some(tool_params("set_cell", json!({"notebook_handle":second_handle,"cell_id":"sentinel","source":"explicit survivor"}), false))).await;
    assert_eq!(
        result(&changed)["content"][1]["uri"],
        format!("nteract://sessions/{second_handle}/cells/sentinel")
    );
    assert_eq!(
        read(&mut wire, 21, second_handle, false).await["cells"][0]["source_preview"],
        "explicit survivor"
    );
    let selected = wire
        .request(
            22,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"notebook_handle":selected_handle,"cell_id":"sentinel"}),
                false,
            )),
        )
        .await;
    assert!(
        result(&selected).to_string().contains("legacy selection"),
        "{selected}"
    );
    assert_eq!(fixture.server.attachments().read_entries().len(), 2);
    fixture.stop(wire).await;
}

#[tokio::test]
async fn legacy_reacquisition_keeps_original_handle_and_id_ambiguity() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("a", "legacy A");
    let b = fixture.notebook("b", "legacy B");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let first_response = wire
        .request(
            10,
            "tools/call",
            Some(tool_params("connect_notebook", json!({"path":a}), false)),
        )
        .await;
    let first = payload(&first_response);
    let a_handle = first["notebook_handle"].as_str().unwrap();
    fixture.ready(a_handle).await;
    let b_handle = open(&mut wire, 11, &b, false).await;
    fixture.ready(&b_handle).await;
    let selected_a = open(&mut wire, 12, &a, false).await;
    fixture.ready(&selected_a).await;
    assert_eq!(
        read(&mut wire, 13, a_handle, false).await["cells"][0]["source_preview"],
        "legacy A"
    );
    let id_uri = format!(
        "nteract://notebooks/{}/cells",
        first["notebook_id"].as_str().unwrap()
    );
    let by_id = wire
        .request(14, "resources/read", Some(json!({"uri":id_uri})))
        .await;
    assert_eq!(by_id["error"]["code"], -32602);
    assert!(by_id["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Ambiguous notebook ID"));
    assert_ne!(selected_a, a_handle, "each acquisition owns a fresh handle");
    result(&mutate(&mut wire, 15, a_handle, "A after switch-back", false).await);
    let selected = wire
        .request(
            16,
            "tools/call",
            Some(tool_params(
                "get_cell",
                json!({"notebook_handle":selected_a,"cell_id":"sentinel"}),
                false,
            )),
        )
        .await;
    assert!(result(&selected)
        .to_string()
        .contains("A after switch-back"));
    assert_eq!(
        read(&mut wire, 17, &b_handle, false).await["cells"][0]["source_preview"],
        "legacy B"
    );
    release(&mut wire, 18, &selected_a, false).await;
    result(
        &wire
            .request(19, "resources/read", Some(json!({"uri":id_uri})))
            .await,
    );
    fixture.stop(wire).await;
}

#[tokio::test]
async fn legacy_repeated_acquire_release_keeps_original_owners_and_peers() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("a", "legacy A");
    let b = fixture.notebook("b", "legacy B");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let a_handle = open(&mut wire, 10, &a, false).await;
    fixture.ready(&a_handle).await;
    let b_handle = open(&mut wire, 11, &b, false).await;
    fixture.ready(&b_handle).await;
    let original_docs = {
        let entries = fixture.server.attachments().read_entries();
        [
            entries[&a_handle].session.handle.clone(),
            entries[&b_handle].session.handle.clone(),
        ]
    };
    let pool = runtimed_client::client::PoolClient::new(fixture.root.path().join("daemon.sock"));
    for index in 0..160 {
        let (path, expected) = if index % 2 == 0 {
            (&a, &a_handle)
        } else {
            (&b, &b_handle)
        };
        let handle = open(&mut wire, 20 + index * 2, path, false).await;
        fixture.ready(&handle).await;
        let retained = fixture.server.attachments().read_entries().len();
        let rooms = pool.list_rooms().await.unwrap();
        let peers: usize = rooms.iter().map(|room| room.active_peers).sum();
        eprintln!(
            "legacy acquisition {index}: {retained} retained owners, {peers} active daemon peers"
        );
        assert_eq!(
            retained, 3,
            "each acquisition must retain an independent owner"
        );
        assert_ne!(handle, *expected);
        assert_eq!(
            peers, 2,
            "same-target acquisition must share the healthy backing"
        );
        release(&mut wire, 21 + index * 2, &handle, false).await;
        assert_eq!(fixture.server.attachments().read_entries().len(), 2);
        // Strict receipts from the original captured handles catch peer
        // replacement even if a broken implementation reuses the handle text.
        for doc in &original_docs {
            tokio::time::timeout(support::DEADLINE, doc.confirm_notebook_sync())
                .await
                .unwrap()
                .unwrap();
        }
    }
    assert_eq!(
        read(&mut wire, 500, &a_handle, false).await["cells"][0]["source_preview"],
        "legacy A"
    );
    assert_eq!(
        read(&mut wire, 501, &b_handle, false).await["cells"][0]["source_preview"],
        "legacy B"
    );
    fixture.stop(wire).await;
}

#[tokio::test]
async fn admission_counts_pending_opens_without_evicting_retained_handles() {
    let fixture = Fixture::start().await;
    let a = fixture.notebook("a", "admission sentinel");
    let b = fixture.notebook("pending", "pending sentinel");
    let mut wire = fixture.wire();
    let mut retained = Vec::new();
    for index in 0..127 {
        let path = fixture.notebook(&format!("retained-{index}"), "admission sentinel");
        let handle = open(&mut wire, 1000 + index, &path, true).await;
        fixture.ready(&handle).await;
        retained.push(handle);
    }
    // A failed acquisition must give back its reservation.
    let failed = wire
        .request(
            1200,
            "tools/call",
            Some(tool_params(
                "connect_notebook",
                json!({"path":fixture.root.path().join("missing.ipynb")}),
                true,
            )),
        )
        .await;
    assert!(
        failed.get("error").is_some() || failed["result"]["isError"] == true,
        "{failed}"
    );
    let mut gate = fixture.gate(&b);
    wire.send_request(
        1201,
        "tools/call",
        Some(tool_params("connect_notebook", json!({"path":b}), true)),
    )
    .await;
    gate.reached().await;
    let refused = wire
        .request(
            1202,
            "tools/call",
            Some(tool_params("connect_notebook", json!({"path":a}), true)),
        )
        .await;
    assert!(
        support::assert_target_tool_error(&refused, "attachment_limit")["message"]
            .as_str()
            .unwrap()
            .contains("attachment_limit"),
        "{refused}"
    );
    wire.send(
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1201}}),
    )
    .await;
    // rmcp suppresses responses for cancelled requests. Observe the released
    // reservation while the real daemon open remains blocked instead.
    tokio::time::timeout(support::DEADLINE, async {
        loop {
            if fixture.server.attachments().reserve().is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled open must return its reservation");
    gate.release();
    // Capacity becoming available is the barrier, not a timed sleep.
    let last = open(&mut wire, 1203, &a, true).await;
    retained.push(last);
    let refused = wire
        .request(
            1204,
            "tools/call",
            Some(tool_params("connect_notebook", json!({"path":a}), true)),
        )
        .await;
    assert!(
        support::assert_target_tool_error(&refused, "attachment_limit")["message"]
            .as_str()
            .unwrap()
            .contains("attachment_limit"),
        "{refused}"
    );
    for (index, handle) in retained.iter().enumerate() {
        fixture.ready(handle).await;
        let data = read(&mut wire, 2000 + index as u64, handle, true).await;
        assert_eq!(data["notebook_handle"], *handle);
        assert_eq!(data["cells"][0]["source_preview"], "admission sentinel");
    }
    release(&mut wire, 2200, &retained[0], true).await;
    let fresh = open(&mut wire, 2201, &a, true).await;
    assert!(!retained.contains(&fresh));
    fixture.ready(&fresh).await;
    assert_eq!(
        read(&mut wire, 2202, &fresh, true).await["cells"][0]["source_preview"],
        "admission sentinel"
    );
    fixture.stop(wire).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_shutdown_reply_requires_clean_owned_daemon_exit() {
    assert_shutdown_reply_fault(ShutdownFault::LostReply).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn truncated_shutdown_reply_requires_clean_owned_daemon_exit() {
    assert_shutdown_reply_fault(ShutdownFault::TruncatedReply).await;
}

async fn assert_shutdown_reply_fault(fault: ShutdownFault) {
    let fixture = Fixture::start().await;
    let a_path = fixture.notebook("shutdown-a", "source A");
    let b_path = fixture.notebook("shutdown-b", "source B");
    let mut wire = fixture.wire();
    let a = open(&mut wire, 10, &a_path, true).await;
    let b = open(&mut wire, 11, &b_path, true).await;
    for handle in [&a, &b] {
        fixture.ready(handle).await;
        fixture.synced(handle).await;
    }
    result(&mutate(&mut wire, 12, &a, "durable A before shutdown", true).await);
    fixture.synced(&a).await;
    assert_eq!(
        read(&mut wire, 13, &b, true).await["cells"][0]["source_preview"],
        "source B"
    );
    fixture.stop_with_shutdown_fault(wire, fault).await;
}

async fn reject_shutdown_fault(fault: ShutdownFault) {
    let fixture = Fixture::start().await;
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    fixture.stop_with_shutdown_fault(wire, fault).await;
}

#[tokio::test]
#[should_panic(expected = "daemon shutdown request failed")]
async fn shutdown_refusal_does_not_pass_fixture_cleanup() {
    reject_shutdown_fault(ShutdownFault::Refusal).await;
}

#[tokio::test]
#[should_panic(expected = "daemon failed:")]
async fn shutdown_eof_does_not_hide_failed_owned_child() {
    reject_shutdown_fault(ShutdownFault::FailedChild).await;
}

#[tokio::test]
#[should_panic(expected = "daemon must stop cleanly after shutdown reply")]
async fn shutdown_eof_does_not_pass_with_live_owned_child() {
    reject_shutdown_fault(ShutdownFault::Disconnect).await;
}
