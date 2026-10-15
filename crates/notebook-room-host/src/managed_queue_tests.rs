use super::*;
use automerge::ReadDoc;

const PRINCIPAL: &str = "user:dev:managed-test";
const PEER: &str = "managed-python:session-1";
const ACTOR: &str = "user:dev:managed-test/managed-python:session-1";

fn fixture() -> RoomHostEngine {
    let mut host = RoomHostEngine::create_empty("managed-queue", "system/schema:room").unwrap();
    host.state_doc.set_actor("system/room");
    let attachment = serde_json::from_value(serde_json::json!({
        "workstation_id":"celld-preview-python", "display_name":"Python", "provider":"pyodide",
        "default_environment_label":"Python", "environment_policy":"pyodide",
        "status":"ready", "runtime_session_id":"session-1"
    }))
    .unwrap();
    host.set_workstation_attachment(Some(&attachment)).unwrap();
    host.seed_initial_code_cell_if_empty("one").unwrap();
    host.doc.add_cell_after("two", "code", Some("one")).unwrap();
    host.doc
        .add_cell_after("three", "code", Some("two"))
        .unwrap();
    host
}

fn admit(host: &mut RoomHostEngine, cell: &str) -> String {
    host.handle_execute_cell(
        &serde_json::json!({"cell_id":cell}),
        "owner",
        "user:dev:managed-test/browser",
    )
    .unwrap();
    host.doc.get_execution_id(cell).unwrap()
}

fn payload(peer: &mut RuntimeStateDoc, baseline: &[automerge::ChangeHash]) -> Vec<u8> {
    let changes = peer.doc_mut().save_after(baseline);
    sync::Message {
        heads: peer.get_heads(),
        need: vec![],
        have: vec![],
        changes: sync::ChunkList::from(changes),
        flags: None,
        version: sync::MessageVersion::V1,
    }
    .encode()
}

fn receive(host: &mut RoomHostEngine, bytes: &[u8]) -> Result<RoomHostFrameResult, RoomHostError> {
    host.receive_managed_runtime_state_sync(PEER, PRINCIPAL, "session-1", bytes)
}

fn assert_queue(host: &RoomHostEngine, executing: Option<&str>, queued: &[&str]) {
    let mut state = host.state_doc.read_state();
    state.queue = host.state_doc.read_explicit_queue();
    assert_eq!(
        state
            .queue
            .executing
            .as_ref()
            .map(|e| e.execution_id.as_str()),
        executing
    );
    assert_eq!(
        state
            .queue
            .queued
            .iter()
            .map(|e| e.execution_id.as_str())
            .collect::<Vec<_>>(),
        queued
    );
    let (_, queue) = host
        .state_doc
        .doc()
        .get(automerge::ROOT, "queue")
        .unwrap()
        .unwrap();
    let (_, list) = host
        .state_doc
        .doc()
        .get(&queue, "queued_execution_ids")
        .unwrap()
        .unwrap();
    assert_eq!(
        host.state_doc.doc().length(&list),
        queued.len(),
        "physical list has no hidden duplicates"
    );
}

#[test]
fn concurrent_admission_and_running_progress_keep_unique_ordered_queue() {
    for initial_count in [1, 2] {
        let mut host = fixture();
        let one = admit(&mut host, "one");
        let two = (initial_count == 2).then(|| admit(&mut host, "two"));
        let baseline = host.state_doc.get_heads();
        let mut peer = host.state_doc.fork_with_actor(ACTOR);
        peer.set_execution_running(&one).unwrap();
        // Runtime publishes progress only; room admission is held concurrent.
        let bytes = payload(&mut peer, &baseline);
        let three = admit(&mut host, "three");
        assert_ne!(one, three);
        let result = receive(&mut host, &bytes).unwrap();
        assert!(result.runtime_state_changed);
        let mut expected = two.iter().map(String::as_str).collect::<Vec<_>>();
        expected.push(&three);
        assert_queue(&host, Some(&one), &expected);
        let applied = host.state_doc.get_heads();
        assert!(
            !receive(&mut host, &bytes).unwrap().changed,
            "duplicate frame is idempotent"
        );
        assert_eq!(host.state_doc.get_heads(), applied);
        assert_queue(&host, Some(&one), &expected);
    }
}

#[test]
fn concurrent_admission_and_terminal_progress_preserve_outputs_and_pending_work() {
    for success in [true, false] {
        let mut host = fixture();
        let one = admit(&mut host, "one");
        let two = admit(&mut host, "two");
        host.state_doc.set_execution_running(&one).unwrap();
        host.state_doc
            .set_queue(
                Some(&QueueEntry {
                    execution_id: one.clone(),
                }),
                &[QueueEntry {
                    execution_id: two.clone(),
                }],
            )
            .unwrap();
        let baseline = host.state_doc.get_heads();
        let mut peer = host.state_doc.fork_with_actor(ACTOR);
        let output = serde_json::json!({"output_type":"stream", "output_id":"output-1", "name":"stdout", "text":{"inline":"finished"}});
        peer.append_output(&one, &output).unwrap();
        peer.set_execution_done(&one, success).unwrap();
        let bytes = payload(&mut peer, &baseline);
        let three = admit(&mut host, "three");
        receive(&mut host, &bytes).unwrap();
        assert_queue(&host, None, &[&two, &three]);
        assert_eq!(host.state_doc.get_outputs(&one), vec![output]);
        assert_eq!(
            host.state_doc.get_execution(&one).unwrap().status,
            if success { "done" } else { "error" }
        );
    }
}

