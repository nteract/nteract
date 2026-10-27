//! Keyed documents through a real room: the coordinator's runtime-agent
//! connection, the peer loop and a `notebook-sync` client.

use std::sync::Arc;
use std::time::Duration;

use automerge::transaction::Transactable;
use automerge::{ReadDoc, ROOT};
use notebook_protocol::connection::{
    self, FrameSource, FramedReader, NotebookFrameType, TypedNotebookFrame, WriterFrameSink,
};
use notebook_protocol::protocol::SessionControlMessage;
use notebook_sync::KeyedDocEvent;
use tokio::io::{AsyncWrite, WriteHalf};
use uuid::Uuid;

use super::tests::test_daemon_config;
use super::*;
use crate::blob_store::BlobStore;
use crate::keyed_doc::test_kind::{kv_get, kv_put, TestKvAgentDoc, TestKvKind, TEST_KV};
use crate::keyed_doc::{AgentDocs, KeyedDocHub};

const TIMEOUT: Duration = Duration::from_secs(10);

fn room_with_kinds(tmp: &tempfile::TempDir, kind: Option<Arc<TestKvKind>>) -> Arc<NotebookRoom> {
    let mut room = NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        tmp.path(),
        Arc::new(BlobStore::new(tmp.path().join("blobs"))),
        false,
    );
    room.keyed_docs = Arc::new(KeyedDocHub::new(
        kind.into_iter()
            .map(|kind| kind as Arc<dyn crate::keyed_doc::KeyedDocKind>)
            .collect(),
    ));
    Arc::new(room)
}

struct ReaderSource(FramedReader);

impl FrameSource for ReaderSource {
    async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
        self.0.recv().await
    }
}

/// Start the coordinator half of a runtime-agent connection and return the
/// agent's end of the socket.
async fn connect_runtime_agent(
    tmp: &tempfile::TempDir,
    room: &Arc<NotebookRoom>,
) -> (
    FramedReader,
    WriteHalf<tokio::io::DuplexStream>,
    tokio::task::JoinHandle<()>,
) {
    let agent_id = "runtime-agent:keyed-doc-test";
    room.expect_runtime_agent(agent_id);
    *room.current_runtime_agent_id.write().await = Some(agent_id.into());
    let (coordinator_socket, agent_socket) = tokio::io::duplex(1024 * 1024);
    let (reader, writer) = tokio::io::split(coordinator_socket);
    let task = tokio::spawn(handle_runtime_agent_sync_connection(
        reader,
        writer,
        room.clone(),
        room.id.to_string(),
        agent_id.into(),
        tmp.path().join("executions"),
    ));
    let (reader, writer) = tokio::io::split(agent_socket);
    (FramedReader::spawn(reader, 16), writer, task)
}

async fn recv(reader: &mut FramedReader) -> TypedNotebookFrame {
    tokio::time::timeout(TIMEOUT, reader.recv())
        .await
        .expect("frame within timeout")
        .expect("connection open")
        .expect("valid frame")
}

fn capabilities(frame: &TypedNotebookFrame) -> Vec<String> {
    assert_eq!(frame.frame_type, NotebookFrameType::SessionControl);
    match serde_json::from_slice(&frame.payload).unwrap() {
        SessionControlMessage::RuntimeAgentCapabilities { keyed_doc_kinds } => keyed_doc_kinds,
        other => panic!("expected RuntimeAgentCapabilities, got {other:?}"),
    }
}

#[tokio::test]
async fn coordinator_announces_routed_kinds_before_any_sync() {
    let tmp = tempfile::TempDir::new().unwrap();
    let local = room_with_kinds(&tmp, Some(Arc::new(TestKvKind::default())));
    let (mut reader, _writer, task) = connect_runtime_agent(&tmp, &local).await;
    assert_eq!(
        capabilities(&recv(&mut reader).await),
        vec![TEST_KV.to_string()]
    );
    task.abort();

    let hosted_tmp = tempfile::TempDir::new().unwrap();
    let hosted = room_with_kinds(&hosted_tmp, Some(Arc::new(TestKvKind::default())));
    hosted.mark_hosted();
    let (mut reader, _writer, task) = connect_runtime_agent(&hosted_tmp, &hosted).await;
    assert!(
        capabilities(&recv(&mut reader).await).is_empty(),
        "hosted-bridged rooms route no keyed documents"
    );
    task.abort();
}

