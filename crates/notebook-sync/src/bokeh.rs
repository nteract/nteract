//! Replicas of Bokeh session documents (frame `0x0b`).
//!
//! A client subscribes to a session by syncing an empty replica for the epoch
//! RuntimeStateDoc announces; the daemon then pushes later changes. Writes are
//! property values only and are checked with the daemon hub's own rules
//! before they are sent. The hub stays the authority: a refused write comes
//! back as `SessionControlMessage::BokehSessionResync`, which resets the
//! replica and drops the write.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use automerge::{sync, ChangeHash};
use log::warn;
use notebook_wire::BokehSessionFrameHeader;
use runtime_doc::{
    BokehSessionChangeset, BokehSessionDoc, BokehSessionSnapshot, BokehSessionStatus,
    BokehSessionWriteContext, BokehSessionWriteRejection, RuntimeStateWriteScope,
};
use tokio::sync::broadcast;

use crate::error::SyncError;
use crate::shared::SharedDocState;

/// A replica changed or was reset by the daemon.
#[derive(Debug, Clone, PartialEq)]
pub enum BokehSessionEvent {
    Changed {
        session_id: String,
        epoch: u64,
        changeset: BokehSessionChangeset,
    },
    /// The daemon refused this client's changes; the replica restarted empty.
    Resync {
        session_id: String,
        epoch: u64,
        reason: String,
    },
}

pub(crate) struct BokehReplica {
    epoch: u64,
    doc: BokehSessionDoc,
    state: sync::State,
}

impl BokehReplica {
    fn new(epoch: u64, actor_label: &str) -> Self {
        Self {
            epoch,
            doc: BokehSessionDoc::new_empty(actor_label),
            state: sync::State::new(),
        }
    }

    fn synced(&self) -> bool {
        self.doc.epoch().is_some()
    }

    fn framed_sync_message(&mut self, session_id: &str) -> Option<Vec<u8>> {
        let message = self.doc.generate_sync_message(&mut self.state)?;
        Some(BokehSessionFrameHeader::new(session_id, self.epoch).encode_frame(&message.encode()))
    }

    /// Whether the daemon has merged every change in `heads`.
    fn has_merged(&mut self, heads: &[ChangeHash]) -> bool {
        if self.state.shared_heads.is_empty() {
            return false;
        }
        let shared = self.state.shared_heads.clone();
        let unmerged = self.doc.doc_mut().get_changes(&shared);
        !unmerged.iter().any(|change| heads.contains(&change.hash()))
    }
}

#[derive(Default)]
pub(crate) struct BokehReplicas {
    sessions: HashMap<String, BokehReplica>,
}

impl BokehReplicas {
    /// Open a replica, or restart it for a newer epoch. Returns whether a new
    /// replica needs its opening frame sent.
    fn open(&mut self, session_id: &str, epoch: u64, actor_label: &str) -> bool {
        if self
            .sessions
            .get(session_id)
            .is_some_and(|replica| replica.epoch >= epoch)
        {
            return false;
        }
        self.sessions.insert(
            session_id.to_string(),
            BokehReplica::new(epoch, actor_label),
        );
        true
    }

    /// Apply a daemon frame for a subscribed session. Returns the event to
    /// publish and the reply payload.
    pub(crate) fn receive(
        &mut self,
        payload: &[u8],
        actor_label: &str,
    ) -> (Option<BokehSessionEvent>, Option<Vec<u8>>) {
        let (header, body) = match BokehSessionFrameHeader::try_parse(payload) {
            Ok(parsed) => parsed,
            Err(error) => {
                warn!("[notebook-sync] Dropping malformed Bokeh session frame: {error}");
                return (None, None);
            }
        };
        let Some(replica) = self.sessions.get_mut(&header.session_id) else {
            return (None, None);
        };
        if header.epoch < replica.epoch {
            return (None, None);
        }
        if header.epoch > replica.epoch {
            *replica = BokehReplica::new(header.epoch, actor_label);
        }
        let event = match sync::Message::decode(body) {
            Ok(message) => match replica
                .doc
                .receive_sync_message(&mut replica.state, message)
            {
                Ok(changeset) if !changeset.is_empty() => Some(BokehSessionEvent::Changed {
                    session_id: header.session_id.clone(),
                    epoch: header.epoch,
                    changeset,
                }),
                Ok(_) => None,
                Err(error) => {
                    warn!(
                        "[notebook-sync] Bokeh session {} sync failed: {error}",
                        header.session_id
                    );
                    replica.state = sync::State::new();
                    None
                }
            },
            Err(error) => {
                warn!(
                    "[notebook-sync] Undecodable Bokeh session sync for {}: {error}",
                    header.session_id
                );
                None
            }
        };
        let reply = replica.framed_sync_message(&header.session_id);
        (event, reply)
    }

