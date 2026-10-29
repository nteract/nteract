//! The room's replica of every keyed document and the `KeyedDocSync` (0x0b)
//! routing between the runtime agent and notebook peers.
//!
//! The hub never writes. The runtime agent produces each document; its
//! frames are checked against the hub replica's epoch and may be ahead of it
//! (never behind), and a newer epoch starts a fresh replica. A peer subscribes to a document by sending its first frame for
//! it and then receives updates, including the move to a new epoch. A
//! rejected peer frame resets that peer's sync state and returns `DocResync`
//! so the peer drops its replica instead of resending the refused changes.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use automerge::sync::SyncDoc;
use automerge::{sync, AutoCommit};
use automerge_recovery::catch_automerge_result;
use notebook_protocol::protocol::{NotebookBroadcast, SessionControlMessage};
use notebook_wire::{KeyedDocFrameHeader, KeyedDocKey};
use nteract_identity::ConnectionScope;
use runtime_doc::{
    KeyedDocRejection, KeyedWriteContext, KeyedWritePermission, RuntimeStateHandle,
    RuntimeStateWriteScope,
};
use tokio::sync::broadcast;
use tracing::{debug, warn};

use super::admission::{check_change_actors, full_sync_request, has_missing_deps, preview_receive};
use super::kind::{KeyedDocKind, RoomKindCtx};
use crate::blob_store::BlobStore;
use crate::notebook_sync_server::RoomConnectionIdentity;

const HUB_ACTOR: &[u8] = b"runtimed:keyed-hub";
const CHANGED_CHANNEL_CAPACITY: usize = 256;
/// Record reads a peer frame may retry while replicas are being removed.
const MAX_RECORD_READS: usize = 3;

struct HubDoc {
    epoch: u64,
    doc: AutoCommit,
}

impl HubDoc {
    fn new(epoch: u64) -> Self {
        Self {
            epoch,
            doc: AutoCommit::new().with_actor(automerge::ActorId::from(HUB_ACTOR)),
        }
    }
}

/// Per-connection sync states, owned by one peer or runtime-agent loop.
/// A key is present once the connection has exchanged a frame for it.
#[derive(Default)]
pub(crate) struct KeyedSyncStates(HashMap<KeyedDocKey, (u64, sync::State)>);

impl KeyedSyncStates {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }

    pub(crate) fn contains(&self, key: &KeyedDocKey) -> bool {
        self.0.contains_key(key)
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &KeyedDocKey> {
        self.0.keys()
    }

    /// The state for `key`, started fresh when its epoch moved.
    pub(crate) fn for_epoch(&mut self, key: &KeyedDocKey, epoch: u64) -> &mut sync::State {
        let entry = self
            .0
            .entry(key.clone())
            .or_insert_with(|| (epoch, sync::State::new()));
        if entry.0 != epoch {
            *entry = (epoch, sync::State::new());
        }
        &mut entry.1
    }

    pub(crate) fn reset(&mut self, key: &KeyedDocKey, epoch: u64) {
        self.0.insert(key.clone(), (epoch, sync::State::new()));
    }

    /// Keep only the states `keep` accepts, e.g. to forget documents that
    /// no longer exist.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "kind-facing seam; production callers arrive with the first registered kind"
        )
    )]
    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&KeyedDocKey) -> bool) {
        self.0.retain(|key, _| keep(key));
    }
}

/// What to send back after a peer frame.
#[derive(Debug, Default)]
pub(crate) struct KeyedFrameReply {
    /// `KeyedDocSync` payloads (no type byte).
    pub frames: Vec<Vec<u8>>,
    /// `DocResync`, sent before `frames`.
    pub resync: Option<SessionControlMessage>,
}

pub(crate) struct KeyedDocHub {
    kinds: HashMap<&'static str, Arc<dyn KeyedDocKind>>,
    /// Cleared when the room is bridged to a hosted notebook: the hosted room
    /// has no runtime agent here and the cloud does not route 0x0b.
    routing: AtomicBool,
    docs: StdMutex<HashMap<KeyedDocKey, HubDoc>>,
    /// Bumped under the `docs` lock whenever a replica is removed.
    removals: AtomicU64,
    changed_tx: broadcast::Sender<KeyedDocKey>,
}

