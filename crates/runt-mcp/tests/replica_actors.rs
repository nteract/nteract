#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/attachments.rs"]
mod attachments;
mod support;
use attachments::*;
use std::sync::Arc;

// Exercise independent and shared physical replicas through a real isolated daemon.
#[tokio::test]
async fn already_open_file_room_shares_healthy_peer() {
    let fixture = Fixture::start_with_trace().await;
    let path = fixture.notebook("already-open", "baseline");
    let mut keeper_wire = fixture.wire();
    let keeper = open(&mut keeper_wire, 1, &path, true).await;
    fixture.ready(&keeper).await;
    fixture.synced(&keeper).await;

    let worker = Arc::new(runt_mcp::NteractMcp::new_no_show(
        fixture.root.path().join("daemon.sock"),
        None,
        Some(fixture.root.path().join("blobs")),
    ));
    let mut wire = support::Wire::start(worker.clone());
    let first = open(&mut wire, 2, &path, true).await;
    let first_doc = worker.attachments().read_entries()[&first]
        .session
        .handle
        .clone();
    first_doc
        .await_session_ready_timeout(support::DEADLINE)
        .await
        .unwrap();
    first_doc.confirm_notebook_sync().await.unwrap();
    let phase = worker.attachments().read_entries()[&first]
        .session
        .readiness()
        .source_state
        .clone();
    assert_eq!(phase["phase"], "ready");

    let second = open(&mut wire, 3, &path, true).await;
    let second_doc = worker.attachments().read_entries()[&second]
        .session
        .handle
        .clone();
    second_doc
        .await_session_ready_timeout(support::DEADLINE)
        .await
        .unwrap();
    second_doc.confirm_notebook_sync().await.unwrap();
    let rooms = runtimed_client::client::PoolClient::new(fixture.root.path().join("daemon.sock"))
        .list_rooms()
        .await
        .unwrap();
    let peers: usize = rooms.iter().map(|room| room.active_peers).sum();
    assert_eq!(peers, 2, "one keeper plus one shared MCP peer");
    let actor = first_doc.get_actor_id().unwrap();
    assert_eq!(actor, second_doc.get_actor_id().unwrap());
    eprintln!("verified control: already-open file has phase=ready and physical peers={peers}");
    worker.shutdown().await;
    assert!(wire.finish().await);
    fixture.stop(keeper_wire).await;
}

#[tokio::test]
async fn independent_replicas_converge_after_create_then_connect() {
    let fixture = Fixture::start_with_trace().await;
    let mut wire = fixture.wire();
    // An empty project directory prevents environment resolution. We only test
    // notebook content, and the fixture also forbids real runtime-agent launch.
    let created_response = wire.request(1, "tools/call", Some(tool_params(
        "create_notebook",
        serde_json::json!({"runtime":"python", "environment_mode":"project", "working_dir":fixture.root.path()}),
        true,
    ))).await;
    let created = payload(&created_response);
    let first = created["notebook_handle"].as_str().unwrap();
    fixture.ready(first).await;
    let first_doc = fixture.server.attachments().read_entries()[first]
        .session
        .handle
        .clone();
    let cell_response = wire.request(2, "tools/call", Some(tool_params(
        "create_cell",
        serde_json::json!({"notebook_handle":first,"cell_type":"markdown","source":"baseline"}),
        true,
    ))).await;
    result(&cell_response);
    let cell_id = first_doc
        .get_cell_ids()
        .into_iter()
        .find(|id| first_doc.get_cell_source(id).as_deref() == Some("baseline"))
        .expect("the created markdown cell");
    first_doc.confirm_notebook_sync().await.unwrap();
    let second_result = payload(
        &wire
            .request(
                3,
                "tools/call",
                Some(tool_params(
                    "connect_notebook",
                    serde_json::json!({"notebook_id":created["notebook_id"]}),
                    true,
                )),
            )
            .await,
    );
    let second = second_result["notebook_handle"].as_str().unwrap();
    fixture.ready(second).await;
    let second_doc = fixture.server.attachments().read_entries()[second]
        .session
        .handle
        .clone();
    second_doc.confirm_notebook_sync().await.unwrap();
    let rooms = runtimed_client::client::PoolClient::new(fixture.root.path().join("daemon.sock"))
        .list_rooms()
        .await
        .unwrap();
    let peers: usize = rooms.iter().map(|room| room.active_peers).sum();
    assert_eq!(
        peers, 2,
        "create plus connect created independent physical peers"
    );
    assert_ne!(
        first_doc.get_actor_id().unwrap(),
        second_doc.get_actor_id().unwrap()
    );

    // This single-threaded runtime cannot run either sync task between these writes.
    first_doc
        .update_source(&cell_id, "first concurrent edit")
        .unwrap();
    second_doc
        .update_source(&cell_id, "second concurrent edit")
        .unwrap();
    first_doc
        .create_comment_thread(
            comments_doc::CommentAnchor::Notebook,
            "first replica comment".into(),
        )
        .unwrap();
    second_doc
        .create_comment_thread(
            comments_doc::CommentAnchor::Notebook,
            "second replica comment".into(),
        )
        .unwrap();
    let (first_sync, second_sync) = tokio::join!(
        first_doc.confirm_notebook_sync(),
        second_doc.confirm_notebook_sync()
    );
    first_sync.unwrap();
    second_sync.unwrap();
    tokio::time::timeout(support::DEADLINE, async {
        loop {
            let first_comments =
                serde_json::to_string(&first_doc.get_comments_projection().unwrap()).unwrap();
            let second_comments =
                serde_json::to_string(&second_doc.get_comments_projection().unwrap()).unwrap();
            if first_doc.current_heads_hex().unwrap() == second_doc.current_heads_hex().unwrap()
                && first_doc.get_cell_source(&cell_id) == second_doc.get_cell_source(&cell_id)
                && first_comments == second_comments
                && first_comments.contains("first replica comment")
                && first_comments.contains("second replica comment")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both independently authored documents converge");
    let log = std::fs::read_to_string(fixture.root.path().join("daemon.log")).unwrap();
    assert!(
        !log.contains("DuplicateSeqNumber") && !log.contains("duplicate seq"),
        "{log}"
    );
    fixture.stop(wire).await;
}
