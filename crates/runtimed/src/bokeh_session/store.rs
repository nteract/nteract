//! The runtime agent's authoritative session documents.
//!
//! Every document here is written only under its kernel's actor. Property
//! changes another actor wins arrive through [`BokehSessionStore::receive_sync`]
//! and go to the kernel through the forwarder in the same critical section,
//! so a replacement can never re-author an unforwarded foreign value.
//!
//! The store is the agent half of the `bokeh_session` keyed document kind
//! ([`AgentKeyedDoc`]). It creates sessions only while the coordinator routes
//! that kind; otherwise Panel outputs stay static.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use automerge::sync;
use notebook_protocol::protocol::{
    BokehSessionBufferRef, BokehSessionDataTail, BokehSessionEvents, NotebookBroadcast,
};
use notebook_wire::{KeyedDocFrameHeader, KeyedDocKey};
use runtime_doc::{
    BokehReplacementPolicy, BokehReplacementTracker, BokehSessionChangeset, BokehSessionDoc,
    BokehSessionDocDelta, BokehSessionStatus, RuntimeStateHandle,
};
use serde_json::{json, Value};
use tokio::sync::oneshot::error::TryRecvError;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, warn};

use super::hex_heads;
use super::ingest::{
    prepare_flush, BlobSink, BytesEncoding, DataOp, KernelDelta, PreparedFlush, Tagged,
};
use super::kernel::{BokehKernelOutbox, BokehKernelRequester, INGEST_DRAIN_TIMEOUT};
use super::materialize::SnapshotWithTail;
use super::BOKEH_SESSION_KIND;
use crate::blob_store::BlobStore;
use crate::kernel_extensions::RawIopubMessage;
use crate::keyed_doc::agent::{KeyedDocAvailability, KeyedDocWaker};
use crate::keyed_doc::{AgentKeyedDoc, KeyedSyncStates};
use crate::output_blob_publisher::OutputBlobPublisher;

/// Coalescing window for kernel deltas, as for widget state.
const INGEST_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// Retired one-off and superseded column blobs stay readable this long, so
/// peers that just received a broadcast or ref can still fetch them.
const RETIRED_BLOB_GRACE_MS: u64 = 60_000;
const REPLACEMENT_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// A deferred fold whose delta never arrived (a failed flush, or the
/// kernel's fold raising) stops blocking new requests after twice the
/// launcher's quiet-fold interval (`FOLD_QUIET_SECONDS`, 2 s).
pub(crate) const FOLD_CLAIM_TTL_MS: u64 = 4_000;

/// Test-only replacement policy, honored only in dev mode:
/// `<change bytes>[,<min interval ms>]`, with no saved-size factor. Lets
/// end-to-end tests force a replacement without the 60 s rate limit.
pub(crate) const TEST_REPLACEMENT_POLICY_ENV: &str = "NTERACT_TEST_BOKEH_REPLACEMENT";

pub(crate) fn replacement_policy_from_env() -> BokehReplacementPolicy {
    if !runt_workspace::is_dev_mode() {
        return BokehReplacementPolicy::default();
    }
    let Ok(raw) = std::env::var(TEST_REPLACEMENT_POLICY_ENV) else {
        return BokehReplacementPolicy::default();
    };
    match parse_test_replacement_policy(&raw) {
        Some(policy) => {
            warn!("[bokeh-session] Using test replacement policy {policy:?}");
            policy
        }
        None => {
            warn!("[bokeh-session] Ignoring invalid {TEST_REPLACEMENT_POLICY_ENV}={raw:?}");
            BokehReplacementPolicy::default()
        }
    }
}

fn parse_test_replacement_policy(raw: &str) -> Option<BokehReplacementPolicy> {
    let mut parts = raw.split(',').map(str::trim);
    let min_change_bytes = parts.next()?.parse().ok()?;
    let min_interval_ms = match parts.next() {
        Some(interval) => interval.parse().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }
    Some(BokehReplacementPolicy {
        min_change_bytes,
        saved_size_factor: 0,
        min_interval_ms,
    })
}

/// Property changes a non-kernel actor won, as a test forwarder sees them.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BokehForeignForward {
    pub(crate) session_id: String,
    /// `(model id, property, encoded value)`.
    pub(crate) changes: Vec<(String, String, String)>,
}

/// RuntimeStateDoc facts for a freshly replaced document.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BokehReplacementRecord {
    pub(crate) session_id: String,
    pub(crate) epoch: u64,
    pub(crate) doc_heads: Vec<String>,
    pub(crate) previous_heads: Vec<String>,
}

#[derive(Default)]
struct SourceTail {
    events: Vec<BokehSessionEvents>,
    bytes: usize,
    buffer_blobs: Vec<String>,
}

struct AgentSession {
    doc: BokehSessionDoc,
    kernel_id: String,
    kernel_actor: String,
    tracker: BokehReplacementTracker,
    tails: HashMap<String, SourceTail>,
    /// Sources with a fold requested from the kernel and not yet answered
    /// (`None`), or deferred by the kernel at the given time and not yet
    /// delivered; repeated data requests must not queue more.
    folds_pending: HashMap<String, Option<u64>>,
}

impl AgentSession {
    fn is_foreign(&self, actor: &automerge::ActorId) -> bool {
        actor.to_bytes() != self.kernel_actor.as_bytes()
    }

    /// Column, property and retained tail buffer blobs this session reads.
    fn blob_refs(&self) -> BTreeSet<String> {
        let mut blobs = self.doc.referenced_blobs();
        for tail in self.tails.values() {
            blobs.extend(tail.buffer_blobs.iter().cloned());
        }
        blobs
    }

    /// The document state plus every source's tail, which the folded
    /// column blobs do not include yet.
    fn snapshot_with_tail(&self) -> anyhow::Result<SnapshotWithTail> {
        let snapshot = self
            .doc
            .read_snapshot()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let mut sources: Vec<(&String, &SourceTail)> = self.tails.iter().collect();
        sources.sort_by_key(|(source_id, _)| *source_id);
        let tail = sources
            .into_iter()
            .flat_map(|(_, tail)| tail.events.iter().cloned())
            .collect();
        Ok(SnapshotWithTail {
            snapshot,
            tail,
            ..Default::default()
        })
    }
}

/// The launched kernel's shell requester, bound at kernel launch.
struct KernelBinding {
    kernel_id: String,
    requester: BokehKernelRequester,
}

struct Inner {
    sessions: HashMap<String, AgentSession>,
    forwarder: Option<BokehKernelOutbox>,
    kernel: Option<KernelBinding>,
    /// Per kernel: resolves once its ingest applied every delta it received.
    ingest_drains: HashMap<String, oneshot::Receiver<()>>,
    retired: Vec<(u64, String)>,
    policy: BokehReplacementPolicy,
}

impl Inner {
    fn live_blob_refs(&self) -> BTreeSet<String> {
        self.sessions
            .values()
            .flat_map(AgentSession::blob_refs)
            .collect()
    }
}

#[derive(Clone)]
pub(crate) struct BokehSessionStore {
    inner: Arc<StdMutex<Inner>>,
    waker: Arc<StdMutex<Option<KeyedDocWaker>>>,
    /// `None` only in tests, where every session is accepted.
    availability: Option<KeyedDocAvailability>,
    started: Instant,
    #[cfg(test)]
    clock_offset_ms: Arc<std::sync::atomic::AtomicU64>,
}

#[cfg(test)]
impl Default for BokehSessionStore {
    fn default() -> Self {
        Self::with_policy(BokehReplacementPolicy::default())
    }
}

impl BokehSessionStore {
    /// The agent's store: sessions exist only while the coordinator routes
    /// `bokeh_session` (`availability`).
    pub(crate) fn new(policy: BokehReplacementPolicy, availability: KeyedDocAvailability) -> Self {
        Self::build(policy, Some(availability))
    }

    /// A store that accepts every session, for tests.
    #[cfg(test)]
    pub(crate) fn with_policy(policy: BokehReplacementPolicy) -> Self {
        Self::build(policy, None)
    }

