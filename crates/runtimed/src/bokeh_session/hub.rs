//! The room side of Bokeh session documents: [`BokehRoomKind`] plugs the
//! `bokeh_session` kind into the room's generic `KeyedDocHub`.
//!
//! The hub owns the replicas and the frame `0x0b` routing; this kind
//! supplies the record that admits a session (its RuntimeStateDoc record),
//! the content filter for peer writes, GC roots, and the agent-loss freeze.
//!
//! It also retains the data events the runtime agent broadcasts, per source,
//! until the hub replica's column versions pass them, so a session the room
//! freezes or saves includes streams and patches since the last fold.
//!
//! Lifetime: a replica and its tail are dropped once the session's record is
//! `closed` (rerun, retired or deleted output). Closed records are immutable
//! and [`BokehRoomKind`] reports no record for them; the hub re-reads a
//! record that raced a removal, so a late peer frame cannot recreate the
//! replica. Disconnected and error sessions keep their
//! replica, which mounted peers still read. Hub epochs never rewind for an
//! id: a restarted runtime agent never resumes an old session (sessions are
//! frozen on agent loss and reruns mint new ids), so its frames for an older
//! epoch of an existing id are dropped as stale.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Mutex as StdMutex, MutexGuard};

use automerge::AutoCommit;
use futures::future::BoxFuture;
use notebook_protocol::protocol::{BokehSessionEvents, NotebookBroadcast};
use notebook_wire::KeyedDocKey;
use runtime_doc::{
    BokehColumnRef, BokehSessionDocRef, BokehSessionStatus, KeyedDocRecord, KeyedDocRejection,
    KeyedWriteContext, RuntimeStateDoc, RuntimeStateHandle,
};
use tracing::warn;

use super::ingest::{event_kind, event_source, referenced_buffer_ids};
use super::materialize::{freeze_session_output, SnapshotWithTail};
use super::BOKEH_SESSION_KIND;
use crate::keyed_doc::kind::RoomKindCtx;
use crate::keyed_doc::{KeyedDocHub, KeyedDocKind};
use crate::output_blob_publisher::OutputBlobPublisher;

/// Floor of a source's retained tail bytes; see [`tail_byte_cap`].
const MIN_TAIL_CAP_BYTES: u64 = 1024 * 1024;

pub(crate) fn session_key(session_id: &str) -> KeyedDocKey {
    KeyedDocKey::new(BOKEH_SESSION_KIND, session_id)
}

/// The launcher folds once stream and patch bytes since the last fold reach
/// twice that fold's size, so a tail past four times the folded column
/// bytes (or 1 MiB for small sources) means the replica missed a fold.
pub(crate) fn tail_byte_cap(folded_bytes: u64) -> u64 {
    MIN_TAIL_CAP_BYTES.max(folded_bytes.saturating_mul(4))
}

/// One source's single-event broadcasts since its last known fold.
#[derive(Default)]
struct SourceTail {
    /// Each event with its [`event_bytes`], measured once on arrival.
    events: Vec<(u64, BokehSessionEvents)>,
    bytes: u64,
    /// Highest version among events dropped on overflow. Until the
    /// replica's columns reach it, the tail cannot be replayed.
    lost_through: Option<u64>,
}

impl SourceTail {
    /// Drop events at or below the replica's column version.
    fn prune(&mut self, folded: u64) {
        let bytes = &mut self.bytes;
        self.events.retain(|(size, event)| {
            let keep = new_version(event) > folded;
            if !keep {
                *bytes -= size;
            }
            keep
        });
        if self.lost_through.is_some_and(|lost| lost <= folded) {
            self.lost_through = None;
        }
    }
}

/// A source's column version and folded column bytes in the hub replica.
type FoldedColumns = BTreeMap<String, (u64, u64)>;

#[derive(Default)]
struct KindState {
    /// Per session, from the last runtime change of its hub replica. Kept
    /// here because broadcasts arrive outside the hub lock.
    folded: HashMap<String, FoldedColumns>,
    /// Per session and source. An event can arrive before the first frame,
    /// and tails survive epoch changes, since column versions do.
    tails: HashMap<String, HashMap<String, SourceTail>>,
}

/// Room-scoped state of the `bokeh_session` kind. Lock order: the hub's
/// document lock, then this kind's lock; never the reverse.
#[derive(Default)]
pub(crate) struct BokehRoomKind {
    state: StdMutex<KindState>,
}

impl BokehRoomKind {
    fn lock(&self) -> MutexGuard<'_, KindState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The hub replica's state plus the retained events its columns lack,
    /// for freezing or saving.
    pub(crate) fn snapshot_with_tail(
        &self,
        hub: &KeyedDocHub,
        session_id: &str,
    ) -> Option<SnapshotWithTail> {
        hub.with_doc(&session_key(session_id), |_, doc| {
            let snapshot = BokehSessionDocRef::from_doc(doc).read_snapshot().ok()?;
            Some(self.with_tail(snapshot, session_id))
        })
        .flatten()
    }

    fn with_tail(
        &self,
        snapshot: runtime_doc::BokehSessionSnapshot,
        session_id: &str,
    ) -> SnapshotWithTail {
        let mut state = SnapshotWithTail {
            snapshot,
            ..Default::default()
        };
        let inner = self.lock();
        let Some(sources) = inner.tails.get(session_id) else {
            return state;
        };
        let mut source_ids: Vec<&String> = sources.keys().collect();
        source_ids.sort();
        for source_id in source_ids {
            let source = &sources[source_id];
            let (folded, _) = folded_columns(state.snapshot.columns.get(source_id));
            if source.lost_through.is_some_and(|lost| lost > folded) {
                state.incomplete_sources.insert(source_id.clone());
            } else {
                state
                    .tail
                    .extend(source.events.iter().map(|(_, event)| event.clone()));
            }
        }
        state
    }

