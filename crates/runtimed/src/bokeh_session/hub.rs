//! The room's replica of each Bokeh session document and the frame `0x0b`
//! routing between the runtime agent and peers.
//!
//! The hub never writes. The runtime agent's frames are structural writes
//! and may run an epoch ahead; it starts each epoch as a fresh replica. A
//! peer subscribes to a session by sending a frame for it and then receives
//! updates, including the switch to a new epoch. Rejected peer writes reset
//! that peer's sync state and send `SessionControlMessage::BokehSessionResync`
//! so the peer drops its replica instead of retrying the rejected changes.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex as StdMutex;

use automerge::{sync, ActorId};
use notebook_protocol::protocol::SessionControlMessage;
use notebook_wire::BokehSessionFrameHeader;
use runtime_doc::{
    BokehSessionDoc, BokehSessionIngressError, BokehSessionSnapshot, BokehSessionState,
    BokehSessionStatus, BokehSessionWriteContext, RuntimeStateWriteScope,
};
use tokio::sync::broadcast;
use tracing::{debug, warn};

use super::store::BokehSyncStates;

const HUB_ACTOR: &str = "runtimed:bokeh-hub";

struct HubSession {
    epoch: u64,
    doc: BokehSessionDoc,
}

pub struct BokehSessionHub {
    sessions: StdMutex<HashMap<String, HubSession>>,
    changed_tx: broadcast::Sender<String>,
}

impl Default for BokehSessionHub {
    fn default() -> Self {
        let (changed_tx, _) = broadcast::channel(256);
        Self {
            sessions: StdMutex::new(HashMap::new()),
            changed_tx,
        }
    }
}

/// What to send back after a peer frame.
#[derive(Debug, Default)]
pub(crate) struct PeerFrameResult {
    pub(crate) frames: Vec<Vec<u8>>,
    pub(crate) resync: Option<SessionControlMessage>,
}

impl BokehSessionHub {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HubSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Session ids whose document changed.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<String> {
        self.changed_tx.subscribe()
    }

    pub(crate) fn epoch(&self, session_id: &str) -> Option<u64> {
        self.lock().get(session_id).map(|session| session.epoch)
    }

