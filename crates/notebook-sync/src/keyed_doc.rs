//! Replicas of keyed documents (frame `0x0b`).
//!
//! A keyed document is a small Automerge document identified by
//! `(kind, id)` whose `epoch` changes when its producer replaces it. A client
//! subscribes by syncing an empty replica for the epoch it learned about
//! (normally from RuntimeStateDoc); the daemon then pushes later changes. The
//! daemon validates every write, and a refused write comes back as
//! `SessionControlMessage::DocResync`, which drops the replica and syncs a
//! fresh one at the daemon's epoch.
//!
//! This module is kind-agnostic: kinds wrap the replica's `AutoCommit` in
//! their own typed view through [`crate::DocHandle::with_keyed_doc`].

use std::collections::HashMap;

use automerge::sync::{self, SyncDoc};
use automerge::{ActorId, AutoCommit, ChangeHash};
use automerge_recovery::catch_automerge_panic;
use log::warn;
use notebook_protocol::connection::{KeyedDocFrameHeader, KeyedDocKey};

/// A subscribed replica changed or was restarted.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyedDocEvent {
    /// Daemon changes were merged into the replica.
    Changed {
        key: KeyedDocKey,
        epoch: u64,
        before: Vec<ChangeHash>,
        after: Vec<ChangeHash>,
    },
    /// The replica restarted empty at `epoch`, discarding its unsent and
    /// refused changes: the daemon refused this client's changes
    /// (`DocResync`), or the local replica could not apply a sync message.
    Resync {
        key: KeyedDocKey,
        epoch: u64,
        reason: String,
    },
}

pub(crate) struct KeyedReplica {
    pub(crate) epoch: u64,
    pub(crate) doc: AutoCommit,
    pub(crate) state: sync::State,
}

impl KeyedReplica {
    fn new(epoch: u64, actor: &ActorId) -> Self {
        Self {
            epoch,
            doc: AutoCommit::new().with_actor(actor.clone()),
            state: sync::State::new(),
        }
    }

    fn framed_sync_message(&mut self, key: &KeyedDocKey) -> Option<Vec<u8>> {
        let message = self.doc.sync().generate_sync_message(&mut self.state)?;
        Some(
            KeyedDocFrameHeader::new(key.kind.clone(), key.id.clone(), self.epoch)
                .encode_frame(&message.encode()),
        )
    }
}

/// A replica lent to [`crate::DocHandle::with_keyed_doc`].
pub struct KeyedReplicaView<'a> {
    pub epoch: u64,
    pub doc: &'a mut AutoCommit,
    shared_heads: &'a [ChangeHash],
}

impl KeyedReplicaView<'_> {
    /// Heads the daemon is known to have for this replica.
    pub fn shared_heads(&self) -> &[ChangeHash] {
        self.shared_heads
    }

    /// Whether the daemon has merged every change in `heads`.
    pub fn has_merged(&mut self, heads: &[ChangeHash]) -> bool {
        if self.shared_heads.is_empty() {
            return false;
        }
        let unmerged = self.doc.get_changes(self.shared_heads);
        !unmerged.iter().any(|change| heads.contains(&change.hash()))
    }
}

#[derive(Default)]
pub(crate) struct KeyedReplicas(HashMap<KeyedDocKey, KeyedReplica>);

impl KeyedReplicas {
    /// Open a replica, or restart it for a newer epoch. Returns whether a new
    /// replica needs its opening frame sent.
    pub(crate) fn open(&mut self, key: &KeyedDocKey, epoch: u64, actor: &ActorId) -> bool {
        if self
            .0
            .get(key)
            .is_some_and(|replica| replica.epoch >= epoch)
        {
            return false;
        }
        self.0.insert(key.clone(), KeyedReplica::new(epoch, actor));
        true
    }