    /// Forget the tails of sessions whose record left `connected` (frozen,
    /// closed or retired): their payload is final. Sessions without a record
    /// keep theirs, since a broadcast can arrive before the record syncs.
    pub(crate) fn drop_unconnected_tails(&self, state: &RuntimeStateHandle) {
        if self.lock().tails.is_empty() {
            return;
        }
        if let Err(error) = state.read(|doc| self.drop_unconnected_tails_in(doc)) {
            warn!("[bokeh-session] Could not read session records: {error}");
        }
    }

    fn drop_unconnected_tails_in(&self, doc: &RuntimeStateDoc) {
        let mut inner = self.lock();
        inner.tails.retain(|session_id, _| {
            doc.get_bokeh_session(session_id)
                .is_none_or(|record| record.status == BokehSessionStatus::Connected)
        });
    }

    /// Retain the data events of a runtime agent broadcast, one event per
    /// entry with only its own buffers. Messages are not state and are
    /// skipped. Events the replica's columns already cover are dropped.
    pub(crate) fn retain_events(&self, events: &BokehSessionEvents) {
        let mut retained: Vec<(&str, BokehSessionEvents)> = Vec::new();
        for event in &events.data_events {
            let Some(source_id) = event_source(event) else {
                continue;
            };
            if !matches!(
                event_kind(event),
                Some("ColumnsStreamed" | "ColumnsPatched" | "ColumnDataChanged")
            ) {
                continue;
            }
            let mut ids = BTreeSet::new();
            referenced_buffer_ids(event, &mut ids);
            retained.push((
                source_id,
                BokehSessionEvents {
                    session_id: events.session_id.clone(),
                    epoch: events.epoch,
                    transaction_id: events.transaction_id.clone(),
                    data_events: vec![event.clone()],
                    messages: Vec::new(),
                    buffers: events
                        .buffers
                        .iter()
                        .filter(|buffer| ids.contains(&buffer.id))
                        .cloned()
                        .collect(),
                },
            ));
        }
        if retained.is_empty() {
            return;
        }
        let mut inner = self.lock();
        let KindState { folded, tails } = &mut *inner;
        let versions = folded.get(&events.session_id);
        let sources = tails.entry(events.session_id.clone()).or_default();
        for (source_id, event) in retained {
            let (version, folded_bytes) = versions
                .and_then(|versions| versions.get(source_id))
                .copied()
                .unwrap_or_default();
            let tail = sources.entry(source_id.to_string()).or_default();
            let size = event_bytes(&event);
            tail.bytes += size;
            tail.events.push((size, event));
            tail.prune(version);
            let cap = tail_byte_cap(folded_bytes);
            if tail.bytes > cap {
                warn!(
                    "[bokeh-session] Tail of {source_id} in {} passed {cap} bytes without a fold; \
                     saves keep the stored output until the next fold",
                    events.session_id
                );
                let lost = tail
                    .events
                    .iter()
                    .map(|(_, event)| new_version(event))
                    .max();
                tail.lost_through = tail.lost_through.max(lost);
                tail.events.clear();
                tail.bytes = 0;
            }
        }
    }

    /// On runtime agent loss, freeze every connected session from the hub
    /// replica into its output's `snapshot` and mark it disconnected.
    async fn freeze_connected_sessions(&self, ctx: RoomKindCtx<'_>) {
        let connected: Vec<String> = ctx
            .state
            .read(|doc| {
                doc.get_bokeh_sessions()
                    .into_iter()
                    .filter(|(_, session)| session.status == BokehSessionStatus::Connected)
                    .map(|(id, _)| id)
                    .collect()
            })
            .unwrap_or_default();
        if connected.is_empty() {
            return;
        }
        for session_id in &connected {
            let Some(session) = self.snapshot_with_tail(ctx.hub, session_id) else {
                continue;
            };
            if let Err(error) = freeze_session_output(
                session_id,
                &session,
                ctx.state,
                None,
                ctx.blob_store,
                &OutputBlobPublisher::none(),
            )
            .await
            {
                warn!("[bokeh-session] Failed to freeze session {session_id}: {error}");
            }
        }
        if let Err(error) = ctx
            .state
            .with_doc(|doc| doc.disconnect_bokeh_sessions(&connected).map(|_| ()))
        {
            warn!("[bokeh-session] Failed to disconnect sessions: {error}");
        }
        self.drop_unconnected_tails(ctx.state);
    }
}

