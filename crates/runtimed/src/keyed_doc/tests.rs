//! Hub routing tests with the `test_kv` kind.

use std::sync::Arc;

use automerge::sync::{self, SyncDoc};
use automerge::transaction::Transactable;
use automerge::{AutoCommit, ROOT};
use notebook_protocol::protocol::SessionControlMessage;
use notebook_wire::{KeyedDocFrameHeader, KeyedDocKey};
use nteract_identity::ConnectionScope;
use runtime_doc::{RuntimeStateDoc, RuntimeStateHandle};

use super::test_kind::{kv_get, kv_peer_doc, kv_put, TestKvAgentDoc, TestKvKind, TEST_KV};
use super::{AgentKeyedDoc, KeyedDocHub, KeyedSyncStates};
use crate::notebook_sync_server::RoomConnectionIdentity;

const ALICE: &str = "user:dev:alice/browser:a";
const BOB: &str = "user:dev:bob/browser:b";

fn identity(principal: &str, operator: &str, scope: ConnectionScope) -> RoomConnectionIdentity {
    RoomConnectionIdentity::hosted_bridged(principal, Some(operator.into()), scope).unwrap()
}

fn alice() -> RoomConnectionIdentity {
    identity("user:dev:alice", "browser:a", ConnectionScope::Editor)
}

fn bob() -> RoomConnectionIdentity {
    identity("user:dev:bob", "browser:b", ConnectionScope::Editor)
}

fn state() -> RuntimeStateHandle {
    RuntimeStateHandle::new(RuntimeStateDoc::new(), tokio::sync::broadcast::channel(4).0)
}

fn key(id: &str) -> KeyedDocKey {
    KeyedDocKey::new(TEST_KV, id)
}

/// A room hub with `test_kv` plus the runtime agent's producer, already
/// synced so the hub holds `doc-1` at epoch 0 with `a = 1`.
struct Room {
    kind: Arc<TestKvKind>,
    hub: Arc<KeyedDocHub>,
    agent: Arc<TestKvAgentDoc>,
    agent_states: KeyedSyncStates,
    hub_agent_states: KeyedSyncStates,
    state: RuntimeStateHandle,
}

impl Room {
    fn new() -> Self {
        let kind = Arc::new(TestKvKind::default());
        kind.set_record("doc-1", 0, true);
        let agent = Arc::new(TestKvAgentDoc::default());
        agent.insert("doc-1", 0);
        agent.put("doc-1", "a", "1");
        let mut room = Self {
            hub: Arc::new(KeyedDocHub::new(vec![kind.clone()])),
            kind,
            agent,
            agent_states: KeyedSyncStates::new(),
            hub_agent_states: KeyedSyncStates::new(),
            state: state(),
        };
        room.sync_agent();
        room
    }

    /// Exchange frames between the agent producer and the hub until quiet.
    fn sync_agent(&mut self) {
        for _ in 0..16 {
            let mut quiet = true;
            for frame in self.agent.generate_frames(&mut self.agent_states) {
                quiet = false;
                for reply in self
                    .hub
                    .receive_runtime_frame(&mut self.hub_agent_states, &frame)
                {
                    self.agent_receive(&reply);
                }
            }
            for frame in self.hub.runtime_updates(&mut self.hub_agent_states, None) {
                quiet = false;
                self.agent_receive(&frame);
            }
            if quiet {
                return;
            }
        }
        panic!("agent and hub did not converge");
    }

    fn agent_receive(&mut self, frame: &[u8]) {
        let (header, body) = KeyedDocFrameHeader::try_parse(frame).unwrap();
        let message = sync::Message::decode(body).unwrap();
        if let Some(reply) = self
            .agent
            .receive_frame(&header, message, &mut self.agent_states)
            .unwrap()
        {
            self.hub
                .receive_runtime_frame(&mut self.hub_agent_states, &reply);
        }
    }

    fn hub_value(&self, id: &str, value_key: &str) -> Option<String> {
        self.hub
            .with_doc(&key(id), |_, doc| kv_get(doc, value_key))
            .flatten()
    }
}