#[test]
fn inactive_history_is_not_scheduled_or_authorized_for_progress() {
    let mut host = fixture();
    host.state_doc
        .create_execution_with_source("historical-queued", "must not run", 0)
        .unwrap();
    host.state_doc
        .create_execution_with_source("uncertain-running", "may have run", 1)
        .unwrap();
    host.state_doc
        .set_execution_running("uncertain-running")
        .unwrap();
    let one = admit(&mut host, "one");
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.set_execution_running(&one).unwrap();
    receive(&mut host, &payload(&mut peer, &baseline)).unwrap();
    assert_queue(&host, Some(&one), &[]);
    assert_eq!(
        host.state_doc
            .get_execution("historical-queued")
            .unwrap()
            .status,
        "queued"
    );
    assert_eq!(
        host.state_doc
            .get_execution("uncertain-running")
            .unwrap()
            .status,
        "running"
    );
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.set_execution_cancelled("historical-queued").unwrap();
    let error = receive(&mut host, &payload(&mut peer, &baseline)).unwrap_err();
    assert!(error.to_string().contains("outside the active queue"));
    assert_eq!(host.state_doc.get_heads(), baseline);
}

#[test]
fn cancelled_work_and_replaced_sessions_cannot_publish_late_progress() {
    let mut host = fixture();
    let one = admit(&mut host, "one");
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.set_execution_running(&one).unwrap();
    let bytes = payload(&mut peer, &baseline);
    let mut attachment = host.workstation_attachment().unwrap();
    attachment.runtime_session_id = Some("session-2".to_string());
    host.set_workstation_attachment(Some(&attachment)).unwrap();
    let after_replacement = host.state_doc.get_heads();
    assert!(receive(&mut host, &bytes)
        .unwrap_err()
        .to_string()
        .contains("replaced session"));
    assert_eq!(host.state_doc.get_heads(), after_replacement);

    attachment.runtime_session_id = Some("session-1".to_string());
    host.set_workstation_attachment(Some(&attachment)).unwrap();
    host.cancel_unstarted_executions().unwrap();
    let cancelled = host.state_doc.get_heads();
    assert!(receive(&mut host, &bytes).is_err());
    assert_eq!(host.state_doc.get_heads(), cancelled);
    assert_queue(&host, None, &[]);
}

#[test]
fn invalid_peer_queue_writes_are_rejected_before_host_projection() {
    let mut host = fixture();
    let one = admit(&mut host, "one");
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.set_execution_running(&one).unwrap();
    peer.set_queue(Some(&QueueEntry { execution_id: one }), &[])
        .unwrap();
    let bytes = payload(&mut peer, &baseline);
    assert!(receive(&mut host, &bytes)
        .unwrap_err()
        .to_string()
        .contains("room-owned queue"));
    assert_eq!(host.state_doc.get_heads(), baseline);
    // The legacy/native ingress still accepts its existing peer-owned protocol.
    assert!(
        host.receive_runtime_state_sync(
            "native-peer",
            PRINCIPAL,
            RuntimeStateWriteScope::RuntimePeer,
            &bytes
        )
        .unwrap()
        .changed
    );
}

#[test]
fn invalid_execution_intent_is_not_normalized_by_host_projection() {
    let mut host = fixture();
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.create_execution_with_source("forged", "must not run", 0)
        .unwrap();
    assert!(receive(&mut host, &payload(&mut peer, &baseline))
        .unwrap_err()
        .to_string()
        .contains("execution intent"));
    assert_eq!(host.state_doc.get_heads(), baseline);
}

#[test]
fn disconnected_current_session_accepts_reconnect_progress() {
    let mut host = fixture();
    let one = admit(&mut host, "one");
    let mut attachment = host.workstation_attachment().unwrap();
    attachment.status = "disconnected".to_string();
    host.set_workstation_attachment(Some(&attachment)).unwrap();
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.set_execution_running(&one).unwrap();
    receive(&mut host, &payload(&mut peer, &baseline)).unwrap();
    assert_queue(&host, Some(&one), &[]);
}

#[test]
fn managed_activity_and_idle_ignore_history_but_preserve_active_work() {
    let mut host = fixture();
    host.state_doc
        .create_execution_with_source("old-queued", "source", 0)
        .unwrap();
    host.state_doc
        .create_execution_with_source("old-running", "source", 1)
        .unwrap();
    host.state_doc.set_execution_running("old-running").unwrap();
    assert_eq!(host.runtime_queue_depth(), 0);
    assert!(!host.runtime_execution_activity().executing);
    assert_eq!(host.runtime_execution_activity().queue_depth, 0);
    // The native/default compatibility view still reports inflight history.
    let native = runtime_execution_activity(&host.state_doc.read_state());
    assert!(native.executing);
    assert_eq!(native.queue_depth, 1);
    let one = admit(&mut host, "one");
    assert_eq!(host.runtime_queue_depth(), 1);
    assert!(!host.reconcile_runtime_idle_timeout("idle").unwrap().changed);
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.set_execution_running(&one).unwrap();
    receive(&mut host, &payload(&mut peer, &baseline)).unwrap();
    assert!(host.runtime_execution_activity().executing);
    assert!(!host.reconcile_runtime_idle_timeout("idle").unwrap().changed);
    let baseline = host.state_doc.get_heads();
    let mut peer = host.state_doc.fork_with_actor(ACTOR);
    peer.set_execution_done(&one, true).unwrap();
    receive(&mut host, &payload(&mut peer, &baseline)).unwrap();
    assert!(host.reconcile_runtime_idle_timeout("idle").unwrap().changed);
    assert_eq!(host.workstation_attachment().unwrap().status, "idle");
    assert_eq!(
        host.state_doc.get_execution("old-queued").unwrap().status,
        "queued"
    );
    assert_eq!(
        host.state_doc.get_execution("old-running").unwrap().status,
        "running"
    );
}