impl KeyedDocKind for BokehRoomKind {
    fn kind(&self) -> &'static str {
        BOKEH_SESSION_KIND
    }

    fn record(&self, state: &RuntimeStateDoc, id: &str) -> Option<KeyedDocRecord> {
        let session = state.get_bokeh_session(id)?;
        let status_label = match session.status {
            BokehSessionStatus::Connected => "connected",
            BokehSessionStatus::Disconnected => "disconnected",
            BokehSessionStatus::Error => "error",
            // Its replica is dropped; no frame may recreate it.
            BokehSessionStatus::Closed => return None,
        };
        Some(KeyedDocRecord {
            epoch: session.epoch,
            accepts_peer_writes: session.status == BokehSessionStatus::Connected,
            status_label,
        })
    }

    fn validate_peer_changes(
        &self,
        before: &AutoCommit,
        changes: &[automerge::Change],
        ctx: &KeyedWriteContext,
    ) -> Result<(), KeyedDocRejection> {
        BokehSessionDocRef::from_doc(before)
            .validate_peer_changes(changes, ctx.current_epoch)
            .map_err(|rejection| KeyedDocRejection::Content(rejection.to_string()))
    }

    fn referenced_blobs(&self, doc: &AutoCommit) -> BTreeSet<String> {
        BokehSessionDocRef::from_doc(doc).referenced_blobs()
    }

    /// Buffers and replacement columns of retained tails, which no replica
    /// references until a fold.
    fn room_blob_roots(&self) -> BTreeSet<String> {
        let inner = self.lock();
        let mut roots = BTreeSet::new();
        for (_, event) in inner
            .tails
            .values()
            .flat_map(HashMap::values)
            .flat_map(|tail| &tail.events)
        {
            roots.extend(event.buffers.iter().map(|buffer| buffer.blob.clone()));
            for data_event in &event.data_events {
                if event_kind(data_event) != Some("ColumnDataChanged") {
                    continue;
                }
                let columns = data_event
                    .get("columns")
                    .and_then(serde_json::Value::as_object);
                roots.extend(
                    columns
                        .into_iter()
                        .flat_map(|columns| columns.values())
                        .filter_map(|column| column.get("blob")?.as_str())
                        .map(str::to_string),
                );
            }
        }
        roots
    }

    fn observe_runtime_broadcast(&self, broadcast: &NotebookBroadcast) {
        if let NotebookBroadcast::BokehSessionEvents { events } = broadcast {
            self.retain_events(events);
        }
    }

    fn on_runtime_change(&self, id: &str, _epoch: u64, doc: &AutoCommit) {
        let columns = BokehSessionDocRef::from_doc(doc).read_columns();
        let folded: FoldedColumns = columns
            .iter()
            .map(|(source_id, columns)| (source_id.clone(), folded_columns(Some(columns))))
            .collect();
        let mut inner = self.lock();
        if let Some(sources) = inner.tails.get_mut(id) {
            for (source_id, tail) in sources.iter_mut() {
                let (version, _) = folded.get(source_id).copied().unwrap_or_default();
                tail.prune(version);
            }
        }
        inner.folded.insert(id.to_string(), folded);
    }

    fn on_runtime_state_change(&self, state: &RuntimeStateDoc, ids: &[String]) -> Vec<String> {
        self.drop_unconnected_tails_in(state);
        let closed: Vec<String> = ids
            .iter()
            .filter(|id| {
                state
                    .get_bokeh_session(id)
                    .is_some_and(|record| record.status == BokehSessionStatus::Closed)
            })
            .cloned()
            .collect();
        if !closed.is_empty() {
            let mut inner = self.lock();
            for id in &closed {
                inner.folded.remove(id);
                inner.tails.remove(id);
            }
        }
        closed
    }

    fn on_runtime_agent_lost<'a>(&'a self, ctx: RoomKindCtx<'a>) -> BoxFuture<'a, ()> {
        Box::pin(self.freeze_connected_sessions(ctx))
    }
}

fn folded_columns(columns: Option<&BTreeMap<String, BokehColumnRef>>) -> (u64, u64) {
    columns.map_or((0, 0), |columns| {
        (
            columns.values().map(|c| c.version).max().unwrap_or(0),
            columns.values().map(|c| c.size).sum(),
        )
    })
}

/// Payload and buffer bytes, as the launcher's fold policy counts them.
fn event_bytes(events: &BokehSessionEvents) -> u64 {
    let payload: usize = events
        .data_events
        .iter()
        .map(|event| serde_json::to_vec(event).map_or(0, |bytes| bytes.len()))
        .sum();
    payload as u64 + events.buffers.iter().map(|buffer| buffer.size).sum::<u64>()
}

