//! CommsDoc — per-notebook Automerge document for widget comm state.
//!
//! RuntimeStateDoc owns comm topology: target name, model identity, output
//! routing, and insertion order. CommsDoc owns the mutable widget state map for
//! each `comm_id`. The runtime agent derives membership from RuntimeStateDoc
//! before forwarding any CommsDoc state to the kernel.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

#[cfg(test)]
use automerge::transaction::CommitOptions;
#[cfg(test)]
use automerge::ScalarValue;
use automerge::{
    sync, sync::SyncDoc, transaction::Transactable, ActorId, AutoCommit, AutomergeError, ObjId,
    ObjType, ReadDoc, Value, ROOT,
};
use automerge_recovery::{
    catch_automerge_panic, catch_automerge_result, is_recoverable_sync_error,
    recoverable_automerge_operation, AutomergeAttempt, AutomergeOperationError,
    AutomergeRebuildError,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::RuntimeStateError;

#[cfg(test)]
const COMMS_DOC_SCHEMA_SEED_ACTOR: &str = "nteract:comms-doc-schema:v1";
#[cfg(test)]
pub const COMMS_DOC_SCHEMA_VERSION: u64 = 1;
const COMMS_DOC_GENESIS_V1_BYTES: &[u8] = include_bytes!("../assets/comms_doc_genesis_v1.am");

/// Full comm-state snapshot, keyed by comm_id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CommsState {
    #[serde(default)]
    pub comms: HashMap<String, serde_json::Value>,
}

/// A sync receive result plus a per-field foreign-authored comm-state view.
#[derive(Debug, Clone)]
pub struct CommsForeignSyncView {
    pub applied_actors: Vec<ActorId>,
    pub foreign_comms: Option<HashMap<String, serde_json::Value>>,
}

/// Per-notebook Automerge document for widget comm state.
pub struct CommsDoc {
    doc: AutoCommit,
}