/// A notebook peer holding one replica, as `notebook-sync` does.
struct Peer {
    identity: RoomConnectionIdentity,
    doc: AutoCommit,
    state: sync::State,
    epoch: u64,
    hub_states: KeyedSyncStates,
    resyncs: Vec<SessionControlMessage>,
}

impl Peer {
    fn new(identity: RoomConnectionIdentity, actor: &str) -> Self {
        Self {
            identity,
            doc: kv_peer_doc(actor),
            state: sync::State::new(),
            epoch: 0,
            hub_states: KeyedSyncStates::new(),
            resyncs: Vec::new(),
        }
    }

    fn frame(&mut self, id: &str) -> Option<Vec<u8>> {
        let message = self.doc.sync().generate_sync_message(&mut self.state)?;
        Some(KeyedDocFrameHeader::new(TEST_KV, id, self.epoch).encode_frame(&message.encode()))
    }

    /// The opening frame, even when Automerge has nothing to say.
    fn opening_frame(&mut self, id: &str) -> Vec<u8> {
        self.frame(id)
            .unwrap_or_else(|| KeyedDocFrameHeader::new(TEST_KV, id, self.epoch).encode_frame(&[]))
    }

    fn receive(&mut self, frame: &[u8]) {
        let (header, body) = KeyedDocFrameHeader::try_parse(frame).unwrap();
        if header.epoch > self.epoch {
            self.restart(header.epoch);
        }
        let message = sync::Message::decode(body).unwrap();
        self.doc
            .sync()
            .receive_sync_message(&mut self.state, message)
            .unwrap();
    }

    fn restart(&mut self, epoch: u64) {
        let actor = self.doc.get_actor().clone();
        self.doc = AutoCommit::new().with_actor(actor);
        self.state = sync::State::new();
        self.epoch = epoch;
    }

    /// Send `frame` to the hub and apply every reply.
    fn send(&mut self, hub: &KeyedDocHub, state: &RuntimeStateHandle, frame: &[u8]) {
        let reply = hub.receive_peer_frame(&mut self.hub_states, frame, &self.identity, state);
        if let Some(resync) = reply.resync {
            if let SessionControlMessage::DocResync { epoch, .. } = &resync {
                self.restart(*epoch);
            }
            self.resyncs.push(resync);
        }
        for frame in reply.frames {
            self.receive(&frame);
        }
    }

    /// Run the sync protocol with the hub until neither side has anything
    /// to send.
    fn sync(&mut self, hub: &KeyedDocHub, state: &RuntimeStateHandle, id: &str) {
        for _ in 0..16 {
            let mut quiet = true;
            if let Some(frame) = self.frame(id) {
                quiet = false;
                self.send(hub, state, &frame);
            }
            for frame in hub.peer_updates(&mut self.hub_states, None) {
                quiet = false;
                self.receive(&frame);
            }
            if quiet {
                return;
            }
        }
        panic!("peer and hub did not converge");
    }

    fn value(&self, value_key: &str) -> Option<String> {
        kv_get(&self.doc, value_key)
    }
}

#[test]
fn advertises_registered_kinds_until_routing_is_disabled() {
    let room = Room::new();
    assert_eq!(room.hub.advertised_kinds(), vec![TEST_KV.to_string()]);
    assert!(KeyedDocHub::default().advertised_kinds().is_empty());
    room.hub.disable_routing();
    assert!(room.hub.advertised_kinds().is_empty());
    let mut peer = Peer::new(alice(), ALICE);
    let frame = peer.opening_frame("doc-1");
    let reply =
        room.hub
            .receive_peer_frame(&mut peer.hub_states, &frame, &peer.identity, &room.state);
    assert!(reply.frames.is_empty() && reply.resync.is_none());
    assert_eq!(peer.hub_states.keys().count(), 0);
}