    /// Restart a subscribed session after the daemon refused its changes.
    /// Returns the event and the new replica's opening frame.
    pub(crate) fn resync(
        &mut self,
        session_id: &str,
        epoch: u64,
        reason: &str,
        actor_label: &str,
    ) -> Option<(BokehSessionEvent, Option<Vec<u8>>)> {
        let replica = self.sessions.get_mut(session_id)?;
        *replica = BokehReplica::new(epoch, actor_label);
        let opening = replica.framed_sync_message(session_id);
        Some((
            BokehSessionEvent::Resync {
                session_id: session_id.to_string(),
                epoch,
                reason: reason.to_string(),
            },
            opening,
        ))
    }

    /// Pending sync payloads: opening frames and local writes.
    pub(crate) fn outbound(&mut self) -> Vec<Vec<u8>> {
        self.sessions
            .iter_mut()
            .filter_map(|(session_id, replica)| replica.framed_sync_message(session_id))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_doc::{BokehModelState, BokehSessionMeta};

    const AGENT: &str = "agent:test";

    fn hub() -> BokehSessionDoc {
        let snapshot = BokehSessionSnapshot {
            epoch: 0,
            meta: BokehSessionMeta {
                session_id: "s1".into(),
                producer_name: "panel".into(),
                producer_version: "1.9.4".into(),
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: None,
                doc_extras: None,
            },
            models: BTreeMap::from([(
                "p1".to_string(),
                BokehModelState {
                    type_name: "Slider".into(),
                    ref_props: Vec::new(),
                    props: BTreeMap::from([("value".to_string(), "1".to_string())]),
                },
            )]),
            columns: BTreeMap::new(),
        };
        BokehSessionDoc::build(&snapshot, "rt:kernel:test").unwrap()
    }

    /// Feed `payload` to the hub and return its framed reply.
    fn hub_reply(hub: &mut BokehSessionDoc, state: &mut sync::State, payload: &[u8]) -> Vec<u8> {
        let (header, body) = BokehSessionFrameHeader::try_parse(payload).unwrap();
        hub.receive_sync_message(state, sync::Message::decode(body).unwrap())
            .unwrap();
        let message = hub.generate_sync_message(state).unwrap();
        BokehSessionFrameHeader::new(&header.session_id, header.epoch)
            .encode_frame(&message.encode())
    }

    #[test]
    fn replicas_subscribe_follow_epochs_and_restart_on_resync() {
        let mut hub = hub();
        let mut hub_state = sync::State::new();
        let mut replicas = BokehReplicas::default();
        assert!(replicas.open("s1", 0, AGENT));
        assert!(!replicas.open("s1", 0, AGENT), "already open");

        let opening = replicas.outbound();
        assert_eq!(opening.len(), 1);
        let reply = hub_reply(&mut hub, &mut hub_state, &opening[0]);
        let (event, _) = replicas.receive(&reply, AGENT);
        assert!(matches!(
            event,
            Some(BokehSessionEvent::Changed { ref session_id, epoch: 0, .. }) if session_id == "s1"
        ));
        assert_eq!(
            replicas.sessions["s1"]
                .doc
                .get_prop("p1", "value")
                .as_deref(),
            Some("1")
        );

        // Frames for sessions this client never opened are ignored.
        let other = BokehSessionFrameHeader::new("s2", 0).encode_frame(&[]);
        assert_eq!(replicas.receive(&other, AGENT), (None, None));

        // A newer epoch restarts the replica before applying the frame.
        let newer = BokehSessionFrameHeader::new("s1", 1).encode_frame(&[0xff]);
        replicas.receive(&newer, AGENT);
        assert_eq!(replicas.sessions["s1"].epoch, 1);
        assert!(!replicas.sessions["s1"].synced());
        // And frames for the older one are then dropped.
        let reply = hub_reply(&mut hub, &mut sync::State::new(), &opening[0]);
        assert_eq!(replicas.receive(&reply, AGENT), (None, None));

        assert!(replicas.resync("s2", 0, "nope", AGENT).is_none());
        let (event, opening) = replicas
            .resync("s1", 2, "scope viewer cannot write", AGENT)
            .unwrap();
        assert_eq!(
            event,
            BokehSessionEvent::Resync {
                session_id: "s1".into(),
                epoch: 2,
                reason: "scope viewer cannot write".into(),
            }
        );
        assert!(opening.is_some());
        assert_eq!(replicas.sessions["s1"].epoch, 2);
    }
}

/// The value a written property has after the write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BokehWrittenValue {
    pub value: Option<String>,
    /// Another actor (normally the kernel's correction) wrote it after us.
    pub corrected: bool,
}