impl Default for KeyedDocHub {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl KeyedDocHub {
    pub(crate) fn new(kinds: Vec<Arc<dyn KeyedDocKind>>) -> Self {
        let (changed_tx, _) = broadcast::channel(CHANGED_CHANNEL_CAPACITY);
        let kinds = kinds.into_iter().map(|kind| (kind.kind(), kind)).collect();
        Self {
            kinds,
            routing: AtomicBool::new(true),
            docs: StdMutex::new(HashMap::new()),
            removals: AtomicU64::new(0),
            changed_tx,
        }
    }

    /// Stop routing every kind for the rest of the room's life.
    pub(crate) fn disable_routing(&self) {
        self.routing.store(false, Ordering::Relaxed);
    }

    /// Kinds this room routes, sorted; advertised to clients and runtime agents.
    pub(crate) fn advertised_kinds(&self) -> Vec<String> {
        if !self.routing.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let mut kinds: Vec<String> = self.kinds.keys().map(|kind| kind.to_string()).collect();
        kinds.sort();
        kinds
    }

    pub(crate) fn kind(&self, kind: &str) -> Option<&Arc<dyn KeyedDocKind>> {
        if !self.routing.load(Ordering::Relaxed) {
            return None;
        }
        self.kinds.get(kind)
    }

    /// Keys whose replica changed.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<KeyedDocKey> {
        self.changed_tx.subscribe()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<KeyedDocKey, HubDoc>> {
        self.docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self, key: KeyedDocKey) {
        let _ = self.changed_tx.send(key);
    }

    /// Parse the header and look up the routed kind. Frames that fail here
    /// are dropped without a reply: there is no document to resync.
    fn admit_frame<'p>(
        &self,
        payload: &'p [u8],
        source: &str,
    ) -> Option<(KeyedDocFrameHeader, &'p [u8], &Arc<dyn KeyedDocKind>)> {
        let (header, body) = match KeyedDocFrameHeader::try_parse(payload) {
            Ok(parsed) => parsed,
            Err(error) => {
                warn!("[keyed-doc] Dropping malformed {source} frame: {error}");
                return None;
            }
        };
        let Some(kind) = self.kind(&header.kind) else {
            debug!(
                "[keyed-doc] Dropping {source} frame for unrouted kind {}",
                header.kind
            );
            return None;
        };
        Some((header, body, kind))
    }

    /// The kind's body limit, checked once the header names a routed kind.
    fn check_body_size(
        kind: &dyn KeyedDocKind,
        header: &KeyedDocFrameHeader,
        body: &[u8],
        source: &str,
    ) -> Result<(), KeyedDocRejection> {
        let limits = kind.frame_limits();
        if body.len() > limits.cap {
            warn!(
                "[keyed-doc] Oversized {source} frame for {}/{}: {} bytes exceeds {}",
                header.kind,
                header.id,
                body.len(),
                limits.cap
            );
            return Err(KeyedDocRejection::TooLarge {
                size: body.len(),
                cap: limits.cap,
            });
        }
        if body.len() > limits.warn {
            warn!(
                "[keyed-doc] Large {source} frame for {}/{}: {} bytes",
                header.kind,
                header.id,
                body.len()
            );
        }
        Ok(())
    }