#[test]
fn peer_subscribes_with_its_first_frame() {
    let mut room = Room::new();
    let mut peer = Peer::new(alice(), ALICE);
    assert!(
        room.hub.peer_updates(&mut peer.hub_states, None).is_empty(),
        "nothing is pushed before the peer asks"
    );
    assert!(room
        .hub
        .peer_updates(&mut peer.hub_states, Some(&key("doc-1")))
        .is_empty());

    let opening = peer.opening_frame("doc-1");
    peer.send(&room.hub, &room.state, &opening);
    peer.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(peer.value("a").as_deref(), Some("1"));
    assert_eq!(
        peer.hub_states.keys().collect::<Vec<_>>(),
        vec![&key("doc-1")]
    );

    // A later runtime change is pushed through the changed channel.
    let mut changed = room.hub.subscribe();
    room.agent.put("doc-1", "a", "2");
    room.sync_agent();
    assert_eq!(changed.try_recv().unwrap(), key("doc-1"));
    let frames = room
        .hub
        .peer_updates(&mut peer.hub_states, Some(&key("doc-1")));
    assert!(!frames.is_empty());
    for frame in frames {
        peer.receive(&frame);
    }
    peer.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(peer.value("a").as_deref(), Some("2"));
}

#[test]
fn unknown_documents_and_kinds_are_dropped_without_subscribing() {
    let room = Room::new();
    let mut peer = Peer::new(alice(), ALICE);
    let unknown = peer.opening_frame("nope");
    let reply =
        room.hub
            .receive_peer_frame(&mut peer.hub_states, &unknown, &peer.identity, &room.state);
    assert!(reply.frames.is_empty() && reply.resync.is_none());
    let other_kind = KeyedDocFrameHeader::new("other_kind", "doc-1", 0).encode_frame(&[]);
    let reply = room.hub.receive_peer_frame(
        &mut peer.hub_states,
        &other_kind,
        &peer.identity,
        &room.state,
    );
    assert!(reply.frames.is_empty() && reply.resync.is_none());
    assert_eq!(peer.hub_states.keys().count(), 0);
    assert!(room.hub.ids(TEST_KV) == vec!["doc-1".to_string()]);
}

#[test]
fn two_peers_converge_through_the_hub() {
    let mut room = Room::new();
    let mut alice_peer = Peer::new(alice(), ALICE);
    let mut bob_peer = Peer::new(bob(), BOB);
    for peer in [&mut alice_peer, &mut bob_peer] {
        let opening = peer.opening_frame("doc-1");
        peer.send(&room.hub, &room.state, &opening);
        peer.sync(&room.hub, &room.state, "doc-1");
    }

    let mut changed = room.hub.subscribe();
    kv_put(&mut alice_peer.doc, "b", "from alice");
    alice_peer.sync(&room.hub, &room.state, "doc-1");
    assert!(alice_peer.resyncs.is_empty(), "{:?}", alice_peer.resyncs);
    assert_eq!(changed.try_recv().unwrap(), key("doc-1"));
    assert_eq!(room.hub_value("doc-1", "b").as_deref(), Some("from alice"));

    bob_peer.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(bob_peer.value("b").as_deref(), Some("from alice"));
    kv_put(&mut bob_peer.doc, "c", "from bob");
    bob_peer.sync(&room.hub, &room.state, "doc-1");
    alice_peer.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(alice_peer.value("c").as_deref(), Some("from bob"));

    // The producer sees peer writes too.
    room.sync_agent();
    assert_eq!(room.agent.get("doc-1", "b").as_deref(), Some("from alice"));
    assert_eq!(room.agent.get("doc-1", "c").as_deref(), Some("from bob"));
}