/// What became of a property write within the wait window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BokehWriteReport {
    /// False when every value was already current, so nothing was sent.
    pub changed: bool,
    /// The daemon merged the write.
    pub acknowledged: bool,
    /// The daemon refused the write; the replica restarted without it.
    pub rejected: Option<String>,
    pub values: BTreeMap<String, BTreeMap<String, BokehWrittenValue>>,
    /// Other properties another actor changed during the wait, such as
    /// callback side effects.
    pub side_effects: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum BokehWriteError {
    #[error("this daemon connection does not sync Bokeh session documents")]
    Unsupported,
    #[error("Bokeh session {0} has not synced its document yet")]
    NotSynced(String),
    #[error(transparent)]
    Rejected(#[from] BokehSessionWriteRejection),
    #[error(transparent)]
    Sync(Box<SyncError>),
}

impl From<SyncError> for BokehWriteError {
    fn from(error: SyncError) -> Self {
        Self::Sync(Box::new(error))
    }
}

pub(crate) type SharedState = Arc<Mutex<SharedDocState>>;

fn lock(doc: &SharedState) -> Result<std::sync::MutexGuard<'_, SharedDocState>, SyncError> {
    doc.lock().map_err(|_| SyncError::LockPoisoned)
}

fn actor_label(state: &SharedDocState) -> String {
    notebook_doc::actor_label_from_id(state.doc.get_actor())
}

/// Open the session's replica. Returns whether an opening frame is pending.
pub(crate) fn open(doc: &SharedState, session_id: &str, epoch: u64) -> Result<bool, SyncError> {
    let mut state = lock(doc)?;
    let actor = actor_label(&state);
    Ok(state.bokeh.open(session_id, epoch, &actor))
}

pub(crate) fn snapshot(
    doc: &SharedState,
    session_id: &str,
) -> Result<Option<BokehSessionSnapshot>, SyncError> {
    let state = lock(doc)?;
    Ok(state
        .bokeh
        .sessions
        .get(session_id)
        .filter(|replica| replica.synced())
        .and_then(|replica| replica.doc.read_snapshot().ok()))
}

/// Wait until the replica holds the session's document.
pub(crate) async fn await_snapshot(
    doc: &SharedState,
    mut events: broadcast::Receiver<BokehSessionEvent>,
    session_id: &str,
    timeout: Duration,
) -> Result<Option<BokehSessionSnapshot>, SyncError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(snapshot) = snapshot(doc, session_id)? {
            return Ok(Some(snapshot));
        }
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Err(_) | Ok(Err(broadcast::error::RecvError::Closed)) => return Ok(None),
            Ok(_) => {}
        }
    }
}

