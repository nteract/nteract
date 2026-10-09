#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/attachments.rs"]
mod attachments;
#[path = "support/explicit_targets.rs"]
mod explicit;
mod support;
use attachments::*;
use serde_json::json;

#[tokio::test]
async fn ordinary_legacy_two_chats_route_create_set_read_and_execute_admission() {
    let fixture = Fixture::start().await;
    let paths = [
        fixture.notebook("a", "original A"),
        fixture.notebook("b", "original B"),
    ];
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let a = open(&mut wire, 10, &paths[0], false).await;
    let b = open(&mut wire, 11, &paths[1], false).await;
    for handle in [&a, &b] {
        fixture.ready(handle).await;
        fixture.synced(handle).await;
    }
    explicit::interleaved_chats(&mut wire, &a, &b, [&paths[0], &paths[1]], 100).await;
    fixture.stop(wire).await;
}

#[tokio::test]
async fn ordinary_legacy_missing_targets_reject_without_notebook_runtime_or_owner_effects() {
    let fixture = Fixture::start().await;
    let a_path = fixture.notebook("a", "original A");
    let b_path = fixture.notebook("b", "original B");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let a = open(&mut wire, 10, &a_path, false).await;
    let b = open(&mut wire, 11, &b_path, false).await;
    for handle in [&a, &b] {
        fixture.ready(handle).await;
        fixture.synced(handle).await;
    }
    let docs = {
        let entries = fixture.server.attachments().read_entries();
        [
            entries[&a].session.handle.clone(),
            entries[&b].session.handle.clone(),
        ]
    };
    let before = docs.each_ref().map(|doc| doc.save_snapshot_pair().unwrap());
    let responses = explicit::missing_targets(&mut wire, 100).await;
    let after = docs.each_ref().map(|doc| doc.save_snapshot_pair().unwrap());
    for index in 0..2 {
        assert_eq!(
            before[index].notebook_heads, after[index].notebook_heads,
            "missing targets must not write notebook {index}"
        );
        assert_eq!(
            before[index].runtime_state_heads, after[index].runtime_state_heads,
            "missing targets must not dispatch runtime effects in notebook {index}"
        );
    }
    assert!(fixture.server.attachments().read_entries().contains_key(&a));
    assert!(fixture.server.attachments().read_entries().contains_key(&b));
    explicit::assert_missing_targets(&responses);
    fixture.stop(wire).await;
}

#[tokio::test]
async fn ordinary_legacy_same_target_acquisitions_release_independently_and_expire_old_handles() {
    let fixture = Fixture::start().await;
    let path = fixture.notebook("a", "shared original");
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    let a1 = open(&mut wire, 10, &path, false).await;
    fixture.ready(&a1).await;
    let a2 = open(&mut wire, 11, &path, false).await;
    assert_ne!(
        a1, a2,
        "ordinary legacy acquisitions need independent logical ownership"
    );
    fixture.ready(&a2).await;
    release(&mut wire, 12, &a1, false).await;
    result(&mutate(&mut wire, 13, &a2, "retained owner", false).await);
    assert_eq!(
        read(&mut wire, 14, &a2, false).await["cells"][0]["source_preview"],
        "retained owner"
    );
    let expired = wire
        .request(
            15,
            "resources/read",
            Some(json!({"uri":format!("nteract://sessions/{a1}/cells")})),
        )
        .await;
    assert_eq!(expired["error"]["data"]["code"], "attachment_expired");
    let a3 = open(&mut wire, 16, &path, false).await;
    assert_ne!(a3, a1);
    assert_ne!(a3, a2);
    fixture.ready(&a3).await;
    let stale_write = wire.request(17, "tools/call", Some(tool_params("set_cell", json!({"notebook_handle":a1,"cell_id":"sentinel","source":"expired owner must not rebind"}), false))).await;
    let error = support::assert_target_tool_error(&stale_write, "attachment_expired");
    assert!(error["message"].as_str().unwrap().contains("expired"));
    for (id, handle) in [(18, &a2), (19, &a3)] {
        assert_eq!(
            read(&mut wire, id, handle, false).await["cells"][0]["source_preview"],
            "retained owner"
        );
    }
    fixture.stop(wire).await;
}

#[tokio::test]
async fn every_initialize_protocol_advertises_required_handles() {
    for version in support::LEGACY_VERSIONS {
        let fixture = Fixture::start().await;
        let mut wire = fixture.wire();
        wire.initialize(version).await;
        wire.initialized().await;
        let response = wire.request(10, "tools/list", None).await;
        for tool in result(&response)["tools"].as_array().unwrap() {
            if mcp_transport::notebook_scoped_tool(tool["name"].as_str().unwrap()) {
                assert!(
                    tool["inputSchema"]["required"]
                        .as_array()
                        .is_some_and(|fields| fields
                            .iter()
                            .any(|field| field == "notebook_handle")),
                    "{version}: {} needs required notebook_handle",
                    tool["name"]
                );
            }
        }
        fixture.stop(wire).await;
    }
}

#[tokio::test]
async fn launch_selectors_are_target_feedback_but_unrelated_arguments_keep_protocol_errors() {
    for native in [false, true] {
        let fixture = Fixture::start().await;
        let path = fixture.notebook("launch-admission", "unchanged source");
        let mut wire = fixture.wire();
        if !native {
            wire.initialize("2025-11-25").await;
            wire.initialized().await;
        }
        let handle = open(&mut wire, 10, &path, native).await;
        fixture.ready(&handle).await;
        for (index, (extra, target_error)) in [
            (json!({"path":"/wrong.ipynb"}), true),
            (json!({"notebook_id":"wrong"}), true),
            (json!({"timeout_secs":1}), false),
        ]
        .into_iter()
        .enumerate()
        {
            let mut arguments = json!({"notebook_handle":handle});
            arguments
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let response = wire
                .request(
                    20 + index as u64,
                    "tools/call",
                    Some(tool_params("resolve_notebook_launch", arguments, native)),
                )
                .await;
            if target_error {
                support::assert_target_tool_error(&response, "invalid_notebook_target");
            } else {
                assert_eq!(response["error"]["code"], -32602, "{response}");
                assert!(response["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("timeout_secs"));
            }
        }
        assert_eq!(
            read(&mut wire, 30, &handle, native).await["cells"][0]["source_preview"],
            "unchanged source"
        );
        fixture.stop(wire).await;
    }
}