/// Each refusal returns `DocResync` at the current epoch, leaves the hub
/// replica unchanged, and the peer converges again after restarting.
#[test]
fn refused_writes_resync_and_leave_the_hub_unchanged() {
    type Write = Box<dyn Fn(&mut AutoCommit)>;
    let cases: Vec<(&str, RoomConnectionIdentity, &str, Write)> = vec![
        (
            "content",
            alice(),
            ALICE,
            Box::new(|doc: &mut AutoCommit| {
                doc.put(ROOT, "extra", "x").unwrap();
                doc.commit();
            }),
        ),
        (
            "actor",
            alice(),
            BOB,
            Box::new(|doc: &mut AutoCommit| kv_put(doc, "b", "spoofed")),
        ),
        (
            "viewer",
            identity("user:dev:alice", "browser:a", ConnectionScope::Viewer),
            ALICE,
            Box::new(|doc: &mut AutoCommit| kv_put(doc, "b", "viewer")),
        ),
    ];
    for (label, identity, actor, write) in cases {
        let room = Room::new();
        let mut peer = Peer::new(identity, actor);
        let opening = peer.opening_frame("doc-1");
        peer.send(&room.hub, &room.state, &opening);
        peer.sync(&room.hub, &room.state, "doc-1");
        let heads_before = room.hub.with_doc(&key("doc-1"), |_, doc| doc.get_heads());

        write(&mut peer.doc);
        let frame = peer.frame("doc-1").expect("the write produces a frame");
        peer.send(&room.hub, &room.state, &frame);
        let Some(SessionControlMessage::DocResync {
            kind,
            id,
            epoch,
            reason,
        }) = peer.resyncs.first()
        else {
            panic!("{label}: expected DocResync, got {:?}", peer.resyncs);
        };
        assert_eq!((kind.as_str(), id.as_str(), *epoch), (TEST_KV, "doc-1", 0));
        assert!(!reason.is_empty());
        assert_eq!(
            room.hub.with_doc(&key("doc-1"), |_, doc| doc.get_heads()),
            heads_before,
            "{label}: the hub replica must not change"
        );

        peer.sync(&room.hub, &room.state, "doc-1");
        assert_eq!(peer.value("a").as_deref(), Some("1"), "{label}");
        assert_eq!(peer.value("b"), None, "{label}");
    }
}

#[test]
fn missing_dependencies_request_a_full_resend_without_losing_peer_edits() {
    let room = Room::new();
    let mut peer = Peer::new(alice(), ALICE);
    let opening = peer.opening_frame("doc-1");
    peer.send(&room.hub, &room.state, &opening);
    peer.sync(&room.hub, &room.state, "doc-1");
    kv_put(&mut peer.doc, "b", "first unsynced edit");
    kv_put(&mut peer.doc, "c", "second unsynced edit");
    let child = peer.doc.get_last_local_change().unwrap().clone();
    let _full_frame = peer.frame("doc-1").unwrap();
    // Model a Bloom false positive that omits the parent from this frame.
    let partial = sync::Message {
        heads: vec![child.hash()],
        need: vec![],
        have: vec![],
        changes: vec![child.raw_bytes().to_vec()].into(),
        flags: None,
        version: sync::MessageVersion::V1,
    };
    let frame = KeyedDocFrameHeader::new(TEST_KV, "doc-1", 0).encode_frame(&partial.encode());
    peer.send(&room.hub, &room.state, &frame);
    assert!(peer.resyncs.is_empty(), "do not discard the peer's replica");
    assert_eq!(peer.value("b").as_deref(), Some("first unsynced edit"));
    assert_eq!(peer.value("c").as_deref(), Some("second unsynced edit"));
    assert_eq!(room.hub_value("doc-1", "b"), None);
    assert_eq!(room.hub_value("doc-1", "c"), None);
    assert!(room
        .hub
        .with_doc(&key("doc-1"), |_, doc| doc.get_missing_deps(&[]).is_empty())
        .unwrap());
    peer.sync(&room.hub, &room.state, "doc-1");
    assert!(peer.resyncs.is_empty());
    assert_eq!(
        room.hub_value("doc-1", "b").as_deref(),
        Some("first unsynced edit")
    );
    assert_eq!(
        room.hub_value("doc-1", "c").as_deref(),
        Some("second unsynced edit")
    );
}

#[test]
fn writes_are_refused_while_the_record_does_not_accept_them() {
    let room = Room::new();
    room.kind.set_record("doc-1", 0, false);
    let mut peer = Peer::new(alice(), ALICE);
    let opening = peer.opening_frame("doc-1");
    peer.send(&room.hub, &room.state, &opening);
    peer.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(peer.value("a").as_deref(), Some("1"), "reads still work");
    kv_put(&mut peer.doc, "b", "late");
    let frame = peer.frame("doc-1").unwrap();
    peer.send(&room.hub, &room.state, &frame);
    let Some(SessionControlMessage::DocResync { reason, .. }) = peer.resyncs.first() else {
        panic!("expected DocResync");
    };
    assert_eq!(reason, "test_kv is disconnected; it does not accept writes");
    assert_eq!(room.hub_value("doc-1", "b"), None);
}