    fn build(policy: BokehReplacementPolicy, availability: Option<KeyedDocAvailability>) -> Self {
        Self {
            inner: Arc::new(StdMutex::new(Inner {
                sessions: HashMap::new(),
                forwarder: None,
                kernel: None,
                ingest_drains: HashMap::new(),
                retired: Vec::new(),
                policy,
            })),
            waker: Arc::new(StdMutex::new(None)),
            availability,
            started: Instant::now(),
            #[cfg(test)]
            clock_offset_ms: Arc::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether a display output may start a live session. Without a
    /// coordinator that routes `bokeh_session` nobody could sync the
    /// document, so the output stays static.
    pub(crate) fn accepts_sessions(&self) -> bool {
        self.availability
            .as_ref()
            .is_none_or(|availability| availability.is_available(BOKEH_SESSION_KIND))
    }

    pub(crate) fn contains(&self, session_id: &str) -> bool {
        self.lock().sessions.contains_key(session_id)
    }

    /// Wake the agent's outbound keyed-document arm.
    pub(crate) fn kick(&self) {
        if let Some(waker) = self
            .waker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            waker.wake();
        }
    }

    /// Monotonic milliseconds for the replacement tracker.
    pub(crate) fn now_ms(&self) -> u64 {
        let now = self.started.elapsed().as_millis() as u64;
        #[cfg(test)]
        let now = now
            + self
                .clock_offset_ms
                .load(std::sync::atomic::Ordering::Relaxed);
        now
    }

    #[cfg(test)]
    pub(crate) fn advance_clock_for_test(&self, ms: u64) {
        self.clock_offset_ms
            .fetch_add(ms, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn set_forwarder(
        &self,
        forwarder: Option<mpsc::UnboundedSender<BokehForeignForward>>,
    ) {
        self.lock().forwarder = forwarder.map(BokehKernelOutbox::tap_for_test);
    }

    /// Bind a launched kernel: its outbox receives foreign property changes
    /// and one-off events, its requester serves fold and close requests, and
    /// `ingest_drained` resolves once its ingest has stopped.
    pub(crate) fn attach_kernel(
        &self,
        kernel_id: &str,
        requester: BokehKernelRequester,
        outbox: BokehKernelOutbox,
        ingest_drained: oneshot::Receiver<()>,
    ) {
        let mut inner = self.lock();
        inner.forwarder = Some(outbox);
        inner.kernel = Some(KernelBinding {
            kernel_id: kernel_id.to_string(),
            requester,
        });
        inner
            .ingest_drains
            .retain(|_, drained| matches!(drained.try_recv(), Err(TryRecvError::Empty)));
        inner
            .ingest_drains
            .insert(kernel_id.to_string(), ingest_drained);
    }

    /// Undo [`Self::attach_kernel`] unless a newer kernel already replaced
    /// the binding.
    pub(crate) fn detach_kernel(&self, kernel_id: &str, outbox: &BokehKernelOutbox) {
        let mut inner = self.lock();
        if inner
            .forwarder
            .as_ref()
            .is_some_and(|current| current.same(outbox))
        {
            inner.forwarder = None;
        }
        if inner
            .kernel
            .as_ref()
            .is_some_and(|binding| binding.kernel_id == kernel_id)
        {
            inner.kernel = None;
        }
    }

    /// The outbox of `kernel_id`, if that kernel is bound.
    pub(crate) fn outbox(&self, kernel_id: &str) -> Option<BokehKernelOutbox> {
        let inner = self.lock();
        inner
            .kernel
            .as_ref()
            .filter(|binding| binding.kernel_id == kernel_id)
            .and(inner.forwarder.clone())
    }

    /// Wait until `kernel_id`'s ingest has applied the deltas it received
    /// before it stopped (bounded by [`INGEST_DRAIN_TIMEOUT`]).
    pub(crate) async fn ingest_drained(&self, kernel_id: &str) {
        let drained = self.lock().ingest_drains.remove(kernel_id);
        if let Some(drained) = drained {
            let _ = drained.await;
        }
    }

    /// The requester of `kernel_id`, if that kernel is bound.
    pub(crate) fn requester(&self, kernel_id: &str) -> Option<BokehKernelRequester> {
        self.lock()
            .kernel
            .as_ref()
            .filter(|binding| binding.kernel_id == kernel_id)
            .map(|binding| binding.requester.clone())
    }

    /// Adopt a freshly built epoch document. A known session is left alone so
    /// a repeated display message cannot rewind it, and nothing is adopted
    /// while the coordinator does not route `bokeh_session`.
    pub(crate) fn insert(
        &self,
        session_id: &str,
        mut doc: BokehSessionDoc,
        kernel_id: &str,
        kernel_actor: &str,
    ) -> bool {
        if !self.accepts_sessions() {
            debug!("[bokeh-session] Not adopting {session_id}: the coordinator does not route bokeh_session");
            return false;
        }
        let now = self.now_ms();
        let mut inner = self.lock();
        if inner.sessions.contains_key(session_id) {
            return false;
        }
        let tracker = BokehReplacementTracker::start(&mut doc, inner.policy, now);
        inner.sessions.insert(
            session_id.to_string(),
            AgentSession {
                doc,
                kernel_id: kernel_id.to_string(),
                kernel_actor: kernel_actor.to_string(),
                tracker,
                tails: HashMap::new(),
                folds_pending: HashMap::new(),
            },
        );
        drop(inner);
        self.kick();
        true
    }

    /// How column blobs for this session must encode inlined buffers.
    pub(crate) fn bytes_encoding(&self, session_id: &str) -> BytesEncoding {
        let version = self
            .lock()
            .sessions
            .get(session_id)
            .and_then(|session| session.doc.read_meta())
            .map(|meta| meta.bokeh_version)
            .unwrap_or_default();
        BytesEncoding::for_bokeh_version(&version)
    }

    #[cfg(test)]
    pub(crate) fn epoch(&self, session_id: &str) -> Option<u64> {
        self.lock()
            .sessions
            .get(session_id)
            .and_then(|session| session.doc.epoch())
    }

    #[cfg(test)]
    pub(crate) fn with_doc<R>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut BokehSessionDoc) -> R,
    ) -> Option<R> {
        self.lock()
            .sessions
            .get_mut(session_id)
            .map(|session| f(&mut session.doc))
    }

    /// Apply one coalesced flush as one change and return the broadcasts it
    /// produced, stamped with the session's epoch.
    pub(crate) fn commit_flush(
        &self,
        flush: PreparedFlush,
    ) -> anyhow::Result<Vec<BokehSessionEvents>> {
        let now = self.now_ms();
        let mut inner = self.lock();
        let Inner {
            sessions, retired, ..
        } = &mut *inner;
        let session = sessions
            .get_mut(&flush.session_id)
            .ok_or_else(|| anyhow::anyhow!("unknown Bokeh session {}", flush.session_id))?;
        let epoch = session.doc.epoch().unwrap_or_default();

        let mut delta = BokehSessionDocDelta {
            models_added: flush.models_added,
            models_removed: flush.models_removed.iter().cloned().collect(),
            ..Default::default()
        };
        if let Some(patch) = &flush.meta {
            let mut meta = session.doc.read_meta().unwrap_or_default();
            patch.apply(&mut meta);
            delta.meta = Some(meta);
        }
        // Deltas may name models a later removal in the same flush dropped.
        delta.props_changed = flush
            .props_changed
            .into_iter()
            .filter(|(id, _)| {
                (session.doc.has_model(id) || delta.models_added.contains_key(id))
                    && !flush.models_removed.contains(id)
            })
            .collect();

        let current_columns = session.doc.read_columns();
        let mut columns_before: BTreeSet<String> = BTreeSet::new();
        let mut broadcasts = EventsBuilder::new(&flush.session_id, epoch);
        for op in flush.data_ops {
            match op {
                DataOp::Event {
                    transaction_id,
                    source_id,
                    event,
                    buffers,
                    bytes,
                } => {
                    broadcasts.push_data(&transaction_id, event.clone(), &buffers);
                    let tail = session.tails.entry(source_id).or_default();
                    tail.buffer_blobs
                        .extend(buffers.iter().map(|buffer| buffer.blob.clone()));
                    tail.bytes += bytes;
                    tail.events.push(BokehSessionEvents {
                        session_id: flush.session_id.clone(),
                        epoch,
                        transaction_id,
                        data_events: vec![event],
                        messages: Vec::new(),
                        buffers,
                    });
                }
                DataOp::Fold { source_id, columns } => {
                    if let Some(existing) = current_columns.get(&source_id) {
                        columns_before.extend(existing.values().map(|c| c.blob.clone()));
                        let stale: Vec<String> = existing
                            .keys()
                            .filter(|name| !columns.contains_key(*name))
                            .cloned()
                            .collect();
                        if !stale.is_empty() {
                            delta.columns_removed.insert(source_id.clone(), stale);
                        }
                    }
                    retire_tail(session.tails.remove(&source_id), now, retired);
                    session.folds_pending.remove(&source_id);
                    delta.columns_changed.insert(source_id, columns);
                }
                DataOp::Replace {
                    transaction_id,
                    source_id,
                    base_version,
                    new_version,
                    columns,
                    removed,
                } => {
                    if let Some(existing) = current_columns.get(&source_id) {
                        columns_before.extend(existing.values().map(|c| c.blob.clone()));
                    }
                    broadcasts.push_data(
                        &transaction_id,
                        json!({
                            "kind": "ColumnDataChanged",
                            "source_id": source_id,
                            "base_version": base_version,
                            "new_version": new_version,
                            "columns": columns,
                            "columns_removed": removed,
                        }),
                        &[],
                    );
                    retire_tail(session.tails.remove(&source_id), now, retired);
                    if !removed.is_empty() {
                        delta.columns_removed.insert(source_id.clone(), removed);
                    }
                    delta.columns_changed.insert(source_id, columns);
                }
            }
        }
        for id in &flush.models_removed {
            if let Some(existing) = current_columns.get(id) {
                columns_before.extend(existing.values().map(|c| c.blob.clone()));
            }
            retire_tail(session.tails.remove(id), now, retired);
            // The kernel cannot fold a removed source, so no delta will clear it.
            session.folds_pending.remove(id);
        }
        for message in flush.messages {
            broadcasts.push_message(message, &flush.message_buffers);
        }

        let applied = session.doc.apply_delta(&delta);
        // Ops applied before an error are valid kernel state; keep them.
        session.doc.commit();
        let referenced = session.blob_refs();
        // Content addressing can make a retired hash current again; its
        // grace period restarts when it is next superseded.
        retired.retain(|(_, blob)| !referenced.contains(blob));
        retired.extend(
            columns_before
                .into_iter()
                .filter(|blob| !referenced.contains(blob))
                .map(|blob| (now, blob)),
        );
        drop(inner);
        self.kick();
        applied.map_err(|error| anyhow::anyhow!("apply Bokeh delta: {error}"))?;
        Ok(broadcasts.finish())
    }

    /// Blobs retired at least `RETIRED_BLOB_GRACE_MS` ago, to free if
    /// ephemeral. Content addressing lets any session reference a retired
    /// hash again, so blobs still live anywhere in the store are dropped
    /// from the list instead of returned.
    pub(crate) fn take_expired_retired(&self, now_ms: u64) -> Vec<String> {
        let mut inner = self.lock();
        let (expired, kept): (Vec<_>, Vec<_>) = inner
            .retired
            .drain(..)
            .partition(|(at, _)| now_ms.saturating_sub(*at) >= RETIRED_BLOB_GRACE_MS);
        inner.retired = kept;
        if expired.is_empty() {
            return Vec::new();
        }
        let live = inner.live_blob_refs();
        let mut seen = BTreeSet::new();
        expired
            .into_iter()
            .map(|(_, blob)| blob)
            .filter(|blob| !live.contains(blob) && seen.insert(blob.clone()))
            .collect()
    }

    /// Every blob a session in this store still references: column refs,
    /// offloaded property values and retained tail buffers.
    #[cfg(test)]
    pub(crate) fn live_blob_refs(&self) -> BTreeSet<String> {
        self.lock().live_blob_refs()
    }

    /// Replace every document whose history passed the replacement rule,
    /// forwarding all foreign-won properties to the kernel first: the new
    /// document authors every value under the kernel actor.
    pub(crate) fn replace_due(&self) -> anyhow::Result<Vec<BokehReplacementRecord>> {
        let now = self.now_ms();
        let mut inner = self.lock();
        let Inner {
            sessions,
            forwarder,
            policy,
            ..
        } = &mut *inner;
        let mut records = Vec::new();
        for (session_id, session) in sessions.iter_mut() {
            if !session.tracker.is_due(&mut session.doc, now) {
                continue;
            }
            let all_props = BokehSessionChangeset {
                props_changed: session
                    .doc
                    .model_ids()
                    .into_iter()
                    .filter_map(|id| {
                        let names = session.doc.read_model(&id)?.props.into_keys().collect();
                        Some((id, names))
                    })
                    .collect(),
                ..Default::default()
            };
            let foreign = session
                .doc
                .foreign_props(&all_props, |actor| session.is_foreign(actor));
            forward(forwarder.as_ref(), session_id, foreign);

            let replacement = session
                .doc
                .build_replacement(&session.kernel_actor)
                .map_err(|error| anyhow::anyhow!("replace Bokeh session {session_id}: {error}"))?;
            session.doc = replacement.doc;
            session.tracker = BokehReplacementTracker::start(&mut session.doc, *policy, now);
            // A fold deferred across the replacement may never be needed in
            // the new epoch; let readers ask again.
            session.folds_pending.clear();
            records.push(BokehReplacementRecord {
                session_id: session_id.clone(),
                epoch: replacement.epoch,
                doc_heads: hex_heads(&session.doc.get_heads()),
                previous_heads: hex_heads(&replacement.previous_heads),
            });
        }
        drop(inner);
        if !records.is_empty() {
            self.kick();
        }
        Ok(records)
    }

    /// Outbound `0x0b` payloads for every session that has something to send.
    pub(crate) fn generate_frames(&self, states: &mut KeyedSyncStates) -> Vec<Vec<u8>> {
        let mut inner = self.lock();
        states.retain(|key| key.kind != BOKEH_SESSION_KIND || inner.sessions.contains_key(&key.id));
        let mut frames = Vec::new();
        for (session_id, session) in inner.sessions.iter_mut() {
            let epoch = session.doc.epoch().unwrap_or_default();
            if let Some(frame) = generate(session_id, epoch, &mut session.doc, states) {
                frames.push(frame);
            }
        }
        frames
    }

    /// A whole `0x0b` payload, header included; tests drive the store
    /// without `AgentDocs` through this.
    #[cfg(test)]
    pub(crate) fn receive_payload(
        &self,
        payload: &[u8],
        states: &mut KeyedSyncStates,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let (header, body) = KeyedDocFrameHeader::try_parse(payload)?;
        let message = sync::Message::decode(body)
            .map_err(|error| anyhow::anyhow!("decode Bokeh session sync: {error}"))?;
        self.receive_sync(&header, message, states)
    }

    /// Apply a frame from the room. Foreign property changes are forwarded to
    /// the kernel before the lock is released. Returns the reply frame.
    pub(crate) fn receive_sync(
        &self,
        header: &KeyedDocFrameHeader,
        message: sync::Message,
        states: &mut KeyedSyncStates,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        if header.kind != BOKEH_SESSION_KIND {
            return Ok(None);
        }
        let mut inner = self.lock();
        let Inner {
            sessions,
            forwarder,
            ..
        } = &mut *inner;
        let session_id = header.id.as_str();
        let Some(session) = sessions.get_mut(session_id) else {
            debug!("[bokeh-session] Dropping frame for unknown session {session_id}");
            return Ok(None);
        };
        let epoch = session.doc.epoch().unwrap_or_default();
        if header.epoch != epoch {
            debug!(
                "[bokeh-session] Dropping frame for epoch {} of {session_id} (current {epoch})",
                header.epoch
            );
            return Ok(None);
        }
        let state = states.for_epoch(&session_key(session_id), epoch);
        let before = session.doc.get_heads();
        let kernel_actor = session.kernel_actor.clone();
        let view = session
            .doc
            .receive_sync_and_foreign_props(state, message, |actor| {
                actor.to_bytes() != kernel_actor.as_bytes()
            })?;
        let mut changed = BTreeMap::new();
        for (model, props) in view.foreign_props {
            for (name, value) in props {
                if session.doc.get_prop_at(&model, &name, &before).as_deref() != Some(&value) {
                    changed
                        .entry(model.clone())
                        .or_insert_with(BTreeMap::new)
                        .insert(name, value);
                }
            }
        }
        forward(forwarder.as_ref(), session_id, changed);
        let reply = generate(session_id, epoch, &mut session.doc, states);
        drop(inner);
        if !view.changeset.is_empty() {
            self.kick();
        }
        Ok(reply)
    }

    /// The tail since each source's last fold. Sources whose tail outgrew
    /// their fold are left out and returned for an on-demand fold.
    pub(crate) fn data_tail(
        &self,
        session_id: &str,
        source_ids: Option<&[String]>,
    ) -> Option<BokehSessionDataTail> {
        let inner = self.lock();
        let session = inner.sessions.get(session_id)?;
        let columns = session.doc.read_columns();
        let mut tail = BokehSessionDataTail {
            session_id: session_id.to_string(),
            epoch: session.doc.epoch().unwrap_or_default(),
            ..Default::default()
        };
        let mut sources: Vec<&String> = session.tails.keys().collect();
        sources.sort();
        for source_id in sources {
            if source_ids.is_some_and(|ids| !ids.contains(source_id)) {
                continue;
            }
            let source = &session.tails[source_id];
            let fold_size: u64 = columns
                .get(source_id)
                .map(|cols| cols.values().map(|c| c.size).sum())
                .unwrap_or(0);
            if fold_size > 0 && source.bytes as u64 > fold_size {
                tail.fold_requested.push(source_id.clone());
            } else {
                tail.events.extend(source.events.iter().cloned());
            }
        }
        Some(tail)
    }

    /// Mark folds as requested from the kernel and return the sources that
    /// had none pending, or only an expired deferred one, which the caller
    /// must request.
    pub(crate) fn claim_folds(&self, session_id: &str, sources: &[String]) -> Vec<String> {
        let now = self.now_ms();
        let mut inner = self.lock();
        let Some(session) = inner.sessions.get_mut(session_id) else {
            return Vec::new();
        };
        sources
            .iter()
            .filter(|source| {
                let free = match session.folds_pending.get(*source) {
                    None => true,
                    Some(None) => false,
                    Some(Some(deferred_at)) => {
                        now.saturating_sub(*deferred_at) >= FOLD_CLAIM_TTL_MS
                    }
                };
                if free {
                    session.folds_pending.insert((*source).clone(), None);
                }
                free
            })
            .cloned()
            .collect()
    }

    /// Keep claims the kernel deferred until their `ColumnsFolded` lands,
    /// the source is removed, the epoch is replaced or
    /// [`FOLD_CLAIM_TTL_MS`] passes.
    pub(crate) fn defer_folds(&self, session_id: &str, sources: &[String]) {
        let now = self.now_ms();
        if let Some(session) = self.lock().sessions.get_mut(session_id) {
            for source in sources {
                // The fold delta may have landed before the reply and ended
                // the claim already.
                if let Some(claim) = session.folds_pending.get_mut(source) {
                    *claim = Some(now);
                }
            }
        }
    }

    /// End claims the kernel answered without deferring, or failed.
    pub(crate) fn release_folds(&self, session_id: &str, sources: &[String]) {
        if let Some(session) = self.lock().sessions.get_mut(session_id) {
            for source in sources {
                session.folds_pending.remove(source);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn folds_pending(&self, session_id: &str) -> Vec<String> {
        let inner = self.lock();
        let mut pending: Vec<String> = inner
            .sessions
            .get(session_id)
            .map(|session| session.folds_pending.keys().cloned().collect())
            .unwrap_or_default();
        pending.sort();
        pending
    }

    /// Drop a kernel's sessions, returning their final state, tails
    /// included, to freeze. The tail buffers stay readable for the grace
    /// period, long enough for the caller to materialize them.
    pub(crate) fn remove_kernel_sessions(
        &self,
        kernel_id: &str,
    ) -> Vec<(String, SnapshotWithTail)> {
        self.remove_sessions_where(|session| session.kernel_id == kernel_id)
    }

    /// Drop every session, returning each final state to freeze, as
    /// [`Self::remove_kernel_sessions`] does for one kernel.
    pub(crate) fn remove_all_sessions(&self) -> Vec<(String, SnapshotWithTail)> {
        self.remove_sessions_where(|_| true)
    }

    fn remove_sessions_where(
        &self,
        matches: impl Fn(&AgentSession) -> bool,
    ) -> Vec<(String, SnapshotWithTail)> {
        let now = self.now_ms();
        let mut inner = self.lock();
        let Inner {
            sessions, retired, ..
        } = &mut *inner;
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| matches(session))
            .map(|(id, _)| id.clone())
            .collect();
        let mut removed = Vec::new();
        for id in ids {
            if let Some(mut session) = sessions.remove(&id) {
                match session.snapshot_with_tail() {
                    Ok(state) => removed.push((id, state)),
                    Err(error) => warn!("[bokeh-session] Cannot freeze session {id}: {error}"),
                }
                for (_, tail) in session.tails.drain() {
                    retire_tail(Some(tail), now, retired);
                }
            }
        }
        removed
    }

    /// Drop sessions whose record is no longer connected, without freezing:
    /// whoever ended the record (the room, on losing this agent's
    /// connection) already froze it. Returns the dropped ids.
    pub(crate) fn drop_unconnected_sessions(&self, state: &RuntimeStateHandle) -> Vec<String> {
        let ids: Vec<String> = self.lock().sessions.keys().cloned().collect();
        if ids.is_empty() {
            return ids;
        }
        let stale: Vec<String> = state
            .read(|doc| {
                ids.into_iter()
                    .filter(|id| {
                        doc.get_bokeh_session(id)
                            .is_some_and(|record| record.status != BokehSessionStatus::Connected)
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.remove_sessions(&stale);
        stale
    }

    pub(crate) fn remove_sessions(&self, session_ids: &[String]) {
        let now = self.now_ms();
        let mut inner = self.lock();
        let Inner {
            sessions, retired, ..
        } = &mut *inner;
        for id in session_ids {
            if let Some(mut session) = sessions.remove(id) {
                for (_, tail) in session.tails.drain() {
                    retire_tail(Some(tail), now, retired);
                }
            }
        }
    }
}

fn session_key(session_id: &str) -> KeyedDocKey {
    KeyedDocKey::new(BOKEH_SESSION_KIND, session_id)
}

fn generate(
    session_id: &str,
    epoch: u64,
    doc: &mut BokehSessionDoc,
    states: &mut KeyedSyncStates,
) -> Option<Vec<u8>> {
    let state = states.for_epoch(&session_key(session_id), epoch);
    let message = doc.generate_sync_message(state)?;
    Some(
        KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, session_id, epoch)
            .encode_frame(&message.encode()),
    )
}

impl AgentKeyedDoc for BokehSessionStore {
    fn kind(&self) -> &'static str {
        BOKEH_SESSION_KIND
    }

    fn attach(&self, waker: KeyedDocWaker) {
        *self
            .waker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(waker);
    }

    fn generate_frames(&self, states: &mut KeyedSyncStates) -> Vec<Vec<u8>> {
        BokehSessionStore::generate_frames(self, states)
    }

    fn receive_frame(
        &self,
        header: &KeyedDocFrameHeader,
        message: sync::Message,
        states: &mut KeyedSyncStates,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        self.receive_sync(header, message, states)
    }
}

fn forward(
    forwarder: Option<&BokehKernelOutbox>,
    session_id: &str,
    props: BTreeMap<String, BTreeMap<String, String>>,
) {
    let changes: Vec<(String, String, String)> = props
        .into_iter()
        .flat_map(|(model, props)| {
            props
                .into_iter()
                .map(move |(name, value)| (model.clone(), name, value))
        })
        .collect();
    if changes.is_empty() {
        return;
    }
    let Some(forwarder) = forwarder else {
        warn!("[bokeh-session] No kernel to forward {session_id} property changes to");
        return;
    };
    forwarder.forward_props(session_id, changes);
}

fn retire_tail(tail: Option<SourceTail>, now: u64, retired: &mut Vec<(u64, String)>) {
    if let Some(tail) = tail {
        retired.extend(tail.buffer_blobs.into_iter().map(|blob| (now, blob)));
    }
}

/// Groups one-off events into broadcasts, one per consecutive transaction.
struct EventsBuilder {
    session_id: String,
    epoch: u64,
    out: Vec<BokehSessionEvents>,
}

impl EventsBuilder {
    fn new(session_id: &str, epoch: u64) -> Self {
        Self {
            session_id: session_id.to_string(),
            epoch,
            out: Vec::new(),
        }
    }

    fn current(&mut self, transaction_id: &str) -> &mut BokehSessionEvents {
        let continues = self
            .out
            .last()
            .is_some_and(|last| last.transaction_id == transaction_id);
        if !continues {
            self.out.push(BokehSessionEvents {
                session_id: self.session_id.clone(),
                epoch: self.epoch,
                transaction_id: transaction_id.to_string(),
                ..Default::default()
            });
        }
        let last = self.out.len() - 1;
        &mut self.out[last]
    }

    fn push_data(&mut self, transaction_id: &str, event: Value, buffers: &[BokehSessionBufferRef]) {
        let events = self.current(transaction_id);
        events.data_events.push(event);
        events.buffers.extend(buffers.iter().cloned());
    }

    fn push_message(&mut self, message: Tagged, buffers: &[BokehSessionBufferRef]) {
        let mut ids = BTreeSet::new();
        collect_buffer_ids(&message.value, &mut ids);
        let events = self.current(&message.transaction_id);
        events.messages.push(message.value);
        events.buffers.extend(
            buffers
                .iter()
                .filter(|buffer| ids.contains(&buffer.id))
                .cloned(),
        );
    }

    fn finish(self) -> Vec<BokehSessionEvents> {
        self.out
    }
}

fn collect_buffer_ids(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(id) = map
                .get("data")
                .and_then(|data| data.get("id"))
                .and_then(Value::as_str)
                .filter(|_| map.get("type").and_then(Value::as_str) == Some("bytes"))
            {
                out.insert(id.to_string());
            }
            map.values()
                .for_each(|value| collect_buffer_ids(value, out));
        }
        Value::Array(items) => items.iter().for_each(|item| collect_buffer_ids(item, out)),
        _ => {}
    }
}

/// What the ingest task needs besides the store.
pub(crate) struct IngestContext {
    pub(crate) store: BokehSessionStore,
    pub(crate) blob_store: Arc<BlobStore>,
    pub(crate) blob_publisher: OutputBlobPublisher,
    pub(crate) state: RuntimeStateHandle,
    pub(crate) broadcast_tx: broadcast::Sender<NotebookBroadcast>,
    pub(crate) kernel_actor_id: String,
}

/// Coalesce kernel deltas (`nteract_bokeh_delta` from IOPub) per session and
/// apply each window as one change. On `stop` (or when every sender is gone)
/// the deltas already received are applied within [`INGEST_DRAIN_TIMEOUT`].
pub(crate) async fn run_ingest(
    mut rx: mpsc::UnboundedReceiver<RawIopubMessage>,
    ctx: IngestContext,
    mut stop: oneshot::Receiver<()>,
) {
    let mut pending: Vec<KernelDelta> = Vec::new();
    let mut flush_tick = tokio::time::interval(INGEST_FLUSH_INTERVAL);
    flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut replacement_tick = tokio::time::interval(REPLACEMENT_CHECK_INTERVAL);
    replacement_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            raw = rx.recv() => {
                let Some(raw) = raw else { break };
                queue_delta(&mut pending, raw);
            }
            // A dropped sender counts as a stop.
            _ = &mut stop => break,
            _ = flush_tick.tick(), if !pending.is_empty() => {
                for delta in std::mem::take(&mut pending) {
                    flush_delta(delta, &ctx).await;
                }
                apply_replacements(&ctx);
                free_retired(&ctx).await;
            }
            _ = replacement_tick.tick() => {
                apply_replacements(&ctx);
                free_retired(&ctx).await;
            }
        }
    }
    rx.close();
    let drain = async {
        while let Some(raw) = rx.recv().await {
            queue_delta(&mut pending, raw);
        }
        for delta in pending {
            flush_delta(delta, &ctx).await;
        }
    };
    if tokio::time::timeout(INGEST_DRAIN_TIMEOUT, drain)
        .await
        .is_err()
    {
        warn!("[bokeh-session] Gave up applying the final kernel deltas");
    }
}

fn queue_delta(pending: &mut Vec<KernelDelta>, raw: RawIopubMessage) {
    match KernelDelta::parse(&raw.content, &raw.buffers) {
        Ok(delta) => match pending
            .iter_mut()
            .find(|p| p.session_id == delta.session_id)
        {
            Some(existing) => existing.merge(delta),
            None => pending.push(delta),
        },
        Err(error) => warn!("[bokeh-session] Dropping malformed delta: {error}"),
    }
}

pub(crate) async fn flush_delta(delta: KernelDelta, ctx: &IngestContext) {
    let session_id = delta.session_id.clone();
    // Static outputs (no coordinator routing, or a retired session) have no
    // document; storing their blobs would only leak them.
    if !ctx.store.contains(&session_id) {
        debug!("[bokeh-session] Dropping delta for {session_id}: no live session");
        return;
    }
    let sink = BlobSink::new(&ctx.blob_store, &ctx.blob_publisher);
    let encoding = ctx.store.bytes_encoding(&session_id);
    let flush = match prepare_flush(delta, encoding, &sink).await {
        Ok(flush) => flush,
        Err(error) => {
            warn!("[bokeh-session] Failed to store delta for {session_id}: {error}");
            return;
        }
    };
    match ctx.store.commit_flush(flush) {
        Ok(broadcasts) => {
            for events in broadcasts {
                let _ = ctx
                    .broadcast_tx
                    .send(NotebookBroadcast::BokehSessionEvents {
                        events: Box::new(events),
                    });
            }
        }
        Err(error) => warn!("[bokeh-session] Failed to apply delta for {session_id}: {error}"),
    }
}

pub(crate) fn apply_replacements(ctx: &IngestContext) {
    let records = match ctx.store.replace_due() {
        Ok(records) => records,
        Err(error) => {
            warn!("[bokeh-session] {error}");
            return;
        }
    };
    let mut stale = Vec::new();
    for record in records {
        let result = ctx.state.transact_at_current_heads(
            Some(&ctx.kernel_actor_id),
            "runtime-state-bokeh-epoch",
            |doc| {
                let Some(mut session) = doc.get_bokeh_session(&record.session_id) else {
                    return Ok(());
                };
                // The room froze or closed it (e.g. across an agent
                // reconnect); a stale replica must not revive the record.
                if session.status != BokehSessionStatus::Connected {
                    stale.push(record.session_id.clone());
                    return Ok(());
                }
                session.epoch = record.epoch;
                session.doc_heads = record.doc_heads.clone();
                session.previous_heads = record.previous_heads.clone();
                doc.put_bokeh_session(&record.session_id, &session)
            },
        );
        if let Err(error) = result {
            warn!(
                "[bokeh-session] Failed to publish epoch {} of {}: {error}",
                record.epoch, record.session_id
            );
        }
    }
    ctx.store.remove_sessions(&stale);
}

async fn free_retired(ctx: &IngestContext) {
    for blob in ctx.store.take_expired_retired(ctx.store.now_ms()) {
        if let Err(error) = ctx.blob_store.delete_if_ephemeral(&blob).await {
            debug!("[bokeh-session] Could not free retired blob {blob}: {error}");
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bokeh_session::hex_sha256;
    use crate::bokeh_session::ingest::tests::wire_delta;
    use runtime_doc::{BokehModelState, BokehSessionMeta, BokehSessionSnapshot};

    pub(crate) const KERNEL: &str = "rt:kernel:test";

    pub(crate) fn snapshot() -> BokehSessionSnapshot {
        let model = |type_name: &str, ref_props: &[&str], props: &[(&str, &str)]| BokehModelState {
            type_name: type_name.into(),
            ref_props: ref_props.iter().map(|s| s.to_string()).collect(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        };
        BokehSessionSnapshot {
            epoch: 0,
            meta: BokehSessionMeta {
                session_id: "session-1".into(),
                producer_name: "panel".into(),
                producer_version: "1.9.4".into(),
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: Some("Page".into()),
                doc_extras: None,
            },
            models: BTreeMap::from([
                (
                    "p1".to_string(),
                    model(
                        "Row",
                        &["children"],
                        &[("children", r#"[{"id":"p2"},{"id":"p3"}]"#)],
                    ),
                ),
                (
                    "p2".to_string(),
                    model("Slider", &[], &[("value", "0.5"), ("title", r#""Alpha""#)]),
                ),
                (
                    "p3".to_string(),
                    model("ColumnDataSource", &["selected"], &[]),
                ),
            ]),
            columns: BTreeMap::new(),
        }
    }

    pub(crate) fn store_with_session() -> BokehSessionStore {
        let store = BokehSessionStore::default();
        let doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        assert!(store.insert("session-1", doc, "kernel-1", KERNEL));
        store
    }

    pub(crate) async fn flush(
        store: &BokehSessionStore,
        blobs: &BlobStore,
        content: Value,
        buffers: &[Vec<u8>],
    ) -> Vec<BokehSessionEvents> {
        let publisher = OutputBlobPublisher::none();
        let delta = KernelDelta::parse(&content, buffers).unwrap();
        let encoding = store.bytes_encoding(&delta.session_id);
        let prepared = prepare_flush(delta, encoding, &BlobSink::new(blobs, &publisher))
            .await
            .unwrap();
        store.commit_flush(prepared).unwrap()
    }

    /// Sync the store to a fresh peer replica through frame payloads.
    pub(crate) fn sync_peer(
        store: &BokehSessionStore,
        store_states: &mut KeyedSyncStates,
        peer: &mut BokehSessionDoc,
        peer_state: &mut sync::State,
        epoch: u64,
    ) {
        for _ in 0..16 {
            let mut progressed = false;
            for frame in store.generate_frames(store_states) {
                let (_, body) = KeyedDocFrameHeader::try_parse(&frame).unwrap();
                peer.receive_sync_message(peer_state, sync::Message::decode(body).unwrap())
                    .unwrap();
                progressed = true;
            }
            if let Some(message) = peer.generate_sync_message(peer_state) {
                let frame = KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "session-1", epoch)
                    .encode_frame(&message.encode());
                if let Some(reply) = store.receive_payload(&frame, store_states).unwrap() {
                    let (_, body) = KeyedDocFrameHeader::try_parse(&reply).unwrap();
                    peer.receive_sync_message(peer_state, sync::Message::decode(body).unwrap())
                        .unwrap();
                }
                progressed = true;
            }
            if !progressed {
                return;
            }
        }
    }

    #[tokio::test]
    async fn delta_ingest_merges_meta_offloads_values_and_tracks_tail() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = store_with_session();
        let data = vec![9u8; 8];
        let long_title = format!("\"{}\"", "t".repeat(2000));
        let broadcasts = flush(
            &store,
            &blobs,
            wire_delta(
                "tx-1",
                json!({
                    "meta": {"root_ids": ["p1", "p9"]},
                    "models_added": {"p9": {"type": "Div", "ref_props": [], "props": {"text": "hi"}}},
                    "props_changed": {"p2": {"value": 0.75, "title": long_title}},
                    "data_events": [{
                        "kind": "ColumnsStreamed", "source_id": "p3", "base_version": 0, "new_version": 1,
                        "data": {"type": "map", "entries": [["x", {"type": "bytes", "data": {"id": "b1"}}]]},
                        "rollover": null,
                    }],
                    "messages": [{"msg_type": "toast", "msg_data": {}}],
                    "buffers": [{"id": "b1", "hash": hex_sha256(&data), "size": 8, "buffer_index": 0}],
                }),
            ),
            std::slice::from_ref(&data),
        )
        .await;

        store.with_doc("session-1", |doc| {
            let meta = doc.read_meta().unwrap();
            assert_eq!(meta.root_ids, vec!["p1", "p9"]);
            assert_eq!(
                meta.title.as_deref(),
                Some("Page"),
                "partial meta keeps other fields"
            );
            assert_eq!(meta.producer_name, "panel");
            assert_eq!(doc.get_prop("p2", "value").as_deref(), Some("0.75"));
            assert!(
                runtime_doc::BokehBlobRef::parse(&doc.get_prop("p2", "title").unwrap()).is_some()
            );
            assert_eq!(doc.get_prop("p9", "text").as_deref(), Some(r#""hi""#));
        });
        assert_eq!(broadcasts.len(), 1);
        assert_eq!(broadcasts[0].transaction_id, "tx-1");
        assert_eq!(broadcasts[0].data_events.len(), 1);
        assert_eq!(broadcasts[0].messages.len(), 1);
        assert_eq!(broadcasts[0].buffers[0].blob, hex_sha256(&data));

        let tail = store.data_tail("session-1", None).unwrap();
        assert_eq!(tail.events.len(), 1);
        assert_eq!(tail.events[0].data_events[0]["new_version"], 1);
        assert!(tail.fold_requested.is_empty());
    }

    #[tokio::test]
    async fn folds_move_refs_and_clear_the_tail_and_oversized_tails_request_folds() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = store_with_session();
        let stream = |base: u64, payload: &str| {
            json!({
                "kind": "ColumnsStreamed", "source_id": "p3", "base_version": base,
                "new_version": base + 1,
                "data": {"type": "map", "entries": [["x", [payload]]]}, "rollover": null,
            })
        };
        flush(
            &store,
            &blobs,
            wire_delta(
                "tx-0",
                json!({"data_events": [{"kind": "ColumnsFolded", "source_id": "p3", "version": 0,
                                         "columns": {"x": [1], "y": [2]}}]}),
            ),
            &[],
        )
        .await;
        let folded = store
            .with_doc("session-1", |doc| doc.read_columns())
            .unwrap();
        assert_eq!(folded["p3"]["x"].version, 0);

        flush(
            &store,
            &blobs,
            wire_delta("tx-1", json!({"data_events": [stream(0, "a")]})),
            &[],
        )
        .await;
        let tail = store
            .data_tail("session-1", Some(&["p3".to_string()]))
            .unwrap();
        assert!(tail.events.is_empty(), "the tail outgrew the fold");
        assert_eq!(tail.fold_requested, vec!["p3"]);

        // The fold drops a column the source no longer has.
        flush(
            &store,
            &blobs,
            wire_delta(
                "tx-2",
                json!({"data_events": [{"kind": "ColumnsFolded", "source_id": "p3", "version": 1,
                                         "columns": {"x": [1, "a"]}}]}),
            ),
            &[],
        )
        .await;
        let columns = store
            .with_doc("session-1", |doc| doc.read_columns())
            .unwrap();
        assert_eq!(columns["p3"].len(), 1);
        assert_eq!(columns["p3"]["x"].version, 1);
        let tail = store.data_tail("session-1", None).unwrap();
        assert!(tail.events.is_empty() && tail.fold_requested.is_empty());
    }

    #[tokio::test]
    async fn superseded_replacement_blobs_are_freed_after_the_grace_period() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = store_with_session();
        let cdc = |base: u64, value: u64| {
            json!({"kind": "ColumnDataChanged", "source_id": "p3", "base_version": base,
                   "new_version": base + 1, "columns": {"x": [value]}, "columns_removed": []})
        };
        let first = flush(
            &store,
            &blobs,
            wire_delta("tx-1", json!({"data_events": [cdc(0, 1)]})),
            &[],
        )
        .await;
        let first_blob = store
            .with_doc("session-1", |doc| {
                doc.read_columns()["p3"]["x"].blob.clone()
            })
            .unwrap();
        assert!(blobs.exists(&first_blob));
        assert_eq!(first[0].data_events[0]["columns"]["x"]["blob"], first_blob);

        flush(
            &store,
            &blobs,
            wire_delta("tx-2", json!({"data_events": [cdc(1, 2)]})),
            &[],
        )
        .await;
        assert!(
            store.take_expired_retired(store.now_ms()).is_empty(),
            "grace period"
        );
        let expired = store.take_expired_retired(store.now_ms() + RETIRED_BLOB_GRACE_MS);
        assert_eq!(expired, vec![first_blob.clone()]);
        for blob in expired {
            assert!(blobs.delete_if_ephemeral(&blob).await.unwrap());
        }
        assert!(!blobs.exists(&first_blob));
    }

    #[test]
    fn foreign_changes_forward_to_the_kernel_and_kernel_echoes_do_not() {
        let store = store_with_session();
        let (tx, mut rx) = mpsc::unbounded_channel();
        store.set_forwarder(Some(tx));
        let mut states = KeyedSyncStates::new();
        let mut peer = BokehSessionDoc::new_empty("user:dev:alice/browser");
        let mut peer_state = sync::State::new();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        assert_eq!(peer.get_prop("p2", "value").as_deref(), Some("0.5"));

        peer.set_prop("p2", "value", "0.9").unwrap();
        peer.commit();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        let forward = rx.try_recv().expect("forwarded");
        assert_eq!(forward.session_id, "session-1");
        assert_eq!(
            forward.changes,
            vec![("p2".into(), "value".into(), "0.9".into())]
        );

        // A kernel write reaching the peer and syncing back is not forwarded.
        store.with_doc("session-1", |doc| {
            doc.set_prop("p2", "value", "0.95").unwrap();
            doc.commit();
        });
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        assert_eq!(peer.get_prop("p2", "value").as_deref(), Some("0.95"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn replacement_forwards_foreign_values_then_starts_a_new_epoch() {
        let store = BokehSessionStore::with_policy(BokehReplacementPolicy {
            min_change_bytes: 0,
            saved_size_factor: 0,
            min_interval_ms: 0,
        });
        let doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        store.insert("session-1", doc, "kernel-1", KERNEL);
        let mut states = KeyedSyncStates::new();
        let mut peer = BokehSessionDoc::new_empty("user:dev:alice/browser");
        let mut peer_state = sync::State::new();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        peer.set_prop("p2", "value", "0.9").unwrap();
        peer.commit();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        let previous_heads = store
            .with_doc("session-1", |doc| hex_heads(&doc.get_heads()))
            .unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        store.set_forwarder(Some(tx));
        let records = store.replace_due().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].epoch, 1);
        assert_eq!(records[0].previous_heads, previous_heads);
        let forward = rx
            .try_recv()
            .expect("foreign values forwarded before the build");
        assert_eq!(
            forward.changes,
            vec![("p2".into(), "value".into(), "0.9".into())]
        );
        store.with_doc("session-1", |doc| {
            assert_eq!(doc.epoch(), Some(1));
            assert_eq!(doc.get_prop("p2", "value").as_deref(), Some("0.9"));
            assert_eq!(hex_heads(&doc.get_heads()), records[0].doc_heads);
        });

        // Frames for the old epoch are dropped; a fresh replica syncs epoch 1.
        let stale = KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "session-1", 0).encode_frame(
            &peer
                .generate_sync_message(&mut sync::State::new())
                .unwrap()
                .encode(),
        );
        assert!(store
            .receive_payload(&stale, &mut states)
            .unwrap()
            .is_none());
        let mut fresh = BokehSessionDoc::new_empty("user:dev:alice/browser");
        let mut fresh_state = sync::State::new();
        sync_peer(&store, &mut states, &mut fresh, &mut fresh_state, 1);
        assert_eq!(fresh.epoch(), Some(1));
        assert_eq!(fresh.get_prop("p2", "value").as_deref(), Some("0.9"));
    }

    /// Fold claims (deferred ones included) end with the epoch or the
    /// source, since no fold delta may follow; claims are per session.
    #[tokio::test]
    async fn fold_claims_end_with_the_epoch_or_the_source() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = BokehSessionStore::with_policy(BokehReplacementPolicy {
            min_change_bytes: 0,
            saved_size_factor: 0,
            min_interval_ms: 0,
        });
        let doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        store.insert("session-1", doc, "kernel-1", KERNEL);
        let claim = |sources: &[&str]| {
            let sources: Vec<String> = sources.iter().map(|s| s.to_string()).collect();
            store.claim_folds("session-1", &sources)
        };

        assert_eq!(claim(&["p3"]), ["p3"]);
        assert!(claim(&["p3"]).is_empty(), "already claimed");
        assert!(store.claim_folds("other", &["p3".into()]).is_empty());
        store.with_doc("session-1", |doc| {
            doc.set_prop("p2", "value", "0.9").unwrap();
            doc.commit();
        });
        assert_eq!(store.replace_due().unwrap().len(), 1);
        assert!(store.folds_pending("session-1").is_empty());

        assert_eq!(claim(&["p3"]), ["p3"]);
        flush(
            &store,
            &blobs,
            wire_delta("tx-1", json!({"models_removed": ["p3"]})),
            &[],
        )
        .await;
        assert!(store.folds_pending("session-1").is_empty());
    }

    #[test]
    fn test_replacement_policy_parses_bytes_and_optional_interval() {
        let policy = |min_change_bytes, min_interval_ms| BokehReplacementPolicy {
            min_change_bytes,
            saved_size_factor: 0,
            min_interval_ms,
        };
        assert_eq!(parse_test_replacement_policy("4096"), Some(policy(4096, 0)));
        assert_eq!(
            parse_test_replacement_policy("4096, 2000"),
            Some(policy(4096, 2000))
        );
        assert_eq!(parse_test_replacement_policy(""), None);
        assert_eq!(parse_test_replacement_policy("4k"), None);
        assert_eq!(parse_test_replacement_policy("1,2,3"), None);
    }

    pub(crate) fn fold_event(version: u64, x: Value) -> Value {
        json!({"kind": "ColumnsFolded", "source_id": "p3", "version": version, "columns": {"x": x}})
    }

    pub(crate) fn stream_event(base: u64, x: Value) -> Value {
        json!({
            "kind": "ColumnsStreamed", "source_id": "p3", "base_version": base,
            "new_version": base + 1,
            "data": {"type": "map", "entries": [["x", x]]}, "rollover": null,
        })
    }

    /// The `x` column of source `p3` in materialized DocJson.
    pub(crate) fn materialized_x(doc: &Value) -> Value {
        let source = &doc["roots"][0]["attributes"]["children"][1];
        assert_eq!(source["id"], "p3");
        let entries = source["attributes"]["data"]["entries"].as_array().unwrap();
        let (_, column) = entries
            .iter()
            .map(|entry| (entry[0].as_str().unwrap(), entry[1].clone()))
            .find(|(name, _)| *name == "x")
            .unwrap();
        column
    }

    #[tokio::test]
    async fn removing_a_kernel_freezes_folded_columns_plus_the_retained_tail() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = store_with_session();
        let fold = wire_delta(
            "tx-0",
            json!({"data_events": [fold_event(0, json!([1, 2]))]}),
        );
        flush(&store, &blobs, fold, &[]).await;
        let stream = wire_delta(
            "tx-1",
            json!({"data_events": [stream_event(0, json!([3]))]}),
        );
        flush(&store, &blobs, stream, &[]).await;
        let removed = store.remove_kernel_sessions("kernel-1");
        let (_, state) = &removed[0];
        assert_eq!(state.tail.len(), 1, "the stream is retained");
        let doc = crate::bokeh_session::materialize::materialize_doc_json(state, &blobs)
            .await
            .unwrap();
        assert_eq!(materialized_x(&doc), json!([1, 2, 3]));
    }

    #[tokio::test]
    async fn data_event_fields_reach_the_broadcast_and_tail_verbatim() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = store_with_session();
        let mut event = stream_event(0, json!([3]));
        event["echo_of"] = json!(0);
        let broadcasts = flush(
            &store,
            &blobs,
            wire_delta("tx-1", json!({"data_events": [event.clone()]})),
            &[],
        )
        .await;
        assert_eq!(broadcasts[0].data_events, vec![event.clone()]);
        let tail = store.data_tail("session-1", None).unwrap();
        assert_eq!(tail.events[0].data_events, vec![event]);
    }

    fn cdc(session_id: &str, base: u64, value: u64) -> Value {
        let mut content = wire_delta(
            &format!("tx-{session_id}-{base}"),
            json!({"data_events": [{
                "kind": "ColumnDataChanged", "source_id": "p3", "base_version": base,
                "new_version": base + 1, "columns": {"x": [value]}, "columns_removed": [],
            }]}),
        );
        content["session_id"] = json!(session_id);
        content
    }

    fn current_x_blob(store: &BokehSessionStore, session_id: &str) -> String {
        store
            .with_doc(session_id, |doc| doc.read_columns()["p3"]["x"].blob.clone())
            .unwrap()
    }

    async fn free_expired(store: &BokehSessionStore, blobs: &BlobStore) -> Vec<String> {
        let expired = store.take_expired_retired(store.now_ms() + RETIRED_BLOB_GRACE_MS + 1);
        for blob in &expired {
            blobs.delete_if_ephemeral(blob).await.unwrap();
        }
        expired
    }

    async fn materialize_session(store: &BokehSessionStore, session_id: &str, blobs: &BlobStore) {
        let snapshot = store
            .with_doc(session_id, |doc| doc.read_snapshot().unwrap())
            .unwrap();
        let state = SnapshotWithTail {
            snapshot,
            ..Default::default()
        };
        crate::bokeh_session::materialize::materialize_doc_json(&state, blobs)
            .await
            .expect("every current column blob is still stored");
    }

    #[tokio::test]
    async fn a_replacement_hash_used_again_is_not_freed() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = store_with_session();
        let mut hashes = Vec::new();
        for (base, value) in [(0, 0), (1, 1), (2, 2), (3, 1)] {
            flush(&store, &blobs, cdc("session-1", base, value), &[]).await;
            hashes.push(current_x_blob(&store, "session-1"));
        }
        let current = hashes[3].clone();
        assert_eq!(current, hashes[1], "[1] is content-addressed to one blob");

        let expired = free_expired(&store, &blobs).await;
        assert!(!expired.contains(&current), "{expired:?}");
        assert!(expired.contains(&hashes[0]) && expired.contains(&hashes[2]));
        assert!(blobs.exists(&current));
        assert!(!blobs.exists(&hashes[2]));
        materialize_session(&store, "session-1", &blobs).await;

        // Superseded again, the hash gets a fresh grace period and is freed.
        flush(&store, &blobs, cdc("session-1", 4, 3), &[]).await;
        assert!(store.take_expired_retired(store.now_ms()).is_empty());
        assert_eq!(free_expired(&store, &blobs).await, vec![current.clone()]);
        assert!(!blobs.exists(&current));
    }

    #[tokio::test]
    async fn a_hash_another_session_still_uses_is_not_freed() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let store = store_with_session();
        let mut second = snapshot();
        second.meta.session_id = "session-2".into();
        assert!(store.insert(
            "session-2",
            BokehSessionDoc::build(&second, KERNEL).unwrap(),
            "kernel-1",
            KERNEL,
        ));
        flush(&store, &blobs, cdc("session-2", 0, 5), &[]).await;
        flush(&store, &blobs, cdc("session-1", 0, 5), &[]).await;
        let shared = current_x_blob(&store, "session-2");
        assert_eq!(shared, current_x_blob(&store, "session-1"));
        flush(&store, &blobs, cdc("session-1", 1, 6), &[]).await;
        assert!(store.live_blob_refs().contains(&shared));

        let expired = free_expired(&store, &blobs).await;
        assert!(!expired.contains(&shared), "{expired:?}");
        assert!(blobs.exists(&shared));
        materialize_session(&store, "session-2", &blobs).await;
    }

    #[test]
    fn removing_a_kernel_returns_its_sessions_for_freezing() {
        let store = store_with_session();
        assert!(store.remove_kernel_sessions("other-kernel").is_empty());
        let removed = store.remove_kernel_sessions("kernel-1");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].1.snapshot.meta.session_id, "session-1");
        assert!(store.epoch("session-1").is_none());
    }

