//! BokehSessionDoc: one Automerge document per Bokeh document session.
//!
//! The kernel's runtime agent is the only writer of structure: it builds each
//! epoch's document from materialized state and applies kernel deltas. Other
//! peers (browsers, agents) start empty, sync, and may only write scalar
//! values of non-reference properties of models that already exist, and
//! never a value Bokeh reads as a model or readers read as a blob ref. See
//! `docs/adr/bokeh-session-documents.md` for the design and measurements.
//!
//! Layout:
//!
//! ```text
//! schema_version             u64
//! epoch                      u64, incremented on each replacement
//! meta/                      session_id, producer_name, producer_version,
//!                            bokeh_version, root_ids (JSON), title?, doc_extras?
//! models/{id}/type           Bokeh model name
//! models/{id}/ref_props      JSON list of properties that can hold references
//! models/{id}/props/{name}   Bokeh-encoded JSON, or a blob ref
//! columns/{source_id}/{col}  JSON {blob, size, version}
//! ```
//!
//! Values are JSON strings rather than native maps: Phase 0 measured them at
//! 63% of the size and half the materialize time, and each property write is
//! still one op carrying its actor (ADR 0002's per-key requirement).

use std::borrow::{Borrow, BorrowMut};
use std::collections::{BTreeMap, BTreeSet, HashMap};

use automerge::legacy::{Key as LegacyKey, ObjectId as LegacyObjectId, OpType as LegacyOpType};
use automerge::{
    sync, sync::SyncDoc, transaction::CommitOptions, transaction::Transactable, ActorId,
    AutoCommit, AutomergeError, Change, ChangeHash, ObjId, ObjType, PatchAction, Prop, ReadDoc,
    ScalarValue, Value, ROOT,
};
use serde::{Deserialize, Serialize};

use crate::{BokehSessionStatus, RuntimeStateError, RuntimeStateWriteScope};

pub const BOKEH_SESSION_DOC_SCHEMA_VERSION: u64 = 1;

/// Property values larger than this go to the blob store, as in `output_prep.rs`.
pub const BOKEH_PROP_BLOB_THRESHOLD: usize = 1024;

/// Lower cutoff for array-like values (palettes, ticks, small images), so
/// frequent small-array updates do not grow history. Phase 0b: 2.6x less
/// history than inline storage at 20 Hz.
pub const BOKEH_ARRAY_PROP_BLOB_THRESHOLD: usize = 256;

// ── Value types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BokehSessionMeta {
    pub session_id: String,
    pub producer_name: String,
    pub producer_version: String,
    pub bokeh_version: String,
    #[serde(default)]
    pub root_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// DocJson keys beside roots, title and version (`defs`, `config`), as
    /// encoded JSON or a blob ref.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_extras: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BokehModelState {
    #[serde(rename = "type")]
    pub type_name: String,
    /// Properties whose Python descriptor `has_ref`; peers never write these.
    #[serde(default)]
    pub ref_props: Vec<String>,
    /// Bokeh-encoded JSON per property; references are `{"id": ...}`.
    #[serde(default)]
    pub props: BTreeMap<String, String>,
}

/// Current blob of one `ColumnDataSource` column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BokehColumnRef {
    pub blob: String,
    pub size: u64,
    pub version: u64,
}

/// A property or `doc_extras` value moved to the blob store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BokehBlobRef {
    pub blob: String,
    pub size: u64,
    pub media_type: String,
}

impl BokehBlobRef {
    pub fn parse(encoded: &str) -> Option<Self> {
        serde_json::from_str(encoded).ok()
    }

    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Materialized session state; what an epoch's document is built from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BokehSessionSnapshot {
    pub epoch: u64,
    pub meta: BokehSessionMeta,
    #[serde(default)]
    pub models: BTreeMap<String, BokehModelState>,
    #[serde(default)]
    pub columns: BTreeMap<String, BTreeMap<String, BokehColumnRef>>,
}

/// A kernel delta after blob offload, applied under the kernel actor.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BokehSessionDocDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<BokehSessionMeta>,
    #[serde(default)]
    pub models_added: BTreeMap<String, BokehModelState>,
    #[serde(default)]
    pub props_changed: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(default)]
    pub columns_changed: BTreeMap<String, BTreeMap<String, BokehColumnRef>>,
    #[serde(default)]
    pub columns_removed: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub models_removed: Vec<String>,
}

/// What changed between two sets of heads, for building a Bokeh patch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BokehSessionChangeset {
    pub models_added: BTreeSet<String>,
    pub models_removed: BTreeSet<String>,
    /// Changed property names of models that existed before and after.
    pub props_changed: BTreeMap<String, BTreeSet<String>>,
    /// Changed columns per source; an empty set means the whole source.
    pub columns_changed: BTreeMap<String, BTreeSet<String>>,
    pub meta_changed: bool,
}

impl BokehSessionChangeset {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// A sync receive plus the property values whose winning write is foreign.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BokehForeignSyncView {
    pub changeset: BokehSessionChangeset,
    /// Current values of changed properties won by a foreign actor, by model.
    pub foreign_props: BTreeMap<String, BTreeMap<String, String>>,
}

/// Blob cutoff for an encoded property value.
pub fn bokeh_prop_blob_threshold(encoded: &str) -> usize {
    if encoded.len() > BOKEH_ARRAY_PROP_BLOB_THRESHOLD
        && encoded.len() <= BOKEH_PROP_BLOB_THRESHOLD
        && is_array_like(encoded)
    {
        BOKEH_ARRAY_PROP_BLOB_THRESHOLD
    } else {
        BOKEH_PROP_BLOB_THRESHOLD
    }
}

/// Whether the agent must move this encoded value to the blob store.
pub fn bokeh_prop_needs_blob(encoded: &str) -> bool {
    encoded.len() > bokeh_prop_blob_threshold(encoded)
}

fn is_array_like(encoded: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(encoded) {
        Ok(serde_json::Value::Array(_)) => true,
        Ok(serde_json::Value::Object(map)) => matches!(
            map.get("type").and_then(serde_json::Value::as_str),
            Some("ndarray" | "typed_array" | "bytes")
        ),
        _ => false,
    }
}

// ── Write authority ────────────────────────────────────────────────────