#[test]
fn epoch_bump_restarts_replicas_and_sync_states() {
    let mut room = Room::new();
    let mut peer = Peer::new(alice(), ALICE);
    let opening = peer.opening_frame("doc-1");
    peer.send(&room.hub, &room.state, &opening);
    peer.sync(&room.hub, &room.state, "doc-1");
    let stale_heads = peer.doc.get_heads();

    // The runtime agent builds epoch 1 before the record announces it.
    assert_eq!(room.agent.replace("doc-1"), 1);
    room.sync_agent();
    assert_eq!(
        room.hub.with_doc(&key("doc-1"), |epoch, _| epoch),
        Some(1),
        "the runtime peer may run one epoch ahead of the record"
    );

    // The subscribed peer is moved to the new epoch.
    let frames = room.hub.peer_updates(&mut peer.hub_states, None);
    let (header, _) = KeyedDocFrameHeader::try_parse(&frames[0]).unwrap();
    assert_eq!(header.epoch, 1);
    for frame in frames {
        peer.receive(&frame);
    }
    peer.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(peer.epoch, 1);
    assert_eq!(peer.value("a").as_deref(), Some("1"));
    assert_ne!(peer.doc.get_heads(), stale_heads);

    // A peer still writing at epoch 0 is told to resync at epoch 1.
    let mut stale = Peer::new(bob(), BOB);
    kv_put(&mut stale.doc, "b", "stale");
    let frame = stale.frame("doc-1").unwrap();
    stale.send(&room.hub, &room.state, &frame);
    assert!(matches!(
        stale.resyncs.first(),
        Some(SessionControlMessage::DocResync { epoch: 1, .. })
    ));
    assert_eq!(room.hub_value("doc-1", "b"), None);

    // An older runtime frame is dropped with a warning naming both epochs.
    let body = AutoCommit::new()
        .sync()
        .generate_sync_message(&mut sync::State::new())
        .unwrap()
        .encode();
    let old = KeyedDocFrameHeader::new(TEST_KV, "doc-1", 0).encode_frame(&body);
    let logs = capture_warnings(|| {
        assert!(room
            .hub
            .receive_runtime_frame(&mut KeyedSyncStates::new(), &old)
            .is_empty());
    });
    assert!(
        logs.contains("WARN")
            && logs.contains("test_kv/doc-1 at epoch 0: the hub replica is at epoch 1"),
        "{logs}"
    );
    assert_eq!(room.hub.with_doc(&key("doc-1"), |epoch, _| epoch), Some(1));
}

/// Over the kind's limit, a known key is refused like any other write; an
/// unknown key stays a silent drop.
#[test]
fn oversized_peer_frames_are_refused_for_known_keys() {
    let room = Room::new();
    let mut peer = Peer::new(alice(), ALICE);
    let opening = peer.opening_frame("doc-1");
    peer.send(&room.hub, &room.state, &opening);
    peer.sync(&room.hub, &room.state, "doc-1");
    let heads_before = room.hub.with_doc(&key("doc-1"), |_, doc| doc.get_heads());

    let body = vec![0u8; 64 * 1024 + 1];
    let oversized = KeyedDocFrameHeader::new(TEST_KV, "doc-1", 0).encode_frame(&body);
    peer.send(&room.hub, &room.state, &oversized);
    let Some(SessionControlMessage::DocResync { epoch, reason, .. }) = peer.resyncs.first() else {
        panic!("expected DocResync, got {:?}", peer.resyncs);
    };
    assert_eq!(*epoch, 0);
    assert_eq!(
        reason,
        &format!(
            "frame body of {} bytes exceeds the limit of {}",
            body.len(),
            64 * 1024
        )
    );
    assert_eq!(
        room.hub.with_doc(&key("doc-1"), |_, doc| doc.get_heads()),
        heads_before
    );
    peer.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(peer.value("a").as_deref(), Some("1"), "the peer resyncs");

    let mut stranger = Peer::new(alice(), ALICE);
    let unknown = KeyedDocFrameHeader::new(TEST_KV, "nope", 0).encode_frame(&body);
    let reply = room.hub.receive_peer_frame(
        &mut stranger.hub_states,
        &unknown,
        &stranger.identity,
        &room.state,
    );
    assert!(reply.frames.is_empty() && reply.resync.is_none());
    assert_eq!(stranger.hub_states.keys().count(), 0);
}