    pub(crate) fn session_ids(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    pub(crate) fn snapshot(&self, session_id: &str) -> Option<BokehSessionSnapshot> {
        self.lock()
            .get(session_id)
            .and_then(|session| session.doc.read_snapshot().ok())
    }

    /// Every blob any live session document references, for GC roots.
    pub(crate) fn referenced_blobs(&self) -> BTreeSet<String> {
        self.lock()
            .values()
            .flat_map(|session| session.doc.referenced_blobs())
            .collect()
    }

    /// The session's replica, started fresh when `epoch` is newer than the
    /// one held.
    fn ensure_epoch<'a>(
        sessions: &'a mut HashMap<String, HubSession>,
        session_id: &str,
        epoch: u64,
    ) -> &'a mut HubSession {
        let session = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| HubSession {
                epoch,
                doc: BokehSessionDoc::new_empty(HUB_ACTOR),
            });
        if session.epoch < epoch {
            *session = HubSession {
                epoch,
                doc: BokehSessionDoc::new_empty(HUB_ACTOR),
            };
        }
        session
    }

    fn notify(&self, session_id: &str) {
        let _ = self.changed_tx.send(session_id.to_string());
    }

    /// A frame from the runtime agent connection.
    pub(crate) fn receive_runtime_frame(
        &self,
        states: &mut BokehSyncStates,
        payload: &[u8],
    ) -> Vec<Vec<u8>> {
        let Some((header, message)) = decode(payload) else {
            return Vec::new();
        };
        let mut sessions = self.lock();
        let current = sessions.get(&header.session_id).map(|s| s.epoch);
        let context = BokehSessionWriteContext {
            scope: RuntimeStateWriteScope::RuntimePeer,
            status: BokehSessionStatus::Connected,
            current_epoch: current.unwrap_or(header.epoch),
        };
        if let Err(rejection) = context.check_frame_epoch(header.epoch) {
            debug!("[bokeh-session] Dropping runtime frame: {rejection}");
            return Vec::new();
        }
        let session = Self::ensure_epoch(&mut sessions, &header.session_id, header.epoch);
        let state = reset_if_epoch_moved(states, &header.session_id, session.epoch);
        let changed = match session
            .doc
            .receive_peer_sync_message(state, message, &context)
        {
            Ok(changeset) => !changeset.is_empty() || current != Some(header.epoch),
            Err(error) => {
                warn!(
                    "[bokeh-session] Runtime frame for {} failed: {error}",
                    header.session_id
                );
                *state = sync::State::new();
                false
            }
        };
        let frames = generate(&header.session_id, session, states)
            .into_iter()
            .collect();
        drop(sessions);
        if changed {
            self.notify(&header.session_id);
        }
        frames
    }

    /// Updates for one session on the runtime agent connection.
    pub(crate) fn runtime_updates(
        &self,
        states: &mut BokehSyncStates,
        session_id: &str,
    ) -> Vec<Vec<u8>> {
        let mut sessions = self.lock();
        let Some(session) = sessions.get_mut(session_id) else {
            return Vec::new();
        };
        generate(session_id, session, states).into_iter().collect()
    }

    /// A frame from a notebook peer. `record` is the session's
    /// RuntimeStateDoc entry; `actor_ok` checks a change actor against the
    /// connection principal.
    pub(crate) fn receive_peer_frame(
        &self,
        states: &mut BokehSyncStates,
        payload: &[u8],
        scope: RuntimeStateWriteScope,
        record: Option<&BokehSessionState>,
        actor_ok: impl Fn(&ActorId) -> bool,
    ) -> PeerFrameResult {
        let mut result = PeerFrameResult::default();
        let Some((header, mut message)) = decode(payload) else {
            return result;
        };
        let mut sessions = self.lock();
        let hub_epoch = sessions.get(&header.session_id).map(|s| s.epoch);
        let current = match (hub_epoch, record.map(|r| r.epoch)) {
            (None, None) => {
                debug!(
                    "[bokeh-session] Dropping frame for unknown session {}",
                    header.session_id
                );
                return result;
            }
            (hub, recorded) => hub.max(recorded).unwrap_or_default(),
        };
        let session = Self::ensure_epoch(&mut sessions, &header.session_id, current);
        let context = BokehSessionWriteContext {
            scope,
            status: record.map_or(BokehSessionStatus::Closed, |r| r.status),
            current_epoch: current,
        };

        let mut rejection = context.check_frame_epoch(header.epoch).err();
        if rejection.is_none() {
            if !message.changes.is_empty() {
                if let Err(denied) = context.write_permission() {
                    message.changes = sync::ChunkList::empty();
                    rejection = Some(denied);
                }
            }
            let state = reset_if_epoch_moved(states, &header.session_id, current);
            match session
                .doc
                .receive_peer_sync_message_checked(state, message, &context, actor_ok)
            {
                Ok(changeset) => {
                    if !changeset.is_empty() {
                        self.notify(&header.session_id);
                    }
                }
                Err(BokehSessionIngressError::Rejected(denied)) => rejection = Some(denied),
                Err(BokehSessionIngressError::Automerge(error)) => {
                    warn!(
                        "[bokeh-session] Peer frame for {} failed: {error}",
                        header.session_id
                    );
                    rejection.get_or_insert(
                        runtime_doc::BokehSessionWriteRejection::ForbiddenOperation(
                            "undecodable sync",
                        ),
                    );
                }
            }
        }
        if let Some(rejection) = rejection {
            debug!(
                "[bokeh-session] Peer write to {} refused: {rejection}",
                header.session_id
            );
            states.insert(header.session_id.clone(), (current, sync::State::new()));
            result.resync = Some(SessionControlMessage::BokehSessionResync {
                session_id: header.session_id.clone(),
                epoch: current,
                reason: rejection.to_string(),
            });
        }
        result
            .frames
            .extend(generate(&header.session_id, session, states));
        result
    }

    /// Updates for a subscribed peer after `session_id` changed, moving it to
    /// a new epoch when the hub has one.
    pub(crate) fn peer_updates(
        &self,
        states: &mut BokehSyncStates,
        session_id: &str,
    ) -> Vec<Vec<u8>> {
        if !states.contains_key(session_id) {
            return Vec::new();
        }
        let mut sessions = self.lock();
        let Some(session) = sessions.get_mut(session_id) else {
            return Vec::new();
        };
        generate(session_id, session, states).into_iter().collect()
    }
}