    /// The replica for `key`, replaced with a fresh one when `epoch` is newer.
    fn ensure_epoch<'a>(
        docs: &'a mut HashMap<KeyedDocKey, HubDoc>,
        key: &KeyedDocKey,
        epoch: u64,
    ) -> &'a mut HubDoc {
        let doc = docs
            .entry(key.clone())
            .or_insert_with(|| HubDoc::new(epoch));
        if doc.epoch < epoch {
            *doc = HubDoc::new(epoch);
        }
        doc
    }

    /// A frame from the runtime agent connection. Returns reply payloads.
    pub(crate) fn receive_runtime_frame(
        &self,
        states: &mut KeyedSyncStates,
        payload: &[u8],
    ) -> Vec<Vec<u8>> {
        let Some((header, body, kind)) = self.admit_frame(payload, "runtime") else {
            return Vec::new();
        };
        // The producer has no replica to resync; its oversized frame is dropped.
        if Self::check_body_size(kind.as_ref(), &header, body, "runtime").is_err() {
            return Vec::new();
        }
        let message = match sync::Message::decode(body) {
            Ok(message) => message,
            Err(error) => {
                warn!(
                    "[keyed-doc] Dropping undecodable runtime frame for {}/{}: {error}",
                    header.kind, header.id
                );
                return Vec::new();
            }
        };
        let key = header.key();
        let mut docs = self.lock();
        let current = docs.get(&key).map(|doc| doc.epoch);
        let ctx = KeyedWriteContext {
            scope: RuntimeStateWriteScope::RuntimePeer,
            current_epoch: current.unwrap_or(header.epoch),
        };
        if ctx.check_frame_epoch(header.epoch).is_err() {
            warn!(
                "[keyed-doc] Dropping runtime frame for {}/{} at epoch {}: the hub replica is at epoch {}",
                key.kind, key.id, header.epoch, ctx.current_epoch
            );
            return Vec::new();
        }
        let hub_doc = Self::ensure_epoch(&mut docs, &key, header.epoch);
        let state = states.for_epoch(&key, hub_doc.epoch);
        let heads_before = hub_doc.doc.get_heads();
        let received = catch_automerge_result("keyed-doc-runtime-receive", || {
            hub_doc.doc.sync().receive_sync_message(state, message)
        })
        .into_operation_result("keyed-doc-runtime-receive");
        let changed = match received {
            Ok(()) => hub_doc.doc.get_heads() != heads_before || current != Some(header.epoch),
            Err(error) => {
                warn!(
                    "[keyed-doc] Runtime frame for {}/{} failed: {error}",
                    key.kind, key.id
                );
                *state = sync::State::new();
                false
            }
        };
        if changed {
            kind.on_runtime_change(&key.id, hub_doc.epoch, &hub_doc.doc);
        }
        let frames = generate(&key, hub_doc, states).into_iter().collect();
        drop(docs);
        if changed {
            self.notify(key);
        }
        frames
    }

    /// Updates for the runtime agent after `key` changed; `None` covers every
    /// document (after a lagged receiver). The agent produces every document,
    /// so no subscription is needed.
    pub(crate) fn runtime_updates(
        &self,
        states: &mut KeyedSyncStates,
        key: Option<&KeyedDocKey>,
    ) -> Vec<Vec<u8>> {
        let mut docs = self.lock();
        match key {
            Some(key) => docs
                .get_mut(key)
                .and_then(|doc| generate(key, doc, states))
                .into_iter()
                .collect(),
            None => docs
                .iter_mut()
                .filter_map(|(key, doc)| generate(key, doc, states))
                .collect(),
        }
    }

    /// A frame from a notebook peer.
    ///
    /// Order: header → routed kind (both silent drops) → record (read from
    /// `state` before the hub lock, again if a replica was removed meanwhile)
    /// → known key (silent drop otherwise) →
    /// epoch (the newer of hub and record) → per-kind size → write
    /// permission (changes stripped on refusal) → preview, actor check and
    /// kind validation → commit. Any refusal after the key is known resets
    /// the key's sync state and returns `DocResync`. The first frame for a
    /// known key subscribes the connection to it.
    pub(crate) fn receive_peer_frame(
        &self,
        states: &mut KeyedSyncStates,
        payload: &[u8],
        identity: &RoomConnectionIdentity,
        state: &RuntimeStateHandle,
    ) -> KeyedFrameReply {
        let mut reply = KeyedFrameReply::default();
        let Some((header, body, kind)) = self.admit_frame(payload, "peer") else {
            return reply;
        };
        let key = header.key();
        let read_record = || match state.read(|doc| kind.record(doc, &key.id)) {
            Ok(record) => record,
            Err(error) => {
                warn!(
                    "[keyed-doc] Could not read the record for {}/{}: {error}",
                    key.kind, key.id
                );
                None
            }
        };
        let scope = write_scope(identity.scope());
        // Before the hub lock: `frame_limits` is not one of the calls the
        // kind contract allows under it.
        let size_check = Self::check_body_size(kind.as_ref(), &header, body, "peer");

        // The record is read before the hub lock (lock order). If a replica
        // was removed after that read, the record is stale and could
        // recreate the replica empty, so read it again.
        let mut attempts = 0;
        let (record, mut docs) = loop {
            let removals = self.removals.load(Ordering::Acquire);
            let record = read_record();
            let docs = self.lock();
            if docs.contains_key(&key) || self.removals.load(Ordering::Acquire) == removals {
                break (record, docs);
            }
            attempts += 1;
            if attempts == MAX_RECORD_READS {
                debug!(
                    "[keyed-doc] Dropping peer frame for {}/{}: replicas kept being removed",
                    key.kind, key.id
                );
                return reply;
            }
        };
        let current = match (docs.get(&key).map(|doc| doc.epoch), record.as_ref()) {
            (None, None) => {
                debug!(
                    "[keyed-doc] Dropping peer frame for unknown {}/{}",
                    key.kind, key.id
                );
                return reply;
            }
            (hub, record) => hub
                .max(record.map(|record| record.epoch))
                .unwrap_or_default(),
        };
        let hub_doc = Self::ensure_epoch(&mut docs, &key, current);
        let ctx = KeyedWriteContext {
            scope,
            current_epoch: current,
        };
        let heads_before = hub_doc.doc.get_heads();
        let admission = size_check.and_then(|()| {
            admit_peer_message(
                kind.as_ref(),
                hub_doc,
                states.for_epoch(&key, current),
                body,
                &header,
                &ctx,
                record.as_ref(),
                identity,
            )
        });
        let rejection = match admission {
            Ok(Some(request)) => {
                reply.frames.push(
                    KeyedDocFrameHeader::new(key.kind.clone(), key.id.clone(), current)
                        .encode_frame(&request.encode()),
                );
                return reply;
            }
            Ok(None) => None,
            Err(rejection) => Some(rejection),
        };
        let changed = hub_doc.doc.get_heads() != heads_before;
        if let Some(rejection) = rejection {
            debug!(
                "[keyed-doc] Peer frame for {}/{} refused: {rejection}",
                key.kind, key.id
            );
            states.reset(&key, current);
            reply.resync = Some(SessionControlMessage::DocResync {
                kind: key.kind.clone(),
                id: key.id.clone(),
                epoch: current,
                reason: rejection.to_string(),
            });
        }
        reply.frames.extend(generate(&key, hub_doc, states));
        drop(docs);
        if changed {
            self.notify(key);
        }
        reply
    }

    /// Updates for a peer after `key` changed (`None`: every key it holds).
    /// Only keys the peer subscribed to are sent, moved to the hub's epoch.
    pub(crate) fn peer_updates(
        &self,
        states: &mut KeyedSyncStates,
        key: Option<&KeyedDocKey>,
    ) -> Vec<Vec<u8>> {
        let keys: Vec<KeyedDocKey> = match key {
            Some(key) if states.contains(key) => vec![key.clone()],
            Some(_) => return Vec::new(),
            None => states.keys().cloned().collect(),
        };
        let mut docs = self.lock();
        keys.iter()
            .filter_map(|key| {
                let doc = docs.get_mut(key)?;
                generate(key, doc, states)
            })
            .collect()
    }

    /// Run `f` on the replica of `key`. Runs under the hub lock.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "kind-facing seam; production callers arrive with the first registered kind"
        )
    )]
    pub(crate) fn with_doc<R>(
        &self,
        key: &KeyedDocKey,
        f: impl FnOnce(u64, &mut AutoCommit) -> R,
    ) -> Option<R> {
        let mut docs = self.lock();
        let doc = docs.get_mut(key)?;
        Some(f(doc.epoch, &mut doc.doc))
    }

    pub(crate) fn ids(&self, kind: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .lock()
            .keys()
            .filter(|key| key.kind == kind)
            .map(|key| key.id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// GC roots: blobs every replica references plus kind-held roots.
    pub(crate) fn blob_roots(&self) -> BTreeSet<String> {
        let mut roots: BTreeSet<String> = self
            .kinds
            .values()
            .flat_map(|kind| kind.room_blob_roots())
            .collect();
        let docs = self.lock();
        for (key, doc) in docs.iter() {
            if let Some(kind) = self.kinds.get(key.kind.as_str()) {
                roots.extend(kind.referenced_blobs(&doc.doc));
            }
        }
        roots
    }

    /// Let each kind drop replicas whose records ended. The record read
    /// completes before the hub lock is taken.
    pub(crate) fn on_runtime_state_change(&self, state: &RuntimeStateHandle) {
        for kind in self.kinds.values() {
            let ids = self.ids(kind.kind());
            if ids.is_empty() {
                continue;
            }
            let retired = match state.read(|doc| kind.on_runtime_state_change(doc, &ids)) {
                Ok(retired) => retired,
                Err(error) => {
                    warn!(
                        "[keyed-doc] Could not read RuntimeStateDoc for {}: {error}",
                        kind.kind()
                    );
                    continue;
                }
            };
            if retired.is_empty() {
                continue;
            }
            self.remove_docs(
                retired
                    .into_iter()
                    .map(|id| KeyedDocKey::new(kind.kind(), id)),
            );
        }
    }

    fn remove_docs(&self, keys: impl IntoIterator<Item = KeyedDocKey>) {
        let mut docs = self.lock();
        for key in keys {
            docs.remove(&key);
        }
        self.removals.fetch_add(1, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn remove_doc(&self, key: &KeyedDocKey) {
        self.remove_docs([key.clone()]);
    }

    pub(crate) fn observe_runtime_broadcast(&self, broadcast: &NotebookBroadcast) {
        for kind in self.kinds.values() {
            kind.observe_runtime_broadcast(broadcast);
        }
    }

    pub(crate) async fn on_runtime_agent_lost(
        &self,
        state: &RuntimeStateHandle,
        blob_store: &Arc<BlobStore>,
    ) {
        let kinds: Vec<Arc<dyn KeyedDocKind>> = self.kinds.values().cloned().collect();
        for kind in kinds {
            kind.on_runtime_agent_lost(RoomKindCtx {
                state,
                blob_store,
                hub: self,
            })
            .await;
        }
    }
}

/// Apply one peer message to `hub_doc`, or refuse it. A refused message can
/// still have been applied read-only (changes stripped) so the peer keeps
/// receiving; the caller resets the sync state either way.
#[allow(clippy::too_many_arguments)]
fn admit_peer_message(
    kind: &dyn KeyedDocKind,
    hub_doc: &mut HubDoc,
    state: &mut sync::State,
    body: &[u8],
    header: &KeyedDocFrameHeader,
    ctx: &KeyedWriteContext,
    record: Option<&runtime_doc::KeyedDocRecord>,
    identity: &RoomConnectionIdentity,
) -> Result<Option<sync::Message>, KeyedDocRejection> {
    ctx.check_frame_epoch(header.epoch)?;
    let mut message = sync::Message::decode(body).map_err(|_| KeyedDocRejection::Undecodable)?;
    let mut refused = None;
    let permission = if message.changes.is_empty() {
        None
    } else {
        match kind.write_permission(ctx.scope, record) {
            Ok(permission) => Some(permission),
            Err(rejection) => {
                message.changes = sync::ChunkList::empty();
                refused = Some(rejection);
                None
            }
        }
    };
    match permission {
        Some(KeyedWritePermission::Validated) => {
            let preview =
                match preview_receive(&hub_doc.doc, state, message, "keyed-doc-peer-preview") {
                    Ok(preview) => preview,
                    Err(error) if has_missing_deps(&error) => {
                        return full_sync_request(&mut hub_doc.doc, state).map_err(|error| {
                            warn!(
                                "[keyed-doc] Full sync request for {} failed: {error}",
                                header.id
                            );
                            KeyedDocRejection::Undecodable
                        });
                    }
                    Err(error) => {
                        warn!("[keyed-doc] Peer preview for {} failed: {error}", header.id);
                        return Err(KeyedDocRejection::Undecodable);
                    }
                };
            check_change_actors(identity, &preview.new_changes)
                .map_err(|foreign| KeyedDocRejection::UnauthorizedActor(foreign.reason))?;
            kind.validate_peer_changes(&hub_doc.doc, &preview.new_changes, ctx)?;
            hub_doc.doc = preview.doc;
            *state = preview.state;
        }
        Some(KeyedWritePermission::Producer) | None => {
            catch_automerge_result("keyed-doc-peer-receive", || {
                hub_doc.doc.sync().receive_sync_message(state, message)
            })
            .into_operation_result("keyed-doc-peer-receive")
            .map_err(|error| {
                warn!("[keyed-doc] Peer frame for {} failed: {error}", header.id);
                KeyedDocRejection::Undecodable
            })?;
        }
    }
    refused.map_or(Ok(None), Err)
}

fn generate(key: &KeyedDocKey, doc: &mut HubDoc, states: &mut KeyedSyncStates) -> Option<Vec<u8>> {
    let state = states.for_epoch(key, doc.epoch);
    let message = doc.doc.sync().generate_sync_message(state)?;
    Some(
        KeyedDocFrameHeader::new(key.kind.clone(), key.id.clone(), doc.epoch)
            .encode_frame(&message.encode()),
    )
}

pub(crate) fn write_scope(scope: ConnectionScope) -> RuntimeStateWriteScope {
    match scope {
        ConnectionScope::Viewer => RuntimeStateWriteScope::Viewer,
        ConnectionScope::Editor => RuntimeStateWriteScope::Editor,
        ConnectionScope::RuntimePeer => RuntimeStateWriteScope::RuntimePeer,
        ConnectionScope::Owner => RuntimeStateWriteScope::Owner,
    }
}