/// Warnings emitted while `f` runs, formatted without colour.
fn capture_warnings(f: impl FnOnce()) -> String {
    #[derive(Clone, Default)]
    struct Buffer(Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buffer {
        type Writer = Buffer;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
    let buffer = Buffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buffer.clone())
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, f);
    let bytes = buffer.0.lock().unwrap().clone();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn blob_roots_cover_documents_and_kind_state() {
    let mut room = Room::new();
    room.agent.put("doc-1", "blob", "hash-in-doc");
    room.sync_agent();
    room.kind.set_blob_roots(["hash-in-tail".to_string()]);
    assert_eq!(
        room.hub.blob_roots().into_iter().collect::<Vec<_>>(),
        vec!["hash-in-doc".to_string(), "hash-in-tail".to_string()]
    );
}

#[test]
fn sync_states_retain_only_accepted_keys() {
    let mut states = KeyedSyncStates::new();
    states.for_epoch(&key("doc-1"), 0);
    states.for_epoch(&key("doc-2"), 3);
    states.retain(|key| key.id == "doc-2");
    assert!(!states.contains(&key("doc-1")));
    assert!(states.contains(&key("doc-2")));
}

/// R4 P3-3: a peer frame whose record read raced the replica's removal must
/// not recreate the replica from the stale record.
#[test]
fn a_record_read_racing_a_removal_does_not_recreate_the_replica() {
    let room = Room::new();
    let mut alice = Peer::new(alice(), ALICE);
    alice.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(alice.value("a").as_deref(), Some("1"));

    // The record is read as live; the document ends right after that read.
    let hub = Arc::downgrade(&room.hub);
    let kind = Arc::downgrade(&room.kind);
    room.kind.after_next_record(move |id| {
        kind.upgrade().unwrap().remove_record(id);
        hub.upgrade().unwrap().remove_doc(&key(id));
    });
    kv_put(&mut alice.doc, "b", "2");
    alice.sync(&room.hub, &room.state, "doc-1");
    assert!(room.hub.ids(TEST_KV).is_empty(), "replica recreated");
    assert!(alice.resyncs.is_empty());
}

#[test]
fn a_runtime_state_change_drops_replicas_whose_records_closed() {
    let mut room = Room::new();
    room.kind.set_record("doc-2", 0, true);
    room.agent.insert("doc-2", 0);
    room.sync_agent();
    let mut alice = Peer::new(alice(), ALICE);
    alice.sync(&room.hub, &room.state, "doc-1");
    assert_eq!(alice.value("a").as_deref(), Some("1"));

    room.hub.on_runtime_state_change(&room.state);
    assert_eq!(
        room.hub.ids(TEST_KV),
        vec!["doc-1".to_string(), "doc-2".to_string()],
        "live records keep their replicas"
    );

    room.kind.remove_record("doc-1");
    room.hub.on_runtime_state_change(&room.state);
    assert_eq!(room.hub.ids(TEST_KV), vec!["doc-2".to_string()]);
    assert!(room
        .hub
        .peer_updates(&mut alice.hub_states, None)
        .is_empty());

    // Later frames for the closed document are dropped without a resync.
    kv_put(&mut alice.doc, "b", "2");
    let frame = alice.frame("doc-1").expect("a change to send");
    let reply =
        room.hub
            .receive_peer_frame(&mut alice.hub_states, &frame, &alice.identity, &room.state);
    assert!(reply.frames.is_empty() && reply.resync.is_none());
    assert_eq!(room.hub.ids(TEST_KV), vec!["doc-2".to_string()]);
}