fn decode(payload: &[u8]) -> Option<(BokehSessionFrameHeader, sync::Message)> {
    let (header, body) = match BokehSessionFrameHeader::try_parse(payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            warn!("[bokeh-session] Dropping malformed frame: {error}");
            return None;
        }
    };
    match sync::Message::decode(body) {
        Ok(message) => Some((header, message)),
        Err(error) => {
            warn!(
                "[bokeh-session] Dropping undecodable sync for {}: {error}",
                header.session_id
            );
            None
        }
    }
}

fn reset_if_epoch_moved<'a>(
    states: &'a mut BokehSyncStates,
    session_id: &str,
    epoch: u64,
) -> &'a mut sync::State {
    let entry = states
        .entry(session_id.to_string())
        .or_insert_with(|| (epoch, sync::State::new()));
    if entry.0 != epoch {
        *entry = (epoch, sync::State::new());
    }
    &mut entry.1
}

fn generate(
    session_id: &str,
    session: &mut HubSession,
    states: &mut BokehSyncStates,
) -> Option<Vec<u8>> {
    let state = reset_if_epoch_moved(states, session_id, session.epoch);
    let message = session.doc.generate_sync_message(state)?;
    Some(BokehSessionFrameHeader::new(session_id, session.epoch).encode_frame(&message.encode()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bokeh_session::store::tests::{snapshot, store_with_session, KERNEL};
    use crate::bokeh_session::store::BokehSessionStore;

    const ALICE: &str = "user:dev:alice/browser";

    fn record(status: BokehSessionStatus, epoch: u64) -> BokehSessionState {
        BokehSessionState {
            output_id: "output-1".into(),
            cell_id: "cell-1".into(),
            execution_id: "exec-1".into(),
            kernel_id: "kernel-1".into(),
            status,
            producer_name: "panel".into(),
            producer_version: "1.9.4".into(),
            bokeh_version: "3.9.2".into(),
            root_ids: vec!["p1".into()],
            epoch,
            doc_heads: vec!["a".repeat(64)],
            previous_heads: Vec::new(),
        }
    }

    fn alice_only(actor: &ActorId) -> bool {
        actor.to_bytes().starts_with(b"user:dev:alice/")
    }

    /// Pump frames between the agent store and the hub until quiet.
    fn pump_agent(
        store: &BokehSessionStore,
        agent: &mut BokehSyncStates,
        hub: &BokehSessionHub,
        conn: &mut BokehSyncStates,
    ) {
        for _ in 0..16 {
            let mut progressed = false;
            for frame in store.generate_frames(agent) {
                progressed = true;
                for reply in hub.receive_runtime_frame(conn, &frame) {
                    if let Some(back) = store.receive_frame(&reply, agent).unwrap() {
                        hub.receive_runtime_frame(conn, &back);
                    }
                }
            }
            for session_id in hub.session_ids() {
                for frame in hub.runtime_updates(conn, &session_id) {
                    progressed = true;
                    if let Some(back) = store.receive_frame(&frame, agent).unwrap() {
                        hub.receive_runtime_frame(conn, &back);
                    }
                }
            }
            if !progressed {
                return;
            }
        }
    }

    struct Peer {
        doc: BokehSessionDoc,
        state: sync::State,
        hub_states: BokehSyncStates,
        resyncs: Vec<SessionControlMessage>,
    }

    impl Peer {
        fn new() -> Self {
            Self {
                doc: BokehSessionDoc::new_empty(ALICE),
                state: sync::State::new(),
                hub_states: BokehSyncStates::new(),
                resyncs: Vec::new(),
            }
        }

        fn apply(&mut self, frames: Vec<Vec<u8>>) {
            for frame in frames {
                let (_, body) = BokehSessionFrameHeader::try_parse(&frame).unwrap();
                self.doc
                    .receive_sync_message(&mut self.state, sync::Message::decode(body).unwrap())
                    .unwrap();
            }
        }

        fn sync(
            &mut self,
            hub: &BokehSessionHub,
            scope: RuntimeStateWriteScope,
            record: &BokehSessionState,
            epoch: u64,
        ) {
            for _ in 0..16 {
                let Some(message) = self.doc.generate_sync_message(&mut self.state) else {
                    return;
                };
                let frame = BokehSessionFrameHeader::new("session-1", epoch)
                    .encode_frame(&message.encode());
                let result = hub.receive_peer_frame(
                    &mut self.hub_states,
                    &frame,
                    scope,
                    Some(record),
                    alice_only,
                );
                self.apply(result.frames);
                if let Some(resync) = result.resync {
                    self.resyncs.push(resync);
                    return;
                }
            }
        }
    }

    #[test]
    fn peer_edits_route_through_the_hub_to_the_agent_and_kernel_forwarder() {
        let store = store_with_session();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        store.set_forwarder(Some(tx));
        let hub = BokehSessionHub::default();
        let (mut agent, mut conn) = (BokehSyncStates::new(), BokehSyncStates::new());
        pump_agent(&store, &mut agent, &hub, &mut conn);
        assert_eq!(hub.epoch("session-1"), Some(0));

        let connected = record(BokehSessionStatus::Connected, 0);
        let mut peer = Peer::new();
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &connected, 0);
        assert_eq!(peer.doc.get_prop("p2", "value").as_deref(), Some("0.5"));

        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &connected, 0);
        assert!(peer.resyncs.is_empty());
        pump_agent(&store, &mut agent, &hub, &mut conn);
        let forward = rx.try_recv().expect("forwarded to the kernel");
        assert_eq!(
            forward.changes,
            vec![("p2".into(), "value".into(), "0.8".into())]
        );

        // A subscribed peer receives later kernel writes.
        store.with_doc("session-1", |doc| {
            doc.set_prop("p2", "value", "0.1").unwrap();
            doc.commit();
        });
        pump_agent(&store, &mut agent, &hub, &mut conn);
        let updates = hub.peer_updates(&mut peer.hub_states, "session-1");
        peer.apply(updates);
        assert_eq!(peer.doc.get_prop("p2", "value").as_deref(), Some("0.1"));
    }

    #[test]
    fn rejected_writes_strip_and_signal_resync() {
        let store = store_with_session();
        let hub = BokehSessionHub::default();
        let (mut agent, mut conn) = (BokehSyncStates::new(), BokehSyncStates::new());
        pump_agent(&store, &mut agent, &hub, &mut conn);

        // Kernel lost: the session is read-only.
        let disconnected = record(BokehSessionStatus::Disconnected, 0);
        let mut peer = Peer::new();
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &disconnected, 0);
        assert!(peer.resyncs.is_empty(), "read-only sessions still sync");
        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &disconnected, 0);
        let Some(SessionControlMessage::BokehSessionResync { epoch, reason, .. }) =
            peer.resyncs.first()
        else {
            panic!("expected a resync signal");
        };
        assert_eq!(*epoch, 0);
        assert!(reason.contains("Disconnected"), "{reason}");
        assert_eq!(
            hub.snapshot("session-1").unwrap().models["p2"].props["value"],
            "0.5"
        );

        // Content rule: reference properties are refused even when connected.
        let connected = record(BokehSessionStatus::Connected, 0);
        let mut peer = Peer::new();
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &connected, 0);
        peer.doc.set_prop("p1", "children", "[]").unwrap();
        peer.doc.commit();
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &connected, 0);
        assert!(matches!(
            peer.resyncs.first(),
            Some(SessionControlMessage::BokehSessionResync { reason, .. }) if reason.contains("references")
        ));

        // A stale epoch is refused before the message is read.
        let mut stale = Peer::new();
        stale.sync(
            &hub,
            RuntimeStateWriteScope::Editor,
            &record(BokehSessionStatus::Connected, 1),
            0,
        );
        assert!(matches!(
            stale.resyncs.first(),
            Some(SessionControlMessage::BokehSessionResync { epoch: 1, .. })
        ));
    }

    #[test]
    fn writes_by_another_principal_are_refused() {
        let store = store_with_session();
        let hub = BokehSessionHub::default();
        let (mut agent, mut conn) = (BokehSyncStates::new(), BokehSyncStates::new());
        pump_agent(&store, &mut agent, &hub, &mut conn);
        let connected = record(BokehSessionStatus::Connected, 0);
        let mut peer = Peer::new();
        peer.doc = BokehSessionDoc::new_empty("user:dev:mallory/browser");
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &connected, 0);
        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        peer.sync(&hub, RuntimeStateWriteScope::Editor, &connected, 0);
        assert!(matches!(
            peer.resyncs.first(),
            Some(SessionControlMessage::BokehSessionResync { reason, .. }) if reason.contains("mallory")
        ));
        assert_eq!(
            hub.snapshot("session-1").unwrap().models["p2"].props["value"],
            "0.5"
        );
    }

    #[test]
    fn replacement_moves_hub_and_subscribed_peers_to_the_new_epoch() {
        let store = BokehSessionStore::with_policy(runtime_doc::BokehReplacementPolicy {
            min_change_bytes: 0,
            saved_size_factor: 0,
            min_interval_ms: 0,
        });
        store.insert(
            "session-1",
            BokehSessionDoc::build(&snapshot(), KERNEL).unwrap(),
            "kernel-1",
            KERNEL,
        );
        let hub = BokehSessionHub::default();
        let (mut agent, mut conn) = (BokehSyncStates::new(), BokehSyncStates::new());
        pump_agent(&store, &mut agent, &hub, &mut conn);
        let mut peer = Peer::new();
        peer.sync(
            &hub,
            RuntimeStateWriteScope::Viewer,
            &record(BokehSessionStatus::Connected, 0),
            0,
        );
        let old_blobs = hub.referenced_blobs();

        store.with_doc("session-1", |doc| {
            doc.set_prop("p2", "value", "0.3").unwrap();
            doc.commit();
        });
        let records = store.replace_due().unwrap();
        assert_eq!(records[0].epoch, 1);
        pump_agent(&store, &mut agent, &hub, &mut conn);
        assert_eq!(hub.epoch("session-1"), Some(1));
        assert_eq!(hub.referenced_blobs(), old_blobs);

        // The subscribed peer is pushed the new epoch and starts a fresh replica.
        let updates = hub.peer_updates(&mut peer.hub_states, "session-1");
        assert!(!updates.is_empty());
        for frame in &updates {
            let (header, _) = BokehSessionFrameHeader::try_parse(frame).unwrap();
            assert_eq!(header.epoch, 1);
        }
        peer.doc = BokehSessionDoc::new_empty(ALICE);
        peer.state = sync::State::new();
        peer.apply(updates);
        peer.sync(
            &hub,
            RuntimeStateWriteScope::Viewer,
            &record(BokehSessionStatus::Connected, 1),
            1,
        );
        assert!(peer.resyncs.is_empty());
        assert_eq!(peer.doc.epoch(), Some(1));
        assert_eq!(peer.doc.get_prop("p2", "value").as_deref(), Some("0.3"));
    }

    #[test]
    fn gc_roots_cover_prop_and_column_blobs_of_live_sessions() {
        let mut snap = snapshot();
        snap.columns.insert(
            "p3".into(),
            std::collections::BTreeMap::from([(
                "x".to_string(),
                runtime_doc::BokehColumnRef {
                    blob: "c".repeat(64),
                    size: 10,
                    version: 2,
                },
            )]),
        );
        snap.models.get_mut("p2").unwrap().props.insert(
            "title".into(),
            runtime_doc::BokehBlobRef {
                blob: "d".repeat(64),
                size: 2000,
                media_type: crate::bokeh_session::BOKEH_PROP_MEDIA_TYPE.into(),
            }
            .encode(),
        );
        let store = BokehSessionStore::default();
        store.insert(
            "session-1",
            BokehSessionDoc::build(&snap, KERNEL).unwrap(),
            "kernel-1",
            KERNEL,
        );
        let hub = BokehSessionHub::default();
        let (mut agent, mut conn) = (BokehSyncStates::new(), BokehSyncStates::new());
        pump_agent(&store, &mut agent, &hub, &mut conn);
        assert_eq!(
            hub.referenced_blobs(),
            BTreeSet::from(["c".repeat(64), "d".repeat(64)])
        );
    }
}
