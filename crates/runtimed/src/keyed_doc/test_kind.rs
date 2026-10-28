//! `test_kv`: a keyed document kind for tests only.
//!
//! Document shape `{epoch: u64, values: {key: string}}`. Records live in
//! memory instead of RuntimeStateDoc, so tests need no schema change.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex as StdMutex;

use automerge::sync::SyncDoc;
use automerge::transaction::Transactable;
use automerge::{sync, AutoCommit, ObjType, ReadDoc, ScalarValue, Value, ROOT};
use notebook_wire::{FrameSizeLimits, KeyedDocFrameHeader, KeyedDocKey};
use runtime_doc::{KeyedDocRecord, KeyedDocRejection, KeyedWriteContext, RuntimeStateDoc};

use super::agent::{AgentKeyedDoc, KeyedDocWaker};
use super::hub::KeyedSyncStates;
use super::kind::KeyedDocKind;

pub(crate) const TEST_KV: &str = "test_kv";
pub(crate) const TEST_KV_PRODUCER: &str = "rt:kernel:test-kv";

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The string value at `values[key]`.
pub(crate) fn kv_get(doc: &AutoCommit, key: &str) -> Option<String> {
    let (_, values) = doc.get(ROOT, "values").ok()??;
    match doc.get(&values, key).ok()?? {
        (Value::Scalar(scalar), _) => match scalar.as_ref() {
            ScalarValue::Str(text) => Some(text.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// Write `values[key] = value` and commit.
pub(crate) fn kv_put(doc: &mut AutoCommit, key: &str, value: &str) {
    let values = match doc.get(ROOT, "values").unwrap() {
        Some((_, id)) => id,
        None => doc.put_object(ROOT, "values", ObjType::Map).unwrap(),
    };
    doc.put(&values, key, value).unwrap();
    doc.commit();
}

/// An empty replica a peer starts from.
pub(crate) fn kv_peer_doc(actor: &str) -> AutoCommit {
    AutoCommit::new().with_actor(automerge::ActorId::from(actor.as_bytes()))
}

fn kv_build(epoch: u64, values: &[(String, String)]) -> AutoCommit {
    let mut doc = kv_peer_doc(TEST_KV_PRODUCER);
    doc.put(ROOT, "epoch", epoch).unwrap();
    let map = doc.put_object(ROOT, "values", ObjType::Map).unwrap();
    for (key, value) in values {
        doc.put(&map, key.as_str(), value.as_str()).unwrap();
    }
    doc.commit();
    doc
}

fn kv_values(doc: &AutoCommit) -> Vec<(String, String)> {
    let Ok(Some((_, values))) = doc.get(ROOT, "values") else {
        return Vec::new();
    };
    doc.keys(&values)
        .filter_map(|key| kv_get(doc, &key).map(|value| (key, value)))
        .collect()
}

type RecordHook = Box<dyn FnOnce(&str) + Send>;

/// Room side.
#[derive(Default)]
pub(crate) struct TestKvKind {
    records: StdMutex<HashMap<String, KeyedDocRecord>>,
    blob_roots: StdMutex<BTreeSet<String>>,
    /// Runs once, right after the next `record` read.
    record_hook: StdMutex<Option<RecordHook>>,
}

impl TestKvKind {
    pub(crate) fn set_record(&self, id: &str, epoch: u64, accepts_peer_writes: bool) {
        lock(&self.records).insert(
            id.to_string(),
            KeyedDocRecord {
                epoch,
                accepts_peer_writes,
                status_label: if accepts_peer_writes {
                    "connected"
                } else {
                    "disconnected"
                },
            },
        );
    }

    pub(crate) fn remove_record(&self, id: &str) {
        lock(&self.records).remove(id);
    }

    /// Interleave `hook` between the next record read and what follows it.
    pub(crate) fn after_next_record(&self, hook: impl FnOnce(&str) + Send + 'static) {
        *lock(&self.record_hook) = Some(Box::new(hook));
    }

    pub(crate) fn set_blob_roots(&self, roots: impl IntoIterator<Item = String>) {
        *lock(&self.blob_roots) = roots.into_iter().collect();
    }
}

impl KeyedDocKind for TestKvKind {
    fn kind(&self) -> &'static str {
        TEST_KV
    }

    fn frame_limits(&self) -> FrameSizeLimits {
        FrameSizeLimits {
            cap: 64 * 1024,
            warn: 16 * 1024,
        }
    }

    fn record(&self, _state: &RuntimeStateDoc, id: &str) -> Option<KeyedDocRecord> {
        let record = lock(&self.records).get(id).cloned();
        let hook = lock(&self.record_hook).take();
        if let Some(hook) = hook {
            hook(id);
        }
        record
    }

    /// Only string values under `values` may change; judged on the state
    /// after the changes so the rule does not depend on op encoding.
    fn validate_peer_changes(
        &self,
        before: &AutoCommit,
        changes: &[automerge::Change],
        _ctx: &KeyedWriteContext,
    ) -> Result<(), KeyedDocRejection> {
        let mut after = before.clone();
        after
            .apply_changes(changes.iter().cloned())
            .map_err(|_| KeyedDocRejection::Undecodable)?;
        let root_before: BTreeSet<String> = before.keys(ROOT).collect();
        let root_after: BTreeSet<String> = after.keys(ROOT).collect();
        if root_before != root_after
            || before.get(ROOT, "epoch").ok() != after.get(ROOT, "epoch").ok()
        {
            return Err(KeyedDocRejection::Content(
                "only values may change".to_string(),
            ));
        }
        let Ok(Some((_, values))) = after.get(ROOT, "values") else {
            return Ok(());
        };
        for key in after.keys(&values) {
            if kv_get(&after, &key).is_none() {
                return Err(KeyedDocRejection::Content(format!(
                    "values.{key} must be a string"
                )));
            }
        }
        Ok(())
    }

    fn room_blob_roots(&self) -> BTreeSet<String> {
        lock(&self.blob_roots).clone()
    }

    fn referenced_blobs(&self, doc: &AutoCommit) -> BTreeSet<String> {
        kv_values(doc)
            .into_iter()
            .filter_map(|(key, value)| (key == "blob").then_some(value))
            .collect()
    }

    /// A document ends when its record is removed.
    fn on_runtime_state_change(&self, _state: &RuntimeStateDoc, ids: &[String]) -> Vec<String> {
        let records = lock(&self.records);
        ids.iter()
            .filter(|id| !records.contains_key(id.as_str()))
            .cloned()
            .collect()
    }
}

/// Agent side: the producer of every `test_kv` document.
#[derive(Default)]
pub(crate) struct TestKvAgentDoc {
    docs: StdMutex<HashMap<String, (u64, AutoCommit)>>,
    waker: StdMutex<Option<KeyedDocWaker>>,
}

impl TestKvAgentDoc {
    fn wake(&self) {
        if let Some(waker) = lock(&self.waker).as_ref() {
            waker.wake();
        }
    }

    pub(crate) fn insert(&self, id: &str, epoch: u64) {
        lock(&self.docs).insert(id.to_string(), (epoch, kv_build(epoch, &[])));
        self.wake();
    }

    pub(crate) fn put(&self, id: &str, key: &str, value: &str) {
        if let Some((_, doc)) = lock(&self.docs).get_mut(id) {
            kv_put(doc, key, value);
        }
        self.wake();
    }

    pub(crate) fn get(&self, id: &str, key: &str) -> Option<String> {
        lock(&self.docs)
            .get(id)
            .and_then(|(_, doc)| kv_get(doc, key))
    }

    /// Rebuild `id` as a fresh document at the next epoch, keeping values.
    pub(crate) fn replace(&self, id: &str) -> u64 {
        let mut docs = lock(&self.docs);
        let (epoch, doc) = docs.get_mut(id).expect("document exists");
        *epoch += 1;
        *doc = kv_build(*epoch, &kv_values(doc));
        let epoch = *epoch;
        drop(docs);
        self.wake();
        epoch
    }
}

impl AgentKeyedDoc for TestKvAgentDoc {
    fn kind(&self) -> &'static str {
        TEST_KV
    }

    fn attach(&self, waker: KeyedDocWaker) {
        *lock(&self.waker) = Some(waker);
    }

    fn generate_frames(&self, states: &mut KeyedSyncStates) -> Vec<Vec<u8>> {
        let mut docs = lock(&self.docs);
        docs.iter_mut()
            .filter_map(|(id, (epoch, doc))| {
                let key = KeyedDocKey::new(TEST_KV, id.as_str());
                let message = doc
                    .sync()
                    .generate_sync_message(states.for_epoch(&key, *epoch))?;
                Some(
                    KeyedDocFrameHeader::new(TEST_KV, id.as_str(), *epoch)
                        .encode_frame(&message.encode()),
                )
            })
            .collect()
    }

    fn receive_frame(
        &self,
        header: &KeyedDocFrameHeader,
        message: sync::Message,
        states: &mut KeyedSyncStates,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let mut docs = lock(&self.docs);
        let Some((epoch, doc)) = docs.get_mut(&header.id) else {
            return Ok(None);
        };
        if header.epoch != *epoch {
            return Ok(None);
        }
        let state = states.for_epoch(&header.key(), *epoch);
        doc.sync().receive_sync_message(state, message)?;
        let reply = doc.sync().generate_sync_message(state);
        Ok(reply.map(|reply| header.encode_frame(&reply.encode())))
    }
}