fn new_version(events: &BokehSessionEvents) -> u64 {
    events
        .data_events
        .iter()
        .filter_map(|event| event.get("new_version").and_then(serde_json::Value::as_u64))
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod tests {
    use std::sync::Arc;

    use automerge::sync;
    use notebook_protocol::protocol::SessionControlMessage;
    use notebook_wire::KeyedDocFrameHeader;
    use nteract_identity::ConnectionScope;
    use runtime_doc::{BokehSessionDoc, BokehSessionState, BOKEH_SESSION_MIME};
    use serde_json::{json, Value};

    use super::*;
    use crate::blob_store::BlobStore;
    use crate::bokeh_session::ingest::tests::wire_delta;
    use crate::bokeh_session::materialize::materialize_doc_json;
    use crate::bokeh_session::output_hook::{BokehRoomOutputHook, BokehRoomOutputs};
    use crate::bokeh_session::store::tests::{
        flush, fold_event, materialized_x, snapshot, store_with_session, stream_event, KERNEL,
    };
    use crate::bokeh_session::store::BokehSessionStore;
    use crate::keyed_doc::KeyedSyncStates;
    use crate::notebook_sync_server::RoomConnectionIdentity;
    use crate::output_hooks::OutputHookRegistry;
    use crate::output_store::ContentRef;

    const ALICE: &str = "user:dev:alice/browser:a";

    fn identity(principal: &str, operator: &str, scope: ConnectionScope) -> RoomConnectionIdentity {
        RoomConnectionIdentity::hosted_bridged(principal, Some(operator.into()), scope).unwrap()
    }

    fn alice(scope: ConnectionScope) -> RoomConnectionIdentity {
        identity("user:dev:alice", "browser:a", scope)
    }

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
            previous_heads: if epoch == 0 {
                Vec::new()
            } else {
                vec!["b".repeat(64)]
            },
        }
    }

    /// The room-side pieces `extensions::room_extensions` wires, with the
    /// concrete kind kept for assertions.
    pub(crate) struct Room {
        _dir: tempfile::TempDir,
        pub(crate) kind: Arc<BokehRoomKind>,
        pub(crate) hub: Arc<KeyedDocHub>,
        pub(crate) state: RuntimeStateHandle,
        pub(crate) blob_store: Arc<BlobStore>,
        hooks: OutputHookRegistry,
        agent_states: KeyedSyncStates,
        hub_states: KeyedSyncStates,
    }

    impl Room {
        pub(crate) fn new() -> Self {
            let dir = tempfile::TempDir::new().unwrap();
            let blob_store = Arc::new(BlobStore::new(dir.path().join("blobs")));
            let state = RuntimeStateHandle::new(
                RuntimeStateDoc::new(),
                tokio::sync::broadcast::channel(8).0,
            );
            let kind = Arc::new(BokehRoomKind::default());
            let kinds: Vec<Arc<dyn KeyedDocKind>> = vec![kind.clone()];
            let hub = Arc::new(KeyedDocHub::new(kinds));
            let hooks = OutputHookRegistry::new(vec![Arc::new(BokehRoomOutputHook::new(Some(
                BokehRoomOutputs {
                    kind: kind.clone(),
                    hub: hub.clone(),
                    state: state.clone(),
                    blob_store: blob_store.clone(),
                },
            )))]);
            Self {
                _dir: dir,
                kind,
                hub,
                state,
                blob_store,
                hooks,
                agent_states: KeyedSyncStates::new(),
                hub_states: KeyedSyncStates::new(),
            }
        }

        /// Exchange frames between the agent store and the hub until quiet.
        pub(crate) fn pump(&mut self, store: &BokehSessionStore) {
            for _ in 0..16 {
                let mut progressed = false;
                for frame in store.generate_frames(&mut self.agent_states) {
                    progressed = true;
                    for reply in self.hub.receive_runtime_frame(&mut self.hub_states, &frame) {
                        self.agent_receive(store, &reply);
                    }
                }
                for frame in self.hub.runtime_updates(&mut self.hub_states, None) {
                    progressed = true;
                    self.agent_receive(store, &frame);
                }
                if !progressed {
                    return;
                }
            }
            panic!("agent and hub did not converge");
        }

        fn agent_receive(&mut self, store: &BokehSessionStore, frame: &[u8]) {
            if let Some(back) = store
                .receive_payload(frame, &mut self.agent_states)
                .unwrap()
            {
                self.hub.receive_runtime_frame(&mut self.hub_states, &back);
            }
        }

        /// Commit `events` in the store and hand its broadcasts to the hub,
        /// as the room's runtime agent connection does.
        async fn broadcast(&self, store: &BokehSessionStore, events: Value) {
            for events in flush(store, &self.blob_store, wire_delta("tx", events), &[]).await {
                self.hub
                    .observe_runtime_broadcast(&NotebookBroadcast::BokehSessionEvents {
                        events: Box::new(events),
                    });
            }
        }

        /// A replica holding `p3` folded at `[1, 2]` plus the broadcast
        /// stream of `[3]`. Returns the agent store.
        pub(crate) async fn with_streamed_tail(&mut self) -> BokehSessionStore {
            let store = store_with_session();
            self.broadcast(
                &store,
                json!({"data_events": [fold_event(0, json!([1, 2]))]}),
            )
            .await;
            self.pump(&store);
            self.broadcast(
                &store,
                json!({"data_events": [stream_event(0, json!([3]))]}),
            )
            .await;
            self.pump(&store);
            store
        }

        /// Stream a NumPy-backed `[4.0]` onto `p3` at `base` and hand the
        /// broadcast to the hub. Returns the ephemeral buffer blob.
        async fn broadcast_numpy_stream(&self, store: &BokehSessionStore, base: u64) -> String {
            let data = 4.0f64.to_le_bytes().to_vec();
            let hash = crate::bokeh_session::hex_sha256(&data);
            let content = wire_delta(
                "tx-numpy",
                json!({
                    "data_events": [stream_event(base, json!({
                        "type": "ndarray", "dtype": "float64", "order": "little", "shape": [1],
                        "array": {"type": "bytes", "data": {"id": "b1"}},
                    }))],
                    "buffers": [{"id": "b1", "hash": hash, "size": 8, "buffer_index": 0}],
                }),
            );
            for events in flush(
                store,
                &self.blob_store,
                content,
                std::slice::from_ref(&data),
            )
            .await
            {
                self.kind.retain_events(&events);
            }
            hash
        }

        fn snapshot_with_tail(&self) -> Option<SnapshotWithTail> {
            self.kind.snapshot_with_tail(&self.hub, "session-1")
        }

        async fn x(&self) -> Value {
            let state = self.snapshot_with_tail().unwrap();
            materialized_x(
                &materialize_doc_json(&state, &self.blob_store)
                    .await
                    .unwrap(),
            )
        }

        fn set_record(&self, status: BokehSessionStatus, epoch: u64) {
            self.state
                .with_doc(|doc| doc.put_bokeh_session("session-1", &record(status, epoch)))
                .unwrap();
        }

        /// A connected session whose output stores [`payload`] as a blob.
        async fn add_session_output(&self) {
            let stored = serde_json::to_vec(&payload()).unwrap();
            let hash = self
                .blob_store
                .put(&stored, BOKEH_SESSION_MIME)
                .await
                .unwrap();
            self.state
                .with_doc(|doc| {
                    doc.create_execution_with_source_provenance(
                        "exec-1",
                        "panel_output",
                        0,
                        None,
                        Some("cell-1"),
                    )?;
                    doc.append_output(
                        "exec-1",
                        &json!({
                            "output_type": "display_data", "output_id": "output-1",
                            "data": {BOKEH_SESSION_MIME: {"blob": hash, "size": stored.len()}},
                            "metadata": {},
                        }),
                    )
                    .map(|_| ())
                })
                .unwrap();
            self.set_record(BokehSessionStatus::Connected, 0);
        }

        async fn stored_payload(&self) -> Value {
            let outputs = self.state.read(|doc| doc.get_outputs("exec-1")).unwrap();
            let content: ContentRef =
                serde_json::from_value(outputs[0]["data"][BOKEH_SESSION_MIME].clone()).unwrap();
            serde_json::from_str(&content.resolve(&self.blob_store).await.unwrap()).unwrap()
        }

        async fn save(&self, output: Value) -> Value {
            self.hooks.materialize_for_save(output).await
        }

        async fn lose_runtime_agent(&self) {
            self.hub
                .on_runtime_agent_lost(&self.state, &self.blob_store)
                .await;
        }
    }

    fn payload() -> Value {
        json!({"session_id": "session-1", "document": {"roots": []}, "buffers": []})
    }

    fn display_output() -> Value {
        json!({
            "output_type": "display_data",
            "data": {BOKEH_SESSION_MIME: payload()},
            "metadata": {},
        })
    }

    /// Values of a float64 ndarray column encoded for Bokeh 3.9.
    fn float_column(column: &Value) -> Vec<f64> {
        assert_eq!(column["dtype"], "float64");
        let encoding = crate::bokeh_session::ingest::BytesEncoding::for_bokeh_version("3.9.2");
        let data = encoding
            .decode(column["array"]["data"].as_str().unwrap())
            .unwrap();
        data.chunks_exact(8)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
            .collect()
    }

    /// A notebook peer holding one session replica, as the browser does.
    struct Peer {
        identity: RoomConnectionIdentity,
        doc: BokehSessionDoc,
        state: sync::State,
        epoch: u64,
        hub_states: KeyedSyncStates,
        resyncs: Vec<SessionControlMessage>,
    }

    impl Peer {
        fn new(scope: ConnectionScope) -> Self {
            Self::with_identity(alice(scope), ALICE)
        }

        fn with_identity(identity: RoomConnectionIdentity, actor: &str) -> Self {
            Self {
                identity,
                doc: BokehSessionDoc::new_empty(actor),
                state: sync::State::new(),
                epoch: 0,
                hub_states: KeyedSyncStates::new(),
                resyncs: Vec::new(),
            }
        }

        fn restart(&mut self, epoch: u64) {
            let actor = String::from_utf8_lossy(self.doc.doc().get_actor().to_bytes()).into_owned();
            self.doc = BokehSessionDoc::new_empty(&actor);
            self.state = sync::State::new();
            self.epoch = epoch;
        }

        fn apply(&mut self, frames: Vec<Vec<u8>>) {
            for frame in frames {
                let (header, body) = KeyedDocFrameHeader::try_parse(&frame).unwrap();
                if header.epoch > self.epoch {
                    self.restart(header.epoch);
                }
                self.doc
                    .receive_sync_message(&mut self.state, sync::Message::decode(body).unwrap())
                    .unwrap();
            }
        }

        fn sync(&mut self, room: &Room) {
            for _ in 0..16 {
                let Some(message) = self.doc.generate_sync_message(&mut self.state) else {
                    return;
                };
                let frame = KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "session-1", self.epoch)
                    .encode_frame(&message.encode());
                let reply = room.hub.receive_peer_frame(
                    &mut self.hub_states,
                    &frame,
                    &self.identity,
                    &room.state,
                );
                self.apply(reply.frames);
                if let Some(resync) = reply.resync {
                    self.resyncs.push(resync);
                    return;
                }
            }
        }

        fn resync_reason(&self) -> &str {
            match self.resyncs.first() {
                Some(SessionControlMessage::DocResync { reason, .. }) => reason,
                other => panic!("expected a resync, got {other:?}"),
            }
        }
    }

    fn hub_prop(room: &Room, model: &str, name: &str) -> Option<String> {
        room.snapshot_with_tail()?
            .snapshot
            .models
            .get(model)?
            .props
            .get(name)
            .cloned()
    }

    #[test]
    fn peer_edits_route_through_the_hub_to_the_agent_and_kernel_forwarder() {
        let mut room = Room::new();
        let store = store_with_session();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        store.set_forwarder(Some(tx));
        room.pump(&store);
        room.set_record(BokehSessionStatus::Connected, 0);

        let mut peer = Peer::new(ConnectionScope::Editor);
        peer.sync(&room);
        assert_eq!(peer.doc.get_prop("p2", "value").as_deref(), Some("0.5"));

        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        peer.sync(&room);
        assert!(peer.resyncs.is_empty(), "{:?}", peer.resyncs);
        room.pump(&store);
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
        room.pump(&store);
        let updates = room.hub.peer_updates(&mut peer.hub_states, None);
        peer.apply(updates);
        assert_eq!(peer.doc.get_prop("p2", "value").as_deref(), Some("0.1"));
    }

    #[test]
    fn rejected_writes_strip_and_signal_resync() {
        let mut room = Room::new();
        let store = store_with_session();
        room.pump(&store);

        // Kernel lost: the session is read-only.
        room.set_record(BokehSessionStatus::Disconnected, 0);
        let mut peer = Peer::new(ConnectionScope::Editor);
        peer.sync(&room);
        assert!(peer.resyncs.is_empty(), "read-only sessions still sync");
        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        peer.sync(&room);
        assert!(
            peer.resync_reason().contains("disconnected"),
            "{}",
            peer.resync_reason()
        );
        assert_eq!(hub_prop(&room, "p2", "value").as_deref(), Some("0.5"));

        // Viewers never write.
        room.set_record(BokehSessionStatus::Connected, 0);
        let mut viewer = Peer::new(ConnectionScope::Viewer);
        viewer.sync(&room);
        viewer.doc.set_prop("p2", "value", "0.8").unwrap();
        viewer.doc.commit();
        viewer.sync(&room);
        assert!(viewer.resync_reason().contains("viewer"));

        // Content rule: reference properties are refused even when connected.
        let mut peer = Peer::new(ConnectionScope::Editor);
        peer.sync(&room);
        peer.doc.set_prop("p1", "children", "[]").unwrap();
        peer.doc.commit();
        peer.sync(&room);
        assert!(
            peer.resync_reason().contains("references"),
            "{}",
            peer.resync_reason()
        );
        assert_eq!(hub_prop(&room, "p2", "value").as_deref(), Some("0.5"));

        // A stale epoch is refused before the message is read.
        room.set_record(BokehSessionStatus::Connected, 1);
        let mut stale = Peer::new(ConnectionScope::Editor);
        stale.sync(&room);
        assert!(matches!(
            stale.resyncs.first(),
            Some(SessionControlMessage::DocResync { epoch: 1, .. })
        ));
    }

    #[test]
    fn writes_by_another_principal_are_refused() {
        let mut room = Room::new();
        let store = store_with_session();
        room.pump(&store);
        room.set_record(BokehSessionStatus::Connected, 0);
        let mut peer =
            Peer::with_identity(alice(ConnectionScope::Editor), "user:dev:mallory/browser:m");
        peer.sync(&room);
        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        peer.sync(&room);
        assert!(
            peer.resync_reason().contains("mallory"),
            "{}",
            peer.resync_reason()
        );
        assert_eq!(hub_prop(&room, "p2", "value").as_deref(), Some("0.5"));
    }

    /// Send only the peer's last change, as a Bloom false positive can, and
    /// apply the hub's reply.
    fn send_last_change_only(peer: &mut Peer, room: &Room) -> Option<SessionControlMessage> {
        let child = peer.doc.doc_mut().get_last_local_change().unwrap();
        // The peer believes it sent the whole chain.
        peer.doc.generate_sync_message(&mut peer.state).unwrap();
        let partial = sync::Message {
            heads: vec![child.hash()],
            need: vec![],
            have: vec![],
            changes: vec![child.raw_bytes().to_vec()].into(),
            flags: None,
            version: sync::MessageVersion::V1,
        };
        let frame = KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "session-1", peer.epoch)
            .encode_frame(&partial.encode());
        let reply =
            room.hub
                .receive_peer_frame(&mut peer.hub_states, &frame, &peer.identity, &room.state);
        peer.apply(reply.frames);
        reply.resync
    }

    /// An incomplete chain is resent before Bokeh content validation, which
    /// then sees the whole chain.
    #[test]
    fn missing_dependencies_resend_before_content_validation() {
        let mut room = Room::new();
        let store = store_with_session();
        room.pump(&store);
        room.set_record(BokehSessionStatus::Connected, 0);

        let mut peer = Peer::new(ConnectionScope::Editor);
        peer.sync(&room);
        peer.doc.set_prop("p2", "value", "0.7").unwrap();
        peer.doc.commit();
        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        let resync = send_last_change_only(&mut peer, &room);
        assert!(resync.is_none(), "{resync:?}");
        assert_eq!(hub_prop(&room, "p2", "value").as_deref(), Some("0.5"));
        peer.sync(&room);
        assert!(peer.resyncs.is_empty(), "{:?}", peer.resyncs);
        assert_eq!(hub_prop(&room, "p2", "value").as_deref(), Some("0.8"));

        // A refused change hidden behind a missing parent is still refused
        // for its content once the chain is complete, not for the gap.
        let mut peer = Peer::new(ConnectionScope::Editor);
        peer.sync(&room);
        peer.doc.set_prop("p2", "value", "0.9").unwrap();
        peer.doc.commit();
        peer.doc.set_prop("p1", "children", "[]").unwrap();
        peer.doc.commit();
        let resync = send_last_change_only(&mut peer, &room);
        assert!(resync.is_none(), "{resync:?}");
        peer.sync(&room);
        assert!(
            peer.resync_reason().contains("references"),
            "{}",
            peer.resync_reason()
        );
        assert_eq!(hub_prop(&room, "p2", "value").as_deref(), Some("0.8"));
    }

    #[test]
    fn replacement_moves_hub_and_subscribed_peers_to_the_new_epoch() {
        let mut room = Room::new();
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
        room.pump(&store);
        room.set_record(BokehSessionStatus::Connected, 0);
        let mut peer = Peer::new(ConnectionScope::Viewer);
        peer.sync(&room);
        let old_blobs = room.hub.blob_roots();

        store.with_doc("session-1", |doc| {
            doc.set_prop("p2", "value", "0.3").unwrap();
            doc.commit();
        });
        let records = store.replace_due().unwrap();
        assert_eq!(records[0].epoch, 1);
        room.pump(&store);
        assert_eq!(room.snapshot_with_tail().unwrap().snapshot.epoch, 1);
        assert_eq!(room.hub.blob_roots(), old_blobs);

        // The subscribed peer is pushed the new epoch and starts a fresh replica.
        let updates = room.hub.peer_updates(&mut peer.hub_states, None);
        assert!(!updates.is_empty());
        for frame in &updates {
            let (header, _) = KeyedDocFrameHeader::try_parse(frame).unwrap();
            assert_eq!(header.epoch, 1);
        }
        peer.apply(updates);
        room.set_record(BokehSessionStatus::Connected, 1);
        peer.sync(&room);
        assert!(peer.resyncs.is_empty(), "{:?}", peer.resyncs);
        assert_eq!(peer.doc.epoch(), Some(1));
        assert_eq!(peer.doc.get_prop("p2", "value").as_deref(), Some("0.3"));
    }

    #[test]
    fn gc_roots_cover_prop_and_column_blobs_of_live_sessions() {
        let mut snap = snapshot();
        snap.columns.insert(
            "p3".into(),
            BTreeMap::from([(
                "x".to_string(),
                BokehColumnRef {
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
        let mut room = Room::new();
        room.pump(&store);
        assert_eq!(
            room.hub.blob_roots(),
            BTreeSet::from(["c".repeat(64), "d".repeat(64)])
        );
    }

    #[tokio::test]
    async fn gc_roots_cover_retained_tail_buffers() {
        let mut room = Room::new();
        let store = room.with_streamed_tail().await;
        let buffer = room.broadcast_numpy_stream(&store, 1).await;
        assert!(room.kind.room_blob_roots().contains(&buffer));
        assert!(room.hub.blob_roots().contains(&buffer));
    }

    #[tokio::test]
    async fn hub_state_includes_broadcast_events_since_the_last_fold() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        assert_eq!(room.snapshot_with_tail().unwrap().tail.len(), 1);
        assert_eq!(room.x().await, json!([1, 2, 3]));

        // Messages are not retained.
        room.kind.retain_events(&BokehSessionEvents {
            session_id: "session-1".into(),
            transaction_id: "tx-toast".into(),
            messages: vec![json!({"msg_type": "toast"})],
            ..Default::default()
        });
        assert_eq!(room.snapshot_with_tail().unwrap().tail.len(), 1);
    }

    #[tokio::test]
    async fn hub_drops_events_its_replica_has_folded() {
        let mut room = Room::new();
        let store = room.with_streamed_tail().await;

        // Folds are not broadcast; the replica learns of them through sync.
        room.broadcast(
            &store,
            json!({"data_events": [fold_event(1, json!([1, 2, 3]))]}),
        )
        .await;
        room.pump(&store);
        assert_eq!(
            room.x().await,
            json!([1, 2, 3]),
            "a folded event is not applied twice"
        );

        room.broadcast(
            &store,
            json!({"data_events": [stream_event(1, json!([4]))]}),
        )
        .await;
        let state = room.snapshot_with_tail().unwrap();
        assert_eq!(state.tail.len(), 1, "the folded stream was dropped");
        assert_eq!(state.tail[0].data_events[0]["base_version"], 1);
        {
            let inner = room.kind.lock();
            let tail = &inner.tails["session-1"]["p3"];
            assert_eq!(tail.bytes, event_bytes(&state.tail[0]), "pruning subtracts");
        }
        assert_eq!(room.x().await, json!([1, 2, 3, 4]));
    }

    /// Hand the hub a stream larger than the 1 MiB floor of the cap.
    fn overflow_tail(kind: &BokehRoomKind, base: u64) {
        let big = "x".repeat(MIN_TAIL_CAP_BYTES as usize + 1);
        kind.retain_events(&BokehSessionEvents {
            session_id: "session-1".into(),
            transaction_id: "tx-big".into(),
            data_events: vec![stream_event(base, json!([big]))],
            ..Default::default()
        });
    }

    #[test]
    fn the_tail_cap_follows_the_fold_policy() {
        assert_eq!(tail_byte_cap(0), 1024 * 1024);
        assert_eq!(tail_byte_cap(100), 1024 * 1024);
        assert_eq!(tail_byte_cap(1_600_000), 6_400_000);
    }

    #[tokio::test]
    async fn an_overflowing_tail_is_incomplete_until_the_replica_folds_past_it() {
        let mut room = Room::new();
        let store = room.with_streamed_tail().await;
        overflow_tail(&room.kind, 1);
        let state = room.snapshot_with_tail().unwrap();
        assert!(state.tail.is_empty(), "no partial tail is kept");
        assert_eq!(state.incomplete_sources, BTreeSet::from(["p3".to_string()]));
        let error = materialize_doc_json(&state, &room.blob_store)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("lost events"), "{error}");

        // A fold at or past the dropped versions makes the tail whole again.
        room.broadcast(
            &store,
            json!({"data_events": [fold_event(2, json!([1, 2, 3, 4]))]}),
        )
        .await;
        room.pump(&store);
        let state = room.snapshot_with_tail().unwrap();
        assert!(state.incomplete_sources.is_empty());
        assert_eq!(room.x().await, json!([1, 2, 3, 4]));
    }

    #[tokio::test]
    async fn hub_tails_are_dropped_once_their_session_leaves_connected() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        let tail_len = |room: &Room| room.snapshot_with_tail().unwrap().tail.len();
        room.hub.on_runtime_state_change(&room.state);
        assert_eq!(tail_len(&room), 1, "a broadcast can precede its record");
        room.set_record(BokehSessionStatus::Connected, 0);
        room.hub.on_runtime_state_change(&room.state);
        assert_eq!(tail_len(&room), 1);
        room.set_record(BokehSessionStatus::Disconnected, 0);
        room.hub.on_runtime_state_change(&room.state);
        assert_eq!(tail_len(&room), 0);
        assert!(
            room.snapshot_with_tail().is_some(),
            "mounted peers still read a disconnected replica"
        );
    }

    /// R3 follow-up: a closed session's replica and tail are dropped, and a
    /// late peer frame for it neither recreates the replica nor resyncs.
    #[tokio::test]
    async fn closed_sessions_leave_the_hub() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        room.set_record(BokehSessionStatus::Connected, 0);
        let mut peer = Peer::new(ConnectionScope::Editor);
        peer.sync(&room);
        assert!(peer.doc.has_model("p2"));

        room.set_record(BokehSessionStatus::Closed, 0);
        room.hub.on_runtime_state_change(&room.state);
        assert!(room.hub.ids(BOKEH_SESSION_KIND).is_empty());
        assert!(room.snapshot_with_tail().is_none());
        assert!(room.kind.lock().tails.is_empty());
        assert!(room.kind.lock().folded.is_empty());

        peer.doc.set_prop("p2", "value", "0.8").unwrap();
        peer.doc.commit();
        peer.sync(&room);
        assert!(peer.resyncs.is_empty(), "{:?}", peer.resyncs);
        assert!(room.hub.ids(BOKEH_SESSION_KIND).is_empty());
        assert!(room.hub.peer_updates(&mut peer.hub_states, None).is_empty());
    }

    #[tokio::test]
    async fn saving_includes_streams_since_the_last_fold_as_snapshot() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        room.set_record(BokehSessionStatus::Connected, 0);
        let saved = room.save(display_output()).await;
        let saved = &saved["data"][BOKEH_SESSION_MIME];
        assert_eq!(
            materialized_x(&saved["snapshot"]["document"]),
            json!([1, 2, 3])
        );
        assert_eq!(saved["snapshot"]["buffers"], json!([]));
        assert_eq!(saved["document"], payload()["document"], "fix 7");
        assert_eq!(saved["buffers"], payload()["buffers"]);
    }

    #[tokio::test]
    async fn saving_leaves_sessions_that_are_not_connected_as_stored() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        assert_eq!(
            room.save(display_output()).await,
            display_output(),
            "no record yet"
        );
        for status in [
            BokehSessionStatus::Disconnected,
            BokehSessionStatus::Error,
            BokehSessionStatus::Closed,
        ] {
            room.set_record(status, 0);
            assert_eq!(room.save(display_output()).await, display_output());
        }
        let unknown = json!({"output_type": "display_data", "data": {
            BOKEH_SESSION_MIME: {"session_id": "other", "document": {}},
        }});
        assert_eq!(room.save(unknown.clone()).await, unknown);
    }

    /// R1 P2-3: a NumPy stream since the last fold, then the kernel dies and
    /// its tail buffers are freed after the grace period. A later save must
    /// not replace the frozen payload with the folded state.
    #[tokio::test]
    async fn a_save_after_a_freeze_keeps_the_frozen_payload() {
        let mut room = Room::new();
        let store = room.with_streamed_tail().await;
        let buffer = room.broadcast_numpy_stream(&store, 1).await;
        room.add_session_output().await;
        let saved = room.save(display_output()).await;
        let snapshot = &saved["data"][BOKEH_SESSION_MIME]["snapshot"]["document"];
        assert_eq!(
            float_column(&materialized_x(snapshot)),
            [1.0, 2.0, 3.0, 4.0]
        );

        // The runtime agent freezes from its store and marks the session
        // disconnected; the RuntimeStateDoc change drops the hub's tail.
        let (_, state) = store.remove_kernel_sessions("kernel-1").remove(0);
        freeze_session_output(
            "session-1",
            &state,
            &room.state,
            None,
            &room.blob_store,
            &OutputBlobPublisher::none(),
        )
        .await
        .unwrap();
        room.state
            .with_doc(|doc| {
                doc.disconnect_bokeh_sessions_for_kernel("kernel-1")
                    .map(|_| ())
            })
            .unwrap();
        room.hub.on_runtime_state_change(&room.state);
        assert!(room.snapshot_with_tail().unwrap().tail.is_empty());
        let frozen = room.stored_payload().await;
        assert_eq!(
            float_column(&materialized_x(&frozen["snapshot"]["document"])),
            [1.0, 2.0, 3.0, 4.0]
        );
        assert_eq!(frozen["document"], payload()["document"], "fix 7");

        assert!(room.blob_store.delete(&buffer).await.unwrap());
        let output = json!({
            "output_type": "display_data",
            "data": {BOKEH_SESSION_MIME: frozen},
            "metadata": {},
        });
        assert_eq!(room.save(output.clone()).await, output);
    }

    #[tokio::test]
    async fn a_connected_save_whose_tail_cannot_be_replayed_keeps_the_stored_payload() {
        let mut room = Room::new();
        let store = room.with_streamed_tail().await;
        let buffer = room.broadcast_numpy_stream(&store, 1).await;
        room.set_record(BokehSessionStatus::Connected, 0);
        assert!(room.blob_store.delete(&buffer).await.unwrap());
        assert_eq!(room.save(display_output()).await, display_output());
    }

    /// R1 P2-4: a source whose retained tail overflowed is never saved from
    /// a partial tail or from its older folded state.
    #[tokio::test]
    async fn a_save_with_an_overflowed_tail_keeps_the_stored_payload() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        overflow_tail(&room.kind, 1);
        room.set_record(BokehSessionStatus::Connected, 0);
        assert_eq!(room.save(display_output()).await, display_output());
    }

    #[tokio::test]
    async fn runtime_agent_loss_freezes_streams_since_the_last_fold() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        room.add_session_output().await;

        room.lose_runtime_agent().await;

        let record = room
            .state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .unwrap();
        assert_eq!(record.unwrap().status, BokehSessionStatus::Disconnected);
        let frozen = room.stored_payload().await;
        assert_eq!(
            materialized_x(&frozen["snapshot"]["document"]),
            json!([1, 2, 3])
        );
        assert_eq!(frozen["document"], payload()["document"], "fix 7");
        assert!(room.kind.lock().tails.is_empty());
    }

    /// R4 P3-2: a session a new runtime agent creates while the freeze
    /// awaits is not one this freeze materialized, so it stays connected.
    #[tokio::test]
    async fn agent_loss_disconnects_only_the_sessions_it_froze() {
        let mut room = Room::new();
        let _store = room.with_streamed_tail().await;
        room.add_session_output().await;

        // Runs at the freeze's first await, after the connected set was read.
        let state = room.state.clone();
        let created = tokio::spawn(async move {
            state
                .with_doc(|doc| {
                    let mid_freeze = doc
                        .get_bokeh_session("session-1")
                        .is_some_and(|record| record.status == BokehSessionStatus::Connected);
                    doc.put_bokeh_session("session-2", &record(BokehSessionStatus::Connected, 0))?;
                    Ok(mid_freeze)
                })
                .unwrap()
        });
        room.lose_runtime_agent().await;
        assert!(
            created.await.unwrap(),
            "created while the freeze was running"
        );

        let status = |id: &str| {
            room.state
                .read(|doc| doc.get_bokeh_session(id))
                .unwrap()
                .unwrap()
                .status
        };
        assert_eq!(status("session-1"), BokehSessionStatus::Disconnected);
        assert_eq!(status("session-2"), BokehSessionStatus::Connected);
    }

    /// The stored payload is the display-time document, so a freeze whose
    /// tail cannot be replayed keeps the newer folded state.
    #[tokio::test]
    async fn a_freeze_whose_tail_cannot_be_replayed_falls_back_to_the_folded_state() {
        let mut room = Room::new();
        let store = room.with_streamed_tail().await;
        let buffer = room.broadcast_numpy_stream(&store, 1).await;
        room.add_session_output().await;
        assert!(room.blob_store.delete(&buffer).await.unwrap());

        room.lose_runtime_agent().await;

        let frozen = room.stored_payload().await;
        assert_eq!(
            materialized_x(&frozen["snapshot"]["document"]),
            json!([1, 2])
        );
    }
}