/// The runtime agent's side of keyed document sync, driven by `AgentDocs`
/// the way `runtime_agent.rs` drives it.
fn spawn_agent<W>(
    mut reader: FramedReader,
    mut writer: W,
    producer: Arc<TestKvAgentDoc>,
) -> tokio::task::JoinHandle<Vec<NotebookFrameType>>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut docs = AgentDocs::new(
            tokio::sync::broadcast::channel(4).0,
            tokio::sync::broadcast::channel(4).0,
        );
        docs.register(producer);
        let mut sent = Vec::new();
        loop {
            tokio::select! {
                frame = reader.recv() => {
                    let Some(Ok(frame)) = frame else { break };
                    match frame.frame_type {
                        NotebookFrameType::SessionControl => {
                            if let Ok(SessionControlMessage::RuntimeAgentCapabilities { keyed_doc_kinds }) =
                                serde_json::from_slice(&frame.payload)
                            {
                                docs.set_coordinator_kinds(keyed_doc_kinds);
                            }
                        }
                        NotebookFrameType::KeyedDocSync => {
                            if let Some(reply) = docs.receive_keyed_frame(&frame.payload).unwrap() {
                                sent.push(NotebookFrameType::KeyedDocSync);
                                connection::send_typed_frame(&mut writer, NotebookFrameType::KeyedDocSync, &reply)
                                    .await
                                    .unwrap();
                            }
                        }
                        _ => {}
                    }
                }
                _ = docs.keyed_changed() => {
                    for frame in docs.outbound_keyed_frames() {
                        sent.push(NotebookFrameType::KeyedDocSync);
                        if connection::send_typed_frame(&mut writer, NotebookFrameType::KeyedDocSync, &frame)
                            .await
                            .is_err()
                        {
                            return sent;
                        }
                    }
                }
            }
        }
        sent
    })
}

