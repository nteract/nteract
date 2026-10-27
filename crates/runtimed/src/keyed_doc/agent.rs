//! Runtime-agent side of document sync with the coordinator.
//!
//! `AgentDocs` owns the agent's per-connection sync states (RuntimeStateDoc,
//! CommsDoc and every keyed document) so a reconnect resets all of them in
//! one place. Keyed document kinds keep their documents; `AgentDocs` only
//! holds sync states and asks each kind for frames.

use std::collections::BTreeSet;
use std::future::Future;
use std::sync::{Arc, RwLock};

use automerge::sync;
use notebook_wire::{frame_types, KeyedDocFrameHeader};
use tokio::sync::{broadcast, Notify};
use tracing::{debug, warn};

use super::hub::KeyedSyncStates;

/// The agent half of one keyed document kind.
pub(crate) trait AgentKeyedDoc: Send + Sync + 'static {
    fn kind(&self) -> &'static str;
    /// Called once at registration; the kind wakes the agent loop through it
    /// whenever it has something to send.
    fn attach(&self, waker: KeyedDocWaker);
    /// Header-framed payloads for every document with something to send.
    fn generate_frames(&self, states: &mut KeyedSyncStates) -> Vec<Vec<u8>>;
    /// Apply a coordinator frame whose header was already parsed. Returns a
    /// reply payload.
    fn receive_frame(
        &self,
        header: &KeyedDocFrameHeader,
        message: sync::Message,
        states: &mut KeyedSyncStates,
    ) -> anyhow::Result<Option<Vec<u8>>>;
}

#[derive(Clone, Default)]
pub(crate) struct KeyedDocWaker(Arc<Notify>);

impl KeyedDocWaker {
    pub(crate) fn wake(&self) {
        // `notify_one` keeps a permit when the loop is not waiting, so a wake
        // between two polls is not lost.
        self.0.notify_one();
    }
}