    fn routed_store() -> (BokehSessionStore, crate::keyed_doc::AgentDocs) {
        let mut docs =
            crate::keyed_doc::AgentDocs::new(broadcast::channel(4).0, broadcast::channel(4).0);
        let store = BokehSessionStore::new(BokehReplacementPolicy::default(), docs.availability());
        docs.register(Arc::new(store.clone()));
        (store, docs)
    }

    #[tokio::test]
    async fn without_bokeh_routing_no_session_starts_and_deltas_store_nothing() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let (store, mut docs) = routed_store();
        docs.set_coordinator_kinds(vec!["test_kv".to_string()]);
        assert!(!store.accepts_sessions());
        let doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        assert!(!store.insert("session-1", doc, "kernel-1", KERNEL));
        assert!(!store.contains("session-1"));
        assert!(docs.outbound_keyed_frames().is_empty(), "no 0x0b");

        // The launcher still publishes deltas for the static output.
        let (broadcast_tx, mut broadcasts) = broadcast::channel(4);
        let ctx = IngestContext {
            store: store.clone(),
            blob_store: blobs.clone(),
            blob_publisher: OutputBlobPublisher::none(),
            state: RuntimeStateHandle::new(
                runtime_doc::RuntimeStateDoc::new(),
                broadcast::channel(4).0,
            ),
            broadcast_tx,
            kernel_actor_id: KERNEL.to_string(),
        };
        let data = vec![7u8; 4096];
        let content = wire_delta(
            "tx-1",
            json!({
                "data_events": [{
                    "kind": "ColumnsStreamed", "source_id": "p3", "base_version": 0,
                    "new_version": 1, "rollover": null,
                    "data": {"type": "map", "entries": [["x", {"type": "bytes", "data": {"id": "b1"}}]]},
                }],
                "buffers": [{"id": "b1", "hash": hex_sha256(&data), "size": data.len(), "buffer_index": 0}],
            }),
        );
        flush_delta(
            KernelDelta::parse(&content, std::slice::from_ref(&data)).unwrap(),
            &ctx,
        )
        .await;
        assert!(
            !blobs.exists(&hex_sha256(&data)),
            "no blob for a static output"
        );
        assert!(broadcasts.try_recv().is_err(), "no broadcast");