impl CommsDoc {
    pub fn try_new() -> Result<Self, RuntimeStateError> {
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::from(b"runtimed:comms" as &[u8]));
        Ok(Self { doc })
    }

    pub fn try_new_with_actor(actor_label: &str) -> Result<Self, RuntimeStateError> {
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::from(actor_label.as_bytes()));
        Ok(Self { doc })
    }

    pub fn try_new_empty() -> Result<Self, RuntimeStateError> {
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::random());
        Ok(Self { doc })
    }

    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self::try_new().unwrap_or_else(|err| panic!("seed comms doc schema: {err}"))
    }

    pub fn new_with_actor(actor_label: &str) -> Self {
        Self::try_new_with_actor(actor_label)
            .unwrap_or_else(|err| panic!("seed comms doc schema: {err}"))
    }

    pub fn new_empty() -> Self {
        Self::try_new_empty().unwrap_or_else(|err| panic!("seed comms doc schema: {err}"))
    }

    fn schema_seed_doc() -> Result<AutoCommit, RuntimeStateError> {
        AutoCommit::load(COMMS_DOC_GENESIS_V1_BYTES).map_err(RuntimeStateError::from)
    }

    #[cfg(test)]
    fn generated_schema_seed_doc() -> Result<AutoCommit, RuntimeStateError> {
        let mut doc = AutoCommit::new();
        doc.set_actor(ActorId::from(COMMS_DOC_SCHEMA_SEED_ACTOR.as_bytes()));
        scaffold_comms_doc_schema(&mut doc)?;
        let _ = doc.commit_with(
            CommitOptions::default()
                .with_message("Seed nteract comms doc schema")
                .with_time(0),
        );
        Ok(doc)
    }

    pub fn from_doc(doc: AutoCommit) -> Self {
        Self { doc }
    }

    pub fn doc(&self) -> &AutoCommit {
        &self.doc
    }

    pub fn doc_mut(&mut self) -> &mut AutoCommit {
        &mut self.doc
    }

    pub fn get_heads(&mut self) -> Vec<automerge::ChangeHash> {
        self.doc.get_heads()
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    pub fn transact_at_heads_recovering<F, T>(
        &mut self,
        heads: &[automerge::ChangeHash],
        actor: Option<&str>,
        label: &str,
        f: F,
    ) -> Result<T, RuntimeStateError>
    where
        F: FnOnce(&mut CommsDoc) -> Result<T, RuntimeStateError>,
    {
        use std::cell::Cell;

        let original_actor = self.doc.get_actor().clone();
        let isolated = Cell::new(false);
        let mut recovery_panic = None;

        let result = catch_automerge_result(label, || {
            if let Some(actor) = actor {
                self.doc.set_actor(ActorId::from(actor.as_bytes()));
            }
            self.doc.isolate(heads);
            isolated.set(true);
            let result = f(self);
            self.doc.integrate();
            isolated.set(false);
            result
        });

        if isolated.get() {
            if let Err(err) = catch_automerge_panic(format!("{label}:integrate"), || {
                self.doc.integrate();
            }) {
                recovery_panic = Some(err);
            }
        }

        if let Err(err) = catch_automerge_panic(format!("{label}:restore-actor"), || {
            self.doc.set_actor(original_actor);
        }) {
            recovery_panic.get_or_insert(err);
        }

        match (result, recovery_panic) {
            (AutomergeAttempt::Success(value), None) => Ok(value),
            (AutomergeAttempt::OperationError(source), None) => Err(source),
            (AutomergeAttempt::Panic(err), _) | (_, Some(err)) => {
                if let Err(source) = self.rebuild_from_save() {
                    return Err(AutomergeOperationError::rebuild_failed(label, source).into());
                }
                Err(AutomergeOperationError::Panic(err).into())
            }
        }
    }

    fn get_map(&self, key: &str) -> Option<ObjId> {
        match self.doc.get(&ROOT, key).ok().flatten() {
            Some((Value::Object(ObjType::Map), obj)) => Some(obj),
            _ => None,
        }
    }

    fn scaffold_map(&mut self, key: &'static str) -> Result<ObjId, RuntimeStateError> {
        if let Some(obj) = self.get_map(key) {
            return Ok(obj);
        }
        Ok(self.doc.put_object(&ROOT, key, ObjType::Map)?)
    }

    /// Read the full CommsDoc state.
    pub fn read_state(&self) -> CommsState {
        CommsState {
            comms: self.get_comms(),
        }
    }

    pub fn get_comm_state(&self, comm_id: &str) -> Option<serde_json::Value> {
        let comms = self.get_map("comms")?;
        automunge::read_json_value(&self.doc, &comms, comm_id)
    }

    pub fn get_comms(&self) -> HashMap<String, serde_json::Value> {
        let Some(comms_obj) = self.get_map("comms") else {
            return HashMap::new();
        };
        let mut comms = HashMap::new();
        for comm_id in self.doc.keys(&comms_obj) {
            if let Some(state) = automunge::read_json_value(&self.doc, &comms_obj, comm_id.as_str())
            {
                comms.insert(comm_id, state);
            }
        }
        comms
    }

    /// Replace a comm's full state map.
    pub fn put_comm_state(
        &mut self,
        comm_id: &str,
        state: &serde_json::Value,
    ) -> Result<(), RuntimeStateError> {
        let comms = self.scaffold_map("comms")?;
        if self.doc.get(&comms, comm_id)?.is_some() {
            automunge::update_json_at_key(&mut self.doc, &comms, comm_id, state)?;
        } else {
            automunge::put_json_at_key_batched(&mut self.doc, &comms, comm_id, state)?;
        }
        Ok(())
    }

    /// Set a single property in a comm's state map.
    pub fn set_comm_state_property(
        &mut self,
        comm_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), RuntimeStateError> {
        let comms = self.scaffold_map("comms")?;
        let state_obj = match self.doc.get(&comms, comm_id)? {
            Some((Value::Object(ObjType::Map), obj)) => obj,
            _ => self.doc.put_object(&comms, comm_id, ObjType::Map)?,
        };
        automunge::update_json_at_key(&mut self.doc, &state_obj, key, value)?;
        Ok(())
    }

    /// Merge a state delta into a comm's state map, skipping no-op scalar writes.
    pub fn merge_comm_state_delta(
        &mut self,
        comm_id: &str,
        delta: &serde_json::Value,
    ) -> Result<(), RuntimeStateError> {
        let Some(obj) = delta.as_object() else {
            return Ok(());
        };
        let comms = self.scaffold_map("comms")?;
        let state_obj = match self.doc.get(&comms, comm_id)? {
            Some((Value::Object(ObjType::Map), obj)) => obj,
            _ => self.doc.put_object(&comms, comm_id, ObjType::Map)?,
        };

        for (key, new_value) in obj {
            let should_write = match new_value {
                serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::Number(_)
                | serde_json::Value::String(_) => {
                    let current = automunge::read_json_value(&self.doc, &state_obj, key.as_str());
                    current.as_ref() != Some(new_value)
                }
                _ => true,
            };
            if should_write {
                automunge::update_json_at_key(&mut self.doc, &state_obj, key, new_value)?;
            }
        }
        Ok(())
    }

    pub fn remove_comm(&mut self, comm_id: &str) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        if self.doc.get(&comms, comm_id).ok().flatten().is_some() {
            self.doc.delete(&comms, comm_id)?;
        }
        Ok(())
    }

    pub fn clear_comms(&mut self) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        let keys: Vec<String> = self.doc.keys(&comms).collect();
        for key in keys {
            self.doc.delete(&comms, key.as_str())?;
        }
        Ok(())
    }

    /// Drop state for comm ids missing from RuntimeStateDoc topology.
    pub fn prune_orphan_comm_states(
        &mut self,
        active_comm_ids: &HashSet<String>,
    ) -> Result<Vec<String>, RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(Vec::new());
        };
        let keys: Vec<String> = self.doc.keys(&comms).collect();
        let mut removed = Vec::new();
        for key in keys {
            if !active_comm_ids.contains(&key) {
                self.doc.delete(&comms, key.as_str())?;
                removed.push(key);
            }
        }
        Ok(removed)
    }

    pub fn generate_sync_message(&mut self, peer_state: &mut sync::State) -> Option<sync::Message> {
        self.doc.sync().generate_sync_message(peer_state)
    }

    pub fn generate_sync_message_recovering(
        &mut self,
        peer_state: &mut sync::State,
        label: &str,
    ) -> Result<Option<sync::Message>, AutomergeOperationError> {
        let mut context = CommsSyncRecoveryContext {
            doc: self,
            peer_state,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| Ok(context.doc.generate_sync_message(context.peer_state)),
            |_| false,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    pub fn generate_sync_message_bounded_encoded(
        &mut self,
        peer_state: &mut sync::State,
        max_encoded_bytes: usize,
    ) -> Option<Vec<u8>> {
        let message = self.doc.sync().generate_sync_message(peer_state)?;
        let encoded = message.encode();
        if encoded.len() <= max_encoded_bytes {
            return Some(encoded);
        }
        if let Err(err) = self.rebuild_from_save() {
            tracing::warn!("[comms-doc] compaction rebuild failed: {}", err);
            return Some(encoded);
        }
        *peer_state = sync::State::new();
        self.doc
            .sync()
            .generate_sync_message(peer_state)
            .map(|msg| msg.encode())
    }

    pub fn generate_sync_message_bounded_encoded_recovering(
        &mut self,
        peer_state: &mut sync::State,
        max_encoded_bytes: usize,
        label: &str,
    ) -> Result<Option<Vec<u8>>, AutomergeOperationError> {
        let mut context = CommsBoundedSyncRecoveryContext {
            doc: self,
            peer_state,
            max_encoded_bytes,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                Ok(context.doc.generate_sync_message_bounded_encoded(
                    context.peer_state,
                    context.max_encoded_bytes,
                ))
            },
            |_| false,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    pub fn receive_sync_message_with_changes(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<bool, AutomergeError> {
        let heads_before = self.doc.get_heads();
        self.doc.sync().receive_sync_message(peer_state, message)?;
        Ok(self.doc.get_heads() != heads_before)
    }

    pub fn receive_sync_message_with_changes_recovering(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<bool, AutomergeOperationError> {
        let mut context = CommsSyncReceiveRecoveryContext {
            doc: self,
            peer_state,
            next_message: Some(message.clone()),
            retry_message: message,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context
                    .doc
                    .receive_sync_message_with_changes(context.peer_state, message)
            },
            is_recoverable_sync_error,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    pub fn receive_sync_and_foreign_comms<F>(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        is_foreign: F,
    ) -> Result<CommsForeignSyncView, AutomergeError>
    where
        F: Fn(&ActorId) -> bool,
    {
        let heads_before = self.doc.get_heads();
        self.doc.sync().receive_sync_message(peer_state, message)?;

        let applied = self.doc.get_changes(&heads_before);
        if applied.is_empty() {
            return Ok(CommsForeignSyncView {
                applied_actors: Vec::new(),
                foreign_comms: None,
            });
        }

        let applied_actors: Vec<ActorId> = applied.iter().map(|c| c.actor_id().clone()).collect();
        if !applied_actors.iter().any(&is_foreign) {
            return Ok(CommsForeignSyncView {
                applied_actors,
                foreign_comms: None,
            });
        }

        let comms_obj = match self.doc.get(ROOT, "comms")? {
            Some((Value::Object(ObjType::Map), obj)) => obj,
            _ => {
                return Ok(CommsForeignSyncView {
                    applied_actors,
                    foreign_comms: Some(HashMap::new()),
                });
            }
        };

        let mut foreign_comms: HashMap<String, serde_json::Value> = HashMap::new();
        for (comm_id, mut state) in self.get_comms() {
            let Some((Value::Object(ObjType::Map), state_obj)) =
                self.doc.get(&comms_obj, comm_id.as_str())?
            else {
                continue;
            };
            let Some(state_map) = state.as_object_mut() else {
                continue;
            };
            let keys: Vec<String> = state_map.keys().cloned().collect();
            for key in keys {
                let authored_by_foreign = match self.doc.get(&state_obj, key.as_str())? {
                    Some((value, obj_id)) => {
                        self.value_or_descendant_authored_by_foreign(&value, &obj_id, &is_foreign)?
                    }
                    _ => false,
                };
                if !authored_by_foreign {
                    state_map.remove(&key);
                }
            }
            if !state_map.is_empty() {
                foreign_comms.insert(comm_id, state);
            }
        }

        Ok(CommsForeignSyncView {
            applied_actors,
            foreign_comms: Some(foreign_comms),
        })
    }

    fn value_or_descendant_authored_by_foreign<F>(
        &self,
        value: &Value<'_>,
        obj_id: &ObjId,
        is_foreign: &F,
    ) -> Result<bool, AutomergeError>
    where
        F: Fn(&ActorId) -> bool,
    {
        if obj_id_authored_by_foreign(obj_id, is_foreign) {
            return Ok(true);
        }

        match value {
            Value::Object(ObjType::Map) => {
                for key in self.doc.keys(obj_id) {
                    if let Some((child_value, child_obj_id)) = self.doc.get(obj_id, key.as_str())? {
                        if self.value_or_descendant_authored_by_foreign(
                            &child_value,
                            &child_obj_id,
                            is_foreign,
                        )? {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
            Value::Object(ObjType::List) => {
                for index in 0..self.doc.length(obj_id) {
                    if let Some((child_value, child_obj_id)) = self.doc.get(obj_id, index)? {
                        if self.value_or_descendant_authored_by_foreign(
                            &child_value,
                            &child_obj_id,
                            is_foreign,
                        )? {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
            _ => Ok(false),
        }
    }

    pub fn receive_sync_and_foreign_comms_recovering<F>(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        is_foreign: F,
        label: &str,
    ) -> Result<CommsForeignSyncView, AutomergeOperationError>
    where
        F: Fn(&ActorId) -> bool,
    {
        let mut context = CommsForeignSyncReceiveRecoveryContext {
            doc: self,
            peer_state,
            next_message: Some(message.clone()),
            retry_message: message,
            is_foreign,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context.doc.receive_sync_and_foreign_comms(
                    context.peer_state,
                    message,
                    &context.is_foreign,
                )
            },
            is_recoverable_sync_error,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    pub fn rebuild_from_save(&mut self) -> Result<(), AutomergeRebuildError> {
        catch_automerge_panic("comms-doc-rebuild-from-save", || {
            let actor = self.doc.get_actor().clone();
            let bytes = self.doc.save();
            match AutoCommit::load(&bytes) {
                Ok(mut doc) => {
                    doc.set_actor(actor);
                    self.doc = doc;
                    Ok(())
                }
                Err(source) => Err(AutomergeRebuildError::load(source)),
            }
        })?
    }

    pub fn compact_if_oversized(&mut self, threshold: usize) -> bool {
        let actor = self.doc.get_actor().clone();
        let bytes = self.doc.save();
        if bytes.len() <= threshold {
            return false;
        }
        match AutoCommit::load(&bytes) {
            Ok(mut doc) => {
                doc.set_actor(actor);
                self.doc = doc;
                true
            }
            Err(err) => {
                tracing::warn!("[comms-doc] failed to compact oversized CommsDoc: {}", err);
                false
            }
        }
    }
}

fn obj_id_authored_by_foreign<F>(obj_id: &ObjId, is_foreign: &F) -> bool
where
    F: Fn(&ActorId) -> bool,
{
    match obj_id {
        ObjId::Id(_, actor, _) => is_foreign(actor),
        _ => false,
    }
}

struct CommsSyncRecoveryContext<'a> {
    doc: &'a mut CommsDoc,
    peer_state: &'a mut sync::State,
}

struct CommsBoundedSyncRecoveryContext<'a> {
    doc: &'a mut CommsDoc,
    peer_state: &'a mut sync::State,
    max_encoded_bytes: usize,
}

struct CommsSyncReceiveRecoveryContext<'a> {
    doc: &'a mut CommsDoc,
    peer_state: &'a mut sync::State,
    next_message: Option<sync::Message>,
    retry_message: sync::Message,
}

struct CommsForeignSyncReceiveRecoveryContext<'a, F> {
    doc: &'a mut CommsDoc,
    peer_state: &'a mut sync::State,
    next_message: Option<sync::Message>,
    retry_message: sync::Message,
    is_foreign: F,
}

#[cfg(test)]
fn scaffold_comms_doc_schema(doc: &mut AutoCommit) -> Result<(), RuntimeStateError> {
    doc.put(
        &ROOT,
        "schema_version",
        ScalarValue::Uint(COMMS_DOC_SCHEMA_VERSION),
    )?;
    doc.put_object(&ROOT, "comms", ObjType::Map)?;
    Ok(())
}

/// Handle to a per-notebook CommsDoc.
#[derive(Clone)]
pub struct CommsDocHandle {
    doc: Arc<Mutex<CommsDoc>>,
    changed_tx: broadcast::Sender<()>,
}

impl CommsDocHandle {
    pub fn new(doc: CommsDoc, changed_tx: broadcast::Sender<()>) -> Self {
        Self {
            doc: Arc::new(Mutex::new(doc)),
            changed_tx,
        }
    }

    pub fn with_doc<F, T>(&self, f: F) -> Result<T, RuntimeStateError>
    where
        F: FnOnce(&mut CommsDoc) -> Result<T, RuntimeStateError>,
    {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        let heads_before = doc.get_heads();
        let result = f(&mut doc);
        if doc.get_heads() != heads_before {
            let _ = self.changed_tx.send(());
        }
        result
    }

    pub fn generate_sync_message_recovering(
        &self,
        peer_state: &mut sync::State,
        label: &str,
    ) -> Result<Option<sync::Message>, RuntimeStateError> {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        doc.generate_sync_message_recovering(peer_state, label)
            .map_err(Into::into)
    }

    pub fn generate_sync_message_bounded_encoded_recovering(
        &self,
        peer_state: &mut sync::State,
        max_encoded_bytes: usize,
        label: &str,
    ) -> Result<Option<Vec<u8>>, RuntimeStateError> {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        doc.generate_sync_message_bounded_encoded_recovering(peer_state, max_encoded_bytes, label)
            .map_err(Into::into)
    }

    pub fn receive_sync_message_with_changes_recovering(
        &self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<bool, RuntimeStateError> {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        doc.receive_sync_message_with_changes_recovering(peer_state, message, label)
            .map_err(Into::into)
    }

    pub fn receive_sync_and_foreign_comms_recovering<F>(
        &self,
        peer_state: &mut sync::State,
        message: sync::Message,
        is_foreign: F,
        label: &str,
    ) -> Result<CommsForeignSyncView, RuntimeStateError>
    where
        F: Fn(&ActorId) -> bool,
    {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        doc.receive_sync_and_foreign_comms_recovering(peer_state, message, is_foreign, label)
            .map_err(Into::into)
    }

    pub fn read<F, T>(&self, f: F) -> Result<T, RuntimeStateError>
    where
        F: FnOnce(&CommsDoc) -> T,
    {
        let doc = self
            .doc
            .lock()
            .map_err(|_| RuntimeStateError::LockPoisoned)?;
        Ok(f(&doc))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changed_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change_hashes_for_actor(doc: &mut AutoCommit, actor: &str) -> Vec<automerge::ChangeHash> {
        doc.get_changes(&[])
            .into_iter()
            .filter(|change| change.actor_id() == &ActorId::from(actor.as_bytes()))
            .map(|change| change.hash())
            .collect()
    }

    #[test]
    fn comms_doc_genesis_artifact_matches_scaffold() {
        let mut generated = CommsDoc::generated_schema_seed_doc().unwrap();
        let mut frozen = CommsDoc::schema_seed_doc().unwrap();

        assert_eq!(
            change_hashes_for_actor(&mut generated, COMMS_DOC_SCHEMA_SEED_ACTOR),
            change_hashes_for_actor(&mut frozen, COMMS_DOC_SCHEMA_SEED_ACTOR)
        );
        assert_eq!(
            CommsDoc::from_doc(generated).read_state(),
            CommsDoc::from_doc(frozen).read_state()
        );
    }

    #[test]
    #[ignore]
    fn write_comms_doc_genesis_artifact() {
        let Some(path) = std::env::var_os("COMMS_DOC_GENESIS_OUT") else {
            return;
        };
        let mut generated = CommsDoc::generated_schema_seed_doc().unwrap();
        std::fs::write(path, generated.save()).unwrap();
    }

    #[test]
    fn comms_doc_stores_state_as_per_key_map() {
        let mut doc = CommsDoc::new();
        doc.put_comm_state("comm-1", &serde_json::json!({"value": 1, "label": "x"}))
            .unwrap();
        doc.set_comm_state_property("comm-1", "value", &serde_json::json!(2))
            .unwrap();

        assert_eq!(
            doc.get_comm_state("comm-1").unwrap(),
            serde_json::json!({"value": 2, "label": "x"})
        );
    }

    fn sync_until_foreign_view(
        receiver: &mut CommsDoc,
        donor: &mut CommsDoc,
    ) -> CommsForeignSyncView {
        let mut receiver_sync = sync::State::new();
        let mut donor_sync = sync::State::new();

        for _ in 0..8 {
            if let Some(msg) = donor.generate_sync_message(&mut donor_sync) {
                let view = receiver
                    .receive_sync_and_foreign_comms(&mut receiver_sync, msg, |actor| {
                        !actor.to_bytes().starts_with(b"rt:kernel:")
                    })
                    .expect("receive");
                if view.foreign_comms.is_some() {
                    return view;
                }
            }

            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                donor
                    .receive_sync_message_with_changes(&mut donor_sync, reply)
                    .expect("donor receive");
            }
        }

        panic!("sync never converged to produce a foreign view");
    }

    #[test]
    fn foreign_sync_view_keeps_property_with_foreign_nested_winner() {
        let mut receiver = CommsDoc::new_with_actor("rt:kernel:deadbeef");
        receiver
            .put_comm_state(
                "scatter",
                &serde_json::json!({
                    "selection": {
                        "view": null,
                        "dtype": "uint32",
                        "shape": [0]
                    },
                    "unchanged": "kernel"
                }),
            )
            .unwrap();

        let mut donor = CommsDoc::from_doc(receiver.doc().clone());
        donor
            .doc_mut()
            .set_actor(ActorId::from(b"human:peer" as &[u8]));
        donor
            .set_comm_state_property(
                "scatter",
                "selection",
                &serde_json::json!({
                    "view": {
                        "blob": "abcdef",
                        "size": 4,
                        "media_type": "application/octet-stream"
                    },
                    "dtype": "uint32",
                    "shape": [7]
                }),
            )
            .unwrap();

        let view = sync_until_foreign_view(&mut receiver, &mut donor);
        let foreign_comms = view.foreign_comms.expect("foreign comms");
        let scatter = foreign_comms
            .get("scatter")
            .and_then(|state| state.as_object())
            .expect("scatter state");

        assert!(
            scatter.contains_key("selection"),
            "foreign nested writes must keep the top-level property: {scatter:?}"
        );
        assert!(
            !scatter.contains_key("unchanged"),
            "kernel-only sibling properties should still be stripped: {scatter:?}"
        );
        assert_eq!(
            scatter.get("selection"),
            Some(&serde_json::json!({
                "view": {
                    "blob": "abcdef",
                    "size": 4,
                    "media_type": "application/octet-stream"
                },
                "dtype": "uint32",
                "shape": [7]
            }))
        );
    }

    #[test]
    fn prune_orphan_comm_states_removes_topology_absent_entries() {
        let mut doc = CommsDoc::new();
        doc.put_comm_state("alive", &serde_json::json!({"value": 1}))
            .unwrap();
        doc.put_comm_state("orphan", &serde_json::json!({"value": 2}))
            .unwrap();
        let active = HashSet::from(["alive".to_string()]);

        let removed = doc.prune_orphan_comm_states(&active).unwrap();

        assert_eq!(removed, vec!["orphan".to_string()]);
        assert!(doc.get_comm_state("orphan").is_none());
        assert!(doc.get_comm_state("alive").is_some());
    }
}