/// Kinds the current coordinator routes and this agent registers. Read by
/// output code to decide between a live document and a static render.
#[derive(Clone, Default)]
pub(crate) struct KeyedDocAvailability(Arc<RwLock<BTreeSet<&'static str>>>);

impl KeyedDocAvailability {
    pub(crate) fn is_available(&self, kind: &str) -> bool {
        self.0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(kind)
    }

    fn set(&self, kinds: BTreeSet<&'static str>) {
        *self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = kinds;
    }
}

pub(crate) struct AgentDocs {
    pub(crate) coordinator_sync: sync::State,
    pub(crate) comms_sync: sync::State,
    state_kick: broadcast::Sender<()>,
    comms_kick: broadcast::Sender<()>,
    keyed: Vec<(Arc<dyn AgentKeyedDoc>, KeyedSyncStates)>,
    /// From the coordinator's `RuntimeAgentCapabilities` on this connection.
    coordinator_kinds: BTreeSet<String>,
    availability: KeyedDocAvailability,
    waker: KeyedDocWaker,
}

impl AgentDocs {
    pub(crate) fn new(
        state_kick: broadcast::Sender<()>,
        comms_kick: broadcast::Sender<()>,
    ) -> Self {
        Self {
            coordinator_sync: sync::State::new(),
            comms_sync: sync::State::new(),
            state_kick,
            comms_kick,
            keyed: Vec::new(),
            coordinator_kinds: BTreeSet::new(),
            availability: KeyedDocAvailability::default(),
            waker: KeyedDocWaker::default(),
        }
    }

    pub(crate) fn register(&mut self, doc: Arc<dyn AgentKeyedDoc>) {
        doc.attach(self.waker.clone());
        self.keyed.push((doc, KeyedSyncStates::new()));
        self.refresh_availability();
    }

    pub(crate) fn availability(&self) -> KeyedDocAvailability {
        self.availability.clone()
    }

    /// Whether frames for `kind` may be sent on this connection: the agent
    /// registers it and the coordinator advertised it. Kinds read the same
    /// answer through [`Self::availability`].
    #[cfg(test)]
    pub(crate) fn supports(&self, kind: &str) -> bool {
        self.availability.is_available(kind)
    }

    /// Apply the coordinator's `RuntimeAgentCapabilities`.
    pub(crate) fn set_coordinator_kinds(&mut self, kinds: impl IntoIterator<Item = String>) {
        self.coordinator_kinds = kinds.into_iter().collect();
        self.refresh_availability();
        self.waker.wake();
    }

    fn refresh_availability(&self) {
        let available = self
            .keyed
            .iter()
            .map(|(doc, _)| doc.kind())
            .filter(|kind| self.coordinator_kinds.contains(*kind))
            .collect();
        self.availability.set(available);
    }

    /// Fresh sync states for RuntimeStateDoc, CommsDoc and every keyed
    /// document after a reconnect, and a kick so each resyncs. The new
    /// coordinator announces its kinds again, so none are available until it
    /// does.
    pub(crate) fn reset_all(&mut self) {
        self.coordinator_sync = sync::State::new();
        self.comms_sync = sync::State::new();
        for (_, states) in &mut self.keyed {
            states.clear();
        }
        self.coordinator_kinds.clear();
        self.refresh_availability();
        let _ = self.state_kick.send(());
        let _ = self.comms_kick.send(());
        self.waker.wake();
    }

    /// Resolves when a registered kind has something to send. Owns its
    /// handle so a `select!` arm does not borrow `self`.
    pub(crate) fn keyed_changed(&self) -> impl Future<Output = ()> + Send + 'static {
        let notify = self.waker.0.clone();
        async move { notify.notified().await }
    }

    /// Payloads for available kinds only; kinds the coordinator did not
    /// advertise produce nothing.
    pub(crate) fn outbound_keyed_frames(&mut self) -> Vec<Vec<u8>> {
        let availability = &self.availability;
        self.keyed
            .iter_mut()
            .filter(|(doc, _)| availability.is_available(doc.kind()))
            .flat_map(|(doc, states)| doc.generate_frames(states))
            .collect()
    }

    /// A `KeyedDocSync` frame from the coordinator. Frames for kinds that are
    /// not available on this connection are ignored, so a reply is never
    /// sent for a kind the coordinator did not advertise.
    pub(crate) fn receive_keyed_frame(
        &mut self,
        payload: &[u8],
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let (header, body) = KeyedDocFrameHeader::try_parse(payload)?;
        let availability = &self.availability;
        let Some((doc, states)) = self
            .keyed
            .iter_mut()
            .find(|(doc, _)| doc.kind() == header.kind && availability.is_available(doc.kind()))
        else {
            debug!(
                "[runtime-agent] Ignoring KeyedDocSync for unavailable kind {}",
                header.kind
            );
            return Ok(None);
        };
        let message = sync::Message::decode(body)
            .map_err(|error| anyhow::anyhow!("decode keyed doc sync: {error}"))?;
        doc.receive_frame(&header, message, states)
    }

    /// The coordinator (or a relay in front of it) refused a frame type the
    /// connection can live without. For `KeyedDocSync` every kind stops for
    /// this connection; returns the kinds that were available.
    pub(crate) fn on_optional_frame_rejected(
        &mut self,
        frame_type: u8,
        reason: &str,
    ) -> Vec<&'static str> {
        if frame_type != frame_types::KEYED_DOC_SYNC {
            return Vec::new();
        }
        let disabled: Vec<&'static str> = self
            .keyed
            .iter()
            .map(|(doc, _)| doc.kind())
            .filter(|kind| self.availability.is_available(kind))
            .collect();
        warn!(
            "[runtime-agent] Coordinator refused KeyedDocSync ({reason}); disabling {:?}",
            disabled
        );
        self.coordinator_kinds.clear();
        self.refresh_availability();
        disabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyed_doc::test_kind::{TestKvAgentDoc, TEST_KV};

    fn docs() -> (
        AgentDocs,
        broadcast::Receiver<()>,
        broadcast::Receiver<()>,
        Arc<TestKvAgentDoc>,
    ) {
        let (state_kick, state_rx) = broadcast::channel(4);
        let (comms_kick, comms_rx) = broadcast::channel(4);
        let mut docs = AgentDocs::new(state_kick, comms_kick);
        let kv = Arc::new(TestKvAgentDoc::default());
        kv.insert("doc-1", 0);
        kv.put("doc-1", "a", "1");
        docs.register(kv.clone());
        (docs, state_rx, comms_rx, kv)
    }

    #[tokio::test]
    async fn no_frames_until_the_coordinator_advertises_the_kind() {
        let (mut docs, _state_rx, _comms_rx, _kv) = docs();
        assert!(!docs.supports(TEST_KV));
        assert!(docs.outbound_keyed_frames().is_empty());

        docs.set_coordinator_kinds(vec!["other".to_string()]);
        assert!(!docs.supports(TEST_KV));
        assert!(docs.outbound_keyed_frames().is_empty());

        docs.set_coordinator_kinds(vec![TEST_KV.to_string()]);
        assert!(docs.supports(TEST_KV));
        assert!(docs.availability().is_available(TEST_KV));
        let frames = docs.outbound_keyed_frames();
        assert_eq!(frames.len(), 1);
        let (header, _) = KeyedDocFrameHeader::try_parse(&frames[0]).unwrap();
        assert_eq!(
            (header.kind.as_str(), header.id.as_str()),
            (TEST_KV, "doc-1")
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), docs.keyed_changed())
            .await
            .expect("advertising a kind wakes the loop");
    }

    #[tokio::test]
    async fn reset_all_resets_every_state_and_kicks() {
        let (mut docs, mut state_rx, mut comms_rx, _kv) = docs();
        docs.set_coordinator_kinds(vec![TEST_KV.to_string()]);
        assert!(!docs.outbound_keyed_frames().is_empty());
        // In flight: a second generate has nothing new to say.
        assert!(docs.outbound_keyed_frames().is_empty());
        docs.coordinator_sync.shared_heads = vec![automerge::ChangeHash([1; 32])];
        docs.comms_sync.shared_heads = vec![automerge::ChangeHash([2; 32])];
        while state_rx.try_recv().is_ok() {}
        while comms_rx.try_recv().is_ok() {}

        docs.reset_all();
        assert!(docs.coordinator_sync.shared_heads.is_empty());
        assert!(docs.comms_sync.shared_heads.is_empty());
        assert!(state_rx.try_recv().is_ok(), "RuntimeStateDoc kicked");
        assert!(comms_rx.try_recv().is_ok(), "CommsDoc kicked");
        assert!(
            !docs.supports(TEST_KV),
            "kinds wait for the new coordinator's capabilities"
        );
        assert!(docs.outbound_keyed_frames().is_empty());

        docs.set_coordinator_kinds(vec![TEST_KV.to_string()]);
        assert_eq!(
            docs.outbound_keyed_frames().len(),
            1,
            "keyed sync restarts from a fresh state"
        );
    }

    #[test]
    fn optional_frame_rejection_disables_kinds_without_failing() {
        let (mut docs, _state_rx, _comms_rx, _kv) = docs();
        docs.set_coordinator_kinds(vec![TEST_KV.to_string()]);
        assert!(docs.on_optional_frame_rejected(0x05, "nope").is_empty());
        assert!(docs.supports(TEST_KV));
        assert_eq!(
            docs.on_optional_frame_rejected(frame_types::KEYED_DOC_SYNC, "not routed"),
            vec![TEST_KV]
        );
        assert!(!docs.supports(TEST_KV));
        assert!(docs.outbound_keyed_frames().is_empty());
    }
}