/// Write one batch locally. Returns whether it changed the replica and the
/// heads to wait for.
pub(crate) fn write(
    doc: &SharedState,
    session_id: &str,
    status: BokehSessionStatus,
    props: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(bool, Vec<ChangeHash>), BokehWriteError> {
    let mut state = lock(doc)?;
    let replica = state
        .bokeh
        .sessions
        .get_mut(session_id)
        .filter(|replica| replica.synced())
        .ok_or_else(|| BokehWriteError::NotSynced(session_id.to_string()))?;
    // The daemon knows this connection's scope and enforces it; the local
    // check covers status, epoch and content.
    let context = BokehSessionWriteContext {
        scope: RuntimeStateWriteScope::Editor,
        status,
        current_epoch: replica.epoch,
    };
    let changed = replica.doc.write_peer_props(&context, props)?;
    Ok((changed, replica.doc.get_heads()))
}

/// Follow a write until the kernel corrects every value, the daemon refuses
/// it, or `wait` runs out.
pub(crate) async fn observe_write(
    doc: &SharedState,
    mut events: broadcast::Receiver<BokehSessionEvent>,
    session_id: &str,
    props: &BTreeMap<String, BTreeMap<String, String>>,
    heads: &[ChangeHash],
    wait: Duration,
) -> Result<BokehWriteReport, SyncError> {
    let deadline = tokio::time::Instant::now() + wait;
    let mut report = BokehWriteReport {
        changed: true,
        ..Default::default()
    };
    let requested = |model: &str, prop: &str| {
        props
            .get(model)
            .is_some_and(|values| values.contains_key(prop))
    };
    loop {
        if !report.acknowledged {
            let mut state = lock(doc)?;
            if let Some(replica) = state.bokeh.sessions.get_mut(session_id) {
                report.acknowledged = replica.has_merged(heads);
            }
        }
        let all_corrected = props.iter().all(|(model, values)| {
            values.keys().all(|prop| {
                report
                    .values
                    .get(model)
                    .and_then(|values| values.get(prop))
                    .is_some_and(|value| value.corrected)
            })
        });
        if report.rejected.is_some() || all_corrected {
            break;
        }
        let event = match tokio::time::timeout_at(deadline, events.recv()).await {
            Err(_) | Ok(Err(broadcast::error::RecvError::Closed)) => break,
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Ok(event)) => event,
        };
        match event {
            BokehSessionEvent::Resync {
                session_id: id,
                reason,
                ..
            } if id == session_id => report.rejected = Some(reason),
            BokehSessionEvent::Changed {
                session_id: id,
                changeset,
                ..
            } if id == session_id => {
                let state = lock(doc)?;
                let ours = state.doc.get_actor().clone();
                let Some(replica) = state.bokeh.sessions.get(session_id) else {
                    continue;
                };
                let foreign = replica
                    .doc
                    .foreign_props(&changeset, |actor| *actor != ours);
                for (model, values) in foreign {
                    for (prop, value) in values {
                        if requested(&model, &prop) {
                            report.values.entry(model.clone()).or_default().insert(
                                prop,
                                BokehWrittenValue {
                                    value: Some(value),
                                    corrected: true,
                                },
                            );
                        } else {
                            report
                                .side_effects
                                .entry(model.clone())
                                .or_default()
                                .insert(prop, value);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if report.rejected.is_none() {
        let state = lock(doc)?;
        if let Some(replica) = state.bokeh.sessions.get(session_id) {
            for (model, values) in props {
                for prop in values.keys() {
                    let current = replica.doc.get_prop(model, prop);
                    report
                        .values
                        .entry(model.clone())
                        .or_default()
                        .entry(prop.clone())
                        .and_modify(|value| value.value = current.clone())
                        .or_insert(BokehWrittenValue {
                            value: current,
                            corrected: false,
                        });
                }
            }
        }
    }
    Ok(report)
}