    pub(crate) fn view<'a>(&'a mut self, key: &KeyedDocKey) -> Option<KeyedReplicaView<'a>> {
        let replica = self.0.get_mut(key)?;
        Some(KeyedReplicaView {
            epoch: replica.epoch,
            doc: &mut replica.doc,
            shared_heads: &replica.state.shared_heads,
        })
    }

    /// Apply a daemon frame for an open replica. Returns the event to publish
    /// and the reply payload. Frames for documents this client never opened,
    /// or for an older epoch, are dropped.
    pub(crate) fn receive(
        &mut self,
        payload: &[u8],
        actor: &ActorId,
    ) -> (Option<KeyedDocEvent>, Option<Vec<u8>>) {
        let (header, body) = match KeyedDocFrameHeader::try_parse(payload) {
            Ok(parsed) => parsed,
            Err(error) => {
                warn!("[notebook-sync] Dropping malformed KeyedDocSync frame: {error}");
                return (None, None);
            }
        };
        let key = header.key();
        let Some(replica) = self.0.get_mut(&key) else {
            return (None, None);
        };
        if header.epoch < replica.epoch {
            return (None, None);
        }
        if header.epoch > replica.epoch {
            // The producer replaced the document; the daemon restarted its
            // sync state for the new epoch, so start from an empty replica.
            *replica = KeyedReplica::new(header.epoch, actor);
        }
        let message = match sync::Message::decode(body) {
            Ok(message) => message,
            Err(error) => {
                warn!(
                    "[notebook-sync] Undecodable KeyedDocSync for {}/{}: {error}",
                    key.kind, key.id
                );
                return (None, None);
            }
        };
        let before = replica.doc.get_heads();
        let applied = catch_automerge_panic("keyed-doc-sync-inbound", || {
            replica
                .doc
                .sync()
                .receive_sync_message(&mut replica.state, message)
        });
        let failure = match applied {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error.to_string()),
            Err(panic) => Some(panic.to_string()),
        };
        let event = match failure {
            None => {
                let after = replica.doc.get_heads();
                (after != before).then(|| KeyedDocEvent::Changed {
                    key: key.clone(),
                    epoch: replica.epoch,
                    before,
                    after,
                })
            }
            Some(reason) => {
                warn!(
                    "[notebook-sync] KeyedDocSync for {}/{} failed, restarting replica: {reason}",
                    key.kind, key.id
                );
                // The daemon is the authority, so an empty replica resyncs
                // everything that matters.
                *replica = KeyedReplica::new(replica.epoch, actor);
                Some(KeyedDocEvent::Resync {
                    key: key.clone(),
                    epoch: replica.epoch,
                    reason: format!("local sync failed: {reason}"),
                })
            }
        };
        (event, replica.framed_sync_message(&key))
    }

    /// Restart an open replica at `epoch` after the daemon refused its
    /// changes. Returns the event and the new replica's opening frame.
    pub(crate) fn resync(
        &mut self,
        key: &KeyedDocKey,
        epoch: u64,
        reason: &str,
        actor: &ActorId,
    ) -> Option<(KeyedDocEvent, Option<Vec<u8>>)> {
        let replica = self.0.get_mut(key)?;
        *replica = KeyedReplica::new(epoch, actor);
        let opening = replica.framed_sync_message(key);
        Some((
            KeyedDocEvent::Resync {
                key: key.clone(),
                epoch,
                reason: reason.to_string(),
            },
            opening,
        ))
    }

    /// Pending sync payloads: opening frames and local writes.
    pub(crate) fn outbound(&mut self) -> Vec<Vec<u8>> {
        self.0
            .iter_mut()
            .filter_map(|(key, replica)| replica.framed_sync_message(key))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::transaction::Transactable;
    use automerge::{ReadDoc, ROOT};

    fn actor() -> ActorId {
        ActorId::from(b"user:test:alice/client".as_slice())
    }

    fn key(id: &str) -> KeyedDocKey {
        KeyedDocKey::new("test_kv", id)
    }

    fn producer(value: &str) -> AutoCommit {
        let mut doc = AutoCommit::new().with_actor(ActorId::from(b"rt:producer".as_slice()));
        doc.put(ROOT, "value", value).unwrap();
        doc.commit();
        doc
    }

    /// Feed `payload` to the producer doc and return its framed reply.
    fn hub_reply(hub: &mut AutoCommit, state: &mut sync::State, payload: &[u8]) -> Vec<u8> {
        let (header, body) = KeyedDocFrameHeader::try_parse(payload).unwrap();
        hub.sync()
            .receive_sync_message(state, sync::Message::decode(body).unwrap())
            .unwrap();
        let message = hub.sync().generate_sync_message(state).unwrap();
        header.encode_frame(&message.encode())
    }

    fn value(replicas: &mut KeyedReplicas, id: &str) -> Option<String> {
        let view = replicas.view(&key(id))?;
        view.doc
            .get(ROOT, "value")
            .unwrap()
            .and_then(|(value, _)| value.into_string().ok())
    }

    #[test]
    fn replicas_subscribe_follow_epochs_and_restart_on_resync() {
        let mut hub = producer("one");
        let mut hub_state = sync::State::new();
        let mut replicas = KeyedReplicas::default();
        assert!(replicas.open(&key("d1"), 1, &actor()));
        assert!(!replicas.open(&key("d1"), 1, &actor()), "already open");
        assert!(!replicas.open(&key("d1"), 0, &actor()), "older epoch");

        let opening = replicas.outbound();
        assert_eq!(opening.len(), 1);
        let (header, _) = KeyedDocFrameHeader::try_parse(&opening[0]).unwrap();
        assert_eq!(header, KeyedDocFrameHeader::new("test_kv", "d1", 1));
        let reply = hub_reply(&mut hub, &mut hub_state, &opening[0]);
        let (event, _) = replicas.receive(&reply, &actor());
        match event {
            Some(KeyedDocEvent::Changed {
                key: changed,
                epoch: 1,
                before,
                after,
            }) => {
                assert_eq!(changed, key("d1"));
                assert!(before.is_empty());
                assert_eq!(after, hub.get_heads());
            }
            other => panic!("expected Changed, got {other:?}"),
        }
        assert_eq!(value(&mut replicas, "d1").as_deref(), Some("one"));

        // Unopened documents and other kinds are not routed here.
        let other = KeyedDocFrameHeader::new("test_kv", "d2", 1).encode_frame(&[]);
        assert_eq!(replicas.receive(&other, &actor()), (None, None));
        let other_kind = KeyedDocFrameHeader::new("other_kind", "d1", 1).encode_frame(&[]);
        assert_eq!(replicas.receive(&other_kind, &actor()), (None, None));
        assert_eq!(replicas.receive(&[0, 0], &actor()), (None, None));

        // A newer epoch restarts the replica before applying the frame.
        let mut next = producer("two");
        let message = next
            .sync()
            .generate_sync_message(&mut sync::State::new())
            .unwrap();
        let newer = KeyedDocFrameHeader::new("test_kv", "d1", 2).encode_frame(&message.encode());
        replicas.receive(&newer, &actor());
        assert_eq!(replicas.view(&key("d1")).unwrap().epoch, 2);
        assert_eq!(
            value(&mut replicas, "d1"),
            None,
            "old epoch content dropped"
        );
        // Frames for the older epoch are then dropped.
        let stale = hub_reply(&mut hub, &mut sync::State::new(), &opening[0]);
        assert_eq!(replicas.receive(&stale, &actor()), (None, None));

        assert!(replicas.resync(&key("d2"), 0, "nope", &actor()).is_none());
        let (event, opening) = replicas
            .resync(&key("d1"), 3, "scope viewer cannot write", &actor())
            .unwrap();
        assert_eq!(
            event,
            KeyedDocEvent::Resync {
                key: key("d1"),
                epoch: 3,
                reason: "scope viewer cannot write".into(),
            }
        );
        let (header, _) = KeyedDocFrameHeader::try_parse(&opening.unwrap()).unwrap();
        assert_eq!(header.epoch, 3);
        assert_eq!(replicas.view(&key("d1")).unwrap().epoch, 3);
    }

    #[test]
    fn view_reports_whether_the_daemon_merged_local_writes() {
        let mut hub = producer("one");
        let mut hub_state = sync::State::new();
        let mut replicas = KeyedReplicas::default();
        replicas.open(&key("d1"), 1, &actor());
        let opening = replicas.outbound().remove(0);
        let reply = hub_reply(&mut hub, &mut hub_state, &opening);
        replicas.receive(&reply, &actor());

        let heads = {
            let view = replicas.view(&key("d1")).unwrap();
            view.doc.put(ROOT, "value", "local").unwrap();
            view.doc.commit();
            view.doc.get_heads()
        };
        assert!(!replicas.view(&key("d1")).unwrap().has_merged(&heads));

        // Converge with the hub, then the write is acknowledged.
        for _ in 0..8 {
            let outbound = replicas.outbound();
            if outbound.is_empty() {
                break;
            }
            for payload in outbound {
                let reply = hub_reply(&mut hub, &mut hub_state, &payload);
                replicas.receive(&reply, &actor());
            }
        }
        let mut view = replicas.view(&key("d1")).unwrap();
        assert!(!view.shared_heads().is_empty());
        assert!(view.has_merged(&heads));
        assert_eq!(
            hub.get(ROOT, "value")
                .unwrap()
                .and_then(|(value, _)| value.into_string().ok())
                .as_deref(),
            Some("local")
        );
    }
}