        // Once the coordinator routes the kind, the next output is live.
        docs.set_coordinator_kinds(vec![BOKEH_SESSION_KIND.to_string()]);
        assert!(store.accepts_sessions());
        let doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        assert!(store.insert("session-1", doc, "kernel-1", KERNEL));
        let frames = docs.outbound_keyed_frames();
        assert_eq!(frames.len(), 1);
        let (header, _) = KeyedDocFrameHeader::try_parse(&frames[0]).unwrap();
        assert_eq!(
            header,
            KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "session-1", 0)
        );
    }

    #[tokio::test]
    async fn store_changes_wake_the_agent_loop() {
        let (store, mut docs) = routed_store();
        docs.set_coordinator_kinds(vec![BOKEH_SESSION_KIND.to_string()]);
        // Consume the wake from advertising the kind.
        tokio::time::timeout(Duration::from_secs(1), docs.keyed_changed())
            .await
            .unwrap();
        let doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        store.insert("session-1", doc, "kernel-1", KERNEL);
        tokio::time::timeout(Duration::from_secs(1), docs.keyed_changed())
            .await
            .expect("insert wakes the outbound arm");
    }

    #[test]
    fn a_kernel_binding_is_only_cleared_by_its_own_kernel() {
        let store = store_with_session();
        let (shell, _rx) = crate::kernel_shell_requester::KernelShellRequester::for_test();
        let requester = BokehKernelRequester::new(
            shell,
            Arc::new(crate::output_redaction::OutputRedactor::default()),
        );
        let (old_tx, _old_rx) = mpsc::unbounded_channel();
        let (new_tx, mut new_rx) = mpsc::unbounded_channel();
        let old = BokehKernelOutbox::tap_for_test(old_tx);
        store.attach_kernel(
            "kernel-1",
            requester.clone(),
            old.clone(),
            oneshot::channel().1,
        );
        store.attach_kernel(
            "kernel-2",
            requester,
            BokehKernelOutbox::tap_for_test(new_tx),
            oneshot::channel().1,
        );
        assert!(store.requester("kernel-1").is_none());
        assert!(store.outbox("kernel-1").is_none());
        assert!(store.requester("kernel-2").is_some());

        // The replaced kernel shutting down late leaves the new binding.
        store.detach_kernel("kernel-1", &old);
        assert!(store.requester("kernel-2").is_some());
        assert!(store.outbox("kernel-2").is_some());
        let mut states = KeyedSyncStates::new();
        let mut peer = BokehSessionDoc::new_empty("user:dev:alice/browser");
        let mut peer_state = sync::State::new();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        peer.set_prop("p2", "value", "0.9").unwrap();
        peer.commit();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        assert!(
            new_rx.try_recv().is_ok(),
            "the new kernel's forwarder is kept"
        );
    }

    /// A replacement due for a session the room already ended must not
    /// rewrite its record; the stale session leaves the store instead.
    #[test]
    fn replacements_skip_records_that_are_no_longer_connected() {
        let store = BokehSessionStore::with_policy(BokehReplacementPolicy {
            min_change_bytes: 0,
            saved_size_factor: 0,
            min_interval_ms: 0,
        });
        let doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        store.insert("session-1", doc, "kernel-1", KERNEL);
        let mut states = KeyedSyncStates::new();
        let mut peer = BokehSessionDoc::new_empty("user:dev:alice/browser");
        let mut peer_state = sync::State::new();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);
        peer.set_prop("p2", "value", "0.9").unwrap();
        peer.commit();
        sync_peer(&store, &mut states, &mut peer, &mut peer_state, 0);

        let dir = tempfile::TempDir::new().unwrap();
        let state =
            RuntimeStateHandle::new(runtime_doc::RuntimeStateDoc::new(), broadcast::channel(4).0);
        let frozen: runtime_doc::BokehSessionState = serde_json::from_value(json!({
            "output_id": "output-1", "cell_id": "cell-1", "execution_id": "exec-1",
            "kernel_id": "kernel-1", "status": "disconnected", "producer_name": "panel",
            "producer_version": "1", "bokeh_version": "3", "root_ids": ["p1"],
            "epoch": 0, "doc_heads": [], "previous_heads": [],
        }))
        .unwrap();
        state
            .with_doc(|doc| doc.put_bokeh_session("session-1", &frozen))
            .unwrap();
        let ctx = IngestContext {
            store: store.clone(),
            blob_store: Arc::new(BlobStore::new(dir.path().to_path_buf())),
            blob_publisher: OutputBlobPublisher::none(),
            state: state.clone(),
            broadcast_tx: broadcast::channel(4).0,
            kernel_actor_id: KERNEL.to_string(),
        };
        apply_replacements(&ctx);
        assert_eq!(
            state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap(),
            Some(frozen)
        );
        assert!(!store.contains("session-1"));
    }

    #[test]
    fn sync_states_of_removed_sessions_are_pruned() {
        let store = store_with_session();
        let mut states = KeyedSyncStates::new();
        let other = KeyedDocKey::new("test_kv", "session-1");
        states.for_epoch(&other, 0);
        assert_eq!(store.generate_frames(&mut states).len(), 1);
        assert!(states.contains(&session_key("session-1")));

        store.remove_sessions(&["session-1".to_string()]);
        assert!(store.generate_frames(&mut states).is_empty());
        assert!(!states.contains(&session_key("session-1")));
        assert!(
            states.contains(&other),
            "other kinds' states are left alone"
        );
    }

    #[test]
    fn frames_of_another_kind_are_ignored() {
        let store = store_with_session();
        let mut states = KeyedSyncStates::new();
        let message = BokehSessionDoc::new_empty("user:dev:alice/browser")
            .generate_sync_message(&mut sync::State::new())
            .unwrap();
        let header = KeyedDocFrameHeader::new("test_kv", "session-1", 0);
        assert!(store
            .receive_sync(&header, message, &mut states)
            .unwrap()
            .is_none());
        assert!(states.keys().next().is_none());
    }
}