/// Why a peer write to a session document was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BokehSessionWriteRejection {
    #[error("scope {0} cannot write Bokeh session documents")]
    Scope(&'static str),
    #[error("Bokeh session is {0:?}; only connected sessions accept writes")]
    SessionNotConnected(BokehSessionStatus),
    #[error("epoch {frame} is not the current epoch {current}")]
    StaleEpoch { frame: u64, current: u64 },
    #[error("write outside the props of an existing model")]
    NotAModelProperty,
    #[error("model {0} does not exist")]
    UnknownModel(String),
    #[error("{model}.{prop} can hold model references")]
    ReferenceProperty { model: String, prop: String },
    #[error("{model}.{prop} must be a JSON string value")]
    InvalidValue { model: String, prop: String },
    #[error("{model}.{prop} value holds a model reference")]
    ModelReferenceValue { model: String, prop: String },
    #[error("{model}.{prop} value is shaped like a blob ref")]
    BlobRefValue { model: String, prop: String },
    #[error("{0} operations are not allowed for peers")]
    ForbiddenOperation(&'static str),
    #[error("change actor {0} does not belong to this connection")]
    UnauthorizedActor(String),
}

#[derive(Debug, thiserror::Error)]
pub enum BokehSessionIngressError {
    #[error(transparent)]
    Rejected(#[from] BokehSessionWriteRejection),
    #[error("automerge: {0}")]
    Automerge(#[from] AutomergeError),
}

/// What a connection may write once its frame passed the epoch check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BokehWritePermission {
    /// The runtime agent: models, references, columns and meta.
    Structural,
    /// Editors and owners: non-reference properties of existing models.
    PropertiesOnly,
}

/// Facts the ingress filter needs from the connection and RuntimeStateDoc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BokehSessionWriteContext {
    pub scope: RuntimeStateWriteScope,
    pub status: BokehSessionStatus,
    pub current_epoch: u64,
}

impl BokehSessionWriteContext {
    /// Transport check on the frame header; failing frames are dropped whole.
    ///
    /// The runtime agent may run ahead: it builds epoch N+1 before
    /// RuntimeStateDoc announces it, so only older epochs are stale for it.
    pub fn check_frame_epoch(&self, frame_epoch: u64) -> Result<(), BokehSessionWriteRejection> {
        let stale = match self.scope {
            RuntimeStateWriteScope::RuntimePeer => frame_epoch < self.current_epoch,
            _ => frame_epoch != self.current_epoch,
        };
        if stale {
            return Err(BokehSessionWriteRejection::StaleEpoch {
                frame: frame_epoch,
                current: self.current_epoch,
            });
        }
        Ok(())
    }

    /// On `Err`, strip the message's changes and keep syncing read-only.
    pub fn write_permission(&self) -> Result<BokehWritePermission, BokehSessionWriteRejection> {
        match self.scope {
            RuntimeStateWriteScope::RuntimePeer => Ok(BokehWritePermission::Structural),
            RuntimeStateWriteScope::Viewer => Err(BokehSessionWriteRejection::Scope(
                RuntimeStateWriteScope::Viewer.as_str(),
            )),
            RuntimeStateWriteScope::Editor | RuntimeStateWriteScope::Owner => {
                if self.status == BokehSessionStatus::Connected {
                    Ok(BokehWritePermission::PropertiesOnly)
                } else {
                    Err(BokehSessionWriteRejection::SessionNotConnected(self.status))
                }
            }
        }
    }
}

/// Props maps peers may write, keyed by object id, from the pre-receive doc.
struct WritableProps {
    by_obj: HashMap<(u64, ActorId), (String, BTreeSet<String>)>,
}

// ── Document ───────────────────────────────────────────────────────────

/// A session document over an owned (`BokehSessionDoc`) or borrowed
/// (`BokehSessionDocRef`) Automerge document. Reads work on both; writes
/// and sync need the owned form.
pub struct BokehSessionDocOf<D> {
    doc: D,
}

pub type BokehSessionDoc = BokehSessionDocOf<AutoCommit>;

/// Read-only view of a replica held elsewhere, e.g. the room hub's.
pub type BokehSessionDocRef<'a> = BokehSessionDocOf<&'a AutoCommit>;

/// Writable view of a replica held elsewhere, e.g. a keyed-doc replica.
pub type BokehSessionDocMut<'a> = BokehSessionDocOf<&'a mut AutoCommit>;

impl<D> BokehSessionDocOf<D> {
    /// Wrap a document without touching its actor.
    pub fn from_doc(doc: D) -> Self {
        Self { doc }
    }

    pub fn into_doc(self) -> D {
        self.doc
    }
}

impl BokehSessionDoc {
    /// Build an epoch's document. Deterministic for a given snapshot and
    /// actor (sorted keys, one change, time 0), so rebuilding the same state
    /// yields the same heads.
    pub fn build(
        snapshot: &BokehSessionSnapshot,
        actor_label: &str,
    ) -> Result<Self, RuntimeStateError> {
        let mut doc = AutoCommit::new().with_actor(ActorId::from(actor_label.as_bytes()));
        doc.put(
            &ROOT,
            "schema_version",
            ScalarValue::Uint(BOKEH_SESSION_DOC_SCHEMA_VERSION),
        )?;
        doc.put(&ROOT, "epoch", ScalarValue::Uint(snapshot.epoch))?;
        doc.put_object(&ROOT, "meta", ObjType::Map)?;
        doc.put_object(&ROOT, "models", ObjType::Map)?;
        doc.put_object(&ROOT, "columns", ObjType::Map)?;
        let mut this = Self { doc };
        this.put_meta(&snapshot.meta)?;
        for (id, model) in &snapshot.models {
            this.put_model(id, model)?;
        }
        for (source_id, columns) in &snapshot.columns {
            for (column, column_ref) in columns {
                this.set_column(source_id, column, column_ref)?;
            }
        }
        this.doc.commit_with(
            CommitOptions::default()
                .with_time(0)
                .with_message(format!("Bokeh session epoch {}", snapshot.epoch)),
        );
        Ok(this)
    }

    /// An empty replica that receives an epoch's document through sync.
    pub fn new_empty(actor_label: &str) -> Self {
        Self {
            doc: AutoCommit::new().with_actor(ActorId::from(actor_label.as_bytes())),
        }
    }

    pub fn load(bytes: &[u8], actor_label: &str) -> Result<Self, RuntimeStateError> {
        let mut doc = AutoCommit::load(bytes)?;
        doc.set_actor(ActorId::from(actor_label.as_bytes()));
        Ok(Self { doc })
    }
}

impl<D: BorrowMut<AutoCommit>> BokehSessionDocOf<D> {
    fn am_mut(&mut self) -> &mut AutoCommit {
        self.doc.borrow_mut()
    }

    pub fn doc_mut(&mut self) -> &mut AutoCommit {
        self.am_mut()
    }

    pub fn set_actor(&mut self, actor_label: &str) {
        self.am_mut()
            .set_actor(ActorId::from(actor_label.as_bytes()));
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.am_mut().save()
    }

    pub fn get_heads(&mut self) -> Vec<ChangeHash> {
        self.am_mut().get_heads()
    }

    /// Group pending writes into one change.
    pub fn commit(&mut self) -> Option<ChangeHash> {
        self.am_mut().commit()
    }

    // ── Kernel writes ──────────────────────────────────────────────────

    pub fn put_meta(&mut self, meta: &BokehSessionMeta) -> Result<(), RuntimeStateError> {
        let obj = self.root_map("meta")?;
        let root_ids = serde_json::to_string(&meta.root_ids).unwrap_or_default();
        for (key, value) in [
            ("session_id", Some(meta.session_id.as_str())),
            ("producer_name", Some(meta.producer_name.as_str())),
            ("producer_version", Some(meta.producer_version.as_str())),
            ("bokeh_version", Some(meta.bokeh_version.as_str())),
            ("root_ids", Some(root_ids.as_str())),
            ("title", meta.title.as_deref()),
            ("doc_extras", meta.doc_extras.as_deref()),
        ] {
            match value {
                Some(value) => {
                    self.put_str_if_changed(&obj, key, value)?;
                }
                None => {
                    if self.am_mut().get(&obj, key)?.is_some() {
                        self.am_mut().delete(&obj, key)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Add a model, or bring an existing one to exactly this state.
    pub fn put_model(
        &mut self,
        model_id: &str,
        model: &BokehModelState,
    ) -> Result<(), RuntimeStateError> {
        let models = self.root_map("models")?;
        let (model_obj, props_obj) = match self.model_obj(model_id) {
            Some(model_obj) => {
                let props_obj = match self.map_at(&model_obj, "props") {
                    Some(props) => props,
                    None => self
                        .am_mut()
                        .put_object(&model_obj, "props", ObjType::Map)?,
                };
                (model_obj, props_obj)
            }
            None => {
                let model_obj = self.am_mut().put_object(&models, model_id, ObjType::Map)?;
                let props_obj = self
                    .am_mut()
                    .put_object(&model_obj, "props", ObjType::Map)?;
                (model_obj, props_obj)
            }
        };
        self.put_str_if_changed(&model_obj, "type", &model.type_name)?;
        let ref_props = serde_json::to_string(&model.ref_props).unwrap_or_default();
        self.put_str_if_changed(&model_obj, "ref_props", &ref_props)?;
        let stale: Vec<String> = self
            .am()
            .keys(&props_obj)
            .filter(|name| !model.props.contains_key(name))
            .collect();
        for name in stale {
            self.am_mut().delete(&props_obj, name.as_str())?;
        }
        for (name, value) in &model.props {
            self.put_str_if_changed(&props_obj, name, value)?;
        }
        Ok(())
    }

    /// Remove a model and its column data.
    pub fn remove_model(&mut self, model_id: &str) -> Result<bool, RuntimeStateError> {
        let models = self.root_map("models")?;
        let existed = self.am_mut().get(&models, model_id)?.is_some();
        if existed {
            self.am_mut().delete(&models, model_id)?;
        }
        let columns = self.root_map("columns")?;
        if self.am_mut().get(&columns, model_id)?.is_some() {
            self.am_mut().delete(&columns, model_id)?;
        }
        Ok(existed)
    }

    /// Set one property; returns whether the document changed.
    pub fn set_prop(
        &mut self,
        model_id: &str,
        name: &str,
        encoded: &str,
    ) -> Result<bool, RuntimeStateError> {
        let props = self.props_obj(model_id).ok_or_else(|| {
            RuntimeStateError::InvalidBokehSession(format!("unknown model {model_id}"))
        })?;
        self.put_str_if_changed(&props, name, encoded)
    }

    pub fn set_column(
        &mut self,
        source_id: &str,
        column: &str,
        column_ref: &BokehColumnRef,
    ) -> Result<bool, RuntimeStateError> {
        let columns = self.root_map("columns")?;
        let source = match self.map_at(&columns, source_id) {
            Some(source) => source,
            None => self
                .am_mut()
                .put_object(&columns, source_id, ObjType::Map)?,
        };
        let encoded = serde_json::to_string(column_ref).unwrap_or_default();
        self.put_str_if_changed(&source, column, &encoded)
    }

    pub fn remove_column(
        &mut self,
        source_id: &str,
        column: &str,
    ) -> Result<bool, RuntimeStateError> {
        let columns = self.root_map("columns")?;
        let Some(source) = self.map_at(&columns, source_id) else {
            return Ok(false);
        };
        if self.am_mut().get(&source, column)?.is_none() {
            return Ok(false);
        }
        self.am_mut().delete(&source, column)?;
        Ok(true)
    }

    /// Apply a kernel delta. The caller commits, so a coalesced flush lands as
    /// one change and new models arrive with the references to them.
    pub fn apply_delta(&mut self, delta: &BokehSessionDocDelta) -> Result<(), RuntimeStateError> {
        if let Some(meta) = &delta.meta {
            self.put_meta(meta)?;
        }
        for (id, model) in &delta.models_added {
            self.put_model(id, model)?;
        }
        for (id, props) in &delta.props_changed {
            for (name, value) in props {
                self.set_prop(id, name, value)?;
            }
        }
        for (source_id, columns) in &delta.columns_changed {
            for (column, column_ref) in columns {
                self.set_column(source_id, column, column_ref)?;
            }
        }
        for (source_id, columns) in &delta.columns_removed {
            for column in columns {
                self.remove_column(source_id, column)?;
            }
        }
        for id in &delta.models_removed {
            self.remove_model(id)?;
        }
        Ok(())
    }

    /// Write `{model_id: {prop: encoded}}` as one peer change, applying the
    /// ingress filter's rules first so a refused batch writes nothing.
    /// Returns whether the document changed.
    pub fn write_peer_props(
        &mut self,
        context: &BokehSessionWriteContext,
        props: &BTreeMap<String, BTreeMap<String, String>>,
    ) -> Result<bool, BokehSessionWriteRejection> {
        context.write_permission()?;
        let epoch = self.epoch().unwrap_or(context.current_epoch);
        context.check_frame_epoch(epoch)?;
        for (model_id, values) in props {
            for (name, encoded) in values {
                self.check_peer_write(model_id, name, encoded)?;
            }
        }
        let mut changed = false;
        for (model_id, values) in props {
            for (name, encoded) in values {
                changed |= self
                    .set_prop(model_id, name, encoded)
                    .map_err(|_| BokehSessionWriteRejection::UnknownModel(model_id.clone()))?;
            }
        }
        self.commit();
        Ok(changed)
    }

    // ── Sync ───────────────────────────────────────────────────────────

    pub fn generate_sync_message(&mut self, peer_state: &mut sync::State) -> Option<sync::Message> {
        self.am_mut().sync().generate_sync_message(peer_state)
    }

    /// Unfiltered receive, for replicas syncing from the daemon.
    pub fn receive_sync_message(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<BokehSessionChangeset, AutomergeError> {
        let before = self.am_mut().get_heads();
        self.am_mut()
            .sync()
            .receive_sync_message(peer_state, message)?;
        let after = self.am_mut().get_heads();
        Ok(self.diff(&before, &after))
    }

    /// Ingress for a peer's message. The caller has checked the frame epoch
    /// and stripped changes when `write_permission` failed; the checks are
    /// repeated here so this entry point cannot admit a forbidden write. On
    /// rejection the document and `peer_state` are unchanged.
    pub fn receive_peer_sync_message(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        context: &BokehSessionWriteContext,
    ) -> Result<BokehSessionChangeset, BokehSessionIngressError> {
        self.receive_peer_sync_message_checked(peer_state, message, context, |_| true)
    }

    /// `receive_peer_sync_message`, also requiring every new property
    /// change's actor to pass `actor_ok` (the connection's principal check).
    pub fn receive_peer_sync_message_checked<F>(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        context: &BokehSessionWriteContext,
        actor_ok: F,
    ) -> Result<BokehSessionChangeset, BokehSessionIngressError>
    where
        F: Fn(&ActorId) -> bool,
    {
        if message.changes.is_empty() {
            return Ok(self.receive_sync_message(peer_state, message)?);
        }
        match context.write_permission()? {
            BokehWritePermission::Structural => Ok(self.receive_sync_message(peer_state, message)?),
            BokehWritePermission::PropertiesOnly => {
                // Validate on a clone, as peer_comms_sync.rs does: sync
                // messages carry change chunks that cannot be split.
                let before = self.am_mut().get_heads();
                let mut preview = self.am_mut().clone();
                let mut preview_state = peer_state.clone();
                preview
                    .sync()
                    .receive_sync_message(&mut preview_state, message)?;
                let changes = preview.get_changes(&before);
                for change in &changes {
                    if !actor_ok(change.actor_id()) {
                        return Err(BokehSessionWriteRejection::UnauthorizedActor(
                            String::from_utf8_lossy(change.actor_id().to_bytes()).into_owned(),
                        )
                        .into());
                    }
                }
                self.validate_peer_changes(&changes, context.current_epoch)?;
                *self.am_mut() = preview;
                *peer_state = preview_state;
                let after = self.am_mut().get_heads();
                Ok(self.diff(&before, &after))
            }
        }
    }

    /// Receive and report which changed properties a foreign actor won; the
    /// runtime agent forwards those to the kernel.
    pub fn receive_sync_and_foreign_props<F>(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        is_foreign: F,
    ) -> Result<BokehForeignSyncView, AutomergeError>
    where
        F: Fn(&ActorId) -> bool,
    {
        let changeset = self.receive_sync_message(peer_state, message)?;
        let foreign_props = self.foreign_props(&changeset, is_foreign);
        Ok(BokehForeignSyncView {
            changeset,
            foreign_props,
        })
    }

    /// Classify the document patches between two sets of heads.
    pub fn diff(&mut self, before: &[ChangeHash], after: &[ChangeHash]) -> BokehSessionChangeset {
        let mut changeset = BokehSessionChangeset::default();
        if before == after {
            return changeset;
        }
        for patch in self.am_mut().diff(before, after) {
            let path: Vec<&str> = patch
                .path
                .iter()
                .map(|(_, prop)| match prop {
                    Prop::Map(key) => key.as_str(),
                    Prop::Seq(_) => "",
                })
                .collect();
            let key = match &patch.action {
                PatchAction::PutMap { key, .. } | PatchAction::DeleteMap { key } => key.as_str(),
                _ => continue,
            };
            let deleted = matches!(patch.action, PatchAction::DeleteMap { .. });
            match path.as_slice() {
                [] if key == "meta" => changeset.meta_changed = true,
                ["meta", ..] => changeset.meta_changed = true,
                ["models"] => {
                    if deleted {
                        changeset.models_removed.insert(key.to_string());
                    } else {
                        changeset.models_added.insert(key.to_string());
                    }
                }
                ["models", id, "props", ..] => {
                    changeset
                        .props_changed
                        .entry((*id).to_string())
                        .or_default()
                        .insert(key.to_string());
                }
                // `type` or `ref_props` moved: consumers re-read the whole model.
                ["models", id] if key != "props" => {
                    changeset.models_added.insert((*id).to_string());
                }
                ["columns"] => {
                    changeset
                        .columns_changed
                        .entry(key.to_string())
                        .or_default();
                }
                ["columns", source_id, ..] => {
                    changeset
                        .columns_changed
                        .entry((*source_id).to_string())
                        .or_default()
                        .insert(key.to_string());
                }
                _ => {}
            }
        }
        // A model removed and re-added in the window is a re-read.
        let present: BTreeSet<String> = self.model_ids().into_iter().collect();
        changeset.models_added.retain(|id| present.contains(id));
        changeset.models_removed.retain(|id| !present.contains(id));
        let rewritten: BTreeSet<String> = changeset
            .models_added
            .union(&changeset.models_removed)
            .cloned()
            .collect();
        changeset
            .props_changed
            .retain(|id, _| !rewritten.contains(id));
        changeset
    }

    // ── Replacement ────────────────────────────────────────────────────

    /// Build the next epoch's document from this document's current state.
    ///
    /// The caller must have forwarded foreign property changes to the kernel
    /// first: the new document authors every value under `actor_label`.
    pub fn build_replacement(
        &mut self,
        actor_label: &str,
    ) -> Result<BokehSessionReplacement, RuntimeStateError> {
        let mut snapshot = self.read_snapshot()?;
        let previous_epoch = snapshot.epoch;
        snapshot.epoch += 1;
        Ok(BokehSessionReplacement {
            doc: BokehSessionDoc::build(&snapshot, actor_label)?,
            epoch: snapshot.epoch,
            previous_epoch,
            previous_heads: self.am_mut().get_heads(),
        })
    }

    /// Skips equal writes so unchanged values cost no history.
    fn put_str_if_changed(
        &mut self,
        obj: &ObjId,
        key: &str,
        value: &str,
    ) -> Result<bool, RuntimeStateError> {
        if self.read_str(obj, key).as_deref() == Some(value) {
            return Ok(false);
        }
        self.am_mut().put(obj, key, value)?;
        Ok(true)
    }
}

impl<D: Borrow<AutoCommit>> BokehSessionDocOf<D> {
    fn am(&self) -> &AutoCommit {
        self.doc.borrow()
    }

    pub fn doc(&self) -> &AutoCommit {
        self.am()
    }

    // ── Reads ──────────────────────────────────────────────────────────

    pub fn schema_version(&self) -> Option<u64> {
        self.read_uint(&ROOT, "schema_version")
    }

    /// `None` until the replica has received its epoch's document.
    pub fn epoch(&self) -> Option<u64> {
        self.read_uint(&ROOT, "epoch")
    }

    pub fn read_meta(&self) -> Option<BokehSessionMeta> {
        let meta = self.map_at(&ROOT, "meta")?;
        Some(BokehSessionMeta {
            session_id: self.read_str(&meta, "session_id").unwrap_or_default(),
            producer_name: self.read_str(&meta, "producer_name").unwrap_or_default(),
            producer_version: self.read_str(&meta, "producer_version").unwrap_or_default(),
            bokeh_version: self.read_str(&meta, "bokeh_version").unwrap_or_default(),
            root_ids: self
                .read_str(&meta, "root_ids")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            title: self.read_str(&meta, "title"),
            doc_extras: self.read_str(&meta, "doc_extras"),
        })
    }

    pub fn model_ids(&self) -> Vec<String> {
        match self.map_at(&ROOT, "models") {
            Some(models) => self.am().keys(&models).collect(),
            None => Vec::new(),
        }
    }

    pub fn has_model(&self, model_id: &str) -> bool {
        self.model_obj(model_id).is_some()
    }

    pub fn read_model(&self, model_id: &str) -> Option<BokehModelState> {
        let model = self.model_obj(model_id)?;
        let mut props = BTreeMap::new();
        if let Some(props_obj) = self.map_at(&model, "props") {
            for name in self.am().keys(&props_obj) {
                if let Some(value) = self.read_str(&props_obj, &name) {
                    props.insert(name, value);
                }
            }
        }
        Some(BokehModelState {
            type_name: self.read_str(&model, "type").unwrap_or_default(),
            ref_props: self.read_ref_props(&model),
            props,
        })
    }

    pub fn ref_props(&self, model_id: &str) -> Option<Vec<String>> {
        self.model_obj(model_id)
            .map(|model| self.read_ref_props(&model))
    }

    pub fn get_prop(&self, model_id: &str, name: &str) -> Option<String> {
        let props = self.props_obj(model_id)?;
        self.read_str(&props, name)
    }

    /// A property's value at earlier heads, e.g. before a sync receive.
    pub fn get_prop_at(&self, model_id: &str, name: &str, heads: &[ChangeHash]) -> Option<String> {
        let props = self.props_obj(model_id)?;
        match self.am().get_at(&props, name, heads).ok().flatten() {
            Some((Value::Scalar(value), _)) => match value.as_ref() {
                ScalarValue::Str(s) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        }
    }

    /// The actor whose write won a property's current value.
    pub fn prop_actor(&self, model_id: &str, name: &str) -> Option<ActorId> {
        let props = self.props_obj(model_id)?;
        match self.am().get(&props, name).ok().flatten() {
            Some((Value::Scalar(_), ObjId::Id(_, actor, _))) => Some(actor),
            _ => None,
        }
    }

    /// The actor that built this epoch's document: only `build` writes
    /// `epoch`, and it authors the whole build under the kernel actor.
    pub fn epoch_actor(&self) -> Option<ActorId> {
        match self.am().get(&ROOT, "epoch").ok().flatten() {
            Some((Value::Scalar(_), ObjId::Id(_, actor, _))) => Some(actor),
            _ => None,
        }
    }

    pub fn read_columns(&self) -> BTreeMap<String, BTreeMap<String, BokehColumnRef>> {
        let mut out = BTreeMap::new();
        let Some(columns) = self.map_at(&ROOT, "columns") else {
            return out;
        };
        for source_id in self.am().keys(&columns) {
            let Some(source) = self.map_at(&columns, &source_id) else {
                continue;
            };
            let mut cols = BTreeMap::new();
            for column in self.am().keys(&source) {
                if let Some(column_ref) = self
                    .read_str(&source, &column)
                    .and_then(|s| serde_json::from_str(&s).ok())
                {
                    cols.insert(column, column_ref);
                }
            }
            out.insert(source_id, cols);
        }
        out
    }

    pub fn read_snapshot(&self) -> Result<BokehSessionSnapshot, RuntimeStateError> {
        let epoch = self
            .epoch()
            .ok_or(RuntimeStateError::MissingScaffold("epoch"))?;
        let meta = self
            .read_meta()
            .ok_or(RuntimeStateError::MissingScaffold("meta"))?;
        let models = self
            .model_ids()
            .into_iter()
            .filter_map(|id| self.read_model(&id).map(|model| (id, model)))
            .collect();
        Ok(BokehSessionSnapshot {
            epoch,
            meta,
            models,
            columns: self.read_columns(),
        })
    }

    /// Every blob the document references, for blob GC roots.
    pub fn referenced_blobs(&self) -> BTreeSet<String> {
        let mut blobs = BTreeSet::new();
        if let Some(blob) = self
            .read_meta()
            .and_then(|meta| meta.doc_extras)
            .and_then(|extras| BokehBlobRef::parse(&extras))
        {
            blobs.insert(blob.blob);
        }
        for id in self.model_ids() {
            if let Some(model) = self.read_model(&id) {
                blobs.extend(
                    model
                        .props
                        .values()
                        .filter_map(|value| BokehBlobRef::parse(value))
                        .map(|blob| blob.blob),
                );
            }
        }
        for columns in self.read_columns().into_values() {
            blobs.extend(columns.into_values().map(|column| column.blob));
        }
        blobs
    }

    // ── Peer writes ────────────────────────────────────────────────────

    /// The content rules for one peer property write, against this replica.
    pub fn check_peer_write(
        &self,
        model_id: &str,
        name: &str,
        encoded: &str,
    ) -> Result<(), BokehSessionWriteRejection> {
        let Some(model) = self.model_obj(model_id) else {
            return Err(BokehSessionWriteRejection::UnknownModel(
                model_id.to_string(),
            ));
        };
        if self.read_ref_props(&model).iter().any(|prop| prop == name) {
            return Err(BokehSessionWriteRejection::ReferenceProperty {
                model: model_id.to_string(),
                prop: name.to_string(),
            });
        }
        check_peer_value(model_id, name, encoded)
    }

    /// Of the changed properties, those whose current winner is foreign.
    pub fn foreign_props<F>(
        &self,
        changeset: &BokehSessionChangeset,
        is_foreign: F,
    ) -> BTreeMap<String, BTreeMap<String, String>>
    where
        F: Fn(&ActorId) -> bool,
    {
        let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        for (model_id, names) in &changeset.props_changed {
            let Some(props) = self.props_obj(model_id) else {
                continue;
            };
            for name in names {
                if let Ok(Some((Value::Scalar(value), ObjId::Id(_, actor, _)))) =
                    self.am().get(&props, name.as_str())
                {
                    if let (ScalarValue::Str(value), true) = (value.as_ref(), is_foreign(&actor)) {
                        out.entry(model_id.clone())
                            .or_default()
                            .insert(name.clone(), value.to_string());
                    }
                }
            }
        }
        out
    }

    // ── Helpers ────────────────────────────────────────────────────────

    /// Content rules for every new change of one peer message, checked
    /// against this replica as it was before the message. Actor checks are
    /// the caller's.
    pub fn validate_peer_changes(
        &self,
        changes: &[Change],
        current_epoch: u64,
    ) -> Result<(), BokehSessionWriteRejection> {
        if let Some(epoch) = self.epoch() {
            if epoch != current_epoch {
                return Err(BokehSessionWriteRejection::StaleEpoch {
                    frame: epoch,
                    current: current_epoch,
                });
            }
        }
        let writable = self.writable_props();
        changes
            .iter()
            .try_for_each(|change| validate_peer_change(change, &writable))
    }

    fn writable_props(&self) -> WritableProps {
        let mut by_obj = HashMap::new();
        for id in self.model_ids() {
            let Some(model) = self.model_obj(&id) else {
                continue;
            };
            if let Some(ObjId::Id(counter, actor, _)) = self.map_at(&model, "props") {
                let ref_props = self.read_ref_props(&model).into_iter().collect();
                by_obj.insert((counter, actor), (id, ref_props));
            }
        }
        WritableProps { by_obj }
    }

    fn map_at(&self, parent: &ObjId, key: &str) -> Option<ObjId> {
        match self.am().get(parent, key).ok().flatten() {
            Some((Value::Object(ObjType::Map), obj)) => Some(obj),
            _ => None,
        }
    }

    fn root_map(&self, key: &'static str) -> Result<ObjId, RuntimeStateError> {
        self.map_at(&ROOT, key)
            .ok_or(RuntimeStateError::MissingScaffold(key))
    }

    fn model_obj(&self, model_id: &str) -> Option<ObjId> {
        let models = self.map_at(&ROOT, "models")?;
        self.map_at(&models, model_id)
    }

    fn props_obj(&self, model_id: &str) -> Option<ObjId> {
        let model = self.model_obj(model_id)?;
        self.map_at(&model, "props")
    }

    fn read_str(&self, obj: &ObjId, key: &str) -> Option<String> {
        match self.am().get(obj, key).ok().flatten() {
            Some((Value::Scalar(value), _)) => match value.as_ref() {
                ScalarValue::Str(s) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        }
    }

    fn read_uint(&self, obj: &ObjId, key: &str) -> Option<u64> {
        match self.am().get(obj, key).ok().flatten() {
            Some((Value::Scalar(value), _)) => match value.as_ref() {
                ScalarValue::Uint(n) => Some(*n),
                _ => None,
            },
            _ => None,
        }
    }

    fn read_ref_props(&self, model: &ObjId) -> Vec<String> {
        self.read_str(model, "ref_props")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}

fn validate_peer_change(
    change: &Change,
    writable: &WritableProps,
) -> Result<(), BokehSessionWriteRejection> {
    for op in change.decode().operations {
        let value = match &op.action {
            LegacyOpType::Put(ScalarValue::Str(value)) if !op.insert => value,
            LegacyOpType::Put(_) | LegacyOpType::Delete => {
                return Err(BokehSessionWriteRejection::ForbiddenOperation(
                    match op.action {
                        LegacyOpType::Delete => "delete",
                        _ => "non-string put",
                    },
                ))
            }
            LegacyOpType::Make(_) => {
                return Err(BokehSessionWriteRejection::ForbiddenOperation(
                    "make object",
                ))
            }
            LegacyOpType::Increment(_) => {
                return Err(BokehSessionWriteRejection::ForbiddenOperation("increment"))
            }
            LegacyOpType::MarkBegin(_) | LegacyOpType::MarkEnd(_) => {
                return Err(BokehSessionWriteRejection::ForbiddenOperation("mark"))
            }
        };
        let (LegacyObjectId::Id(obj), LegacyKey::Map(name)) = (&op.obj, &op.key) else {
            return Err(BokehSessionWriteRejection::NotAModelProperty);
        };
        let Some((model_id, ref_props)) = writable.by_obj.get(&(obj.0, obj.1.clone())) else {
            return Err(BokehSessionWriteRejection::NotAModelProperty);
        };
        if ref_props.contains(name.as_str()) {
            return Err(BokehSessionWriteRejection::ReferenceProperty {
                model: model_id.clone(),
                prop: name.to_string(),
            });
        }
        check_peer_value(model_id, name, value)?;
    }
    Ok(())
}

/// Value rules shared by the hub filter and the client pre-check. Peers may
/// write only plain values: both Bokeh deserializers turn the reference
/// shapes into models, and readers dereference a blob-ref shape (and GC roots
/// it), so only the kernel may author either.
fn check_peer_value(
    model_id: &str,
    name: &str,
    encoded: &str,
) -> Result<(), BokehSessionWriteRejection> {
    use BokehSessionWriteRejection::{BlobRefValue, InvalidValue, ModelReferenceValue};
    let (model, prop) = (model_id.to_string(), name.to_string());
    match serde_json::from_str::<serde_json::Value>(encoded) {
        Err(_) => Err(InvalidValue { model, prop }),
        Ok(value) if is_blob_ref_shape(&value) => Err(BlobRefValue { model, prop }),
        Ok(value) if holds_model_reference(&value) => Err(ModelReferenceValue { model, prop }),
        Ok(_) => Ok(()),
    }
}

/// The keys of `BokehBlobRef` and of the frame's `parseBlobRef`, whatever
/// the value types, so no reader can parse a peer value as a blob ref.
fn is_blob_ref_shape(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() == 3
            && ["blob", "size", "media_type"]
                .iter()
                .all(|key| map.contains_key(*key))
    })
}

/// A superset of what Python's `Deserializer._decode` and BokehJS's
/// `Deserializer._decode` read as a model: `ref` and `object` reps, and an
/// object with `id` and no string `type`.
fn holds_model_reference(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(items) => items.iter().any(holds_model_reference),
        serde_json::Value::Object(map) => match map.get("type").and_then(|t| t.as_str()) {
            Some("ref" | "object") => true,
            Some(_) => map.values().any(holds_model_reference),
            None => map.contains_key("id") || map.values().any(holds_model_reference),
        },
        _ => false,
    }
}

/// A freshly built next-epoch document. `previous_heads` lets a peer that had
/// applied the old document up to this point switch without reconciling.
pub struct BokehSessionReplacement {
    pub doc: BokehSessionDoc,
    pub epoch: u64,
    pub previous_epoch: u64,
    pub previous_heads: Vec<ChangeHash>,
}

/// The replacement rule from Phase 0 (revised): replace when the change
/// bytes since the epoch exceed `max(512 KiB, 4 x saved size of the epoch's
/// document)`, at most once per 60 s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BokehReplacementPolicy {
    pub min_change_bytes: usize,
    pub saved_size_factor: usize,
    pub min_interval_ms: u64,
}

impl Default for BokehReplacementPolicy {
    fn default() -> Self {
        Self {
            min_change_bytes: 512 * 1024,
            saved_size_factor: 4,
            min_interval_ms: 60_000,
        }
    }
}

impl BokehReplacementPolicy {
    pub fn threshold(&self, epoch_saved_bytes: usize) -> usize {
        self.min_change_bytes
            .max(self.saved_size_factor.saturating_mul(epoch_saved_bytes))
    }

    pub fn should_replace(
        &self,
        change_bytes: usize,
        epoch_saved_bytes: usize,
        ms_since_epoch_start: u64,
    ) -> bool {
        change_bytes > self.threshold(epoch_saved_bytes)
            && ms_since_epoch_start >= self.min_interval_ms
    }
}

/// Tracks change bytes since an epoch started. Time is passed in because
/// this crate also runs in WASM, where `Instant::now` is unavailable.
#[derive(Debug, Clone)]
pub struct BokehReplacementTracker {
    policy: BokehReplacementPolicy,
    epoch_saved_bytes: usize,
    epoch_started_ms: u64,
    counted_heads: Vec<ChangeHash>,
    change_bytes: usize,
}

impl BokehReplacementTracker {
    /// Start tracking a freshly built epoch document.
    pub fn start(doc: &mut BokehSessionDoc, policy: BokehReplacementPolicy, now_ms: u64) -> Self {
        Self {
            policy,
            epoch_saved_bytes: doc.save().len(),
            epoch_started_ms: now_ms,
            counted_heads: doc.get_heads(),
            change_bytes: 0,
        }
    }

    pub fn epoch_saved_bytes(&self) -> usize {
        self.epoch_saved_bytes
    }

    /// Raw change bytes since the epoch started, counting only new changes
    /// on each call, whoever authored them.
    pub fn change_bytes(&mut self, doc: &mut BokehSessionDoc) -> usize {
        let heads = doc.get_heads();
        if heads != self.counted_heads {
            self.change_bytes += doc
                .doc
                .get_changes(&self.counted_heads)
                .iter()
                .map(|change| change.raw_bytes().len())
                .sum::<usize>();
            self.counted_heads = heads;
        }
        self.change_bytes
    }

    pub fn is_due(&mut self, doc: &mut BokehSessionDoc, now_ms: u64) -> bool {
        let change_bytes = self.change_bytes(doc);
        self.policy.should_replace(
            change_bytes,
            self.epoch_saved_bytes,
            now_ms.saturating_sub(self.epoch_started_ms),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KERNEL: &str = "rt:kernel:test";
    const BROWSER: &str = "user:dev:alice/browser";

    fn model(type_name: &str, ref_props: &[&str], props: &[(&str, &str)]) -> BokehModelState {
        BokehModelState {
            type_name: type_name.into(),
            ref_props: ref_props.iter().map(|s| s.to_string()).collect(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn column(blob: &str, version: u64) -> BokehColumnRef {
        BokehColumnRef {
            blob: blob.into(),
            size: 8,
            version,
        }
    }

    fn snapshot() -> BokehSessionSnapshot {
        let mut models = BTreeMap::new();
        models.insert(
            "p1".to_string(),
            model(
                "Row",
                &["children"],
                &[("children", r#"[{"id":"p2"},{"id":"p3"}]"#)],
            ),
        );
        models.insert(
            "p2".to_string(),
            model(
                "Slider",
                &["js_property_callbacks"],
                &[("value", "0.5"), ("title", r#""Alpha""#)],
            ),
        );
        models.insert(
            "p3".to_string(),
            model("ColumnDataSource", &["selected"], &[("name", "null")]),
        );
        let mut columns = BTreeMap::new();
        columns.insert(
            "p3".to_string(),
            BTreeMap::from([("x".to_string(), column("aa", 0))]),
        );
        BokehSessionSnapshot {
            epoch: 0,
            meta: BokehSessionMeta {
                session_id: "session-1".into(),
                producer_name: "panel".into(),
                producer_version: "1.9.4".into(),
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: Some("Page".into()),
                doc_extras: Some(
                    BokehBlobRef {
                        blob: "dd".into(),
                        size: 100,
                        media_type: "application/json".into(),
                    }
                    .encode(),
                ),
            },
            models,
            columns,
        }
    }

    fn connected(scope: RuntimeStateWriteScope) -> BokehSessionWriteContext {
        BokehSessionWriteContext {
            scope,
            status: BokehSessionStatus::Connected,
            current_epoch: 0,
        }
    }

    /// Sync `server` to a fresh replica and return it.
    fn join(server: &mut BokehSessionDoc, actor: &str) -> BokehSessionDoc {
        let mut replica = BokehSessionDoc::new_empty(actor);
        let mut s_state = sync::State::new();
        let mut r_state = sync::State::new();
        sync_until_quiet(server, &mut s_state, &mut replica, &mut r_state);
        replica
    }

    fn sync_until_quiet(
        a: &mut BokehSessionDoc,
        a_state: &mut sync::State,
        b: &mut BokehSessionDoc,
        b_state: &mut sync::State,
    ) {
        for _ in 0..16 {
            let mut progressed = false;
            if let Some(msg) = a.generate_sync_message(a_state) {
                b.receive_sync_message(b_state, msg).unwrap();
                progressed = true;
            }
            if let Some(msg) = b.generate_sync_message(b_state) {
                a.receive_sync_message(a_state, msg).unwrap();
                progressed = true;
            }
            if !progressed {
                return;
            }
        }
        panic!("sync did not converge");
    }

    /// Run the protocol between a peer and the hub, sending the peer's
    /// messages through the ingress filter. Returns the first rejection.
    fn push_through_filter(
        hub: &mut BokehSessionDoc,
        peer: &mut BokehSessionDoc,
        context: &BokehSessionWriteContext,
    ) -> Result<BokehSessionChangeset, BokehSessionWriteRejection> {
        let mut hub_state = sync::State::new();
        let mut peer_state = sync::State::new();
        let mut changeset = BokehSessionChangeset::default();
        for _ in 0..16 {
            let mut progressed = false;
            if let Some(msg) = peer.generate_sync_message(&mut peer_state) {
                match hub.receive_peer_sync_message(&mut hub_state, msg, context) {
                    Ok(c) if !c.is_empty() => changeset = c,
                    Ok(_) => {}
                    Err(BokehSessionIngressError::Rejected(rejection)) => return Err(rejection),
                    Err(err) => panic!("automerge error: {err}"),
                }
                progressed = true;
            }
            if let Some(msg) = hub.generate_sync_message(&mut hub_state) {
                peer.receive_sync_message(&mut peer_state, msg).unwrap();
                progressed = true;
            }
            if !progressed {
                return Ok(changeset);
            }
        }
        panic!("sync did not converge");
    }

    #[test]
    fn checked_receive_rejects_foreign_principal_actor_and_reads_prior_value() {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, "user:dev:mallory/browser");
        peer.set_prop("p2", "value", "0.9").unwrap();
        peer.commit();

        let mut hub_state = sync::State::new();
        let mut peer_state = sync::State::new();
        let context = connected(RuntimeStateWriteScope::Editor);
        let only_alice = |actor: &ActorId| actor.to_bytes().starts_with(b"user:dev:alice/");
        let mut rejected = None;
        for _ in 0..8 {
            if let Some(msg) = peer.generate_sync_message(&mut peer_state) {
                if let Err(BokehSessionIngressError::Rejected(rejection)) =
                    hub.receive_peer_sync_message_checked(&mut hub_state, msg, &context, only_alice)
                {
                    rejected = Some(rejection);
                    break;
                }
            }
            if let Some(msg) = hub.generate_sync_message(&mut hub_state) {
                peer.receive_sync_message(&mut peer_state, msg).unwrap();
            }
        }
        assert_eq!(
            rejected,
            Some(BokehSessionWriteRejection::UnauthorizedActor(
                "user:dev:mallory/browser".into()
            ))
        );
        assert_eq!(hub.get_prop("p2", "value").as_deref(), Some("0.5"));

        let before = hub.get_heads();
        hub.set_prop("p2", "value", "0.7").unwrap();
        hub.commit();
        assert_eq!(
            hub.get_prop_at("p2", "value", &before).as_deref(),
            Some("0.5")
        );
        assert_eq!(hub.get_prop("p2", "value").as_deref(), Some("0.7"));
    }

    #[test]
    fn write_peer_props_applies_the_ingress_rules_and_passes_the_filter() {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, BROWSER);
        let write = |model: &str, prop: &str, value: &str| {
            BTreeMap::from([(
                model.to_string(),
                BTreeMap::from([(prop.to_string(), value.to_string())]),
            )])
        };
        let editor = connected(RuntimeStateWriteScope::Editor);

        let refused = [
            (
                editor,
                write("p1", "children", "[]"),
                BokehSessionWriteRejection::ReferenceProperty {
                    model: "p1".into(),
                    prop: "children".into(),
                },
            ),
            (
                editor,
                write("p9", "value", "1"),
                BokehSessionWriteRejection::UnknownModel("p9".into()),
            ),
            (
                connected(RuntimeStateWriteScope::Viewer),
                write("p2", "value", "0.9"),
                BokehSessionWriteRejection::Scope("viewer"),
            ),
            (
                BokehSessionWriteContext {
                    status: BokehSessionStatus::Disconnected,
                    ..editor
                },
                write("p2", "value", "0.9"),
                BokehSessionWriteRejection::SessionNotConnected(BokehSessionStatus::Disconnected),
            ),
            (
                BokehSessionWriteContext {
                    current_epoch: 1,
                    ..editor
                },
                write("p2", "value", "0.9"),
                BokehSessionWriteRejection::StaleEpoch {
                    frame: 0,
                    current: 1,
                },
            ),
        ];
        let heads = peer.get_heads();
        for (context, props, expected) in refused {
            assert_eq!(peer.write_peer_props(&context, &props), Err(expected));
        }
        assert_eq!(peer.get_heads(), heads, "refused writes leave no change");

        assert_eq!(
            peer.write_peer_props(&editor, &write("p2", "value", "0.9")),
            Ok(true)
        );
        assert_eq!(
            peer.write_peer_props(&editor, &write("p2", "value", "0.9")),
            Ok(false)
        );
        push_through_filter(&mut hub, &mut peer, &editor).unwrap();
        assert_eq!(hub.get_prop("p2", "value").as_deref(), Some("0.9"));
    }

    #[test]
    fn build_round_trips_snapshot_and_is_deterministic() {
        let snap = snapshot();
        let mut doc = BokehSessionDoc::build(&snap, KERNEL).unwrap();
        assert_eq!(doc.schema_version(), Some(BOKEH_SESSION_DOC_SCHEMA_VERSION));
        assert_eq!(doc.epoch(), Some(0));
        assert_eq!(doc.read_snapshot().unwrap(), snap);
        assert_eq!(doc.get_heads().len(), 1);

        let mut again = BokehSessionDoc::build(&snap, KERNEL).unwrap();
        assert_eq!(again.get_heads(), doc.get_heads());

        let mut loaded = BokehSessionDoc::load(&doc.save(), BROWSER).unwrap();
        assert_eq!(loaded.read_snapshot().unwrap(), snap);
        assert_eq!(loaded.get_heads(), doc.get_heads());
    }

    #[test]
    fn empty_replica_receives_the_whole_document() {
        let mut server = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut replica = BokehSessionDoc::new_empty(BROWSER);
        assert_eq!(replica.epoch(), None);
        assert!(replica.read_snapshot().is_err());
        let mut s_state = sync::State::new();
        let mut r_state = sync::State::new();
        let before = replica.get_heads();
        sync_until_quiet(&mut server, &mut s_state, &mut replica, &mut r_state);
        let after = replica.get_heads();
        // The first sync reports every model, so a frame can build the page.
        let changeset = replica.diff(&before, &after);
        assert!(changeset.meta_changed);
        assert_eq!(
            changeset.models_added,
            BTreeSet::from(["p1".to_string(), "p2".to_string(), "p3".to_string()])
        );
        assert!(changeset.props_changed.is_empty());
        assert!(changeset.columns_changed.contains_key("p3"));
        assert_eq!(replica.read_snapshot().unwrap(), snapshot());
        assert_eq!(
            replica.ref_props("p2").unwrap(),
            vec!["js_property_callbacks"]
        );
        assert_eq!(replica.get_prop("p2", "value").as_deref(), Some("0.5"));
    }

    #[test]
    fn apply_delta_adds_changes_and_removes_with_no_op_skip() {
        let mut doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let before = doc.get_heads();
        let delta = BokehSessionDocDelta {
            models_added: BTreeMap::from([(
                "p4".to_string(),
                model("Div", &[], &[("text", r#""hi""#)]),
            )]),
            props_changed: BTreeMap::from([(
                "p1".to_string(),
                BTreeMap::from([(
                    "children".to_string(),
                    r#"[{"id":"p2"},{"id":"p4"}]"#.to_string(),
                )]),
            )]),
            models_removed: vec!["p3".into()],
            ..Default::default()
        };
        doc.apply_delta(&delta).unwrap();
        doc.commit();
        let after = doc.get_heads();
        let changeset = doc.diff(&before, &after);
        assert_eq!(changeset.models_added, BTreeSet::from(["p4".to_string()]));
        assert_eq!(changeset.models_removed, BTreeSet::from(["p3".to_string()]));
        assert_eq!(
            changeset.props_changed,
            BTreeMap::from([("p1".to_string(), BTreeSet::from(["children".to_string()]))])
        );
        assert_eq!(
            changeset.columns_changed,
            BTreeMap::from([("p3".to_string(), BTreeSet::new())])
        );
        assert!(!doc.has_model("p3"));
        assert!(!doc.read_columns().contains_key("p3"));
        assert_eq!(doc.get_prop("p4", "text").as_deref(), Some(r#""hi""#));

        // Re-applying the same values writes nothing.
        doc.apply_delta(&BokehSessionDocDelta {
            props_changed: delta.props_changed.clone(),
            ..Default::default()
        })
        .unwrap();
        doc.commit();
        assert_eq!(doc.get_heads(), after);

        // A delta for a model the document does not have is an error.
        let err = doc
            .apply_delta(&BokehSessionDocDelta {
                props_changed: BTreeMap::from([(
                    "missing".to_string(),
                    BTreeMap::from([("value".to_string(), "1".to_string())]),
                )]),
                ..Default::default()
            })
            .unwrap_err();
        assert!(matches!(err, RuntimeStateError::InvalidBokehSession(_)));
    }

    #[test]
    fn put_model_replaces_existing_state_and_columns_track_changes() {
        let mut doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let before = doc.get_heads();
        doc.put_model("p2", &model("Slider", &[], &[("value", "0.7")]))
            .unwrap();
        doc.set_column("p3", "x", &column("bb", 1)).unwrap();
        doc.set_column("p3", "y", &column("cc", 1)).unwrap();
        let mut meta = snapshot().meta;
        meta.title = None;
        doc.put_meta(&meta).unwrap();
        doc.commit();
        let after = doc.get_heads();
        let model = doc.read_model("p2").unwrap();
        assert!(model.ref_props.is_empty());
        assert_eq!(
            model.props,
            BTreeMap::from([("value".to_string(), "0.7".to_string())])
        );
        let changeset = doc.diff(&before, &after);
        assert!(changeset.meta_changed);
        // `ref_props` moved, so the model is reported for a full re-read.
        assert!(changeset.models_added.contains("p2"));
        assert_eq!(
            changeset.columns_changed["p3"],
            BTreeSet::from(["x".to_string(), "y".to_string()])
        );
        assert_eq!(doc.read_meta().unwrap().title, None);

        let before = doc.get_heads();
        assert!(doc.remove_column("p3", "y").unwrap());
        assert!(!doc.remove_column("p3", "y").unwrap());
        doc.commit();
        let after = doc.get_heads();
        assert_eq!(
            doc.diff(&before, &after).columns_changed["p3"],
            BTreeSet::from(["y".to_string()])
        );
    }

    #[test]
    fn foreign_view_reports_only_changed_props_won_by_foreign_actors() {
        let mut kernel = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut browser = join(&mut kernel, BROWSER);

        browser.set_prop("p2", "value", "0.9").unwrap();
        browser.set_prop("p2", "title", r#""Beta""#).unwrap();
        browser.commit();
        // The kernel corrects `title` concurrently and wins on its own replica.
        kernel.set_prop("p2", "title", r#""Gamma""#).unwrap();
        kernel.commit();

        let is_foreign = |actor: &ActorId| !actor.to_bytes().starts_with(b"rt:kernel:");
        let mut k_state = sync::State::new();
        let mut b_state = sync::State::new();
        let mut view = BokehForeignSyncView::default();
        for _ in 0..8 {
            if let Some(msg) = browser.generate_sync_message(&mut b_state) {
                let v = kernel
                    .receive_sync_and_foreign_props(&mut k_state, msg, is_foreign)
                    .unwrap();
                if !v.changeset.is_empty() {
                    view = v;
                }
            }
            if let Some(msg) = kernel.generate_sync_message(&mut k_state) {
                browser.receive_sync_message(&mut b_state, msg).unwrap();
            }
        }
        let foreign = view.foreign_props.get("p2").expect("foreign p2 props");
        assert_eq!(foreign.get("value").map(String::as_str), Some("0.9"));
        // Whichever value won the concurrent title write, both replicas agree
        // and it is reported as foreign only if the browser won.
        let title = kernel.get_prop("p2", "title").unwrap();
        assert_eq!(browser.get_prop("p2", "title").unwrap(), title);
        assert_eq!(foreign.contains_key("title"), title == r#""Beta""#);
        assert!(!view.foreign_props.contains_key("p1"));

        // A kernel correction after the foreign write is not foreign.
        kernel.set_prop("p2", "value", "0.8").unwrap();
        kernel.commit();
        let before = browser.get_heads();
        sync_until_quiet(
            &mut kernel,
            &mut sync::State::new(),
            &mut browser,
            &mut sync::State::new(),
        );
        let after = browser.get_heads();
        let changeset = browser.diff(&before, &after);
        assert!(browser.foreign_props(&changeset, is_foreign).is_empty());
    }

    #[test]
    fn prop_and_epoch_actors_name_the_winning_writer() {
        let kernel_actor = ActorId::from(KERNEL.as_bytes());
        let browser_actor = ActorId::from(BROWSER.as_bytes());
        let mut kernel = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut browser = join(&mut kernel, BROWSER);
        assert_eq!(browser.epoch_actor(), Some(kernel_actor.clone()));
        assert_eq!(BokehSessionDoc::new_empty(BROWSER).epoch_actor(), None);
        assert_eq!(
            browser.prop_actor("p2", "value"),
            Some(kernel_actor.clone())
        );
        assert_eq!(browser.prop_actor("p2", "missing"), None);
        assert_eq!(browser.prop_actor("missing", "value"), None);

        browser.set_prop("p2", "value", "2").unwrap();
        browser.commit();
        assert_eq!(browser.prop_actor("p2", "value"), Some(browser_actor));
        sync_until_quiet(
            &mut browser,
            &mut sync::State::new(),
            &mut kernel,
            &mut sync::State::new(),
        );
        // A correction made after seeing the browser's write wins everywhere.
        kernel.set_prop("p2", "value", "1").unwrap();
        kernel.commit();
        sync_until_quiet(
            &mut kernel,
            &mut sync::State::new(),
            &mut browser,
            &mut sync::State::new(),
        );
        assert_eq!(browser.get_prop("p2", "value").as_deref(), Some("1"));
        assert_eq!(browser.prop_actor("p2", "value"), Some(kernel_actor));
    }

    #[test]
    fn frame_epoch_and_permission_rules() {
        let editor = connected(RuntimeStateWriteScope::Editor);
        let runtime = BokehSessionWriteContext {
            current_epoch: 2,
            ..connected(RuntimeStateWriteScope::RuntimePeer)
        };
        assert!(editor.check_frame_epoch(0).is_ok());
        assert_eq!(
            editor.check_frame_epoch(1),
            Err(BokehSessionWriteRejection::StaleEpoch {
                frame: 1,
                current: 0
            })
        );
        assert!(runtime.check_frame_epoch(3).is_ok(), "agent may run ahead");
        assert!(runtime.check_frame_epoch(1).is_err());

        assert_eq!(
            editor.write_permission(),
            Ok(BokehWritePermission::PropertiesOnly)
        );
        assert_eq!(
            connected(RuntimeStateWriteScope::Owner).write_permission(),
            Ok(BokehWritePermission::PropertiesOnly)
        );
        assert_eq!(
            runtime.write_permission(),
            Ok(BokehWritePermission::Structural)
        );
        assert_eq!(
            connected(RuntimeStateWriteScope::Viewer).write_permission(),
            Err(BokehSessionWriteRejection::Scope("viewer"))
        );
        for status in [
            BokehSessionStatus::Disconnected,
            BokehSessionStatus::Closed,
            BokehSessionStatus::Error,
        ] {
            let context = BokehSessionWriteContext { status, ..editor };
            assert_eq!(
                context.write_permission(),
                Err(BokehSessionWriteRejection::SessionNotConnected(status))
            );
        }
    }

    #[test]
    fn filter_accepts_editor_writes_to_existing_non_reference_props() {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, BROWSER);
        peer.check_peer_write("p2", "value", "0.25").unwrap();
        peer.set_prop("p2", "value", "0.25").unwrap();
        // A property absent from the model's props (a default) is writable too.
        peer.set_prop("p2", "disabled", "true").unwrap();
        peer.commit();

        let changeset = push_through_filter(
            &mut hub,
            &mut peer,
            &connected(RuntimeStateWriteScope::Editor),
        )
        .unwrap();
        assert_eq!(
            changeset.props_changed["p2"],
            BTreeSet::from(["disabled".to_string(), "value".to_string()])
        );
        assert_eq!(hub.get_prop("p2", "value").as_deref(), Some("0.25"));
        assert_eq!(hub.get_heads(), peer.get_heads());
    }

    fn assert_rejected(
        write: impl FnOnce(&mut BokehSessionDoc),
        context: BokehSessionWriteContext,
        expected: BokehSessionWriteRejection,
    ) {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, BROWSER);
        let heads = hub.get_heads();
        write(&mut peer);
        peer.commit();
        assert_eq!(
            push_through_filter(&mut hub, &mut peer, &context),
            Err(expected)
        );
        assert_eq!(hub.get_heads(), heads, "a rejected message changes nothing");
    }

    #[test]
    fn filter_rejects_reference_props_structure_and_bad_values() {
        let editor = connected(RuntimeStateWriteScope::Editor);
        assert_rejected(
            |peer| {
                peer.set_prop("p1", "children", r#"[{"id":"p2"}]"#).unwrap();
            },
            editor,
            BokehSessionWriteRejection::ReferenceProperty {
                model: "p1".into(),
                prop: "children".into(),
            },
        );
        assert_rejected(
            |peer| {
                peer.put_model("p9", &model("Div", &[], &[])).unwrap();
            },
            editor,
            BokehSessionWriteRejection::ForbiddenOperation("make object"),
        );
        assert_rejected(
            |peer| {
                peer.remove_model("p2").unwrap();
            },
            editor,
            BokehSessionWriteRejection::ForbiddenOperation("delete"),
        );
        assert_rejected(
            |peer| {
                let props = peer.props_obj("p2").unwrap();
                peer.doc.delete(&props, "value").unwrap();
            },
            editor,
            BokehSessionWriteRejection::ForbiddenOperation("delete"),
        );
        assert_rejected(
            |peer| {
                let props = peer.props_obj("p2").unwrap();
                peer.doc.put(&props, "value", 0.3_f64).unwrap();
            },
            editor,
            BokehSessionWriteRejection::ForbiddenOperation("non-string put"),
        );
        assert_rejected(
            |peer| {
                peer.set_prop("p2", "value", "not json").unwrap();
            },
            editor,
            BokehSessionWriteRejection::InvalidValue {
                model: "p2".into(),
                prop: "value".into(),
            },
        );
        assert_rejected(
            |peer| {
                let model = peer.model_obj("p2").unwrap();
                peer.doc.put(&model, "type", "Div").unwrap();
            },
            editor,
            BokehSessionWriteRejection::NotAModelProperty,
        );
        assert_rejected(
            |peer| {
                peer.set_column("p3", "x", &column("ff", 9)).unwrap();
            },
            editor,
            BokehSessionWriteRejection::NotAModelProperty,
        );
        assert_rejected(
            |peer| {
                let meta = peer.root_map("meta").unwrap();
                peer.doc.put(&meta, "title", "Hijacked").unwrap();
            },
            editor,
            BokehSessionWriteRejection::NotAModelProperty,
        );
    }

    /// A value written to the generically typed `p2.value` must be refused
    /// the same way by the client pre-check and the hub filter.
    fn assert_peer_value_refused(encoded: &str, expected: BokehSessionWriteRejection) {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, BROWSER);
        assert_eq!(
            peer.check_peer_write("p2", "value", encoded),
            Err(expected.clone()),
            "pre-check of {encoded}"
        );
        let heads = hub.get_heads();
        peer.set_prop("p2", "value", encoded).unwrap();
        peer.commit();
        assert_eq!(
            push_through_filter(
                &mut hub,
                &mut peer,
                &connected(RuntimeStateWriteScope::Editor)
            ),
            Err(expected),
            "filter of {encoded}"
        );
        assert_eq!(hub.get_heads(), heads);
    }

    /// Item 5 (review 2026-10-29): Python's and BokehJS's deserializers read
    /// these shapes as references to, or definitions of, models.
    #[test]
    fn filter_rejects_values_bokeh_reads_as_model_references() {
        for encoded in [
            r#"{"id":"p3"}"#,
            r#"{"id":"p3","extra":1}"#,
            r#"[1,{"id":"p3"}]"#,
            r#"{"type":"map","entries":[["k",{"id":"p3"}]]}"#,
            r#"{"type":"ref","id":"p3"}"#,
            r#"{"type":"object","name":"Div","id":"p9","attributes":{"text":"x"}}"#,
            r#"{"type":"object","name":"Div","attributes":{}}"#,
            r#"{"type":1,"id":"p3"}"#,
        ] {
            assert_peer_value_refused(
                encoded,
                BokehSessionWriteRejection::ModelReferenceValue {
                    model: "p2".into(),
                    prop: "value".into(),
                },
            );
        }
    }

    /// Item 5: readers dereference this shape (`BokehBlobRef::parse`, the
    /// frame's `parseBlobRef`) and GC roots it, so only the kernel may write it.
    #[test]
    fn filter_rejects_values_shaped_like_blob_refs() {
        for encoded in [
            r#"{"blob":"ee","size":10,"media_type":"application/json"}"#,
            r#"{"media_type":"x","size":1.5,"blob":"ee"}"#,
        ] {
            assert_peer_value_refused(
                encoded,
                BokehSessionWriteRejection::BlobRefValue {
                    model: "p2".into(),
                    prop: "value".into(),
                },
            );
        }
    }

    #[test]
    fn filter_accepts_plain_bokeh_values_near_the_forbidden_shapes() {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, BROWSER);
        for encoded in [
            r#"{"type":"map","entries":[["id","p3"],["blob","ee"]]}"#,
            r#"{"type":"number","value":"nan"}"#,
            r#"{"type":"value","value":1,"id":"p3"}"#,
            r#"{"blob":"ee","size":10}"#,
            r#""{\"id\":\"p3\"}""#,
        ] {
            peer.check_peer_write("p2", "value", encoded).unwrap();
            peer.set_prop("p2", "value", encoded).unwrap();
            peer.commit();
            push_through_filter(
                &mut hub,
                &mut peer,
                &connected(RuntimeStateWriteScope::Editor),
            )
            .unwrap();
            assert_eq!(hub.get_prop("p2", "value").as_deref(), Some(encoded));
        }
    }

    #[test]
    fn filter_rejects_viewers_disconnected_sessions_and_stale_replicas() {
        let write = |peer: &mut BokehSessionDoc| {
            peer.set_prop("p2", "value", "0.1").unwrap();
        };
        assert_rejected(
            write,
            connected(RuntimeStateWriteScope::Viewer),
            BokehSessionWriteRejection::Scope("viewer"),
        );
        assert_rejected(
            write,
            BokehSessionWriteContext {
                status: BokehSessionStatus::Disconnected,
                ..connected(RuntimeStateWriteScope::Editor)
            },
            BokehSessionWriteRejection::SessionNotConnected(BokehSessionStatus::Disconnected),
        );
        assert_rejected(
            write,
            BokehSessionWriteContext {
                current_epoch: 1,
                ..connected(RuntimeStateWriteScope::Editor)
            },
            BokehSessionWriteRejection::StaleEpoch {
                frame: 0,
                current: 1,
            },
        );
    }

    #[test]
    fn filter_rejects_writes_to_a_model_the_kernel_removed() {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, BROWSER);
        hub.remove_model("p2").unwrap();
        hub.commit();
        peer.set_prop("p2", "value", "0.1").unwrap();
        peer.commit();
        assert_eq!(
            push_through_filter(
                &mut hub,
                &mut peer,
                &connected(RuntimeStateWriteScope::Editor)
            ),
            Err(BokehSessionWriteRejection::NotAModelProperty)
        );
    }

    #[test]
    fn runtime_peer_writes_structure_through_the_filter() {
        let mut hub = BokehSessionDoc::new_empty("runtimed:hub");
        let mut agent = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        agent.put_model("p9", &model("Div", &[], &[])).unwrap();
        agent.commit();
        push_through_filter(
            &mut hub,
            &mut agent,
            &connected(RuntimeStateWriteScope::RuntimePeer),
        )
        .unwrap();
        assert!(hub.has_model("p9"));
        assert_eq!(hub.get_heads(), agent.get_heads());
    }

    #[test]
    fn replacement_rule_uses_max_of_floor_and_saved_size() {
        let policy = BokehReplacementPolicy::default();
        assert_eq!(policy.threshold(10_000), 512 * 1024);
        assert_eq!(policy.threshold(200_000), 800_000);
        assert!(!policy.should_replace(512 * 1024, 10_000, 60_000));
        assert!(policy.should_replace(512 * 1024 + 1, 10_000, 60_000));
        assert!(!policy.should_replace(10_000_000, 10_000, 59_999));
        assert!(!policy.should_replace(700_000, 200_000, 120_000));
        assert!(policy.should_replace(800_001, 200_000, 120_000));
    }

    #[test]
    fn tracker_counts_changes_from_every_actor_once() {
        let policy = BokehReplacementPolicy {
            min_change_bytes: 1,
            saved_size_factor: 0,
            min_interval_ms: 1_000,
        };
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut tracker = BokehReplacementTracker::start(&mut hub, policy, 5_000);
        assert!(tracker.epoch_saved_bytes() > 0);
        assert_eq!(tracker.change_bytes(&mut hub), 0);

        hub.set_prop("p2", "value", "0.6").unwrap();
        hub.commit();
        let kernel_bytes = tracker.change_bytes(&mut hub);
        assert!(kernel_bytes > 0);
        assert_eq!(tracker.change_bytes(&mut hub), kernel_bytes);

        let mut peer = join(&mut hub, BROWSER);
        peer.set_prop("p2", "value", "0.7").unwrap();
        peer.commit();
        push_through_filter(
            &mut hub,
            &mut peer,
            &connected(RuntimeStateWriteScope::Editor),
        )
        .unwrap();
        assert!(tracker.change_bytes(&mut hub) > kernel_bytes);

        assert!(!tracker.is_due(&mut hub, 5_999), "rate limited");
        assert!(tracker.is_due(&mut hub, 6_000));
    }

    #[test]
    fn replacement_rebuilds_current_state_in_the_next_epoch() {
        let mut hub = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        let mut peer = join(&mut hub, BROWSER);
        for i in 0..50 {
            hub.set_prop("p2", "value", &format!("0.{i}")).unwrap();
            hub.commit();
        }
        peer.set_prop("p2", "title", r#""Edited""#).unwrap();
        peer.commit();
        push_through_filter(
            &mut hub,
            &mut peer,
            &connected(RuntimeStateWriteScope::Editor),
        )
        .unwrap();
        let old_save = hub.save().len();
        let old_heads = hub.get_heads();

        let BokehSessionReplacement {
            doc: mut next,
            epoch,
            previous_epoch,
            previous_heads,
        } = hub.build_replacement(KERNEL).unwrap();
        assert_eq!(previous_epoch, 0);
        assert_eq!(epoch, 1);
        assert_eq!(previous_heads, old_heads);
        assert_eq!(next.epoch(), Some(1));
        let mut expected = hub.read_snapshot().unwrap();
        expected.epoch = 1;
        assert_eq!(next.read_snapshot().unwrap(), expected);
        assert!(next.save().len() < old_save, "history is dropped");
        assert_eq!(
            BokehSessionDoc::build(&expected, KERNEL)
                .unwrap()
                .get_heads(),
            next.get_heads()
        );

        // Peers sync the new epoch from scratch; writes framed for the old
        // epoch are dropped at the frame check.
        let mut fresh = join(&mut next, BROWSER);
        assert_eq!(fresh.read_snapshot().unwrap(), expected);
        let context = BokehSessionWriteContext {
            current_epoch: 1,
            ..connected(RuntimeStateWriteScope::Editor)
        };
        assert!(context.check_frame_epoch(0).is_err());
        fresh.set_prop("p2", "value", "0.99").unwrap();
        fresh.commit();
        push_through_filter(&mut next, &mut fresh, &context).unwrap();
        assert_eq!(next.get_prop("p2", "value").as_deref(), Some("0.99"));
    }

    #[test]
    fn blob_cutoffs_and_references() {
        let small_array = format!("[{}]", vec!["1"; 200].join(","));
        assert!(small_array.len() > 256 && small_array.len() <= 1024);
        assert_eq!(bokeh_prop_blob_threshold(&small_array), 256);
        assert!(bokeh_prop_needs_blob(&small_array));
        let ndarray = format!(
            r#"{{"type":"ndarray","array":{{"type":"bytes","data":"{}"}},"shape":[64],"dtype":"float64","order":"little"}}"#,
            "A".repeat(300)
        );
        assert!(bokeh_prop_needs_blob(&ndarray));
        let text = format!("\"{}\"", "x".repeat(500));
        assert_eq!(bokeh_prop_blob_threshold(&text), 1024);
        assert!(!bokeh_prop_needs_blob(&text));
        assert!(bokeh_prop_needs_blob(&format!("\"{}\"", "x".repeat(1100))));
        assert!(!bokeh_prop_needs_blob("[1,2,3]"));

        let blob = BokehBlobRef {
            blob: "ee".into(),
            size: 2048,
            media_type: "application/json".into(),
        };
        assert_eq!(BokehBlobRef::parse(&blob.encode()), Some(blob.clone()));
        assert_eq!(BokehBlobRef::parse(r#"{"blob":"x","size":1}"#), None);
        assert_eq!(
            BokehBlobRef::parse(r#"{"blob":"x","size":1,"media_type":"a","extra":1}"#),
            None
        );

        let mut doc = BokehSessionDoc::build(&snapshot(), KERNEL).unwrap();
        doc.set_prop("p2", "title", &blob.encode()).unwrap();
        assert_eq!(
            doc.referenced_blobs(),
            BTreeSet::from(["aa".to_string(), "dd".to_string(), "ee".to_string()])
        );
    }

    #[test]
    fn delta_and_snapshot_serialize_with_the_python_field_names() {
        let delta: BokehSessionDocDelta = serde_json::from_value(serde_json::json!({
            "models_added": {"p9": {"type": "Div", "ref_props": [], "props": {"text": "\"a\""}}},
            "props_changed": {"p2": {"value": "1"}},
            "models_removed": ["p3"]
        }))
        .unwrap();
        assert_eq!(delta.models_added["p9"].type_name, "Div");
        assert!(delta.columns_changed.is_empty());
        let snap = snapshot();
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["models"]["p2"]["type"], "Slider");
        assert_eq!(
            serde_json::from_value::<BokehSessionSnapshot>(json).unwrap(),
            snap
        );
    }
}