async fn wait_for(mut condition: impl FnMut() -> bool, what: &str) {
    tokio::time::timeout(TIMEOUT, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

#[tokio::test]
async fn notebook_sync_client_and_runtime_agent_share_a_keyed_document() {
    let tmp = tempfile::TempDir::new().unwrap();
    let kind = Arc::new(TestKvKind::default());
    kind.set_record("doc-1", 0, true);
    let room = room_with_kinds(&tmp, Some(kind.clone()));

    // Runtime agent produces doc-1 once the coordinator advertises test_kv.
    let producer = Arc::new(TestKvAgentDoc::default());
    producer.insert("doc-1", 0);
    producer.put("doc-1", "a", "from agent");
    let (agent_reader, agent_writer, coordinator) = connect_runtime_agent(&tmp, &room).await;
    let agent = spawn_agent(agent_reader, agent_writer, producer.clone());
    wait_for(
        || {
            room.keyed_docs
                .with_doc(
                    &notebook_wire::KeyedDocKey::new(TEST_KV, "doc-1"),
                    |_, doc| kv_get(doc, "a"),
                )
                .flatten()
                .is_some()
        },
        "the hub to receive the agent's document",
    )
    .await;

    // A notebook-sync client over the peer loop.
    let daemon = crate::daemon::Daemon::new_for_test(test_daemon_config(&tmp)).unwrap();
    let identity = RoomConnectionIdentity::hosted_bridged(
        "user:dev:alice",
        Some("browser:a".into()),
        nteract_identity::ConnectionScope::Editor,
    )
    .unwrap();
    let (client_io, server_io) = tokio::io::duplex(1024 * 1024);
    let (server_reader, server_writer) = tokio::io::split(server_io);
    let (client_reader, client_writer) = tokio::io::split(client_io);
    let ctx = PeerConnectionContext {
        room: room.clone(),
        rooms: Arc::new(RoomRegistry::new()),
        notebook_id: room.id.to_string(),
        daemon,
        peer_id: "keyed-peer".to_string(),
        connection_identity: identity,
        client_protocol_version: connection::PROTOCOL_VERSION,
        default_runtime: Default::default(),
        default_python_env: Default::default(),
        working_dir: None,
        needs_load: None,
    };
    let server = tokio::spawn(async move {
        super::peer_loop::run_sync_loop_v2(server_reader, server_writer, &ctx).await
    });
    let client = notebook_sync::connect::connect_frame_io(
        room.id.to_string(),
        "user:dev:alice/browser:a",
        ReaderSource(FramedReader::spawn(client_reader, 16)),
        WriterFrameSink::new(client_writer),
    )
    .await
    .unwrap();
    let handle = client
        .handle
        .with_keyed_doc_kinds(room.keyed_docs.advertised_kinds());
    let mut events = handle.subscribe_keyed_docs().unwrap();

    // Subscribe with the first frame; the hub pushes the agent's value.
    assert!(handle.open_keyed_doc(TEST_KV, "doc-1", 0).unwrap());
    let read = |key: &str| {
        handle
            .with_keyed_doc(TEST_KV, "doc-1", |view| kv_get(view.doc, key))
            .unwrap()
            .flatten()
    };
    wait_for(
        || read("a").as_deref() == Some("from agent"),
        "the agent value",
    )
    .await;

    // A validated client write reaches the runtime agent.
    handle
        .with_keyed_doc(TEST_KV, "doc-1", |view| {
            kv_put(view.doc, "b", "from client")
        })
        .unwrap();
    wait_for(
        || producer.get("doc-1", "b").as_deref() == Some("from client"),
        "the client write at the agent",
    )
    .await;

    // A refused write comes back as DocResync; neither side keeps it.
    while events.try_recv().is_ok() {}
    handle
        .with_keyed_doc(TEST_KV, "doc-1", |view| {
            view.doc.put(ROOT, "forbidden", "x").unwrap();
            view.doc.commit();
        })
        .unwrap();
    let resync = tokio::time::timeout(TIMEOUT, async {
        loop {
            if let Ok(KeyedDocEvent::Resync { epoch, reason, .. }) = events.recv().await {
                return (epoch, reason);
            }
        }
    })
    .await
    .expect("DocResync within timeout");
    assert_eq!(resync, (0, "only values may change".to_string()));
    wait_for(
        || read("b").as_deref() == Some("from client"),
        "the client replica to resync",
    )
    .await;
    assert!(read("forbidden").is_none());
    assert!(room
        .keyed_docs
        .with_doc(
            &notebook_wire::KeyedDocKey::new(TEST_KV, "doc-1"),
            |_, doc| { doc.get(ROOT, "forbidden").unwrap().is_none() }
        )
        .unwrap());

    // An epoch bump by the agent moves the subscribed client along.
    producer.replace("doc-1");
    kind.set_record("doc-1", 1, true);
    wait_for(
        || {
            handle
                .with_keyed_doc(TEST_KV, "doc-1", |view| view.epoch)
                .unwrap()
                == Some(1)
                && read("b").as_deref() == Some("from client")
        },
        "the client to follow the new epoch",
    )
    .await;

    drop(handle);
    server.abort();
    coordinator.abort();
    agent.abort();
}

/// The coordinator lets kinds drop replicas on each RuntimeStateDoc change.
#[tokio::test]
async fn a_runtime_state_change_drops_replicas_of_closed_records() {
    let tmp = tempfile::TempDir::new().unwrap();
    let kind = Arc::new(TestKvKind::default());
    kind.set_record("doc-1", 0, true);
    let room = room_with_kinds(&tmp, Some(kind.clone()));
    let producer = Arc::new(TestKvAgentDoc::default());
    producer.insert("doc-1", 0);
    producer.put("doc-1", "a", "1");
    let (agent_reader, agent_writer, coordinator) = connect_runtime_agent(&tmp, &room).await;
    let agent = spawn_agent(agent_reader, agent_writer, producer);
    wait_for(
        || room.keyed_docs.ids(TEST_KV) == vec!["doc-1".to_string()],
        "the hub to receive the agent's document",
    )
    .await;

    kind.remove_record("doc-1");
    room.state
        .with_doc(|state| state.set_path(Some("/tmp/closed-record.ipynb")))
        .unwrap();
    wait_for(
        || room.keyed_docs.ids(TEST_KV).is_empty(),
        "the closed document's replica to be dropped",
    )
    .await;

    coordinator.abort();
    agent.abort();
}

/// With no routed kinds, the agent side never sends `KeyedDocSync`.
#[tokio::test]
async fn agent_sends_nothing_for_kinds_the_coordinator_does_not_route() {
    let tmp = tempfile::TempDir::new().unwrap();
    let room = room_with_kinds(&tmp, None);
    let producer = Arc::new(TestKvAgentDoc::default());
    producer.insert("doc-1", 0);
    producer.put("doc-1", "a", "1");
    let (agent_reader, agent_writer, coordinator) = connect_runtime_agent(&tmp, &room).await;
    let agent = spawn_agent(agent_reader, agent_writer, producer.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    producer.put("doc-1", "a", "2");
    tokio::time::sleep(Duration::from_millis(200)).await;
    coordinator.abort();
    let sent = tokio::time::timeout(TIMEOUT, agent).await.unwrap().unwrap();
    assert!(sent.is_empty(), "agent sent {sent:?}");
    assert!(room.keyed_docs.ids(TEST_KV).is_empty());
}
