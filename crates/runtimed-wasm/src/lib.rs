//! WASM bindings for runtimed notebook document operations.
//!
//! Compiled from the same workspace `automerge` dependency as the daemon,
//! guaranteeing wire-compatible sync messages. The frontend imports this WASM
//! module instead of `@automerge/automerge` to avoid version mismatch issues
//! that produce phantom cells.

// Allow `expect()` and `unwrap()` in tests
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use automerge::patches::PatchAction;
use automerge::sync;
use automerge::sync::SyncDoc;
use automerge::Prop;
use comments_doc::{
    CommentAnchor, CommentsDoc, CommentsDocReceiveRepairResult, CommentsProjection,
    NotebookCommentRef,
};
use notebook_doc::diff::{
    diff_doc, extract_change_actor_hashes, extract_change_actors, CellChangeset, ChangeActor,
    TextPatch,
};
use notebook_doc::mime::{is_binary_mime, ResolvedContentRef};
use notebook_doc::pool_state::{PoolDoc, PoolState};
use notebook_doc::presence;
use notebook_doc::{CellSnapshot, NotebookDoc};
use notebook_wire::{frame_types, SessionControlMessage, SessionSyncStatusWire};
use nteract_identity::{ActorLabel, ConnectionScope, Operator, Principal};
use runtime_doc::{
    diff_output_ids_in_place, output_ids_for_execution, runtime_state_policy_snapshot,
    validate_runtime_state_sync_scope, CommsDoc, CommsState, ExecutionState,
    ExecutionViewChangeset, ExecutionViewProjector, KernelActivity, QueueEntry, RuntimeLifecycle,
    RuntimeState, RuntimeStateDoc, RuntimeStateWriteScope, WorkstationAttachmentState,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

const MARKDOWN_PROJECTION_MIME: &str = "application/vnd.nteract.markdown+json";
const MARKDOWN_SOURCE_MIME: &str = "text/markdown";
const BOKEHJS_EXEC_MIME: &str = "application/vnd.bokehjs_exec.v0+json";
const BOKEHJS_LOAD_MIME: &str = "application/vnd.bokehjs_load.v0+json";
const BOKEHJS_SCRIPT_MIME: &str = "application/javascript";
const BOKEHJS_HTML_MIME: &str = "text/html";
const PANEL_EXEC_MIME: &str = "application/vnd.holoviews_exec.v0+json";
const PANEL_LOAD_MIME: &str = "application/vnd.holoviews_load.v0+json";
const RUNT_OUTPUT_CACHE_KEY: &str = "_runt_output_cache_key";

/// Install the panic hook on module init so Rust panics inside WASM
/// surface as `console.error` entries with file/line and backtrace,
/// instead of the opaque `__wbindgen_throw` stack the frontend sees
/// today. Runs once before any `NotebookHandle` is constructed.
#[wasm_bindgen(start)]
pub fn __wasm_start() {
    console_error_panic_hook::set_once();
}

/// Serialize a Rust value to a `JsValue`, forcing maps to plain JS Objects.
///
/// `serde_wasm_bindgen::to_value` defaults to serializing maps as JS `Map`,
/// but `#[serde(flatten)]` causes serde to emit the containing struct via
/// `serialize_map`. That turns structs like `RuntMetadata` (which flattens
/// an `extra: HashMap`) into JS `Map` objects — breaking dot-access on the
/// JS side (`snapshot.runt.uv` becomes `undefined`).
///
/// Using `serialize_maps_as_objects(true)` ensures all maps become plain
/// JS Objects, matching what `JSON.parse()` would produce. The returned
/// `JsValue` can be any JS type (object, array, scalar) depending on input.
fn serialize_to_js<T: Serialize>(value: &T) -> Result<JsValue, serde_wasm_bindgen::Error> {
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_missing_as_null(true);
    value.serialize(&serializer)
}

fn create_comments_doc_sync_target_with_ref(
    comments_doc_id: &str,
    notebook_ref: &NotebookCommentRef,
    actor_label: &str,
) -> Result<CommentsDoc, JsError> {
    CommentsDoc::try_new_with_actor(comments_doc_id, notebook_ref, actor_label).map_err(|e| {
        JsError::new(&format!(
            "create comments doc sync target failed for {comments_doc_id}: {e}"
        ))
    })
}

fn parse_comments_notebook_ref_json(
    notebook_ref_json: &str,
) -> Result<NotebookCommentRef, JsError> {
    serde_json::from_str(notebook_ref_json).map_err(|e| {
        JsError::new(&format!(
            "parse comments notebook ref failed for {notebook_ref_json}: {e}"
        ))
    })
}

fn comments_sync_target_ref(comments_doc_id: &str) -> NotebookCommentRef {
    NotebookCommentRef::HostedRoom {
        room_locator: comments_doc_id
            .strip_prefix("comments:")
            .unwrap_or(comments_doc_id)
            .to_string(),
    }
}

/// Project markdown source into the experimental nteract markdown plan.
///
/// This is intentionally exposed through `runtimed-wasm` first so the
/// frontend can test the projection data in the same WASM module that already
/// owns notebook materialization. Rendering policy still lives in the app.
#[wasm_bindgen]
pub fn project_markdown_json(source: &str) -> String {
    nteract_markdown_wasm::project_to_json(source)
}

/// A text attribution range produced when a sync message modifies cell source.
///
/// Pushed to the frontend inside `SyncApplied` so it can highlight freshly
/// arrived text (e.g., a fade-in glow showing who wrote it).
#[derive(Serialize)]
pub struct TextAttribution {
    /// The cell ID whose source was modified.
    pub cell_id: String,
    /// Character index in the source where the change starts.
    pub index: usize,
    /// Text that was inserted at this index (empty for pure deletions).
    pub text: String,
    /// Number of characters deleted at this index (0 for pure insertions).
    pub deleted: usize,
    /// Actor label(s) that contributed to this sync batch.
    pub actors: Vec<String>,
}

/// Per-output diff emitted alongside `RuntimeStateSyncApplied`.
///
/// `changed` carries `(output_id, narrowed_manifest)` pairs — manifests
/// are already MIME-narrowed + ContentRef-resolved, so the frontend's
/// outputs store writes them in directly. Mirrors the `CellChangeset`
/// model: WASM owns both the diff and the view projection for outputs.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct OutputChangeset {
    /// Added or modified outputs `(output_id, manifest)`, in no particular order.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub changed: Vec<(String, serde_json::Value)>,
    /// Output IDs no longer present in any execution.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub removed: Vec<String>,
}

#[derive(Serialize)]
struct LocalMutationResult<T: Serialize> {
    result: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<FrameEvent>,
}

impl OutputChangeset {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.removed.is_empty()
    }
}

fn notebook_execution_pointers(doc: &NotebookDoc) -> Vec<(String, Option<String>)> {
    doc.get_cells()
        .into_iter()
        .map(|cell| {
            let execution_id = doc.get_execution_id(&cell.id);
            (cell.id, execution_id)
        })
        .collect()
}

fn parse_requested_cell_execution_ids(
    request: &serde_json::Value,
) -> Result<Option<HashMap<String, String>>, JsError> {
    let Some(raw) = request.get("cell_execution_ids") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    serde_json::from_value(raw.clone())
        .map(Some)
        .map_err(|e| JsError::new(&format!("decode cell_execution_ids: {e}")))
}

fn validate_requested_execution_ids(
    requested_execution_ids: Option<&HashMap<String, String>>,
    existing_execution_ids: &HashSet<String>,
    allocated_execution_ids: &mut HashSet<String>,
) -> Result<(), JsError> {
    let Some(requested_execution_ids) = requested_execution_ids else {
        return Ok(());
    };

    let mut supplied = HashSet::new();
    for execution_id in requested_execution_ids.values() {
        if uuid::Uuid::parse_str(execution_id).is_err() {
            return Err(JsError::new(&format!(
                "execution_id is not a valid UUID: {execution_id}"
            )));
        }
        if !supplied.insert(execution_id.clone()) {
            return Err(JsError::new(&format!(
                "duplicate execution_id in request: {execution_id}"
            )));
        }
        if existing_execution_ids.contains(execution_id) {
            return Err(JsError::new(&format!(
                "execution_id already exists: {execution_id}"
            )));
        }
    }

    allocated_execution_ids.extend(supplied);
    Ok(())
}

fn allocate_hosted_execution_id(allocated_execution_ids: &mut HashSet<String>) -> String {
    loop {
        let execution_id = uuid::Uuid::new_v4().to_string();
        if allocated_execution_ids.insert(execution_id.clone()) {
            return execution_id;
        }
    }
}

fn restore_cell_execution_pointers(
    doc: &mut NotebookDoc,
    cell_pointers: &[(String, Option<String>)],
) {
    for (cell_id, execution_id) in cell_pointers.iter().rev() {
        let _ = doc.set_execution_id(cell_id, execution_id.as_deref());
    }
}

/// Event returned from `receive_frame()` for the frontend to handle.
///
/// Converted directly to a JS object via `serde-wasm-bindgen` — no JSON
/// string serialization round-trip. The frontend reads the `type` field
/// to dispatch to the appropriate handler.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FrameEvent {
    /// Automerge sync message was applied; frontend should materialize cells.
    SyncApplied {
        /// True if the document changed (new cells, updated source, etc.)
        changed: bool,
        /// Structural changeset describing which cells/fields changed.
        /// `None` when `changed` is false.
        #[serde(skip_serializing_if = "Option::is_none")]
        changeset: Option<CellChangeset>,
        /// Text attribution ranges for source edits in this sync batch.
        /// Empty when `changed` is false or when only non-source fields changed.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        attributions: Vec<TextAttribution>,
        /// Sync reply to send back to the daemon, generated atomically after
        /// applying the inbound message. `None` when the protocol has nothing
        /// to send (e.g. already in sync). The caller should prepend frame type
        /// byte 0x00 and send via `sendFrame`.
        #[serde(skip_serializing_if = "Option::is_none")]
        reply: Option<Vec<u8>>,
        /// Cross-document execution view changes caused by notebook pointer
        /// movement in this sync batch.
        #[serde(skip_serializing_if = "ExecutionViewChangeset::is_empty")]
        #[serde(default)]
        execution_view_changeset: ExecutionViewChangeset,
    },
    /// Broadcast event from the daemon (kernel status, output, etc.)
    Broadcast {
        /// The broadcast payload (parsed from JSON frame, passed through as-is).
        payload: serde_json::Value,
    },
    /// Presence update from a remote peer.
    Presence {
        /// The decoded presence message (decoded from CBOR, passed through as-is).
        payload: serde_json::Value,
    },
    /// Connection-local session status from the daemon.
    SessionControl {
        /// Full bootstrap/readiness snapshot for this socket.
        status: SessionSyncStatusWire,
    },
    /// Runtime state document was synced — frontend should update runtime state UI.
    RuntimeStateSyncApplied {
        /// True if the runtime state document changed.
        changed: bool,
        /// The full current runtime state snapshot (only when changed).
        /// Includes outputs inline in each ExecutionState entry.
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<Box<RuntimeState>>,
        /// Per-output diff for this sync frame. Added or modified outputs
        /// arrive here with their narrowed manifest inline; the frontend's
        /// outputs store can write them straight in with no second
        /// lookup against the state doc.
        ///
        /// Keyed by the `output_id` field on each output manifest (UUIDv4
        /// stamped by the daemon). Removed output_ids are carried alongside
        /// so the store can drop them.
        #[serde(skip_serializing_if = "OutputChangeset::is_empty")]
        #[serde(default)]
        output_changeset: OutputChangeset,
        /// Execution-id materialized-view diff for runtime-state changes.
        #[serde(skip_serializing_if = "ExecutionViewChangeset::is_empty")]
        #[serde(default)]
        execution_view_changeset: ExecutionViewChangeset,
    },
    /// CommsDoc was synced — frontend should update widget comm projections.
    CommsDocSyncApplied {
        changed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<Box<CommsState>>,
    },
    /// CommentsDoc was synced — frontend should update comment projections.
    CommentsDocSyncApplied {
        changed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        projection: Option<Box<CommentsProjection>>,
    },
    /// Sync apply error recovered — doc rebuilt and sync state normalized.
    ///
    /// Emitted when `receive_sync_message` returns an error. The WASM layer
    /// rebuilds the doc via save→load and normalizes sync state via encode→decode
    /// round-trip (preserving `shared_heads`, clearing transient state). The
    /// optional `reply` contains a fresh sync message to restart negotiation.
    SyncError {
        /// True if the document advanced before the error (partial apply).
        /// When true, the SyncEngine should trigger a full materialization
        /// so the UI reflects the recovered doc state.
        changed: bool,
        /// Fresh sync message generated after recovery.
        #[serde(skip_serializing_if = "Option::is_none")]
        reply: Option<Vec<u8>>,
    },
    /// Runtime state sync error recovered — state doc rebuilt.
    RuntimeStateSyncError {
        /// True if the state doc advanced before the error.
        changed: bool,
        /// The current runtime state snapshot (only when changed).
        /// Included so the SyncEngine can update the UI even if no
        /// further runtime-state frames arrive after recovery.
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<Box<RuntimeState>>,
        /// Fresh sync message generated after recovery.
        #[serde(skip_serializing_if = "Option::is_none")]
        reply: Option<Vec<u8>>,
        /// Execution-id materialized-view diff after recovery.
        #[serde(skip_serializing_if = "ExecutionViewChangeset::is_empty")]
        #[serde(default)]
        execution_view_changeset: ExecutionViewChangeset,
    },
    /// CommsDoc sync error recovered — comms doc rebuilt.
    CommsDocSyncError {
        changed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<Box<CommsState>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply: Option<Vec<u8>>,
    },
    /// CommentsDoc sync error recovered — comments doc rebuilt.
    CommentsDocSyncError {
        changed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        projection: Option<Box<CommentsProjection>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply: Option<Vec<u8>>,
    },
    /// Pool state document was synced — frontend should update pool state UI.
    PoolStateSyncApplied {
        /// True if the pool state document changed.
        changed: bool,
        /// The full current pool state snapshot (only when changed).
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<Box<PoolState>>,
    },
    /// Pool state sync error recovered — pool doc rebuilt.
    PoolStateSyncError {
        /// True if the pool doc advanced before the error.
        changed: bool,
        /// The current pool state snapshot (only when changed).
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<Box<PoolState>>,
        /// Fresh sync message generated after recovery.
        #[serde(skip_serializing_if = "Option::is_none")]
        reply: Option<Vec<u8>>,
    },
    /// Unknown frame type — frontend can log and ignore.
    Unknown { frame_type: u8 },
}

/// Outbound frame produced by [`RoomHostHandle`].
///
/// The Worker owns WebSocket I/O; the WASM room host owns document state and
/// per-peer Automerge sync state. Each event tells the Worker which peer should
/// receive which typed-frame payload.
#[derive(Serialize, Debug)]
pub struct RoomHostOutboundFrame {
    pub peer_id: String,
    pub frame_type: u8,
    pub payload: Vec<u8>,
}

/// Result returned after the room host processes one peer frame.
#[derive(Serialize, Debug)]
pub struct RoomHostFrameResult {
    pub changed: bool,
    pub ignored_stale: bool,
    pub notebook_changed: bool,
    pub runtime_state_changed: bool,
    pub outbound: Vec<RoomHostOutboundFrame>,
}

impl RoomHostFrameResult {
    fn empty() -> Self {
        Self {
            changed: false,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: false,
            outbound: Vec::new(),
        }
    }
}

/// WASM-side authoring handle for a runtime peer.
///
/// This is intentionally separate from [`NotebookHandle`]: hosted runtime
/// agents need to publish execution/output state without acquiring a frontend
/// notebook editing surface.
#[wasm_bindgen]
pub struct RuntimeStatePeerHandle {
    state_doc: RuntimeStateDoc,
    state_sync_state: sync::State,
    comms_doc: CommsDoc,
    comms_sync_state: sync::State,
}

#[derive(Serialize)]
struct RuntimeStatePeerFrameResult {
    changed: bool,
    reply: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl RuntimeStatePeerHandle {
    #[wasm_bindgen(constructor)]
    pub fn new(actor_label: &str) -> Result<RuntimeStatePeerHandle, JsError> {
        let mut state_doc = RuntimeStateDoc::try_new_empty()
            .map_err(|e| JsError::new(&format!("create runtime peer state doc: {e}")))?;
        state_doc.set_actor(actor_label);
        Ok(RuntimeStatePeerHandle {
            state_doc,
            state_sync_state: sync::State::new(),
            comms_doc: CommsDoc::try_new_with_actor(actor_label)
                .map_err(|e| JsError::new(&format!("create runtime peer comms doc: {e}")))?,
            comms_sync_state: sync::State::new(),
        })
    }

    pub fn load(
        runtime_state_bytes: &[u8],
        actor_label: &str,
    ) -> Result<RuntimeStatePeerHandle, JsError> {
        let runtime_doc = automerge::AutoCommit::load(runtime_state_bytes)
            .map_err(|e| JsError::new(&format!("load runtime state doc: {e}")))?;
        let mut state_doc = RuntimeStateDoc::from_doc(runtime_doc);
        state_doc.set_actor(actor_label);
        Ok(RuntimeStatePeerHandle {
            state_doc,
            state_sync_state: sync::State::new(),
            comms_doc: CommsDoc::try_new_with_actor(actor_label)
                .map_err(|e| JsError::new(&format!("create runtime peer comms doc: {e}")))?,
            comms_sync_state: sync::State::new(),
        })
    }

    pub fn set_actor(&mut self, actor_label: &str) {
        self.state_doc.set_actor(actor_label);
        self.comms_doc
            .doc_mut()
            .set_actor(automerge::ActorId::from(actor_label.as_bytes()));
    }

    pub fn receive_frame(&mut self, frame_bytes: &[u8]) -> Result<JsValue, JsError> {
        if frame_bytes.is_empty() {
            return Err(JsError::new("typed frame cannot be empty"));
        }

        let result = match frame_bytes[0] {
            frame_types::RUNTIME_STATE_SYNC => {
                let message = sync::Message::decode(&frame_bytes[1..])
                    .map_err(|e| JsError::new(&format!("decode runtime state sync: {e}")))?;
                let heads_before = self.state_doc.get_heads();
                self.state_doc
                    .receive_sync_message_with_changes_recovering(
                        &mut self.state_sync_state,
                        message,
                        "runtime-peer-receive-sync",
                    )
                    .map_err(|e| JsError::new(&format!("receive runtime state sync: {e}")))?;
                RuntimeStatePeerFrameResult {
                    changed: heads_before != self.state_doc.get_heads(),
                    reply: self.generate_runtime_state_sync_reply(),
                }
            }
            frame_types::COMMS_DOC_SYNC => {
                let message = sync::Message::decode(&frame_bytes[1..])
                    .map_err(|e| JsError::new(&format!("decode comms doc sync: {e}")))?;
                let heads_before = self.comms_doc.get_heads();
                self.comms_doc
                    .receive_sync_message_with_changes_recovering(
                        &mut self.comms_sync_state,
                        message,
                        "runtime-peer-comms-receive-sync",
                    )
                    .map_err(|e| JsError::new(&format!("receive comms doc sync: {e}")))?;
                RuntimeStatePeerFrameResult {
                    changed: heads_before != self.comms_doc.get_heads(),
                    reply: self.generate_comms_doc_sync_reply(),
                }
            }
            _ => {
                return Err(JsError::new(
                    "runtime peer only accepts RuntimeStateDoc or CommsDoc sync frames",
                ));
            }
        };
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize runtime peer result: {e}")))
    }

    pub fn flush_runtime_state_sync(&mut self) -> Option<Vec<u8>> {
        self.state_doc
            .generate_sync_message(&mut self.state_sync_state)
            .map(|msg| msg.encode())
    }

    pub fn generate_runtime_state_sync_reply(&mut self) -> Option<Vec<u8>> {
        self.state_doc
            .generate_sync_message(&mut self.state_sync_state)
            .map(|msg| msg.encode())
    }

    pub fn cancel_last_runtime_state_flush(&mut self) {
        self.state_sync_state.in_flight = false;
        self.state_sync_state.sent_hashes.clear();
    }

    pub fn flush_comms_doc_sync(&mut self) -> Option<Vec<u8>> {
        self.comms_doc
            .generate_sync_message(&mut self.comms_sync_state)
            .map(|msg| msg.encode())
    }

    pub fn generate_comms_doc_sync_reply(&mut self) -> Option<Vec<u8>> {
        self.comms_doc
            .generate_sync_message(&mut self.comms_sync_state)
            .map(|msg| msg.encode())
    }

    pub fn cancel_last_comms_doc_flush(&mut self) {
        self.comms_sync_state.in_flight = false;
        self.comms_sync_state.sent_hashes.clear();
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.state_doc.doc_mut().save()
    }

    pub fn save_comms_doc(&mut self) -> Vec<u8> {
        self.comms_doc.doc_mut().save()
    }

    pub fn get_runtime_state(&self) -> JsValue {
        serialize_to_js(&self.state_doc.read_state()).unwrap_or(JsValue::UNDEFINED)
    }

    pub fn set_kernel_running(
        &mut self,
        kernel_name: &str,
        language: &str,
        env_source: &str,
        runtime_agent_id: &str,
    ) -> Result<(), JsError> {
        self.state_doc
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .map_err(|e| JsError::new(&format!("set kernel lifecycle failed: {e}")))?;
        self.state_doc
            .set_kernel_info(kernel_name, language, env_source)
            .map_err(|e| JsError::new(&format!("set kernel info failed: {e}")))?;
        self.state_doc
            .set_runtime_agent_id(runtime_agent_id)
            .map_err(|e| JsError::new(&format!("set runtime agent id failed: {e}")))
    }

    pub fn set_kernel_error(&mut self, details: Option<String>) -> Result<(), JsError> {
        self.state_doc
            .set_lifecycle_with_error_details(&RuntimeLifecycle::Error, None, details.as_deref())
            .map_err(|e| JsError::new(&format!("set kernel error failed: {e}")))
    }

    pub fn create_execution(&mut self, execution_id: &str) -> Result<(), JsError> {
        self.state_doc
            .create_execution(execution_id)
            .map_err(|e| JsError::new(&format!("create execution failed: {e}")))
    }

    pub fn create_execution_with_source(
        &mut self,
        execution_id: &str,
        source: &str,
        seq: u32,
    ) -> Result<bool, JsError> {
        self.state_doc
            .create_execution_with_source(execution_id, source, seq.into())
            .map_err(|e| JsError::new(&format!("create execution with source failed: {e}")))
    }

    pub fn set_execution_running(&mut self, execution_id: &str) -> Result<(), JsError> {
        self.state_doc
            .set_execution_running(execution_id)
            .map_err(|e| JsError::new(&format!("set execution running failed: {e}")))
    }

    pub fn set_execution_count(
        &mut self,
        execution_id: &str,
        execution_count: i32,
    ) -> Result<(), JsError> {
        self.state_doc
            .set_execution_count(execution_id, execution_count.into())
            .map_err(|e| JsError::new(&format!("set execution count failed: {e}")))
    }

    pub fn set_execution_done(&mut self, execution_id: &str, success: bool) -> Result<(), JsError> {
        self.state_doc
            .set_execution_done(execution_id, success)
            .map_err(|e| JsError::new(&format!("set execution done failed: {e}")))
    }

    pub fn append_output_json(
        &mut self,
        execution_id: &str,
        manifest_json: &str,
    ) -> Result<String, JsError> {
        let manifest: serde_json::Value = serde_json::from_str(manifest_json)
            .map_err(|e| JsError::new(&format!("decode output manifest json: {e}")))?;
        self.state_doc
            .append_output(execution_id, &manifest)
            .map_err(|e| JsError::new(&format!("append output failed: {e}")))
    }

    pub fn put_comm_json(
        &mut self,
        comm_id: &str,
        target_name: &str,
        model_module: &str,
        model_name: &str,
        state_json: &str,
        seq: u32,
    ) -> Result<(), JsError> {
        let state: serde_json::Value = serde_json::from_str(state_json)
            .map_err(|e| JsError::new(&format!("decode comm state json: {e}")))?;
        self.state_doc
            .put_comm(
                comm_id,
                target_name,
                model_module,
                model_name,
                &serde_json::json!({}),
                seq.into(),
            )
            .map_err(|e| JsError::new(&format!("put comm topology failed: {e}")))?;
        self.comms_doc
            .put_comm_state(comm_id, &state)
            .map_err(|e| JsError::new(&format!("put comm state failed: {e}")))
    }
}

/// Durable-Object room host for NotebookDoc + RuntimeStateDoc + CommsDoc + CommentsDoc sync.
///
/// Unlike [`NotebookHandle`], this is not a frontend/client handle. It owns the
/// authoritative document pair for one room and keeps a separate Automerge
/// `sync::State` per connected peer. That per-peer state is load-bearing:
/// sharing one sync state across browser tabs would make the Worker acknowledge
/// the wrong heads and eventually suppress valid sync messages.
#[wasm_bindgen]
pub struct RoomHostHandle {
    doc: NotebookDoc,
    state_doc: RuntimeStateDoc,
    comms_doc: CommsDoc,
    comments_doc: CommentsDoc,
    notebook_peer_states: HashMap<String, sync::State>,
    runtime_peer_states: HashMap<String, sync::State>,
    comms_peer_states: HashMap<String, sync::State>,
    comments_peer_states: HashMap<String, sync::State>,
}

#[wasm_bindgen]
impl RoomHostHandle {
    /// Create an empty room host from the canonical schema seeds.
    pub fn create_empty(notebook_id: &str, actor_label: &str) -> Result<RoomHostHandle, JsError> {
        let (comments_doc_id, comments_ref) = hosted_comments_identity(notebook_id);
        Ok(RoomHostHandle {
            doc: NotebookDoc::new_with_actor(notebook_id, actor_label),
            state_doc: RuntimeStateDoc::try_new_empty()
                .map_err(|e| JsError::new(&format!("create runtime state doc failed: {e}")))?,
            comms_doc: CommsDoc::try_new_empty()
                .map_err(|e| JsError::new(&format!("create comms doc failed: {e}")))?,
            comments_doc: CommentsDoc::try_new_empty(&comments_doc_id, &comments_ref)
                .map_err(|e| JsError::new(&format!("create comments doc failed: {e}")))?,
            notebook_peer_states: HashMap::new(),
            runtime_peer_states: HashMap::new(),
            comms_peer_states: HashMap::new(),
            comments_peer_states: HashMap::new(),
        })
    }

    /// Seed the room with one initial code cell if the authoritative NotebookDoc is empty.
    ///
    /// Hosted room creation uses this after creating a brand-new room host. Sync
    /// bootstrap handles and test fixtures can still use `create_empty` to mean
    /// "schema only, zero cells."
    pub fn seed_initial_code_cell_if_empty(&mut self, cell_id: &str) -> Result<bool, JsError> {
        if !self.doc.is_pristine() {
            return Ok(false);
        }
        self.doc
            .add_cell_after(cell_id, "code", None)
            .map_err(|e| JsError::new(&format!("seed initial code cell failed: {e}")))?;
        Ok(true)
    }

    /// Load a room host from persisted NotebookDoc + RuntimeStateDoc bytes.
    pub fn load_snapshot(
        notebook_bytes: &[u8],
        runtime_state_bytes: &[u8],
    ) -> Result<RoomHostHandle, JsError> {
        let doc = NotebookDoc::load_with_encoding(
            notebook_bytes,
            notebook_doc::TextEncoding::Utf16CodeUnit,
        )
        .map_err(|e| JsError::new(&format!("load notebook snapshot failed: {e}")))?;
        let runtime_doc = automerge::AutoCommit::load(runtime_state_bytes)
            .map_err(|e| JsError::new(&format!("load runtime snapshot failed: {e}")))?;
        let notebook_id = doc
            .notebook_id()
            .ok_or_else(|| JsError::new("load room host snapshot missing notebook_id"))?;
        let (comments_doc_id, comments_ref) = hosted_comments_identity(&notebook_id);
        Ok(RoomHostHandle {
            doc,
            state_doc: RuntimeStateDoc::from_doc(runtime_doc),
            comms_doc: CommsDoc::try_new_empty()
                .map_err(|e| JsError::new(&format!("create comms doc failed: {e}")))?,
            comments_doc: CommentsDoc::try_new_empty(&comments_doc_id, &comments_ref)
                .map_err(|e| JsError::new(&format!("create comments doc failed: {e}")))?,
            notebook_peer_states: HashMap::new(),
            runtime_peer_states: HashMap::new(),
            comms_peer_states: HashMap::new(),
            comments_peer_states: HashMap::new(),
        })
    }

    /// Drop all sync state for a disconnected peer.
    pub fn remove_peer(&mut self, peer_id: &str) {
        self.notebook_peer_states.remove(peer_id);
        self.runtime_peer_states.remove(peer_id);
        self.comms_peer_states.remove(peer_id);
        self.comments_peer_states.remove(peer_id);
    }

    /// Reconcile the authoritative RuntimeStateDoc after the room's
    /// `runtime_peer` has departed and not returned within the grace period.
    ///
    /// This is the room-side safety net the daemon structurally cannot provide:
    /// when the runtime peer (the daemon) vanishes, it is the very actor that
    /// would otherwise terminalize in-flight work, so no surviving participant
    /// and no daemon-side code can correct the doc (lifecycle-analysis reqs #3,
    /// #7). Left alone, running/queued executions spin forever and the kernel
    /// shows a phantom-live status to every viewer.
    ///
    /// Concretely it: marks all in-flight (`running`/`queued`) executions
    /// failed, clears the queue, and — if the kernel still reads as live
    /// (`Running`/a starting phase) — flips lifecycle to `Error` with an
    /// `error_details` note. It deliberately does NOT touch an already-terminal
    /// kernel (`Error`/`Shutdown`/`NotStarted`), so a clean shutdown that raced
    /// the disconnect is not relabeled.
    ///
    /// Authoring here is *direct* on the room host's `state_doc`, which does not
    /// pass through `validate_runtime_state_sync_scope` (that gates only incoming
    /// peer sync); the room host is the authoritative writer for this document,
    /// so no policy relaxation is required (see #16 decision log #32).
    ///
    /// The Worker is expected to call this from a DurableObject `alarm()` armed
    /// when the last `runtime_peer` leaves and disarmed if one rejoins within the
    /// grace window — so a transient blip reconnects rather than reconciles.
    /// `reason` is a short human string folded into `error_details`. Returns the
    /// outbound sync frames to broadcast to remaining peers (empty if nothing
    /// changed — the call is idempotent, so a second alarm is a safe no-op).
    pub fn reconcile_runtime_peer_gone(&mut self, reason: &str) -> Result<JsValue, JsError> {
        let result = self.reconcile_runtime_peer_gone_inner(reason)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize reconcile result: {e}")))
    }

    /// Publish the room-host-owned workstation attachment snapshot into
    /// RuntimeStateDoc and return outbound runtime-state sync frames.
    ///
    /// `attachment_json` is either a JSON `WorkstationAttachmentState` object
    /// or `null` to clear the current attachment. This is a room-host API,
    /// intentionally separate from incoming runtime-peer sync frames: runtime
    /// peers can report provider facts through control paths, but the host owns
    /// the notebook-visible selected-compute projection.
    pub fn set_workstation_attachment_json(
        &mut self,
        attachment_json: &str,
    ) -> Result<JsValue, JsError> {
        let attachment =
            serde_json::from_str::<Option<WorkstationAttachmentState>>(attachment_json)
                .map_err(|e| JsError::new(&format!("parse workstation attachment: {e}")))?;
        let result = self.set_workstation_attachment_inner(attachment.as_ref())?;
        serialize_to_js(&result).map_err(|e| {
            JsError::new(&format!(
                "serialize workstation attachment sync result: {e}"
            ))
        })
    }

    /// Return the current room-host-owned workstation attachment snapshot.
    ///
    /// The Worker uses this before accepting a runtime peer so only the
    /// workstation selected for the notebook can refresh the live attachment
    /// projection. This is read-only; mutations still go through
    /// `set_workstation_attachment_json` or runtime-peer-gone reconciliation.
    pub fn get_workstation_attachment_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.state_doc.workstation_attachment())
            .map_err(|e| JsError::new(&format!("serialize workstation attachment: {e}")))
    }

    /// Number of executions currently waiting behind any active execution.
    ///
    /// Dashboard summaries use this for "N queued" without materializing a
    /// browser-side shadow of RuntimeStateDoc queue state.
    pub fn get_runtime_queue_depth(&self) -> usize {
        self.state_doc.read_state().queue.queued.len()
    }

    /// Execution-only activity snapshot for hosted runtime idle guards.
    ///
    /// The room host uses this to decide whether the runtime can be lazily
    /// torn down after its idle TTL. It intentionally reports only execution
    /// state from RuntimeStateDoc: no room occupant or WebSocket presence facts
    /// participate in the decision.
    pub fn get_runtime_execution_activity_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&runtime_execution_activity(&self.state_doc.read_state()))
            .map_err(|e| JsError::new(&format!("serialize runtime execution activity: {e}")))
    }

    /// Cleanly reconcile an execution-idle hosted runtime after the idle TTL.
    ///
    /// This is not the crash watchdog: it does not mark executions failed and
    /// it does not turn the kernel into Error. The caller must first decide the
    /// runtime peer should be stopped. This method rechecks RuntimeStateDoc and
    /// only shuts down when no execution is active and the queue is empty.
    pub fn reconcile_runtime_idle_timeout(
        &mut self,
        reason: &str,
        _updated_at: &str,
    ) -> Result<JsValue, JsError> {
        let result = self.reconcile_runtime_idle_timeout_inner(reason)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize runtime idle timeout result: {e}")))
    }

    /// Generate current sync frames for a peer.
    ///
    /// The Worker calls this immediately after accepting a socket and after the
    /// peer receives `cloud_room_ready`. It lets read-only viewers receive the
    /// current document without authoring any local Automerge changes.
    pub fn sync_peer(&mut self, peer_id: &str, connection_scope: &str) -> Result<JsValue, JsError> {
        let connection_scope = parse_connection_scope(connection_scope)?;
        let mut result = RoomHostFrameResult::empty();
        self.queue_current_sync_for_peer(
            peer_id,
            connection_scope.allows_notebook_write(),
            allows_runtime_state_doc_write(connection_scope),
            allows_comms_doc_write(connection_scope),
            allows_comments_doc_write(connection_scope),
            &mut result.outbound,
        )?;
        serialize_to_js(&result).map_err(|e| JsError::new(&format!("serialize room result: {e}")))
    }

    /// Apply a typed-frame from a peer to the room host.
    ///
    /// `can_write` is the server-side scope decision for this document stream.
    /// Viewers and runtime peers may still send empty sync acks/needs so the
    /// Automerge protocol can converge, but any message carrying changes is
    /// rejected unless `can_write` is true.
    pub fn receive_peer_frame(
        &mut self,
        peer_id: &str,
        principal: &str,
        submitter_actor_label: &str,
        connection_scope: &str,
        can_write_all_notebook_changes: bool,
        frame_bytes: &[u8],
    ) -> Result<JsValue, JsError> {
        if frame_bytes.is_empty() {
            return Err(JsError::new("typed frame cannot be empty"));
        }

        let connection_scope = parse_connection_scope(connection_scope)?;
        let runtime_scope = runtime_state_write_scope(connection_scope);
        let can_write_notebook = connection_scope.allows_notebook_write();
        let can_submit_execution_requests = allows_execution_request_submit(connection_scope);
        let can_write_comms = allows_comms_doc_write(connection_scope);
        let can_write_comments = allows_comments_doc_write(connection_scope);
        let frame_type = frame_bytes[0];
        let payload = &frame_bytes[1..];
        let result = match frame_type {
            frame_types::AUTOMERGE_SYNC => self.receive_notebook_sync(
                peer_id,
                principal,
                can_write_notebook,
                can_write_all_notebook_changes,
                payload,
            )?,
            frame_types::RUNTIME_STATE_SYNC => {
                self.receive_runtime_state_sync(peer_id, principal, runtime_scope, payload)?
            }
            frame_types::COMMS_DOC_SYNC => {
                self.receive_comms_doc_sync(peer_id, principal, can_write_comms, payload)?
            }
            frame_types::COMMENTS_DOC_SYNC => {
                self.receive_comments_doc_sync(peer_id, principal, can_write_comments, payload)?
            }
            frame_types::REQUEST => self.receive_request(
                peer_id,
                submitter_actor_label,
                can_submit_execution_requests,
                payload,
            )?,
            _ => RoomHostFrameResult::empty(),
        };

        serialize_to_js(&result).map_err(|e| JsError::new(&format!("serialize room result: {e}")))
    }

    /// Export the current NotebookDoc bytes for room checkpointing.
    pub fn save_notebook(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    /// Export the current RuntimeStateDoc bytes for room checkpointing.
    pub fn save_runtime_state_doc(&mut self) -> Vec<u8> {
        self.state_doc.doc_mut().save()
    }

    /// Export the current CommsDoc bytes for room checkpointing.
    pub fn save_comms_doc(&mut self) -> Vec<u8> {
        self.comms_doc.doc_mut().save()
    }

    /// Export the current CommentsDoc bytes for room checkpointing.
    pub fn save_comments_doc(&mut self) -> Vec<u8> {
        self.comments_doc.save()
    }

    /// Replace the current CommsDoc from checkpointed bytes.
    pub fn load_comms_doc(&mut self, comms_bytes: &[u8]) -> Result<(), JsError> {
        let comms_doc = automerge::AutoCommit::load(comms_bytes)
            .map_err(|e| JsError::new(&format!("load comms snapshot failed: {e}")))?;
        self.comms_doc = CommsDoc::from_doc(comms_doc);
        self.comms_peer_states.clear();
        Ok(())
    }

    /// Replace the current CommentsDoc from checkpointed bytes.
    pub fn load_comments_doc(&mut self, comments_bytes: &[u8]) -> Result<(), JsError> {
        self.load_comments_doc_inner(comments_bytes)
            .map_err(|error| JsError::new(&error))
    }

    /// Current NotebookDoc heads as hex strings.
    pub fn get_heads_hex(&mut self) -> Vec<String> {
        self.doc.get_heads_hex()
    }

    /// Current RuntimeStateDoc heads as hex strings.
    pub fn get_runtime_state_heads_hex(&mut self) -> Vec<String> {
        self.state_doc
            .get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    /// Current CommsDoc heads as hex strings.
    pub fn get_comms_doc_heads_hex(&mut self) -> Vec<String> {
        self.comms_doc
            .get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    /// Current CommentsDoc heads as hex strings.
    pub fn get_comments_doc_heads_hex(&mut self) -> Vec<String> {
        self.comments_doc
            .get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    /// Read the current CommentsDoc projection from the room-host document set.
    pub fn get_comments_projection(&mut self) -> JsValue {
        let cell_order: Vec<String> = self
            .doc
            .get_cells()
            .into_iter()
            .map(|cell| cell.id)
            .collect();
        match self.comments_doc.read_projection(Some(&cell_order)) {
            Ok(projection) => serialize_to_js(&projection).unwrap_or(JsValue::UNDEFINED),
            Err(_) => JsValue::UNDEFINED,
        }
    }
}

impl RoomHostHandle {
    /// Hosted rooms derive the CommentsDoc identity from the authoritative
    /// NotebookDoc id, not from potentially stale CommentsDoc contents.
    fn expected_comments_identity(&self) -> Result<(String, NotebookCommentRef), String> {
        self.doc
            .notebook_id()
            .map(|notebook_id| hosted_comments_identity(&notebook_id))
            .ok_or_else(|| "room host notebook is missing notebook_id".to_string())
    }

    fn load_comments_doc_inner(&mut self, comments_bytes: &[u8]) -> Result<(), String> {
        let (expected_comments_doc_id, expected_comments_ref) =
            self.expected_comments_identity()?;
        let actor = notebook_doc::actor_label_from_id(self.comments_doc.doc().get_actor());
        let (comments_doc, _repaired) = CommentsDoc::load_with_actor_repairing_identity(
            comments_bytes,
            &expected_comments_doc_id,
            &expected_comments_ref,
            &actor,
        )
        .map_err(|e| format!("load comments snapshot failed: {e}"))?;
        self.comments_doc = comments_doc;
        self.comments_peer_states.clear();
        Ok(())
    }

    fn receive_notebook_sync(
        &mut self,
        peer_id: &str,
        principal: &str,
        can_write: bool,
        can_write_all_notebook_changes: bool,
        payload: &[u8],
    ) -> Result<RoomHostFrameResult, JsError> {
        let message = sync::Message::decode(payload)
            .map_err(|e| JsError::new(&format!("decode notebook sync: {e}")))?;
        let has_changes = !message.changes.is_empty();
        if has_changes && !can_write {
            return Err(JsError::new(
                "connection scope cannot write NotebookDoc changes",
            ));
        }
        if has_changes {
            let heads_before = self.doc.get_heads();
            let peer_state = self
                .notebook_peer_states
                .entry(peer_id.to_string())
                .or_insert_with(|| room_peer_sync_state(can_write));
            let mut preview = NotebookDoc::wrap(self.doc.doc().clone());
            let mut preview_peer_state = peer_state.clone();
            preview
                .receive_sync_message_recovering(
                    &mut preview_peer_state,
                    message.clone(),
                    "cloud-room-doc-auth-preview",
                )
                .map_err(|e| JsError::new(&format!("notebook auth preview failed: {e}")))?;
            let actors = extract_change_actor_hashes(preview.doc_mut(), &heads_before);
            validate_room_notebook_change_actors(principal, actors.iter())?;
            if !can_write_all_notebook_changes {
                validate_editor_notebook_changes(&mut preview, &heads_before, actors.iter())
                    .map_err(|e| JsError::new(&e))?;
            }
        }

        let heads_before = self.doc.get_heads();
        {
            let peer_state = self
                .notebook_peer_states
                .entry(peer_id.to_string())
                .or_insert_with(|| room_peer_sync_state(can_write));
            self.doc
                .receive_sync_message_recovering(peer_state, message, "cloud-room-doc-receive-sync")
                .map_err(|e| JsError::new(&format!("receive notebook sync: {e}")))?;
        }
        let heads_after = self.doc.get_heads();
        let changed = heads_before != heads_after;

        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: changed,
            runtime_state_changed: false,
            outbound: Vec::new(),
        };
        self.queue_notebook_sync_for_peer(peer_id, can_write, &mut result.outbound)?;
        if changed {
            self.queue_notebook_sync_for_other_peers(peer_id, &mut result.outbound)?;
        }
        Ok(result)
    }

    fn receive_runtime_state_sync(
        &mut self,
        peer_id: &str,
        principal: &str,
        scope: RuntimeStateWriteScope,
        payload: &[u8],
    ) -> Result<RoomHostFrameResult, JsError> {
        let message = sync::Message::decode(payload)
            .map_err(|e| JsError::new(&format!("decode runtime state sync: {e}")))?;
        let has_changes = !message.changes.is_empty();
        let can_write = scope.allows_runtime_state_write();
        if has_changes && !can_write {
            return Err(JsError::new(
                "connection scope cannot write RuntimeStateDoc changes",
            ));
        }
        if has_changes {
            let heads_before = self.state_doc.get_heads();
            let peer_state = self
                .runtime_peer_states
                .entry(peer_id.to_string())
                .or_insert_with(|| room_peer_sync_state(can_write));
            let mut preview = RuntimeStateDoc::from_doc(self.state_doc.doc().clone());
            let mut preview_peer_state = peer_state.clone();
            preview
                .receive_sync_message_with_changes_recovering(
                    &mut preview_peer_state,
                    message.clone(),
                    "cloud-room-state-auth-preview",
                )
                .map_err(|e| JsError::new(&format!("runtime state auth preview failed: {e}")))?;
            let actors = extract_change_actors(preview.doc_mut(), &heads_before);
            validate_room_actor_labels(principal, actors.iter().map(String::as_str))?;
            let state_before = runtime_state_policy_snapshot(&self.state_doc);
            let state_after = runtime_state_policy_snapshot(&preview);
            validate_runtime_state_sync_scope(&state_before, &state_after, scope)
                .map_err(|e| JsError::new(&e.to_string()))?;
            // This is a synchronous WASM host path: no await or host callback
            // can interleave another RuntimeStateDoc writer between the
            // validated preview and the real apply below.
        }

        let heads_before = self.state_doc.get_heads();
        {
            let peer_state = self
                .runtime_peer_states
                .entry(peer_id.to_string())
                .or_insert_with(|| room_peer_sync_state(can_write));
            self.state_doc
                .receive_sync_message_with_changes_recovering(
                    peer_state,
                    message,
                    "cloud-room-state-receive-sync",
                )
                .map_err(|e| JsError::new(&format!("receive runtime state sync: {e}")))?;
        }
        let heads_after = self.state_doc.get_heads();
        let changed = heads_before != heads_after;

        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            outbound: Vec::new(),
        };
        self.queue_runtime_state_sync_for_peer(peer_id, can_write, &mut result.outbound)?;
        if changed {
            self.queue_runtime_state_sync_for_other_peers(peer_id, &mut result.outbound)?;
        }
        Ok(result)
    }

    fn receive_comms_doc_sync(
        &mut self,
        peer_id: &str,
        principal: &str,
        can_write: bool,
        payload: &[u8],
    ) -> Result<RoomHostFrameResult, JsError> {
        let message = sync::Message::decode(payload)
            .map_err(|e| JsError::new(&format!("decode comms doc sync: {e}")))?;
        let has_changes = !message.changes.is_empty();
        if has_changes && !can_write {
            return Err(JsError::new(
                "connection scope cannot write CommsDoc changes",
            ));
        }
        if has_changes {
            let heads_before = self.comms_doc.get_heads();
            let peer_state = self
                .comms_peer_states
                .entry(peer_id.to_string())
                .or_insert_with(|| room_peer_sync_state(can_write));
            let mut preview = CommsDoc::from_doc(self.comms_doc.doc().clone());
            let mut preview_peer_state = peer_state.clone();
            preview
                .receive_sync_message_with_changes_recovering(
                    &mut preview_peer_state,
                    message.clone(),
                    "cloud-room-comms-auth-preview",
                )
                .map_err(|e| JsError::new(&format!("comms auth preview failed: {e}")))?;
            let actors = extract_change_actors(preview.doc_mut(), &heads_before);
            validate_room_actor_labels(principal, actors.iter().map(String::as_str))?;
        }

        let heads_before = self.comms_doc.get_heads();
        {
            let peer_state = self
                .comms_peer_states
                .entry(peer_id.to_string())
                .or_insert_with(|| room_peer_sync_state(can_write));
            self.comms_doc
                .receive_sync_message_with_changes_recovering(
                    peer_state,
                    message,
                    "cloud-room-comms-receive-sync",
                )
                .map_err(|e| JsError::new(&format!("receive comms doc sync: {e}")))?;
        }
        let heads_after = self.comms_doc.get_heads();
        let changed = heads_before != heads_after;

        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: false,
            outbound: Vec::new(),
        };
        self.queue_comms_doc_sync_for_peer(peer_id, can_write, &mut result.outbound)?;
        if changed {
            self.queue_comms_doc_sync_for_other_peers(peer_id, &mut result.outbound)?;
        }
        Ok(result)
    }

    fn receive_comments_doc_sync(
        &mut self,
        peer_id: &str,
        principal: &str,
        can_write: bool,
        payload: &[u8],
    ) -> Result<RoomHostFrameResult, JsError> {
        self.receive_comments_doc_sync_inner(peer_id, principal, can_write, payload)
            .map_err(|error| JsError::new(&error))
    }

    fn receive_comments_doc_sync_inner(
        &mut self,
        peer_id: &str,
        principal: &str,
        can_write: bool,
        payload: &[u8],
    ) -> Result<RoomHostFrameResult, String> {
        let message =
            sync::Message::decode(payload).map_err(|e| format!("decode comments doc sync: {e}"))?;
        let has_changes = !message.changes.is_empty();
        if has_changes && !can_write {
            return Err("connection scope cannot write CommentsDoc changes".to_string());
        }
        let (expected_comments_doc_id, expected_comments_ref) =
            self.expected_comments_identity()?;
        let mut next_comments_doc = self.comments_doc.clone();
        let receive_result;
        {
            let peer_state = self
                .comments_peer_states
                .entry(peer_id.to_string())
                .or_insert_with(|| room_peer_sync_state(can_write));
            let mut next_peer_state = peer_state.clone();
            receive_result = next_comments_doc
                .receive_sync_message_with_changes_repairing_identity_recovering(
                    &mut next_peer_state,
                    message,
                    &expected_comments_doc_id,
                    &expected_comments_ref,
                    "cloud-room-comments-receive-sync",
                )
                .map_err(|e| format!("receive comments doc sync: {e}"))?;
            if has_changes {
                validate_room_actor_labels_inner(
                    principal,
                    receive_result
                        .incoming_actor_labels
                        .iter()
                        .map(String::as_str),
                )?;
            }
            *peer_state = next_peer_state;
        }
        self.comments_doc = next_comments_doc;
        let changed = receive_result.changed;

        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: false,
            outbound: Vec::new(),
        };
        self.queue_comments_doc_sync_for_peer(peer_id, can_write, &mut result.outbound)
            .map_err(|error| format!("{error:?}"))?;
        if changed {
            self.queue_comments_doc_sync_for_other_peers(peer_id, &mut result.outbound)
                .map_err(|error| format!("{error:?}"))?;
        }
        Ok(result)
    }

    /// Handle a NotebookRequest frame (`frame_types::REQUEST`).
    ///
    /// The hosted room only acts on execution intent requests: an authorized
    /// browser peer asks to run synced notebook cells, and the room host (the
    /// one peer that can create execution intent) writes queued executions into
    /// RuntimeStateDoc for an attached `runtime_peer` to pick up. Other request
    /// kinds (LaunchKernel, kernel lifecycle) are local-daemon concerns and are
    /// ignored here so they leave the room unchanged rather than erroring the
    /// peer.
    fn receive_request(
        &mut self,
        peer_id: &str,
        submitter_actor_label: &str,
        can_submit_execution_requests: bool,
        payload: &[u8],
    ) -> Result<RoomHostFrameResult, JsError> {
        if !can_submit_execution_requests {
            return Err(JsError::new(
                "connection scope cannot submit execution requests",
            ));
        }
        let request: serde_json::Value = serde_json::from_slice(payload)
            .map_err(|e| JsError::new(&format!("decode request: {e}")))?;
        match request.get("action").and_then(|v| v.as_str()) {
            // Guarded and unguarded execution intent (single-cell and run-all)
            // both create executions; the observed-heads causal guard is deferred
            // (see ADR run-cell follow-ups). Until then `_guarded` is accepted for
            // wire parity but does not validate the requester's NotebookDoc heads.
            Some("execute_cell") | Some("execute_cell_guarded") => {
                self.handle_execute_cell(&request, peer_id, submitter_actor_label)
            }
            Some("run_all_cells") | Some("run_all_cells_guarded") => {
                self.handle_run_all_cells(&request, peer_id, submitter_actor_label)
            }
            _ => Ok(RoomHostFrameResult::empty()),
        }
    }

    /// Create a queued execution for an ExecuteCell request and broadcast it.
    fn handle_execute_cell(
        &mut self,
        request: &serde_json::Value,
        peer_id: &str,
        submitter_actor_label: &str,
    ) -> Result<RoomHostFrameResult, JsError> {
        let cell_id = request
            .get("cell_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| JsError::new("ExecuteCell request missing cell_id"))?;

        let cell = self
            .doc
            .get_cell(cell_id)
            .ok_or_else(|| JsError::new(&format!("cell not found: {cell_id}")))?;
        if cell.cell_type != "code" {
            return Err(JsError::new(&format!(
                "cannot execute non-code cell {cell_id} (type {})",
                cell.cell_type
            )));
        }

        // Idempotency guard, mirroring the daemon's ExecuteCell AlreadyActive
        // check: if the cell already points at an execution that is still queued
        // or running, re-running is a no-op. Without this a double-click queues
        // the cell twice (it runs twice, and the first execution's outputs are
        // orphaned when the cell pointer moves to the second).
        if let Some(active_id) = self.doc.get_execution_id(cell_id) {
            let still_active = self
                .state_doc
                .get_execution(&active_id)
                .is_some_and(|e| e.status == "queued" || e.status == "running");
            if still_active {
                // No-op: nothing changed. The room logs the materialized frame
                // (notebook-room.ts room.materialized_frame.applied) with
                // changed=false, which is the observable signal here.
                return Ok(RoomHostFrameResult::empty());
            }
        }

        // A client may supply an execution_id for idempotent retries; validate it
        // as a UUID so a malformed or oversized value can't become a document key.
        // Absent one, the room mints it.
        let requested_id = request.get("execution_id").and_then(|v| v.as_str());
        if let Some(id) = requested_id {
            if uuid::Uuid::parse_str(id).is_err() {
                return Err(JsError::new(&format!(
                    "execution_id is not a valid UUID: {id}"
                )));
            }
        }
        let execution_id = requested_id
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // Derive the queue seq from the document so it stays monotonic across
        // Durable Object hibernation/reload. An in-memory counter would reset to
        // 0 on reload and produce duplicate seqs / reordered execution.
        let next_seq = self
            .state_doc
            .read_state()
            .executions
            .values()
            .filter_map(|exec| exec.seq)
            .max()
            .map(|m| m + 1)
            .unwrap_or(0);

        // submitted_by is the submitter's full actor label (principal/operator),
        // pinned server-side from the authenticated identity, never a client value.
        // The full label (not a bare principal) matches what every other execution
        // producer writes and satisfies the ActorLabel `/`-delimited contract the
        // frontend attribution projection assumes.
        let created = self
            .state_doc
            .create_execution_with_source_provenance(
                &execution_id,
                &cell.source,
                next_seq,
                Some(submitter_actor_label),
                Some(cell_id),
            )
            .map_err(|e| JsError::new(&format!("create execution: {e}")))?;
        if !created {
            // The id already exists (a client retried with the same id). Treat it
            // as an idempotent no-op rather than erroring the peer, matching the
            // daemon: the existing execution is already in the synced doc.
            return Ok(RoomHostFrameResult::empty());
        }

        // Point the cell at its execution, matching the daemon's ExecuteCell path.
        // If stamping fails, roll back the queued execution so a runtime_peer does
        // not pick up an orphan that no cell points at.
        let previous_execution_id = self.doc.get_execution_id(cell_id);
        if let Err(e) = self.doc.set_execution_id(cell_id, Some(&execution_id)) {
            let _ = self
                .state_doc
                .remove_executions(std::slice::from_ref(&execution_id));
            return Err(JsError::new(&format!("stamp execution_id on cell: {e}")));
        }

        let queue_entry = QueueEntry {
            execution_id: execution_id.clone(),
        };
        if let Err(e) = self.append_queued_entries(std::slice::from_ref(&queue_entry)) {
            let _ = self
                .state_doc
                .remove_executions(std::slice::from_ref(&execution_id));
            let _ = self
                .doc
                .set_execution_id(cell_id, previous_execution_id.as_deref());
            return Err(e);
        }

        // Broadcast the new queued execution (RuntimeStateDoc) and the cell's
        // execution_id pointer (NotebookDoc) to the sender and all other peers.
        let mut result = RoomHostFrameResult {
            changed: true,
            ignored_stale: false,
            notebook_changed: true,
            runtime_state_changed: true,
            outbound: Vec::new(),
        };
        self.queue_runtime_state_sync_for_peer(peer_id, true, &mut result.outbound)?;
        self.queue_runtime_state_sync_for_other_peers(peer_id, &mut result.outbound)?;
        self.queue_notebook_sync_for_peer(peer_id, true, &mut result.outbound)?;
        self.queue_notebook_sync_for_other_peers(peer_id, &mut result.outbound)?;
        Ok(result)
    }

    /// Create queued executions for every code cell in the hosted notebook.
    fn handle_run_all_cells(
        &mut self,
        request: &serde_json::Value,
        peer_id: &str,
        submitter_actor_label: &str,
    ) -> Result<RoomHostFrameResult, JsError> {
        let requested_execution_ids = parse_requested_cell_execution_ids(request)?;
        let cells = self.doc.get_cells();
        let code_cells: Vec<_> = cells
            .into_iter()
            .filter(|cell| cell.cell_type == "code")
            .collect();
        if code_cells.is_empty() {
            return Ok(RoomHostFrameResult::empty());
        }

        let (existing_execution_ids, next_seq) = {
            let state = self.state_doc.read_state();
            let existing_execution_ids: HashSet<String> =
                state.executions.keys().cloned().collect();
            let next_seq = state
                .executions
                .values()
                .filter_map(|exec| exec.seq)
                .max()
                .map(|m| m + 1)
                .unwrap_or(0);
            (existing_execution_ids, next_seq)
        };
        let mut allocated_execution_ids = existing_execution_ids.clone();
        validate_requested_execution_ids(
            requested_execution_ids.as_ref(),
            &existing_execution_ids,
            &mut allocated_execution_ids,
        )?;

        let mut entries = Vec::new();
        for cell in &code_cells {
            let execution_id = requested_execution_ids
                .as_ref()
                .and_then(|ids| ids.get(&cell.id).cloned())
                .unwrap_or_else(|| allocate_hosted_execution_id(&mut allocated_execution_ids));
            let seq = next_seq + entries.len() as u64;
            entries.push((
                execution_id,
                cell.id.clone(),
                cell.source.clone(),
                seq,
                self.doc.get_execution_id(&cell.id),
            ));
        }

        let mut created_execution_ids = Vec::new();
        for (execution_id, cell_id, source, seq, _) in &entries {
            let created = self
                .state_doc
                .create_execution_with_source_provenance(
                    execution_id,
                    source,
                    *seq,
                    Some(submitter_actor_label),
                    Some(cell_id),
                )
                .map_err(|e| JsError::new(&format!("create execution: {e}")))?;
            if !created {
                let _ = self.state_doc.remove_executions(&created_execution_ids);
                return Err(JsError::new(&format!(
                    "execution_id already exists: {execution_id}"
                )));
            }
            created_execution_ids.push(execution_id.clone());
        }

        let mut stamped_cell_pointers = Vec::new();
        for (execution_id, cell_id, _, _, previous_execution_id) in &entries {
            if let Err(e) = self.doc.set_execution_id(cell_id, Some(execution_id)) {
                let _ = self.state_doc.remove_executions(&created_execution_ids);
                restore_cell_execution_pointers(&mut self.doc, &stamped_cell_pointers);
                return Err(JsError::new(&format!("stamp execution_id on cell: {e}")));
            }
            stamped_cell_pointers.push((cell_id.clone(), previous_execution_id.clone()));
        }

        let queued_entries: Vec<QueueEntry> = entries
            .iter()
            .map(|(execution_id, _, _, _, _)| QueueEntry {
                execution_id: execution_id.clone(),
            })
            .collect();
        if let Err(e) = self.append_queued_entries(&queued_entries) {
            let _ = self.state_doc.remove_executions(&created_execution_ids);
            restore_cell_execution_pointers(&mut self.doc, &stamped_cell_pointers);
            return Err(e);
        }

        let mut result = RoomHostFrameResult {
            changed: true,
            ignored_stale: false,
            notebook_changed: true,
            runtime_state_changed: true,
            outbound: Vec::new(),
        };
        self.queue_runtime_state_sync_for_peer(peer_id, true, &mut result.outbound)?;
        self.queue_runtime_state_sync_for_other_peers(peer_id, &mut result.outbound)?;
        self.queue_notebook_sync_for_peer(peer_id, true, &mut result.outbound)?;
        self.queue_notebook_sync_for_other_peers(peer_id, &mut result.outbound)?;
        Ok(result)
    }

    fn append_queued_entries(&mut self, entries: &[QueueEntry]) -> Result<(), JsError> {
        if entries.is_empty() {
            return Ok(());
        }
        let queue = self.state_doc.read_state().queue;
        let executing = queue.executing;
        let mut queued = queue.queued;
        let mut seen = HashSet::new();
        if let Some(entry) = &executing {
            seen.insert(entry.execution_id.clone());
        }
        for entry in &queued {
            seen.insert(entry.execution_id.clone());
        }
        for entry in entries {
            if seen.insert(entry.execution_id.clone()) {
                queued.push(entry.clone());
            }
        }
        self.state_doc
            .set_queue(executing.as_ref(), &queued)
            .map_err(|e| JsError::new(&format!("publish queued executions: {e}")))
    }

    fn queue_current_sync_for_peer(
        &mut self,
        peer_id: &str,
        can_write_notebook: bool,
        can_write_runtime_state: bool,
        can_write_comms: bool,
        can_write_comments: bool,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        self.queue_notebook_sync_for_peer(peer_id, can_write_notebook, outbound)?;
        self.queue_runtime_state_sync_for_peer(peer_id, can_write_runtime_state, outbound)?;
        self.queue_comms_doc_sync_for_peer(peer_id, can_write_comms, outbound)?;
        self.queue_comments_doc_sync_for_peer(peer_id, can_write_comments, outbound)?;
        Ok(())
    }

    fn queue_notebook_sync_for_peer(
        &mut self,
        peer_id: &str,
        can_write: bool,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peer_state = self
            .notebook_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .doc
            .generate_sync_message_recovering(peer_state, "cloud-room-doc-sync-outbound")
            .map_err(|e| JsError::new(&format!("generate notebook sync: {e}")))?
        {
            outbound.push(RoomHostOutboundFrame {
                peer_id: peer_id.to_string(),
                frame_type: frame_types::AUTOMERGE_SYNC,
                payload: message.encode(),
            });
        }
        Ok(())
    }

    fn queue_notebook_sync_for_other_peers(
        &mut self,
        changed_peer_id: &str,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peers: Vec<String> = self.notebook_peer_states.keys().cloned().collect();
        for peer_id in peers {
            if peer_id == changed_peer_id {
                continue;
            }
            self.queue_notebook_sync_for_peer(&peer_id, true, outbound)?;
        }
        Ok(())
    }

    fn queue_runtime_state_sync_for_peer(
        &mut self,
        peer_id: &str,
        can_write: bool,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peer_state = self
            .runtime_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .state_doc
            .generate_sync_message_recovering(peer_state, "cloud-room-state-sync-outbound")
            .map_err(|e| JsError::new(&format!("generate runtime state sync: {e}")))?
        {
            outbound.push(RoomHostOutboundFrame {
                peer_id: peer_id.to_string(),
                frame_type: frame_types::RUNTIME_STATE_SYNC,
                payload: message.encode(),
            });
        }
        Ok(())
    }

    fn queue_runtime_state_sync_for_other_peers(
        &mut self,
        changed_peer_id: &str,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peers: Vec<String> = self.runtime_peer_states.keys().cloned().collect();
        for peer_id in peers {
            if peer_id == changed_peer_id {
                continue;
            }
            self.queue_runtime_state_sync_for_peer(&peer_id, true, outbound)?;
        }
        Ok(())
    }

    fn queue_comms_doc_sync_for_peer(
        &mut self,
        peer_id: &str,
        can_write: bool,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peer_state = self
            .comms_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .comms_doc
            .generate_sync_message_recovering(peer_state, "cloud-room-comms-sync-outbound")
            .map_err(|e| JsError::new(&format!("generate comms doc sync: {e}")))?
        {
            outbound.push(RoomHostOutboundFrame {
                peer_id: peer_id.to_string(),
                frame_type: frame_types::COMMS_DOC_SYNC,
                payload: message.encode(),
            });
        }
        Ok(())
    }

    fn queue_comms_doc_sync_for_other_peers(
        &mut self,
        changed_peer_id: &str,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peers: Vec<String> = self.comms_peer_states.keys().cloned().collect();
        for peer_id in peers {
            if peer_id == changed_peer_id {
                continue;
            }
            self.queue_comms_doc_sync_for_peer(&peer_id, true, outbound)?;
        }
        Ok(())
    }

    fn queue_comments_doc_sync_for_peer(
        &mut self,
        peer_id: &str,
        can_write: bool,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peer_state = self
            .comments_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .comments_doc
            .generate_sync_message_recovering(peer_state, "cloud-room-comments-sync-outbound")
            .map_err(|e| JsError::new(&format!("generate comments doc sync: {e}")))?
        {
            outbound.push(RoomHostOutboundFrame {
                peer_id: peer_id.to_string(),
                frame_type: frame_types::COMMENTS_DOC_SYNC,
                payload: message.encode(),
            });
        }
        Ok(())
    }

    fn queue_comments_doc_sync_for_other_peers(
        &mut self,
        changed_peer_id: &str,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), JsError> {
        let peers: Vec<String> = self.comments_peer_states.keys().cloned().collect();
        for peer_id in peers {
            if peer_id == changed_peer_id {
                continue;
            }
            self.queue_comments_doc_sync_for_peer(&peer_id, true, outbound)?;
        }
        Ok(())
    }

    /// Native-testable core of [`Self::reconcile_runtime_peer_gone`]. Returns the
    /// result struct directly (the public method wraps it for the WASM boundary)
    /// so the reconciliation logic can be unit-tested with plain `cargo test`.
    fn reconcile_runtime_peer_gone_inner(
        &mut self,
        reason: &str,
    ) -> Result<RoomHostFrameResult, JsError> {
        let heads_before = self.state_doc.get_heads();

        // 1. Resolve in-flight executions (running → error, queued →
        //    cancelled) and clear the queue, so viewers stop seeing
        //    perpetually-spinning cells and the idempotency guard in
        //    handle_execute_cell no longer suppresses re-runs of the
        //    orphaned work.
        self.state_doc
            .abort_inflight_executions()
            .map_err(|e| JsError::new(&format!("reconcile executions: {e}")))?;
        self.state_doc
            .set_queue(None, &[])
            .map_err(|e| JsError::new(&format!("reconcile queue: {e}")))?;

        // 2. Flip a still-live kernel to Error. Leave an already-terminal kernel
        //    (Error/Shutdown/NotStarted) untouched so a clean shutdown that raced
        //    the disconnect is not relabeled. "Live" = Running or any starting
        //    phase the dead peer last published.
        let lifecycle = self.state_doc.read_state().kernel.lifecycle;
        if lifecycle_is_live(&lifecycle) {
            let details = format!("runtime peer disconnected: {reason}");
            self.state_doc
                .set_lifecycle_with_error_details(&RuntimeLifecycle::Error, None, Some(&details))
                .map_err(|e| JsError::new(&format!("reconcile lifecycle: {e}")))?;
        }

        let current_attachment = self.state_doc.workstation_attachment();
        let attachment_is_idle = current_attachment
            .as_ref()
            .is_some_and(workstation_attachment_is_idle);
        let attachment_is_error = current_attachment
            .as_ref()
            .is_some_and(workstation_attachment_is_error);
        if !attachment_is_idle
            && !attachment_is_error
            && (current_attachment.is_some() || self.state_doc.get_heads() != heads_before)
        {
            let next_attachment =
                runtime_peer_gone_workstation_attachment(current_attachment, reason);
            self.state_doc
                .set_workstation_attachment(Some(&next_attachment))
                .map_err(|e| JsError::new(&format!("reconcile workstation attachment: {e}")))?;
        }

        let changed = self.state_doc.get_heads() != heads_before;
        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            outbound: Vec::new(),
        };
        // Broadcast the reconciled state to every remaining peer. Passing an
        // empty `changed_peer_id` means "exclude no one" — the departed peer is
        // already gone from `runtime_peer_states`, so this reaches exactly the
        // survivors (viewers/editors) that need the corrected doc.
        if changed {
            self.queue_runtime_state_sync_for_other_peers("", &mut result.outbound)?;
        }
        Ok(result)
    }

    fn reconcile_runtime_idle_timeout_inner(
        &mut self,
        reason: &str,
    ) -> Result<RoomHostFrameResult, JsError> {
        let state = self.state_doc.read_state();
        let activity = runtime_execution_activity(&state);
        if activity.executing || activity.queue_depth > 0 {
            return Ok(RoomHostFrameResult::empty());
        }
        drop(state);

        let heads_before = self.state_doc.get_heads();
        self.state_doc
            .set_queue(None, &[])
            .map_err(|e| JsError::new(&format!("reconcile idle queue: {e}")))?;

        let lifecycle = self.state_doc.read_state().kernel.lifecycle;
        if lifecycle_is_live(&lifecycle) {
            self.state_doc
                .set_lifecycle(&RuntimeLifecycle::Shutdown)
                .map_err(|e| JsError::new(&format!("reconcile idle lifecycle: {e}")))?;
        }

        if let Some(attachment) = runtime_idle_timeout_workstation_attachment(
            self.state_doc.workstation_attachment(),
            reason,
        ) {
            self.state_doc
                .set_workstation_attachment(Some(&attachment))
                .map_err(|e| {
                    JsError::new(&format!("reconcile idle workstation attachment: {e}"))
                })?;
        }

        let changed = self.state_doc.get_heads() != heads_before;
        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            outbound: Vec::new(),
        };
        if changed {
            self.queue_runtime_state_sync_for_other_peers("", &mut result.outbound)?;
        }
        Ok(result)
    }

    /// Native-testable core of [`Self::set_workstation_attachment_json`].
    fn set_workstation_attachment_inner(
        &mut self,
        attachment: Option<&WorkstationAttachmentState>,
    ) -> Result<RoomHostFrameResult, JsError> {
        let heads_before = self.state_doc.get_heads();
        let current_attachment = self.state_doc.workstation_attachment();
        if workstation_attachment_publish_is_stale(current_attachment.as_ref(), attachment) {
            return Ok(RoomHostFrameResult {
                changed: false,
                ignored_stale: true,
                notebook_changed: false,
                runtime_state_changed: false,
                outbound: Vec::new(),
            });
        }
        if attachment.is_some_and(runtime_peer_attachment_is_ready) {
            self.clear_stale_runtime_peer_gone_error()?;
        }
        self.state_doc
            .set_workstation_attachment(attachment)
            .map_err(|e| JsError::new(&format!("set workstation attachment: {e}")))?;
        let changed = self.state_doc.get_heads() != heads_before;
        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            outbound: Vec::new(),
        };
        if changed {
            self.queue_runtime_state_sync_for_other_peers("", &mut result.outbound)?;
        }
        Ok(result)
    }

    fn clear_stale_runtime_peer_gone_error(&mut self) -> Result<(), JsError> {
        let state = self.state_doc.read_state();
        let is_stale_runtime_peer_gone_error =
            matches!(state.kernel.lifecycle, RuntimeLifecycle::Error)
                && state
                    .kernel
                    .error_details
                    .as_deref()
                    .is_some_and(|details| details.starts_with("runtime peer disconnected:"));
        if !is_stale_runtime_peer_gone_error {
            return Ok(());
        }
        self.state_doc
            .set_lifecycle_with_error_details(&RuntimeLifecycle::NotStarted, None, None)
            .map_err(|e| JsError::new(&format!("clear runtime peer gone lifecycle: {e}")))?;
        self.state_doc
            .set_runtime_agent_id("")
            .map_err(|e| JsError::new(&format!("clear runtime peer gone agent id: {e}")))
    }
}

fn runtime_peer_gone_workstation_attachment(
    current: Option<WorkstationAttachmentState>,
    reason: &str,
) -> WorkstationAttachmentState {
    let mut attachment = current.unwrap_or_else(|| WorkstationAttachmentState {
        workstation_id: "runtime-peer".to_string(),
        display_name: "Attached workstation".to_string(),
        provider: "runtime_peer".to_string(),
        default_environment_label: "Current Python".to_string(),
        environment_policy: "runtime_peer".to_string(),
        status: "ready".to_string(),
        status_message: None,
        cpu_count: None,
        memory_bytes: None,
        accelerators: None,
        working_directory: None,
        updated_at: None,
        runtime_session_id: None,
    });
    attachment.status = "disconnected".to_string();
    attachment.status_message = Some(format!("compute disconnected: {reason}"));
    attachment
}

fn workstation_attachment_is_idle(attachment: &WorkstationAttachmentState) -> bool {
    attachment.status == "idle"
}

fn workstation_attachment_is_error(attachment: &WorkstationAttachmentState) -> bool {
    attachment.status == "error"
}

#[derive(Debug, Serialize)]
struct RuntimeExecutionActivity {
    executing: bool,
    queue_depth: usize,
}

fn runtime_execution_activity(state: &RuntimeState) -> RuntimeExecutionActivity {
    RuntimeExecutionActivity {
        executing: state.queue.executing.is_some()
            || state
                .executions
                .values()
                .any(|execution| execution.status == "running"),
        queue_depth: state.queue.queued.len(),
    }
}

fn runtime_idle_timeout_workstation_attachment(
    current: Option<WorkstationAttachmentState>,
    reason: &str,
) -> Option<WorkstationAttachmentState> {
    let mut attachment = current?;
    attachment.status = "idle".to_string();
    attachment.status_message = Some(reason.to_string());
    Some(attachment)
}

fn runtime_peer_attachment_is_ready(attachment: &WorkstationAttachmentState) -> bool {
    attachment.provider == "runtime_peer" && attachment.status == "ready"
}

fn workstation_attachment_publish_is_stale(
    current: Option<&WorkstationAttachmentState>,
    incoming: Option<&WorkstationAttachmentState>,
) -> bool {
    let (Some(current), Some(incoming)) = (current, incoming) else {
        return false;
    };
    let (Some(current_session_id), Some(incoming_session_id)) = (
        current.runtime_session_id.as_deref(),
        incoming.runtime_session_id.as_deref(),
    ) else {
        return false;
    };
    if current_session_id == incoming_session_id {
        return false;
    }
    let (Some(current_updated_at), Some(incoming_updated_at)) = (
        current.updated_at.as_deref(),
        incoming.updated_at.as_deref(),
    ) else {
        return false;
    };
    incoming_updated_at < current_updated_at
}

/// Whether a kernel lifecycle still reads as "alive" — i.e. a viewer would see
/// a running or starting kernel. Used by the disconnect watchdog to decide
/// whether to flip to `Error` (only meaningful from a live state; an already
/// terminal `Error`/`Shutdown`/`NotStarted` is left as-is).
fn lifecycle_is_live(lifecycle: &RuntimeLifecycle) -> bool {
    matches!(
        lifecycle,
        RuntimeLifecycle::Running(_)
            | RuntimeLifecycle::AwaitingTrust
            | RuntimeLifecycle::AwaitingEnvBuild
            | RuntimeLifecycle::Resolving
            | RuntimeLifecycle::PreparingEnv
            | RuntimeLifecycle::Launching
            | RuntimeLifecycle::Connecting
    )
}

fn room_peer_sync_state(can_write: bool) -> sync::State {
    if can_write {
        sync::State::new()
    } else {
        // This is the room host's state for a non-writable peer. Automerge
        // read-only mode means "do not apply incoming peer changes" while
        // still allowing this host to send room changes to the peer. The
        // explicit scope checks above remain the authorization boundary.
        sync::State::new_read_only()
    }
}

fn parse_connection_scope(scope: &str) -> Result<ConnectionScope, JsError> {
    scope
        .parse()
        .map_err(|e| JsError::new(&format!("unknown connection scope: {e}")))
}

fn runtime_state_write_scope(scope: ConnectionScope) -> RuntimeStateWriteScope {
    match scope {
        ConnectionScope::Viewer => RuntimeStateWriteScope::Viewer,
        ConnectionScope::Editor => RuntimeStateWriteScope::Editor,
        ConnectionScope::RuntimePeer => RuntimeStateWriteScope::RuntimePeer,
        ConnectionScope::Owner => RuntimeStateWriteScope::Owner,
    }
}

fn allows_runtime_state_doc_write(scope: ConnectionScope) -> bool {
    matches!(scope, ConnectionScope::RuntimePeer)
}

fn allows_execution_request_submit(scope: ConnectionScope) -> bool {
    matches!(scope, ConnectionScope::Owner)
}

fn allows_comms_doc_write(scope: ConnectionScope) -> bool {
    matches!(
        scope,
        ConnectionScope::Editor | ConnectionScope::Owner | ConnectionScope::RuntimePeer
    )
}

fn allows_comments_doc_write(scope: ConnectionScope) -> bool {
    matches!(scope, ConnectionScope::Editor | ConnectionScope::Owner)
}

fn hosted_comments_doc_id(notebook_id: &str) -> String {
    format!("comments:{notebook_id}")
}

fn hosted_comments_identity(notebook_id: &str) -> (String, NotebookCommentRef) {
    (
        hosted_comments_doc_id(notebook_id),
        NotebookCommentRef::HostedRoom {
            room_locator: notebook_id.to_string(),
        },
    )
}

fn validate_room_actor_labels<'a>(
    principal: &str,
    labels: impl IntoIterator<Item = &'a str>,
) -> Result<(), JsError> {
    validate_room_actor_labels_inner(principal, labels).map_err(|error| JsError::new(&error))
}

fn validate_room_actor_labels_inner<'a>(
    principal: &str,
    labels: impl IntoIterator<Item = &'a str>,
) -> Result<(), String> {
    let expected = Principal::new(principal.to_string())
        .map_err(|e| format!("authenticated principal is invalid: {e}"))?;
    for label in labels {
        match ActorLabel::parse(label.to_string()) {
            Ok(actor) if actor.principal() == expected.as_str() => {}
            Ok(actor) => {
                return Err(format!(
                    "actor principal {} is not authorized for authenticated principal {}",
                    actor.principal(),
                    expected
                ));
            }
            Err(error) => {
                return Err(format!("actor label {label:?} is invalid: {error}"));
            }
        }
    }
    Ok(())
}

fn validate_room_notebook_change_actors<'a>(
    principal: &str,
    changes: impl IntoIterator<Item = &'a ChangeActor>,
) -> Result<(), JsError> {
    validate_room_notebook_change_actors_inner(principal, changes)
        .map_err(|error| JsError::new(&error))
}

fn validate_room_notebook_change_actors_inner<'a>(
    principal: &str,
    changes: impl IntoIterator<Item = &'a ChangeActor>,
) -> Result<(), String> {
    let expected = Principal::new(principal.to_string())
        .map_err(|e| format!("authenticated principal is invalid: {e}"))?;
    for change in changes {
        if NotebookDoc::is_canonical_schema_seed_change(&change.actor_label, &change.hash) {
            continue;
        }

        match ActorLabel::parse(change.actor_label.clone()) {
            Ok(actor) if actor.principal() == expected.as_str() => {}
            Ok(actor) => {
                return Err(format!(
                    "actor principal {} is not authorized for authenticated principal {}",
                    actor.principal(),
                    expected
                ));
            }
            Err(error) => {
                return Err(format!(
                    "actor label {:?} is invalid: {error}",
                    change.actor_label
                ));
            }
        }
    }
    Ok(())
}

/// Validate that an editor-scope peer's NotebookDoc changes stay within the
/// collaborative cell-editing surface.
///
/// Editors may add, remove, reorder, and edit cells of any type. Everything else
/// at the document root is owner-authored: notebook metadata (kernelspec, trust,
/// environment, path, project), `schema_version`, `notebook_id`, and the
/// `runtime_state_doc_id` / `comms_doc_id` pairings. So the policy is an
/// allowlist over the diff — every patch must land inside the `cells` map; any
/// other root write is
/// rejected. Cell-level `execution_count`/`execution_id` live under `cells`, so
/// editors may write them — the live execution authority is RuntimeStateDoc,
/// gated separately, so this cannot fabricate live execution state. Owners skip
/// this check entirely via `can_write_all_notebook_changes`. Canonical
/// schema-seed changes are folded into `heads_before` so a fresh room's genesis
/// is not read as a write.
fn validate_editor_notebook_changes<'a>(
    preview: &mut NotebookDoc,
    heads_before: &[automerge::ChangeHash],
    allowed_changes: impl IntoIterator<Item = &'a ChangeActor>,
) -> Result<(), String> {
    let mut effective_heads_before = heads_before.to_vec();
    for change in allowed_changes {
        if NotebookDoc::is_canonical_schema_seed_change(&change.actor_label, &change.hash)
            && !effective_heads_before.contains(&change.hash)
        {
            effective_heads_before.push(change.hash);
        }
    }

    let heads_after = preview.get_heads();
    for patch in preview
        .doc_mut()
        .diff(&effective_heads_before, &heads_after)
    {
        // A cell op modifies an object at or below `cells`, so its patch path
        // begins with `cells`. Anything else — root metadata, schema_version,
        // notebook_id, runtime_state_doc_id, comms_doc_id, or a root-level
        // replace/delete of the cells map itself — is owner-authored and rejected.
        let within_cells =
            matches!(patch.path.first(), Some((_, Prop::Map(key))) if key == "cells");
        if !within_cells {
            return Err(format!(
                "editor scope may only edit cells; change touched notebook root '{}'",
                editor_change_root_label(&patch)
            ));
        }
    }
    Ok(())
}

/// Best-effort name of the document root a rejected editor patch touched, for
/// error messages.
fn editor_change_root_label(patch: &automerge::Patch) -> String {
    match patch.path.first() {
        Some((_, Prop::Map(key))) => key.clone(),
        Some((_, Prop::Seq(_))) => "<root sequence>".to_string(),
        None => match &patch.action {
            PatchAction::PutMap { key, .. } | PatchAction::DeleteMap { key } => key.clone(),
            _ => "<document root>".to_string(),
        },
    }
}

/// A handle to a local Automerge notebook document.
///
/// All mutations (add cell, delete cell, edit source) happen locally
/// and produce sync messages that the Tauri relay forwards to the daemon.
/// Incoming sync messages from the daemon are applied here, and the
/// frontend re-reads cells to update React state.
#[wasm_bindgen]
pub struct NotebookHandle {
    doc: NotebookDoc,
    sync_state: sync::State,
    /// Runtime state doc — server/runtime-authored, synced read-only here.
    state_doc: RuntimeStateDoc,
    state_sync_state: sync::State,
    /// Widget comm state doc — mutable by notebook editors and runtime.
    comms_doc: CommsDoc,
    comms_sync_state: sync::State,
    /// Durable comments doc — mutable by notebook editors and owners.
    comments_doc: Option<CommentsDoc>,
    comments_identity: Option<(String, NotebookCommentRef)>,
    comments_sync_state: sync::State,
    /// Previous per-`output_id` manifest snapshot. Used to produce the
    /// per-output diff emitted on `RuntimeStateSyncApplied.output_changeset`.
    prev_output_by_id: HashMap<String, serde_json::Value>,
    /// Volatile render-identity epoch for output manifests handed to JS.
    output_identity_epoch: u64,
    /// Per-output render revision, bumped when a manifest changes without
    /// changing its stable `output_id`.
    output_revision_by_id: HashMap<String, u64>,
    /// Cross-document execution materialized-view projector.
    execution_view_projector: ExecutionViewProjector,
    /// Pool state doc — daemon-authoritative, global, synced read-only.
    pool_doc: PoolDoc,
    pool_sync_state: sync::State,
    /// Cached metadata fingerprint — invalidated on `receive_frame` when
    /// the doc changes and on all local metadata mutation methods.
    /// Avoids re-serializing the metadata snapshot on every
    /// `get_metadata_fingerprint()` call (~30/sec during streaming).
    metadata_fingerprint_cache: Option<String>,
    /// MIME type priority list for output selection.
    /// Types earlier in the list are preferred when narrowing output data bundles.
    /// If empty, all MIME types are returned (backward compatible).
    mime_priority: Vec<String>,
    /// Blob server port for resolving binary ContentRefs to URLs.
    /// Set via `set_blob_port()`. When None, binary refs pass through as-is.
    blob_port: Option<u16>,
}

/// A cell snapshot returned to JavaScript.
#[wasm_bindgen]
pub struct JsCell {
    /// Index in the sorted cell list (for backward compatibility).
    #[wasm_bindgen(readonly)]
    pub index: usize,
    id: String,
    cell_type: String,
    position: String,
    source: String,
    /// Legacy notebook-doc execution count fallback. RuntimeStateDoc is
    /// authoritative when an execution exists for this cell.
    execution_count: String,
    outputs: Vec<serde_json::Value>,
    metadata: serde_json::Value,
    resolved_assets: HashMap<String, String>,
}

#[wasm_bindgen]
impl JsCell {
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn cell_type(&self) -> String {
        self.cell_type.clone()
    }

    /// Fractional index hex string for ordering (e.g., "80", "7F80").
    #[wasm_bindgen(getter)]
    pub fn position(&self) -> String {
        self.position.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn source(&self) -> String {
        self.source.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn execution_count(&self) -> String {
        self.execution_count.clone()
    }

    /// Get outputs as a JSON array string of structured manifest objects.
    #[wasm_bindgen(getter)]
    pub fn outputs_json(&self) -> String {
        serde_json::to_string(&self.outputs).unwrap_or_else(|_| "[]".to_string())
    }

    /// Get metadata as a JSON object string.
    #[wasm_bindgen(getter)]
    pub fn metadata_json(&self) -> String {
        serde_json::to_string(&self.metadata).unwrap_or_else(|_| "{}".to_string())
    }

    /// Get resolved asset refs as a JSON object string (`ref` → blob hash).
    #[wasm_bindgen(getter)]
    pub fn resolved_assets_json(&self) -> String {
        serde_json::to_string(&self.resolved_assets).unwrap_or_else(|_| "{}".to_string())
    }
}

/// Build a `JsCell` from a `CellSnapshot` and the cell's outputs fetched
/// separately from `RuntimeStateDoc`. Outputs no longer travel on
/// `CellSnapshot` — callers resolve them explicitly via
/// `state_doc.get_outputs(execution_id)`.
fn js_cell_from_parts(index: usize, snap: CellSnapshot, outputs: Vec<serde_json::Value>) -> JsCell {
    JsCell {
        index,
        id: snap.id,
        cell_type: snap.cell_type,
        position: snap.position,
        source: snap.source,
        execution_count: snap.execution_count,
        outputs,
        metadata: snap.metadata,
        resolved_assets: snap.resolved_assets,
    }
}

// ── Comm state ContentRef resolution ─────────────────────────────────

/// Recursively walk a JSON value, resolving ContentRef objects in place.
///
/// - `{"inline": V}` → unwrap to `V`
/// - `{"blob": H, "size": N, "media_type": M?}` → plain URL string. The JSON
///   path is recorded in either `buffer_paths` (binary MIME, caller should
///   fetch as ArrayBuffer and install a DataView at the path — this is the
///   ipywidgets binary-traitlet protocol), `text_paths` (text MIME, caller
///   should fetch the URL and substitute the decoded text back into the state
///   tree before handing it to widget code), or neither — url-preferred keys
///   like anywidget `_esm` / `_css` stay as bare URL strings that consumers
///   read by known key (`import(url)`, `<link rel=stylesheet href=url>`).
///   A missing or unknown `media_type` is treated as binary so the value
///   stays a URL — matches the legacy behavior for comms that don't carry
///   MIME metadata.
/// - Arrays/objects → recurse
/// - Primitives → pass through
fn walk_and_resolve_comm_state(
    val: &serde_json::Value,
    port: u16,
    current_path: &mut Vec<String>,
    buffer_paths: &mut Vec<Vec<String>>,
    text_paths: &mut Vec<Vec<String>>,
) -> serde_json::Value {
    match val {
        serde_json::Value::Object(obj) => {
            // Check for inline ContentRef: {"inline": ...}
            if obj.len() == 1 {
                if let Some(inner) = obj.get("inline") {
                    return inner.clone();
                }
            }

            // Check for blob ContentRef: {"blob": string, "size": number, "media_type"?: string}
            let exact_blob_hash = match (obj.get("blob"), obj.get("size")) {
                (Some(serde_json::Value::String(hash)), Some(serde_json::Value::Number(_)))
                    if obj
                        .keys()
                        .all(|key| key == "blob" || key == "size" || key == "media_type") =>
                {
                    Some(hash)
                }
                _ => None,
            };

            if let Some(hash) = exact_blob_hash {
                // Anywidget reserves `_esm` and `_css` for URL-preferring
                // loaders: `_esm` flows through `import(url)` and `_css`
                // through `<link rel=stylesheet href=url>`, both of which
                // handle URLs natively. Pulling those blobs over HTTP in
                // the sync engine just to re-serve the decoded string is
                // wasted work and defeats browser caching, and if we listed
                // them in `buffer_paths` the iframe resolver would rewrite
                // the URL string to a DataView and break the loaders. Emit
                // neither path entry — consumers read these by known key.
                let last_key = current_path.last().map(String::as_str);
                let url_preferred = matches!(last_key, Some("_esm") | Some("_css"));

                if !url_preferred {
                    let media_type = obj.get("media_type").and_then(|v| v.as_str());
                    // Only classify as text when we have a media_type that
                    // says so. Missing media_type → binary (URL stays, iframe
                    // installs a DataView for widget protocol).
                    let is_text = media_type.map(|mt| !is_binary_mime(mt)).unwrap_or(false);
                    if is_text {
                        text_paths.push(current_path.clone());
                    } else {
                        buffer_paths.push(current_path.clone());
                    }
                }
                return serde_json::Value::String(format!(
                    "http://127.0.0.1:{}/blob/{}",
                    port, hash
                ));
            }

            // Regular object — recurse into values
            let mut resolved = serde_json::Map::with_capacity(obj.len());
            for (key, child) in obj {
                current_path.push(key.clone());
                resolved.insert(
                    key.clone(),
                    walk_and_resolve_comm_state(
                        child,
                        port,
                        current_path,
                        buffer_paths,
                        text_paths,
                    ),
                );
                current_path.pop();
            }
            serde_json::Value::Object(resolved)
        }
        serde_json::Value::Array(arr) => {
            let resolved: Vec<serde_json::Value> = arr
                .iter()
                .enumerate()
                .map(|(i, child)| {
                    current_path.push(i.to_string());
                    let r = walk_and_resolve_comm_state(
                        child,
                        port,
                        current_path,
                        buffer_paths,
                        text_paths,
                    );
                    current_path.pop();
                    r
                })
                .collect();
            serde_json::Value::Array(resolved)
        }
        // Primitives pass through unchanged
        _ => val.clone(),
    }
}

fn path_starts_with_outputs(path: &[String]) -> bool {
    path.first().map(String::as_str) == Some("outputs")
}

fn resolve_comm_state_for_frontend(
    state: &serde_json::Value,
    port: u16,
    is_output_model: bool,
) -> (serde_json::Value, Vec<Vec<String>>, Vec<Vec<String>>) {
    let mut buffer_paths: Vec<Vec<String>> = Vec::new();
    let mut text_paths: Vec<Vec<String>> = Vec::new();
    let mut resolved = walk_and_resolve_comm_state(
        state,
        port,
        &mut Vec::new(),
        &mut buffer_paths,
        &mut text_paths,
    );

    if is_output_model {
        // OutputModel.outputs contains notebook output manifests. Those
        // ContentRefs are resolved by the output-manifest resolver, not by the
        // ipywidgets binary-traitlet path that fetches URLs into DataViews.
        if let serde_json::Value::Object(obj) = &mut resolved {
            obj.remove("outputs");
        }
        buffer_paths.retain(|path| !path_starts_with_outputs(path));
        text_paths.retain(|path| !path_starts_with_outputs(path));
    }

    (resolved, buffer_paths, text_paths)
}

#[wasm_bindgen]
impl NotebookHandle {
    /// Create a new empty notebook document.
    #[wasm_bindgen(constructor)]
    pub fn new(notebook_id: &str) -> Result<NotebookHandle, JsError> {
        Ok(NotebookHandle {
            doc: NotebookDoc::new_with_encoding(
                notebook_id,
                notebook_doc::TextEncoding::Utf16CodeUnit,
            ),
            sync_state: sync::State::new(),
            state_doc: RuntimeStateDoc::try_new_empty()
                .map_err(|e| JsError::new(&format!("create runtime state doc failed: {}", e)))?,
            state_sync_state: sync::State::new(),
            comms_doc: CommsDoc::try_new_empty()
                .map_err(|e| JsError::new(&format!("create comms doc failed: {}", e)))?,
            comms_sync_state: sync::State::new(),
            comments_doc: None,
            comments_identity: None,
            comments_sync_state: sync::State::new(),
            prev_output_by_id: HashMap::new(),
            output_identity_epoch: 0,
            output_revision_by_id: HashMap::new(),
            execution_view_projector: ExecutionViewProjector::default(),
            pool_doc: PoolDoc::new_empty(),
            pool_sync_state: sync::State::new(),
            metadata_fingerprint_cache: None,
            mime_priority: Vec::new(),
            blob_port: None,
        })
    }

    /// Create a bootstrap handle for sync — no notebook ID, just skeleton + encoding + actor.
    ///
    /// This is the preferred constructor for sync-only clients. The daemon
    /// populates the full document via Automerge sync.
    pub fn create_bootstrap(actor_label: &str) -> Result<NotebookHandle, JsError> {
        let mut state_doc = RuntimeStateDoc::try_new_empty()
            .map_err(|e| JsError::new(&format!("create runtime state doc failed: {}", e)))?;
        state_doc.set_actor(actor_label);
        let mut comms_doc = CommsDoc::try_new_empty()
            .map_err(|e| JsError::new(&format!("create comms doc failed: {}", e)))?;
        comms_doc
            .doc_mut()
            .set_actor(automerge::ActorId::from(actor_label.as_bytes()));
        Ok(NotebookHandle {
            doc: NotebookDoc::bootstrap(notebook_doc::TextEncoding::Utf16CodeUnit, actor_label),
            sync_state: sync::State::new(),
            state_doc,
            state_sync_state: sync::State::new(),
            comms_doc,
            comms_sync_state: sync::State::new(),
            comments_doc: None,
            comments_identity: None,
            comments_sync_state: sync::State::new(),
            prev_output_by_id: HashMap::new(),
            output_identity_epoch: 0,
            output_revision_by_id: HashMap::new(),
            execution_view_projector: ExecutionViewProjector::default(),
            pool_doc: PoolDoc::new_empty(),
            pool_sync_state: sync::State::new(),
            metadata_fingerprint_cache: None,
            mime_priority: Vec::new(),
            blob_port: None,
        })
    }

    /// Create a bootstrap handle with daemon-provided CommentsDoc identity.
    pub fn create_bootstrap_with_comments(
        actor_label: &str,
        comments_doc_id: &str,
    ) -> Result<NotebookHandle, JsError> {
        let mut handle = Self::create_bootstrap(actor_label)?;
        handle.init_comments_sync_target(comments_doc_id)?;
        Ok(handle)
    }

    /// Create a bootstrap handle with daemon-provided CommentsDoc identity and notebook ref.
    pub fn create_bootstrap_with_comments_ref(
        actor_label: &str,
        comments_doc_id: &str,
        notebook_ref_json: &str,
    ) -> Result<NotebookHandle, JsError> {
        let mut handle = Self::create_bootstrap(actor_label)?;
        handle.init_comments_sync_target_ref(comments_doc_id, notebook_ref_json)?;
        Ok(handle)
    }

    /// Create a handle with the bootstrap skeleton for sync.
    ///
    /// Deprecated — use [`create_bootstrap()`](Self::create_bootstrap) which
    /// requires an actor label.
    pub fn create_empty() -> Result<NotebookHandle, JsError> {
        Self::create_bootstrap("anonymous")
    }

    /// Create a bootstrap handle with a specific actor identity.
    ///
    /// Deprecated — use [`create_bootstrap()`](Self::create_bootstrap).
    pub fn create_empty_with_actor(actor_label: &str) -> Result<NotebookHandle, JsError> {
        Self::create_bootstrap(actor_label)
    }

    /// Load a notebook document from saved bytes (e.g., from get_automerge_doc_bytes).
    pub fn load(bytes: &[u8]) -> Result<NotebookHandle, JsError> {
        let doc = NotebookDoc::load_with_encoding(bytes, notebook_doc::TextEncoding::Utf16CodeUnit)
            .map_err(|e| JsError::new(&format!("load failed: {}", e)))?;
        Ok(NotebookHandle {
            doc,
            sync_state: sync::State::new(),
            state_doc: RuntimeStateDoc::try_new_empty()
                .map_err(|e| JsError::new(&format!("create runtime state doc failed: {}", e)))?,
            state_sync_state: sync::State::new(),
            comms_doc: CommsDoc::try_new_empty()
                .map_err(|e| JsError::new(&format!("create comms doc failed: {}", e)))?,
            comms_sync_state: sync::State::new(),
            comments_doc: None,
            comments_identity: None,
            comments_sync_state: sync::State::new(),
            prev_output_by_id: HashMap::new(),
            output_identity_epoch: 0,
            output_revision_by_id: HashMap::new(),
            execution_view_projector: ExecutionViewProjector::default(),
            pool_doc: PoolDoc::new_empty(),
            pool_sync_state: sync::State::new(),
            metadata_fingerprint_cache: None,
            mime_priority: Vec::new(),
            blob_port: None,
        })
    }

    /// Load a persisted NotebookDoc + RuntimeStateDoc snapshot pair.
    ///
    /// Hosted viewers and room hosts should use this when materializing a
    /// published notebook revision: NotebookDoc owns cells and execution_id
    /// pointers, while RuntimeStateDoc owns execution/output manifests.
    pub fn load_snapshot(
        notebook_bytes: &[u8],
        runtime_state_bytes: &[u8],
    ) -> Result<NotebookHandle, JsError> {
        let mut handle = Self::load(notebook_bytes)?;
        handle.load_state_doc(runtime_state_bytes)?;
        Ok(handle)
    }

    /// Load a RuntimeStateDoc from saved bytes.
    ///
    /// Used by test fixtures to provide pre-populated state doc data
    /// (outputs, executions) alongside the notebook doc. Replacing the state
    /// doc also resets RuntimeStateDoc sync state so later room-host sync starts
    /// from the loaded snapshot, not the previous empty/bootstrap doc.
    ///
    /// Preserves the current actor so a load never silently discards an
    /// authenticated actor set via `set_actor` (room hosts reject
    /// non-`<principal>/<operator>` actors).
    pub fn load_state_doc(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let actor = self.state_doc.doc().get_actor().clone();
        let mut doc = automerge::AutoCommit::load(bytes)
            .map_err(|e| JsError::new(&format!("load_state_doc failed: {}", e)))?;
        doc.set_actor(actor);
        self.state_doc = RuntimeStateDoc::from_doc(doc);
        self.state_sync_state = sync::State::new();
        self.prev_output_by_id.clear();
        self.bump_output_identity_epoch();
        self.execution_view_projector.reset();
        Ok(())
    }

    /// Load a CommsDoc from saved bytes.
    ///
    /// Preserves the current actor so a load never silently discards an
    /// authenticated actor set via `set_actor` (room hosts reject
    /// non-`<principal>/<operator>` actors).
    pub fn load_comms_doc(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let actor = self.comms_doc.doc().get_actor().clone();
        let mut doc = automerge::AutoCommit::load(bytes)
            .map_err(|e| JsError::new(&format!("load_comms_doc failed: {}", e)))?;
        doc.set_actor(actor);
        self.comms_doc = CommsDoc::from_doc(doc);
        self.comms_sync_state = sync::State::new();
        Ok(())
    }

    /// RuntimeStateDoc identity recorded by the NotebookDoc pointer.
    pub fn get_runtime_state_doc_id(&self) -> Option<String> {
        self.doc.runtime_state_doc_id()
    }

    /// CommsDoc identity recorded by the NotebookDoc pointer.
    pub fn get_comms_doc_id(&self) -> Option<String> {
        self.doc.comms_doc_id()
    }

    /// Set the RuntimeStateDoc identity on both documents in this snapshot pair.
    ///
    /// This is intentionally narrower than changing notebook identity: fixture
    /// publishers can clone a canned NotebookDoc + RuntimeStateDoc pair into a
    /// route-specific runtime document namespace without creating a legacy
    /// route-derived fallback.
    pub fn set_runtime_state_doc_id(&mut self, runtime_state_doc_id: &str) -> Result<(), JsError> {
        self.doc
            .set_runtime_state_doc_id(runtime_state_doc_id)
            .map_err(|e| JsError::new(&format!("set notebook runtime_state_doc_id failed: {e}")))?;
        self.state_doc
            .set_runtime_state_doc_id(Some(runtime_state_doc_id))
            .map_err(|e| JsError::new(&format!("set runtime state doc id failed: {e}")))?;
        Ok(())
    }

    /// Set the CommsDoc identity on the NotebookDoc pointer.
    pub fn set_comms_doc_id(&mut self, comms_doc_id: &str) -> Result<(), JsError> {
        self.doc
            .set_comms_doc_id(comms_doc_id)
            .map_err(|e| JsError::new(&format!("set notebook comms_doc_id failed: {e}")))?;
        Ok(())
    }

    /// Get the actor identity label for this document.
    pub fn get_actor_id(&self) -> String {
        self.doc.get_actor_id()
    }

    /// Set the actor identity for this document.
    ///
    /// Tags all subsequent edits with this label for provenance tracking.
    pub fn set_actor(&mut self, actor_label: &str) {
        self.doc.set_actor(actor_label);
        self.state_doc.set_actor(actor_label);
        self.comms_doc
            .doc_mut()
            .set_actor(automerge::ActorId::from(actor_label.as_bytes()));
        if let Some(comments_doc) = self.comments_doc.as_mut() {
            comments_doc
                .doc_mut()
                .set_actor(automerge::ActorId::from(actor_label.as_bytes()));
        }
    }

    /// Return the deduplicated, sorted list of actor labels that have
    /// contributed changes to this document's history.
    ///
    /// Useful for debugging provenance — call after sync to see which
    /// peers (e.g., `"local:kyle/desktop:window"`,
    /// `"user:anaconda:alice/agent:codex:s1"`) have touched the notebook.
    pub fn contributing_actors(&mut self) -> Vec<String> {
        self.doc.contributing_actors()
    }

    /// Get the number of cells in the document.
    pub fn cell_count(&self) -> usize {
        self.doc.cell_count()
    }

    /// Return true once the cells map is present.
    pub fn has_cells_map(&self) -> bool {
        self.doc.has_cells_map()
    }

    /// Get all cells as an array of JsCell objects.
    ///
    /// Outputs are fetched from `RuntimeStateDoc` keyed by each cell's
    /// `execution_id`. Cells without an execution_id or with empty outputs
    /// return an empty outputs vec.
    pub fn get_cells(&self) -> Vec<JsCell> {
        self.doc
            .get_cells()
            .into_iter()
            .enumerate()
            .map(|(index, snap)| {
                let outputs = self.fetch_and_narrow_outputs(&snap.id);
                js_cell_from_parts(index, snap, outputs)
            })
            .collect()
    }

    /// Get all cells as a JSON string (for bulk materialization).
    ///
    /// Serializes the same shape as `get_cells()` but as a single JSON
    /// string — cheaper to cross the WASM boundary than many individual
    /// property getters. Outputs are fetched from `RuntimeStateDoc` keyed
    /// by each cell's `execution_id`; `CellSnapshot` itself no longer
    /// carries outputs.
    pub fn get_cells_json(&self) -> String {
        #[derive(serde::Serialize)]
        struct CellWithOutputs<'a> {
            #[serde(flatten)]
            snapshot: &'a CellSnapshot,
            execution_id: Option<String>,
            outputs: Vec<serde_json::Value>,
        }

        let cells = self.doc.get_cells();
        let combined: Vec<CellWithOutputs<'_>> = cells
            .iter()
            .map(|snap| {
                let execution_id = self.doc.get_execution_id(&snap.id);
                let outputs = self.fetch_and_narrow_outputs(&snap.id);
                CellWithOutputs {
                    snapshot: snap,
                    execution_id,
                    outputs,
                }
            })
            .collect();
        serde_json::to_string(&combined).unwrap_or_else(|_| "[]".to_string())
    }

    // ── Per-cell granular accessors ─────────────────────────────────
    //
    // These avoid full get_cells_json() serialization by crossing the
    // WASM boundary only for the requested data.

    /// Get ordered cell IDs (sorted by position, tiebreak on ID).
    pub fn get_cell_ids(&self) -> Vec<String> {
        self.doc.get_cell_ids()
    }

    /// Get a cell's source text.
    pub fn get_cell_source(&self, cell_id: &str) -> Option<String> {
        self.doc.get_cell_source(cell_id)
    }

    /// Get a cell's type — "code", "markdown", or "raw".
    pub fn get_cell_type(&self, cell_id: &str) -> Option<String> {
        self.doc.get_cell_type(cell_id)
    }

    /// Get a cell's outputs as a native JS array of manifest objects.
    ///
    /// Each element is a structured output manifest (with MIME bundles and
    /// ContentRef blob/inline refs). Returns undefined if the cell doesn't exist.
    ///
    /// Outputs live in the RuntimeStateDoc keyed by execution_id. This method
    /// reads the cell's `execution_id` from the notebook doc, then looks up
    /// outputs in the state doc — the dedicated outputs lookup that replaces
    /// the old "read the snapshot and inspect `snapshot.outputs`" path.
    pub fn get_cell_outputs(&self, cell_id: &str) -> JsValue {
        let outputs = self.fetch_and_narrow_outputs(cell_id);
        if outputs.is_empty() {
            JsValue::UNDEFINED
        } else {
            serialize_to_js(&outputs).unwrap_or(JsValue::UNDEFINED)
        }
    }

    // ── Per-execution and per-output accessors ──────────────────────
    //
    // These let the frontend subscribe to state at the `execution_id` and
    // `output_id` granularity instead of the cell granularity. That matters
    // during output streaming: a single append should not force every
    // component tree under the cell to re-render — only the affected
    // <Output> component and any <CellLabel> that reads the execution_count
    // off the execution should update.

    /// Return the `execution_id` currently stamped on a cell, if any.
    ///
    /// Cells with no active execution (never queued, or outputs cleared)
    /// return `None`.
    pub fn get_cell_execution_id(&self, cell_id: &str) -> Option<String> {
        self.doc.get_execution_id(cell_id)
    }

    /// Return a summary of the execution for the given `execution_id`, or
    /// `undefined` when that execution is unknown.
    ///
    /// Shape: `{ execution_count, status, success, output_ids }`.
    /// `output_ids` preserves the daemon's emission order. Full output
    /// manifests are available via `get_output_by_id(output_id)` — this
    /// method intentionally keeps the payload small so execution-level
    /// subscriptions stay cheap.
    pub fn get_execution_by_id(&self, execution_id: &str) -> JsValue {
        let Some(exec) = self.state_doc.get_execution(execution_id) else {
            return JsValue::UNDEFINED;
        };
        let output_ids = output_ids_for_execution(&exec);
        let ExecutionState {
            status,
            execution_count,
            success,
            submitted_by_actor_label,
            ..
        } = exec;
        let summary = serde_json::json!({
            "execution_count": execution_count,
            "status": status,
            "success": success,
            "output_ids": output_ids,
            "submitted_by_actor_label": submitted_by_actor_label,
        });
        serialize_to_js(&summary).unwrap_or(JsValue::UNDEFINED)
    }

    /// Return the ordered list of `output_id`s for an execution, or an empty
    /// list when the execution is unknown.
    pub fn get_output_ids_for_execution(&self, execution_id: &str) -> Vec<String> {
        match self.state_doc.get_execution(execution_id) {
            Some(exec) => output_ids_for_execution(&exec),
            None => Vec::new(),
        }
    }

    fn get_output_by_id_value(&self, output_id: &str) -> Option<serde_json::Value> {
        let state = self.state_doc.read_state();
        for exec in state.executions.values() {
            for output in &exec.outputs {
                if let Some(id) = output.get("output_id").and_then(|v| v.as_str()) {
                    if id == output_id {
                        let narrowed = self.narrow_output_data(output.clone());
                        return Some(self.stamp_output_cache_key(narrowed));
                    }
                }
            }
        }
        None
    }

    /// Return a single output manifest by `output_id`, narrowed to the
    /// active MIME priority set. Returns `undefined` when no output carries
    /// that id.
    ///
    /// Walks all executions in the runtime state doc. The runtime state
    /// maintains O(executions) entries, each with at most a few dozen
    /// outputs, so this is fine for reactive reads. If it ever becomes a
    /// hot path we can cache an `output_id -> (execution_id, index)` map
    /// here — the doc is already the source of truth.
    pub fn get_output_by_id(&self, output_id: &str) -> JsValue {
        self.get_output_by_id_value(output_id)
            .and_then(|value| serialize_to_js(&value).ok())
            .unwrap_or(JsValue::UNDEFINED)
    }

    /// Set the MIME type priority list for output selection.
    /// Types earlier in the list are preferred when narrowing output data bundles.
    /// If empty, all MIME types are returned (backward compatible).
    pub fn set_mime_priority(&mut self, priority: JsValue) {
        if let Ok(p) = serde_wasm_bindgen::from_value::<Vec<String>>(priority) {
            // Narrowing inputs shape the manifest JS caches by identity key,
            // so a different priority list must invalidate stamped keys.
            if self.mime_priority != p {
                self.bump_output_identity_epoch();
            }
            self.mime_priority = p;
        }
    }

    /// Set the blob server port for resolving binary ContentRefs to URLs.
    /// Call after init and whenever the daemon restarts with a new port.
    pub fn set_blob_port(&mut self, port: u16) {
        // Binary ContentRefs resolve to port-qualified URLs; a port change
        // must invalidate identity-keyed caches of the narrowed manifests.
        if self.blob_port != Some(port) {
            self.bump_output_identity_epoch();
        }
        self.blob_port = Some(port);
    }

    /// Fetch a cell's outputs from `RuntimeStateDoc` via its `execution_id`
    /// and narrow the data bundles to the active MIME priority set.
    ///
    /// Returns an empty vec when the cell has no `execution_id` or the
    /// state doc has no outputs for that id. This is the canonical path
    /// for all output reads on the WASM side — `CellSnapshot` no longer
    /// carries outputs.
    fn fetch_and_narrow_outputs(&self, cell_id: &str) -> Vec<serde_json::Value> {
        let Some(eid) = self.doc.get_execution_id(cell_id) else {
            return Vec::new();
        };
        self.state_doc
            .get_outputs(&eid)
            .into_iter()
            .map(|o| self.stamp_output_cache_key(self.narrow_output_data(o)))
            .collect()
    }

    fn stamp_output_cache_key(&self, mut output: serde_json::Value) -> serde_json::Value {
        let output_id = output
            .get("output_id")
            .and_then(|v| v.as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        let Some(output_id) = output_id else {
            return output;
        };

        let Some(obj) = output.as_object_mut() else {
            return output;
        };

        let revision = self
            .output_revision_by_id
            .get(&output_id)
            .copied()
            .unwrap_or(0);
        obj.insert(
            RUNT_OUTPUT_CACHE_KEY.to_string(),
            serde_json::Value::String(format!(
                "output:{}:{}:{}",
                output_id, self.output_identity_epoch, revision
            )),
        );
        output
    }

    fn bump_output_identity_epoch(&mut self) {
        self.output_identity_epoch += 1;
        self.prev_output_by_id.clear();
        self.output_revision_by_id.clear();
    }

    fn build_output_changeset(&mut self, current_state: &RuntimeState) -> OutputChangeset {
        let id_diff =
            diff_output_ids_in_place(&mut self.prev_output_by_id, &current_state.executions);

        for (id, _) in &id_diff.changed {
            *self.output_revision_by_id.entry(id.clone()).or_insert(0) += 1;
        }
        for id in &id_diff.removed_output_ids {
            self.output_revision_by_id.remove(id);
        }

        // Narrow and stamp each changed manifest inline so the frontend writes
        // directly into the outputs store with no second snapshot walk.
        let changed: Vec<(String, serde_json::Value)> = id_diff
            .changed
            .into_iter()
            .map(|(id, manifest)| {
                (
                    id,
                    self.stamp_output_cache_key(self.narrow_output_data(manifest)),
                )
            })
            .collect();
        OutputChangeset {
            changed,
            removed: id_diff.removed_output_ids,
        }
    }

    /// Narrow an output manifest's data bundle to the winning MIME type,
    /// plus all binary MIME refs and text/plain as a fallback candidate.
    /// Multi-MIME renderer plugins may keep a small set of sibling refs that
    /// are required to render the selected MIME.
    ///
    /// Resolves ContentRefs into `ResolvedContentRef` variants:
    /// - Binary MIME types → `Url` (blob server URL, zero fetch cost)
    /// - Inline refs → `Inline` (embedded text)
    /// - Text blob refs → `Blob` (needs JS-side HTTP fetch)
    ///
    /// Only expensive text blob refs for non-winning types are dropped.
    /// Returns the manifest unchanged if mime_priority is empty or output_type
    /// is not display_data/execute_result.
    fn narrow_output_data(&self, mut output: serde_json::Value) -> serde_json::Value {
        if self.mime_priority.is_empty() {
            return output;
        }
        let output_type = output.get("output_type").and_then(|v| v.as_str());
        if !matches!(output_type, Some("display_data" | "execute_result")) {
            return output;
        }
        if let Some(data) = output.get("data").and_then(|d| d.as_object()) {
            let keys: Vec<&str> = data.keys().map(|k| k.as_str()).collect();
            // Find the winning MIME type from priority list
            let winner = self
                .mime_priority
                .iter()
                .find(|p| keys.contains(&p.as_str()))
                .map(|s| s.as_str())
                // Fallback: first available key
                .or_else(|| keys.first().copied());

            if let Some(winner_mime) = winner {
                let mut narrowed = serde_json::Map::new();
                let bokeh_bundle = data.contains_key(BOKEHJS_EXEC_MIME)
                    || data.contains_key(BOKEHJS_LOAD_MIME)
                    || winner_mime == BOKEHJS_EXEC_MIME
                    || winner_mime == BOKEHJS_LOAD_MIME;
                let panel_bundle = data.contains_key(PANEL_EXEC_MIME)
                    || data.contains_key(PANEL_LOAD_MIME)
                    || winner_mime == PANEL_EXEC_MIME
                    || winner_mime == PANEL_LOAD_MIME;

                for (mime, val) in data {
                    if mime == winner_mime
                        || mime == "text/plain"
                        || is_binary_mime(mime)
                        || (winner_mime == MARKDOWN_PROJECTION_MIME && mime == MARKDOWN_SOURCE_MIME)
                        || (bokeh_bundle
                            && matches!(
                                mime.as_str(),
                                BOKEHJS_EXEC_MIME
                                    | BOKEHJS_LOAD_MIME
                                    | BOKEHJS_SCRIPT_MIME
                                    | BOKEHJS_HTML_MIME
                            ))
                        || (panel_bundle
                            && matches!(
                                mime.as_str(),
                                PANEL_EXEC_MIME
                                    | PANEL_LOAD_MIME
                                    | BOKEHJS_SCRIPT_MIME
                                    | BOKEHJS_HTML_MIME
                            ))
                    {
                        let resolved = self.resolve_content_ref(mime, val);
                        narrowed.insert(mime.clone(), resolved);
                    }
                }
                output["data"] = serde_json::Value::Object(narrowed);
            }
        }
        output
    }

    /// Resolve a ContentRef value into a ResolvedContentRef based on MIME type.
    ///
    /// - `{ "inline": "..." }` → `ResolvedContentRef::Inline`
    /// - Binary MIME + `{ "blob": "hash", "size": N }` → `ResolvedContentRef::Url`
    ///   (when blob_port is set)
    /// - Text MIME + `{ "blob": "hash", "size": N }` → `ResolvedContentRef::Blob`
    fn resolve_content_ref(&self, mime: &str, val: &serde_json::Value) -> serde_json::Value {
        // Inline refs pass through as Inline variant
        if let Some(inline) = val.get("inline").and_then(|v| v.as_str()) {
            return serde_json::to_value(ResolvedContentRef::Inline {
                inline: inline.to_string(),
            })
            .unwrap_or_else(|_| val.clone());
        }

        // Blob refs: resolve binary to URL, leave text as Blob
        if let Some(blob_hash) = val.get("blob").and_then(|v| v.as_str()) {
            let size = val.get("size").and_then(|v| v.as_u64()).unwrap_or(0);

            if is_binary_mime(mime) {
                if let Some(port) = self.blob_port {
                    return serde_json::to_value(ResolvedContentRef::Url {
                        url: format!("http://127.0.0.1:{}/blob/{}", port, blob_hash),
                    })
                    .unwrap_or_else(|_| val.clone());
                }
            }

            return serde_json::to_value(ResolvedContentRef::Blob {
                blob: blob_hash.to_string(),
                size,
            })
            .unwrap_or_else(|_| val.clone());
        }

        // Unknown shape — pass through unchanged
        val.clone()
    }

    /// Get a cell's execution count.
    ///
    /// RuntimeStateDoc is authoritative while an execution is known. The
    /// NotebookDoc cell field is a durable nbformat-history fallback for
    /// reload/export paths where runtime state is unavailable.
    pub fn get_cell_execution_count(&self, cell_id: &str) -> Option<String> {
        if let Some(eid) = self.doc.get_execution_id(cell_id) {
            if let Some(exec) = self.state_doc.get_execution(&eid) {
                if let Some(count) = exec.execution_count {
                    return Some(count.to_string());
                }
            }
        }
        self.doc.get_cell_execution_count(cell_id)
    }

    /// Get a cell's metadata as a native JS object.
    ///
    /// Returns undefined if the cell doesn't exist.
    pub fn get_cell_metadata(&self, cell_id: &str) -> JsValue {
        match self.doc.get_cell_metadata(cell_id) {
            Some(metadata) => serialize_to_js(&metadata).unwrap_or(JsValue::UNDEFINED),
            None => JsValue::UNDEFINED,
        }
    }

    /// Get a cell's fractional index position string.
    pub fn get_cell_position(&self, cell_id: &str) -> Option<String> {
        self.doc.get_cell_position(cell_id)
    }

    /// Get a single cell by ID, or null if not found.
    pub fn get_cell(&self, cell_id: &str) -> Option<JsCell> {
        let cells = self.doc.get_cells();
        cells
            .into_iter()
            .enumerate()
            .find(|(_, c)| c.id == cell_id)
            .map(|(index, snap)| {
                let outputs = self.fetch_and_narrow_outputs(&snap.id);
                js_cell_from_parts(index, snap, outputs)
            })
    }

    fn run_local_mutation<T, E, F>(
        &mut self,
        operation: &str,
        mutator: F,
    ) -> Result<LocalMutationResult<T>, JsError>
    where
        T: Serialize,
        E: std::fmt::Display,
        F: FnOnce(&mut NotebookDoc) -> Result<T, E>,
    {
        let heads_before = self.doc.doc_mut().get_heads();
        let result = mutator(&mut self.doc)
            .map_err(|e| JsError::new(&format!("{operation} failed: {e}")))?;
        let heads_after = self.doc.doc_mut().get_heads();

        let event = if heads_before != heads_after {
            let doc_changeset = diff_doc(self.doc.doc_mut(), &heads_before, &heads_after);
            if doc_changeset.metadata_changed {
                self.metadata_fingerprint_cache = None;
            }
            let state = self.state_doc.read_state();
            let execution_view_changeset = self
                .execution_view_projector
                .project_all(notebook_execution_pointers(&self.doc), &state);

            Some(FrameEvent::SyncApplied {
                changed: true,
                changeset: Some(doc_changeset.cells),
                attributions: Vec::new(),
                reply: None,
                execution_view_changeset,
            })
        } else {
            None
        };

        Ok(LocalMutationResult { result, event })
    }

    fn add_cell_after_with_changeset_inner(
        &mut self,
        cell_id: &str,
        cell_type: &str,
        after_cell_id: Option<String>,
    ) -> Result<LocalMutationResult<String>, JsError> {
        self.run_local_mutation("add_cell_after", |doc| {
            doc.add_cell_after(cell_id, cell_type, after_cell_id.as_deref())
        })
    }

    fn move_cell_with_changeset_inner(
        &mut self,
        cell_id: &str,
        after_cell_id: Option<String>,
    ) -> Result<LocalMutationResult<String>, JsError> {
        self.run_local_mutation("move_cell", |doc| {
            doc.move_cell(cell_id, after_cell_id.as_deref())
        })
    }

    fn delete_cell_with_changeset_inner(
        &mut self,
        cell_id: &str,
    ) -> Result<LocalMutationResult<bool>, JsError> {
        self.run_local_mutation("delete_cell", |doc| doc.delete_cell(cell_id))
    }

    fn clear_outputs_with_changeset_inner(
        &mut self,
        cell_id: &str,
    ) -> Result<LocalMutationResult<bool>, JsError> {
        self.run_local_mutation("clear_outputs", |doc| doc.clear_outputs(cell_id))
    }

    fn set_cell_source_hidden_with_changeset_inner(
        &mut self,
        cell_id: &str,
        hidden: bool,
    ) -> Result<LocalMutationResult<bool>, JsError> {
        self.run_local_mutation("set_cell_source_hidden", |doc| {
            doc.set_cell_source_hidden(cell_id, hidden)
        })
    }

    fn set_cell_type_with_changeset_inner(
        &mut self,
        cell_id: &str,
        cell_type: &str,
    ) -> Result<LocalMutationResult<bool>, JsError> {
        self.run_local_mutation("set_cell_type", |doc| doc.set_cell_type(cell_id, cell_type))
    }

    fn set_cell_outputs_hidden_with_changeset_inner(
        &mut self,
        cell_id: &str,
        hidden: bool,
    ) -> Result<LocalMutationResult<bool>, JsError> {
        self.run_local_mutation("set_cell_outputs_hidden", |doc| {
            doc.set_cell_outputs_hidden(cell_id, hidden)
        })
    }

    /// Add a new cell at the given index (backward-compatible API).
    ///
    /// Internally converts the index to an after_cell_id for fractional indexing.
    pub fn add_cell(
        &mut self,
        index: usize,
        cell_id: &str,
        cell_type: &str,
    ) -> Result<(), JsError> {
        self.doc
            .add_cell(index, cell_id, cell_type)
            .map_err(|e| JsError::new(&format!("add_cell failed: {}", e)))
    }

    /// Add a new cell after the specified cell (semantic API).
    ///
    /// - `after_cell_id = null` → insert at the beginning
    /// - `after_cell_id = "id"` → insert after that cell
    ///
    /// Returns the position string of the new cell.
    pub fn add_cell_after(
        &mut self,
        cell_id: &str,
        cell_type: &str,
        after_cell_id: Option<String>,
    ) -> Result<String, JsError> {
        self.doc
            .add_cell_after(cell_id, cell_type, after_cell_id.as_deref())
            .map_err(|e| JsError::new(&format!("add_cell_after failed: {}", e)))
    }

    pub fn add_cell_after_with_changeset(
        &mut self,
        cell_id: &str,
        cell_type: &str,
        after_cell_id: Option<String>,
    ) -> Result<JsValue, JsError> {
        let result = self.add_cell_after_with_changeset_inner(cell_id, cell_type, after_cell_id)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize local mutation result: {e}")))
    }

    /// Move a cell to a new position (after the specified cell).
    ///
    /// - `after_cell_id = null` → move to the beginning
    /// - `after_cell_id = "id"` → move after that cell
    ///
    /// This only updates the cell's position field — no delete/re-insert.
    /// Returns the new position string.
    pub fn move_cell(
        &mut self,
        cell_id: &str,
        after_cell_id: Option<String>,
    ) -> Result<String, JsError> {
        self.doc
            .move_cell(cell_id, after_cell_id.as_deref())
            .map_err(|e| JsError::new(&format!("move_cell failed: {}", e)))
    }

    pub fn move_cell_with_changeset(
        &mut self,
        cell_id: &str,
        after_cell_id: Option<String>,
    ) -> Result<JsValue, JsError> {
        let result = self.move_cell_with_changeset_inner(cell_id, after_cell_id)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize local mutation result: {e}")))
    }

    /// Delete a cell by ID. Returns true if the cell was found and deleted.
    pub fn delete_cell(&mut self, cell_id: &str) -> Result<bool, JsError> {
        self.doc
            .delete_cell(cell_id)
            .map_err(|e| JsError::new(&format!("delete_cell failed: {}", e)))
    }

    pub fn delete_cell_with_changeset(&mut self, cell_id: &str) -> Result<JsValue, JsError> {
        let result = self.delete_cell_with_changeset_inner(cell_id)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize local mutation result: {e}")))
    }

    /// Clear a cell's visible outputs by removing its current execution pointer.
    pub fn clear_outputs(&mut self, cell_id: &str) -> Result<bool, JsError> {
        self.doc
            .clear_outputs(cell_id)
            .map_err(|e| JsError::new(&format!("clear_outputs failed: {}", e)))
    }

    pub fn clear_outputs_with_changeset(&mut self, cell_id: &str) -> Result<JsValue, JsError> {
        let result = self.clear_outputs_with_changeset_inner(cell_id)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize local mutation result: {e}")))
    }

    pub fn set_cell_source_hidden_with_changeset(
        &mut self,
        cell_id: &str,
        hidden: bool,
    ) -> Result<JsValue, JsError> {
        let result = self.set_cell_source_hidden_with_changeset_inner(cell_id, hidden)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize local mutation result: {e}")))
    }

    pub fn set_cell_type_with_changeset(
        &mut self,
        cell_id: &str,
        cell_type: &str,
    ) -> Result<JsValue, JsError> {
        let result = self.set_cell_type_with_changeset_inner(cell_id, cell_type)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize local mutation result: {e}")))
    }

    pub fn set_cell_outputs_hidden_with_changeset(
        &mut self,
        cell_id: &str,
        hidden: bool,
    ) -> Result<JsValue, JsError> {
        let result = self.set_cell_outputs_hidden_with_changeset_inner(cell_id, hidden)?;
        serialize_to_js(&result)
            .map_err(|e| JsError::new(&format!("serialize local mutation result: {e}")))
    }

    /// Update a cell's source text using Automerge Text CRDT (Myers diff).
    pub fn update_source(&mut self, cell_id: &str, source: &str) -> Result<bool, JsError> {
        self.doc
            .update_source(cell_id, source)
            .map_err(|e| JsError::new(&format!("update_source failed: {}", e)))
    }

    /// Splice a cell's source at a specific position (character-level, no diff).
    pub fn splice_source(
        &mut self,
        cell_id: &str,
        index: usize,
        delete_count: usize,
        text: &str,
    ) -> Result<bool, JsError> {
        self.doc
            .splice_source(cell_id, index, delete_count, text)
            .map_err(|e| JsError::new(&format!("splice_source failed: {}", e)))
    }

    /// Append text to a cell's source (optimized for streaming, no diff).
    pub fn append_source(&mut self, cell_id: &str, text: &str) -> Result<bool, JsError> {
        self.doc
            .append_source(cell_id, text)
            .map_err(|e| JsError::new(&format!("append_source failed: {}", e)))
    }

    /// Get a metadata value by key (legacy string API).
    pub fn get_metadata(&self, key: &str) -> Option<String> {
        self.doc.get_metadata(key)
    }

    /// Get the full typed metadata as a JSON string.
    ///
    /// Returns the `NotebookMetadataSnapshot` serialized as JSON, or undefined
    /// if no metadata is set. The frontend can parse this with a shared TS interface.
    pub fn get_metadata_snapshot_json(&self) -> Option<String> {
        let snapshot = self.doc.get_metadata_snapshot()?;
        serde_json::to_string(&snapshot).ok()
    }

    /// Get the full typed metadata as a native JS object.
    ///
    /// Returns the `NotebookMetadataSnapshot` as a JS object via serde-wasm-bindgen,
    /// avoiding JSON string round-trips. Returns undefined if no metadata is set.
    pub fn get_metadata_snapshot(&self) -> JsValue {
        match self.doc.get_metadata_snapshot() {
            Some(snapshot) => serialize_to_js(&snapshot).unwrap_or(JsValue::UNDEFINED),
            None => JsValue::UNDEFINED,
        }
    }

    /// Get a metadata value as a native JS value.
    ///
    /// Reads the Automerge metadata subtree and returns it as a JS object/array/scalar.
    /// Returns undefined if the key doesn't exist.
    pub fn get_metadata_value(&self, key: &str) -> JsValue {
        match self.doc.get_metadata_value(key) {
            Some(value) => serialize_to_js(&value).unwrap_or(JsValue::UNDEFINED),
            None => JsValue::UNDEFINED,
        }
    }

    /// Detect the notebook runtime from kernelspec/language_info metadata.
    ///
    /// Returns "python", "deno", or undefined for unknown runtimes.
    pub fn detect_runtime(&self) -> Option<String> {
        self.doc.detect_runtime()
    }

    /// Invalidate the cached metadata fingerprint.
    fn invalidate_metadata_cache(&mut self) {
        self.metadata_fingerprint_cache = None;
    }

    /// Return a stable fingerprint of the notebook metadata.
    ///
    /// Returns a cached JSON string suitable for equality comparison.
    /// The cache is invalidated in `receive_frame` when the Automerge
    /// doc actually changes (heads differ) and on all local metadata
    /// mutation methods.
    ///
    /// Returns undefined if no metadata is present.
    pub fn get_metadata_fingerprint(&mut self) -> Option<String> {
        if let Some(ref cached) = self.metadata_fingerprint_cache {
            return Some(cached.clone());
        }
        let fp = self.doc.get_metadata_fingerprint()?;
        self.metadata_fingerprint_cache = Some(fp.clone());
        Some(fp)
    }

    /// Return the current Automerge notebook document heads as hex strings.
    pub fn get_heads_hex(&mut self) -> Vec<String> {
        self.doc.get_heads_hex()
    }

    /// True when the local NotebookDoc contains every head the connected
    /// peer last advertised on this connection's sync state — the doc has
    /// provably caught up to everything the peer said it has.
    ///
    /// `their_heads` is `None` until the first inbound sync message is
    /// applied, so this reports `false` before any exchange: an empty
    /// bootstrap doc is never "caught up" merely because nothing has
    /// arrived. Local-only changes keep this `true` — only the peer's
    /// advertised heads must be present locally. `reset_sync_state()`
    /// (reconnect) returns this to `false` until the new connection's
    /// first inbound message applies.
    ///
    /// Hosted viewers use this to decide when an empty synced doc is the
    /// room's truth (safe to displace locally painted content) rather
    /// than a handshake that has not delivered content yet.
    pub fn notebook_doc_caught_up(&mut self) -> bool {
        let Some(their_heads) = self.sync_state.their_heads.clone() else {
            return false;
        };
        their_heads
            .iter()
            .all(|hash| self.doc.doc_mut().get_change_by_hash(hash).is_some())
    }

    /// Return the current RuntimeStateDoc heads as hex strings.
    pub fn get_runtime_state_heads_hex(&mut self) -> Vec<String> {
        self.state_doc
            .get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    /// Return a stable fingerprint of dependency metadata covered by trust approval.
    pub fn get_dependency_fingerprint(&self) -> Option<String> {
        self.doc.get_dependency_fingerprint()
    }

    /// Set a metadata value (legacy string API).
    pub fn set_metadata(&mut self, key: &str, value: &str) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .set_metadata(key, value)
            .map_err(|e| JsError::new(&format!("set_metadata failed: {}", e)))
    }

    /// Set the full typed metadata snapshot from a JS object.
    ///
    /// Accepts a JS object matching the `NotebookMetadataSnapshot` shape and writes
    /// it as native Automerge types (maps, lists, scalars). This enables per-field
    /// CRDT merging instead of last-write-wins on a JSON string.
    pub fn set_metadata_snapshot_value(&mut self, value: JsValue) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        let snapshot: notebook_doc::metadata::NotebookMetadataSnapshot =
            serde_wasm_bindgen::from_value(value)
                .map_err(|e| JsError::new(&format!("invalid metadata snapshot: {}", e)))?;
        self.doc
            .set_metadata_snapshot(&snapshot)
            .map_err(|e| JsError::new(&format!("set_metadata_snapshot failed: {}", e)))
    }

    /// Set a metadata value from a JS object (native Automerge types).
    ///
    /// Accepts any JS value and writes it as native Automerge types under the
    /// given key in the metadata map. Objects become Maps, arrays become Lists,
    /// and scalars become native scalars.
    pub fn set_metadata_value(&mut self, key: &str, value: JsValue) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        let json_value: serde_json::Value = serde_wasm_bindgen::from_value(value)
            .map_err(|e| JsError::new(&format!("invalid metadata value: {}", e)))?;
        self.doc
            .set_metadata_value(key, &json_value)
            .map_err(|e| JsError::new(&format!("set_metadata_value failed: {}", e)))
    }

    // ── Cell metadata operations ─────────────────────────────────

    /// Set whether the cell source should be hidden (JupyterLab convention).
    ///
    /// Sets `metadata.jupyter.source_hidden` for the specified cell.
    /// Returns true if the cell was found and updated.
    pub fn set_cell_source_hidden(&mut self, cell_id: &str, hidden: bool) -> Result<bool, JsError> {
        self.doc
            .set_cell_source_hidden(cell_id, hidden)
            .map_err(|e| JsError::new(&format!("set_cell_source_hidden failed: {}", e)))
    }

    /// Set the cell type for an existing cell. Valid values: "code", "markdown", or "raw".
    ///
    /// Returns true if the cell was found and updated.
    pub fn set_cell_type(&mut self, cell_id: &str, cell_type: &str) -> Result<bool, JsError> {
        self.doc
            .set_cell_type(cell_id, cell_type)
            .map_err(|e| JsError::new(&format!("set_cell_type failed: {}", e)))
    }

    /// Set whether the cell outputs should be hidden (JupyterLab convention).
    ///
    /// Sets `metadata.jupyter.outputs_hidden` for the specified cell.
    /// Returns true if the cell was found and updated.
    pub fn set_cell_outputs_hidden(
        &mut self,
        cell_id: &str,
        hidden: bool,
    ) -> Result<bool, JsError> {
        self.doc
            .set_cell_outputs_hidden(cell_id, hidden)
            .map_err(|e| JsError::new(&format!("set_cell_outputs_hidden failed: {}", e)))
    }

    /// Set the cell tags.
    ///
    /// Accepts a JSON array string (e.g. `'["hide-input", "parameters"]'`).
    /// Returns true if the cell was found and updated.
    pub fn set_cell_tags(&mut self, cell_id: &str, tags_json: &str) -> Result<bool, JsError> {
        let tags: Vec<String> = serde_json::from_str(tags_json)
            .map_err(|e| JsError::new(&format!("invalid tags JSON: {}", e)))?;
        self.doc
            .set_cell_tags(cell_id, tags)
            .map_err(|e| JsError::new(&format!("set_cell_tags failed: {}", e)))
    }

    /// Set the cell tags from a JS array (native, no JSON string).
    ///
    /// Accepts a JS array of strings directly via serde-wasm-bindgen.
    pub fn set_cell_tags_value(&mut self, cell_id: &str, tags: JsValue) -> Result<bool, JsError> {
        let tags: Vec<String> = serde_wasm_bindgen::from_value(tags)
            .map_err(|e| JsError::new(&format!("invalid tags value: {}", e)))?;
        self.doc
            .set_cell_tags(cell_id, tags)
            .map_err(|e| JsError::new(&format!("set_cell_tags failed: {}", e)))
    }

    /// Update cell metadata at a specific path (e.g., ["jupyter", "source_hidden"]).
    ///
    /// Creates intermediate objects if they don't exist.
    /// Accepts path and value as JSON strings.
    /// Returns true if the cell was found and updated.
    pub fn update_cell_metadata_at(
        &mut self,
        cell_id: &str,
        path_json: &str,
        value_json: &str,
    ) -> Result<bool, JsError> {
        let path: Vec<String> = serde_json::from_str(path_json)
            .map_err(|e| JsError::new(&format!("invalid path JSON: {}", e)))?;
        let value: serde_json::Value = serde_json::from_str(value_json)
            .map_err(|e| JsError::new(&format!("invalid value JSON: {}", e)))?;
        let path_refs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        self.doc
            .update_cell_metadata_at(cell_id, &path_refs, value)
            .map_err(|e| JsError::new(&format!("update_cell_metadata_at failed: {}", e)))
    }

    /// Update cell metadata at a specific path using native JS values.
    ///
    /// Path is a JS array of strings, value is any JS value.
    /// No JSON string round-trips.
    pub fn update_cell_metadata_at_value(
        &mut self,
        cell_id: &str,
        path: JsValue,
        value: JsValue,
    ) -> Result<bool, JsError> {
        let path: Vec<String> = serde_wasm_bindgen::from_value(path)
            .map_err(|e| JsError::new(&format!("invalid path: {}", e)))?;
        let value: serde_json::Value = serde_wasm_bindgen::from_value(value)
            .map_err(|e| JsError::new(&format!("invalid value: {}", e)))?;
        let path_refs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        self.doc
            .update_cell_metadata_at(cell_id, &path_refs, value)
            .map_err(|e| JsError::new(&format!("update_cell_metadata_at failed: {}", e)))
    }

    /// Replace entire cell metadata (last-write-wins).
    ///
    /// Accepts metadata as a JSON object string.
    /// Returns true if the cell was found and updated.
    pub fn set_cell_metadata(
        &mut self,
        cell_id: &str,
        metadata_json: &str,
    ) -> Result<bool, JsError> {
        let metadata: serde_json::Value = serde_json::from_str(metadata_json)
            .map_err(|e| JsError::new(&format!("invalid metadata JSON: {}", e)))?;
        if !metadata.is_object() {
            return Err(JsError::new("metadata must be a JSON object"));
        }
        self.doc
            .set_cell_metadata(cell_id, &metadata)
            .map_err(|e| JsError::new(&format!("set_cell_metadata failed: {}", e)))
    }

    /// Replace entire cell metadata from a JS object (native, no JSON string).
    pub fn set_cell_metadata_value(
        &mut self,
        cell_id: &str,
        metadata: JsValue,
    ) -> Result<bool, JsError> {
        let metadata: serde_json::Value = serde_wasm_bindgen::from_value(metadata)
            .map_err(|e| JsError::new(&format!("invalid metadata: {}", e)))?;
        if !metadata.is_object() {
            return Err(JsError::new("metadata must be an object"));
        }
        self.doc
            .set_cell_metadata(cell_id, &metadata)
            .map_err(|e| JsError::new(&format!("set_cell_metadata failed: {}", e)))
    }

    // ── UV dependency operations ─────────────────────────────────

    /// Add a UV dependency, deduplicating by package name (case-insensitive).
    /// Initializes the UV section if absent, preserving existing fields.
    pub fn add_uv_dependency(&mut self, pkg: &str) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .add_uv_dependency(pkg)
            .map_err(|e| JsError::new(&format!("add_uv_dependency failed: {}", e)))
    }

    /// Remove a UV dependency by package name (case-insensitive).
    /// Returns true if a dependency was removed.
    pub fn remove_uv_dependency(&mut self, pkg: &str) -> Result<bool, JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .remove_uv_dependency(pkg)
            .map_err(|e| JsError::new(&format!("remove_uv_dependency failed: {}", e)))
    }

    /// Clear the UV section entirely (deps + requires-python).
    pub fn clear_uv_section(&mut self) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .clear_uv_section()
            .map_err(|e| JsError::new(&format!("clear_uv_section failed: {}", e)))
    }

    /// Set UV requires-python constraint, preserving deps.
    /// Pass undefined/null to clear the constraint.
    pub fn set_uv_requires_python(
        &mut self,
        requires_python: Option<String>,
    ) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .set_uv_requires_python(requires_python)
            .map_err(|e| JsError::new(&format!("set_uv_requires_python failed: {}", e)))
    }

    /// Set UV prerelease strategy, preserving deps and requires-python.
    /// Pass "allow", "disallow", "if-necessary", "explicit", "if-necessary-or-explicit", or null to clear.
    pub fn set_uv_prerelease(&mut self, prerelease: Option<String>) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .set_uv_prerelease(prerelease)
            .map_err(|e| JsError::new(&format!("set_uv_prerelease failed: {}", e)))
    }

    // ── Conda dependency operations ──────────────────────────────

    /// Add a Conda dependency, deduplicating by package name (case-insensitive).
    /// Initializes the Conda section with ["conda-forge"] channels if absent.
    ///
    /// Rejects PEP 508 extras syntax (`pkg[extra]`) — conda matchspecs
    /// don't accept brackets, and letting one through SIGKILLs the
    /// kernel at install time. See issue #2119.
    pub fn add_conda_dependency(&mut self, pkg: &str) -> Result<(), JsError> {
        notebook_doc::metadata::validate_conda_package_specifier(pkg)
            .map_err(|e| JsError::new(&e))?;
        self.invalidate_metadata_cache();
        self.doc
            .add_conda_dependency(pkg)
            .map_err(|e| JsError::new(&format!("add_conda_dependency failed: {}", e)))
    }

    /// Remove a Conda dependency by package name (case-insensitive).
    /// Returns true if a dependency was removed.
    pub fn remove_conda_dependency(&mut self, pkg: &str) -> Result<bool, JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .remove_conda_dependency(pkg)
            .map_err(|e| JsError::new(&format!("remove_conda_dependency failed: {}", e)))
    }

    /// Clear the Conda section entirely.
    pub fn clear_conda_section(&mut self) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .clear_conda_section()
            .map_err(|e| JsError::new(&format!("clear_conda_section failed: {}", e)))
    }

    /// Set Conda channels, preserving deps and python.
    /// Accepts a JSON array string (e.g. `'["conda-forge","bioconda"]'`).
    pub fn set_conda_channels(&mut self, channels_json: &str) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        let channels: Vec<String> = serde_json::from_str(channels_json)
            .map_err(|e| JsError::new(&format!("invalid channels JSON: {}", e)))?;
        self.doc
            .set_conda_channels(channels)
            .map_err(|e| JsError::new(&format!("set_conda_channels failed: {}", e)))
    }

    /// Set Conda python version, preserving deps and channels.
    /// Pass undefined/null to clear the constraint.
    pub fn set_conda_python(&mut self, python: Option<String>) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .set_conda_python(python)
            .map_err(|e| JsError::new(&format!("set_conda_python failed: {}", e)))
    }

    // ── Pixi dependency operations ──────────────────────────────────

    /// Add a Pixi conda dependency (matchspec). Deduplicates by package name.
    ///
    /// Rejects PEP 508 extras syntax (`pkg[extra]`) — pixi uses
    /// rattler-style matchspecs which don't accept brackets. See #2119.
    pub fn add_pixi_dependency(&mut self, pkg: &str) -> Result<(), JsError> {
        notebook_doc::metadata::validate_conda_package_specifier(pkg)
            .map_err(|e| JsError::new(&e))?;
        self.invalidate_metadata_cache();
        self.doc
            .add_pixi_dependency(pkg)
            .map_err(|e| JsError::new(&format!("add_pixi_dependency failed: {}", e)))
    }

    /// Remove a Pixi conda dependency by package name.
    /// Returns true if a dependency was removed.
    pub fn remove_pixi_dependency(&mut self, pkg: &str) -> Result<bool, JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .remove_pixi_dependency(pkg)
            .map_err(|e| JsError::new(&format!("remove_pixi_dependency failed: {}", e)))
    }

    /// Clear the Pixi section entirely.
    pub fn clear_pixi_section(&mut self) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .clear_pixi_section()
            .map_err(|e| JsError::new(&format!("clear_pixi_section failed: {}", e)))
    }

    /// Set Pixi channels.
    /// Accepts a JSON array string (e.g. `'["conda-forge"]'`).
    pub fn set_pixi_channels(&mut self, channels_json: &str) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        let channels: Vec<String> = serde_json::from_str(channels_json)
            .map_err(|e| JsError::new(&format!("invalid channels JSON: {}", e)))?;
        self.doc
            .set_pixi_channels(channels)
            .map_err(|e| JsError::new(&format!("set_pixi_channels failed: {}", e)))
    }

    /// Set Pixi python version.
    /// Pass undefined/null to clear the constraint.
    pub fn set_pixi_python(&mut self, python: Option<String>) -> Result<(), JsError> {
        self.invalidate_metadata_cache();
        self.doc
            .set_pixi_python(python)
            .map_err(|e| JsError::new(&format!("set_pixi_python failed: {}", e)))
    }

    /// Flush any pending local changes as a sync message to send to the daemon.
    ///
    /// Call this after local CRDT mutations (cell edits, metadata changes) to
    /// push them to the daemon. Returns the message as a byte array, or
    /// `undefined` if there are no unsent local changes.
    ///
    /// This is the ONLY way to generate an outbound sync message besides the
    /// reply embedded in `receive_frame()`. Having exactly two controlled paths
    /// (reply-to-inbound and flush-local) prevents the consumption race from
    /// #1067 where `flushSync` and `syncReply$` both called
    /// `generate_sync_message`, racing on the shared `sync_state`.
    ///
    /// If the returned message cannot be delivered, the caller MUST call
    /// `cancel_last_flush()` to prevent `sent_hashes` from permanently
    /// filtering out the undelivered change data.
    pub fn flush_local_changes(&mut self) -> Option<Vec<u8>> {
        self.doc
            .generate_sync_message(&mut self.sync_state)
            .map(|msg| msg.encode())
    }

    /// Roll back sync state after a failed `flush_local_changes()` delivery.
    ///
    /// If the message from `flush_local_changes()` was NOT delivered to the
    /// daemon (e.g. sendFrame failed, relay mutex blocked), call this to clear
    /// `in_flight` and `sent_hashes`. Without this, `generate_sync_message`
    /// will permanently filter out the change data for hashes it believes were
    /// already sent, causing a protocol stall that only `reset_sync_state()`
    /// (page reload) can recover from.
    ///
    /// Clearing `sent_hashes` may cause some change data to be resent on the
    /// next sync message, but the protocol tolerates duplicates — Automerge's
    /// `load_incremental` deduplicates on receive.
    pub fn cancel_last_flush(&mut self) {
        self.sync_state.in_flight = false;
        self.sync_state.sent_hashes.clear();
    }

    /// Receive and apply a sync message from the daemon (via the Tauri relay pipe).
    ///
    /// Returns true if the document changed (caller should re-read cells).
    pub fn receive_sync_message(&mut self, message: &[u8]) -> Result<bool, JsError> {
        let msg = sync::Message::decode(message)
            .map_err(|e| JsError::new(&format!("decode sync message: {}", e)))?;

        // Compare document heads before and after to detect changes.
        // This is O(number of heads) — far cheaper than the previous approach
        // which called doc.save() twice (serializing the entire document).
        let heads_before = self.doc.doc_mut().get_heads();

        self.doc
            .receive_sync_message(&mut self.sync_state, msg)
            .map_err(|e| JsError::new(&format!("receive sync message: {}", e)))?;

        let heads_after = self.doc.doc_mut().get_heads();
        Ok(heads_before != heads_after)
    }

    /// Export the full document as bytes (for debugging or persistence).
    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    /// Serialize every NotebookDoc change that is not a transitive
    /// dependency of `heads_hex` (hex change hashes, as returned by
    /// `get_heads_hex()`).
    ///
    /// Empty heads = full `save()` — the compressed document chunk, never
    /// an incremental dump of the entire history (automerge-repo's
    /// documented `saveSince(empty)` pitfall). Non-empty heads produce a
    /// concatenation of raw change chunks suitable for content-addressed
    /// incremental persistence and the cross-tab bridge; `load()` /
    /// `apply_change_bytes()` accept them directly, including concatenated
    /// snapshot + incremental buffers.
    ///
    /// Stateless by design: the caller owns the heads bookkeeping. This
    /// never touches automerge's internal `save_incremental` cursor —
    /// other code paths call `save()`, which would silently move shared
    /// bookkeeping. Heads unknown to this doc are ignored by the
    /// dependency filter, so a stale basis degrades to a larger
    /// (overlapping) payload, never a gap.
    pub fn save_since_heads(&mut self, heads_hex: Vec<String>) -> Result<Vec<u8>, JsError> {
        self.save_since_heads_inner(&heads_hex)
            .map_err(|e| JsError::new(&e))
    }

    fn save_since_heads_inner(&mut self, heads_hex: &[String]) -> Result<Vec<u8>, String> {
        if heads_hex.is_empty() {
            return Ok(self.doc.save());
        }
        let heads = parse_heads_hex(heads_hex)?;
        Ok(self.doc.doc_mut().save_after(&heads))
    }

    /// Apply serialized NotebookDoc changes (from `save_since_heads()` or
    /// `save()`, possibly concatenated) and return the same event shape as
    /// a `sync_applied` frame so the engine can route it through the
    /// existing materialization path — heads compare for `changed`, one
    /// `diff_doc` walk for the changeset, attributions from the same
    /// patches, execution-view projection. No second diff path.
    ///
    /// Changes the document already knows are deduplicated by
    /// `load_incremental`, reporting `changed: false` — the property that
    /// keeps the cross-tab bridge from ping-ponging. An unparseable buffer
    /// on a non-empty doc degrades to a partial load of zero changes
    /// (automerge warns and applies what parsed), so a bad peer message
    /// can never corrupt the doc or report `changed: true`. Sync state is
    /// untouched: the next ordinary flush/sync round carries the applied
    /// changes to the room. The returned event's `reply` is always absent.
    pub fn apply_change_bytes(&mut self, bytes: &[u8]) -> Result<JsValue, JsError> {
        let event = self
            .apply_change_bytes_inner(bytes)
            .map_err(|e| JsError::new(&e))?;
        Ok(serialize_to_js(&event).unwrap_or(JsValue::UNDEFINED))
    }

    fn apply_change_bytes_inner(&mut self, bytes: &[u8]) -> Result<FrameEvent, String> {
        let heads_before = self.doc.doc_mut().get_heads();
        self.doc
            .doc_mut()
            .load_incremental(bytes)
            .map_err(|e| format!("apply change bytes failed: {e}"))?;
        let heads_after = self.doc.doc_mut().get_heads();
        let changed = heads_before != heads_after;

        // Mirror the AUTOMERGE_SYNC arm of receive_frame exactly: one
        // diff_doc walk covers cells + metadata + text patches.
        let (changeset, attributions) = if changed {
            let doc_changeset = diff_doc(self.doc.doc_mut(), &heads_before, &heads_after);
            if doc_changeset.metadata_changed {
                self.metadata_fingerprint_cache = None;
            }
            let attrs = build_text_attributions(
                self.doc.doc_mut(),
                &heads_before,
                &doc_changeset.text_patches,
            );
            (Some(doc_changeset.cells), attrs)
        } else {
            (None, Vec::new())
        };

        let execution_view_changeset = if changed {
            let state = self.state_doc.read_state();
            self.execution_view_projector
                .project_all(notebook_execution_pointers(&self.doc), &state)
        } else {
            ExecutionViewChangeset::default()
        };

        Ok(FrameEvent::SyncApplied {
            changed,
            changeset,
            attributions,
            reply: None,
            execution_view_changeset,
        })
    }

    /// Export the full RuntimeStateDoc as bytes.
    pub fn save_state_doc(&mut self) -> Vec<u8> {
        self.state_doc.doc_mut().save()
    }

    /// Export the full CommsDoc as bytes.
    pub fn save_comms_doc(&mut self) -> Vec<u8> {
        self.comms_doc.doc_mut().save()
    }

    /// Set a single property in a comm's state map.
    ///
    /// Writes directly to `CommsDoc.comms/{comm_id}/{key}` as a native
    /// Automerge value. Call `flush_comms_doc_sync()` after mutations
    /// to propagate changes to the daemon.
    pub fn set_comm_state_property(&mut self, comm_id: &str, key: &str, value_json: &str) -> bool {
        let value: serde_json::Value = match serde_json::from_str(value_json) {
            Ok(v) => v,
            Err(_) => return false,
        };
        self.comms_doc
            .set_comm_state_property(comm_id, key, &value)
            .is_ok()
    }

    /// Set multiple properties in a comm's state map at once.
    ///
    /// Accepts a JSON object string of key-value pairs to write.
    /// Used by anywidget's `save_changes()` which batches pending mutations.
    /// Call `flush_comms_doc_sync()` after to propagate.
    pub fn set_comm_state_batch(&mut self, comm_id: &str, patch_json: &str) -> bool {
        let patch: serde_json::Value = match serde_json::from_str(patch_json) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let Some(obj) = patch.as_object() else {
            return false;
        };
        let mut any_written = false;
        for (key, value) in obj {
            if self
                .comms_doc
                .set_comm_state_property(comm_id, key, value)
                .is_ok()
            {
                any_written = true;
            }
        }
        any_written
    }

    /// Generate a sync reply for the RuntimeStateDoc.
    /// Called immediately after each `RuntimeStateSyncApplied` event
    /// so the daemon knows which state the client has received.
    pub fn generate_runtime_state_sync_reply(&mut self) -> Option<Vec<u8>> {
        self.state_doc
            .generate_sync_message(&mut self.state_sync_state)
            .map(|msg| msg.encode())
    }

    /// Generate an initial RuntimeStateDoc sync message.
    ///
    /// Call this during bootstrap (alongside `flush_local_changes` for the
    /// notebook doc) so the daemon knows we need the full RuntimeStateDoc.
    /// Without this, if the daemon's initial `RuntimeStateSync` frame arrives
    /// before the WASM handle is ready, the kernel status is never synced
    /// and the frontend stays stuck on "not_started".
    ///
    /// If the returned message cannot be delivered, the caller MUST call
    /// `cancel_last_runtime_state_flush()` to prevent `sent_hashes` from
    /// permanently filtering out the undelivered state data.
    pub fn flush_runtime_state_sync(&mut self) -> Option<Vec<u8>> {
        self.state_doc
            .generate_sync_message(&mut self.state_sync_state)
            .map(|msg| msg.encode())
    }

    /// Roll back runtime-state sync state after a failed
    /// `flush_runtime_state_sync()` delivery.
    ///
    /// Mirrors `cancel_last_flush()` for the notebook doc: clears
    /// `in_flight` and `sent_hashes` on `state_sync_state` so the next
    /// `flush_runtime_state_sync()` or `generate_runtime_state_sync_reply()`
    /// produces a message instead of returning `None`.
    pub fn cancel_last_runtime_state_flush(&mut self) {
        self.state_sync_state.in_flight = false;
        self.state_sync_state.sent_hashes.clear();
    }

    /// Generate a sync reply for the CommsDoc.
    pub fn generate_comms_doc_sync_reply(&mut self) -> Option<Vec<u8>> {
        self.comms_doc
            .generate_sync_message(&mut self.comms_sync_state)
            .map(|msg| msg.encode())
    }

    /// Generate an initial CommsDoc sync message.
    pub fn flush_comms_doc_sync(&mut self) -> Option<Vec<u8>> {
        self.comms_doc
            .generate_sync_message(&mut self.comms_sync_state)
            .map(|msg| msg.encode())
    }

    /// Roll back CommsDoc sync state after a failed delivery.
    pub fn cancel_last_comms_doc_flush(&mut self) {
        self.comms_sync_state.in_flight = false;
        self.comms_sync_state.sent_hashes.clear();
    }

    /// Generate a sync reply for the CommentsDoc.
    pub fn generate_comments_doc_sync_reply(&mut self) -> Option<Vec<u8>> {
        self.comments_doc.as_mut().and_then(|comments_doc| {
            comments_doc
                .generate_sync_message(&mut self.comments_sync_state)
                .map(|msg| msg.encode())
        })
    }

    /// Generate an initial CommentsDoc sync message.
    pub fn flush_comments_doc_sync(&mut self) -> Option<Vec<u8>> {
        self.comments_doc.as_mut().and_then(|comments_doc| {
            comments_doc
                .generate_sync_message(&mut self.comments_sync_state)
                .map(|msg| msg.encode())
        })
    }

    /// Roll back CommentsDoc sync state after a failed delivery.
    pub fn cancel_last_comments_doc_flush(&mut self) {
        self.comments_sync_state.in_flight = false;
        self.comments_sync_state.sent_hashes.clear();
    }

    /// Initialize CommentsDoc sync from daemon-provided room identity.
    pub fn init_comments_sync_target(&mut self, comments_doc_id: &str) -> Result<(), JsError> {
        let notebook_ref = comments_sync_target_ref(comments_doc_id);
        self.init_comments_sync_target_inner(comments_doc_id, &notebook_ref)
    }

    /// Initialize CommentsDoc sync from daemon-provided room identity and notebook ref.
    pub fn init_comments_sync_target_ref(
        &mut self,
        comments_doc_id: &str,
        notebook_ref_json: &str,
    ) -> Result<(), JsError> {
        let notebook_ref = parse_comments_notebook_ref_json(notebook_ref_json)?;
        self.init_comments_sync_target_inner(comments_doc_id, &notebook_ref)
    }

    fn init_comments_sync_target_inner(
        &mut self,
        comments_doc_id: &str,
        notebook_ref: &NotebookCommentRef,
    ) -> Result<(), JsError> {
        let actor_label = self.doc.get_actor_id();
        let current_identity_matches = self.comments_doc.as_ref().is_some_and(|comments_doc| {
            comments_doc.comments_doc_id().as_deref() == Some(comments_doc_id)
                && comments_doc.notebook_ref().as_ref() == Some(notebook_ref)
        });
        if current_identity_matches {
            self.comments_identity = Some((comments_doc_id.to_string(), notebook_ref.clone()));
            if let Some(comments_doc) = self.comments_doc.as_mut() {
                comments_doc
                    .doc_mut()
                    .set_actor(automerge::ActorId::from(actor_label.as_bytes()));
            }
            return Ok(());
        }
        self.comments_doc = Some(create_comments_doc_sync_target_with_ref(
            comments_doc_id,
            notebook_ref,
            &actor_label,
        )?);
        self.comments_identity = Some((comments_doc_id.to_string(), notebook_ref.clone()));
        self.comments_sync_state = sync::State::new();
        Ok(())
    }

    fn expected_comments_identity(&self) -> Option<(String, NotebookCommentRef)> {
        debug_assert!(
            self.comments_identity.is_some() || self.comments_doc.is_none(),
            "comments_doc initialized without cached comments identity"
        );
        self.comments_identity.clone().or_else(|| {
            self.comments_doc.as_ref().and_then(|comments_doc| {
                Some((
                    comments_doc.comments_doc_id()?,
                    comments_doc.notebook_ref()?,
                ))
            })
        })
    }

    /// Current CommentsDoc identity if comments sync is initialized.
    pub fn get_comments_doc_id(&self) -> Option<String> {
        self.comments_doc
            .as_ref()
            .and_then(CommentsDoc::comments_doc_id)
    }

    /// Generate a sync reply for the PoolDoc.
    pub fn generate_pool_state_sync_reply(&mut self) -> Option<Vec<u8>> {
        self.pool_doc
            .generate_sync_message(&mut self.pool_sync_state)
            .map(|msg| msg.encode())
    }

    /// Generate an initial PoolDoc sync message.
    ///
    /// Call this during bootstrap so the daemon syncs pool state.
    pub fn flush_pool_state_sync(&mut self) -> Option<Vec<u8>> {
        self.pool_doc
            .generate_sync_message(&mut self.pool_sync_state)
            .map(|msg| msg.encode())
    }

    /// Roll back pool sync state after a failed delivery.
    pub fn cancel_last_pool_state_flush(&mut self) {
        self.pool_sync_state.in_flight = false;
        self.pool_sync_state.sent_hashes.clear();
    }

    /// Read the current pool state snapshot from the WASM doc.
    pub fn get_pool_state(&self) -> JsValue {
        let state = self.pool_doc.read_state();
        serialize_to_js(&state).unwrap_or(JsValue::UNDEFINED)
    }

    /// Read the current runtime state snapshot from the WASM doc.
    pub fn get_runtime_state(&self) -> JsValue {
        let state = self.state_doc.read_state();
        serialize_to_js(&state).unwrap_or(JsValue::UNDEFINED)
    }

    /// Read the current CommsDoc state snapshot from the WASM doc.
    pub fn get_comms_state(&self) -> JsValue {
        let state = self.comms_doc.read_state();
        serialize_to_js(&state).unwrap_or(JsValue::UNDEFINED)
    }

    /// Read the current CommentsDoc projection from the WASM doc.
    pub fn get_comments_projection(&mut self) -> JsValue {
        self.comments_projection()
            .and_then(|projection| {
                serialize_to_js(&projection)
                    .map_err(|e| JsError::new(&format!("serialize comments projection: {e}")))
            })
            .unwrap_or(JsValue::UNDEFINED)
    }

    /// Return the current CommentsDoc heads as hex strings.
    pub fn get_comments_doc_heads_hex(&mut self) -> Vec<String> {
        self.comments_doc
            .as_mut()
            .map(|comments_doc| {
                comments_doc
                    .get_heads()
                    .into_iter()
                    .map(|head| hex::encode(head.as_ref()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Create a local comment thread in CommentsDoc.
    pub fn create_comment_thread(
        &mut self,
        thread_id: &str,
        message_id: &str,
        anchor: JsValue,
        body: &str,
        after_thread_id: Option<String>,
        created_at: &str,
    ) -> Result<JsValue, JsError> {
        let anchor: CommentAnchor = serde_wasm_bindgen::from_value(anchor)
            .map_err(|e| JsError::new(&format!("decode comment anchor: {e}")))?;
        let comments_doc = self.comments_doc_mut()?;
        comments_doc
            .create_thread(
                thread_id,
                message_id,
                &anchor,
                body,
                after_thread_id.as_deref(),
                created_at,
            )
            .map_err(|e| JsError::new(&format!("create comment thread: {e}")))?;
        self.serialize_comments_projection_event()
    }

    /// Demote a comment thread to a notebook-level comment.
    pub fn demote_comment_thread_to_notebook(&mut self, thread_id: String) -> Result<(), JsError> {
        let comments_doc = self.comments_doc_mut()?;
        comments_doc
            .demote_thread_anchor_to_notebook(&thread_id)
            .map_err(|e| JsError::new(&format!("demote comment thread: {e}")))
    }

    /// Add a local reply to a comment thread in CommentsDoc.
    pub fn reply_comment_thread(
        &mut self,
        thread_id: &str,
        message_id: &str,
        body: &str,
        after_message_id: Option<String>,
        created_at: &str,
    ) -> Result<JsValue, JsError> {
        let comments_doc = self.comments_doc_mut()?;
        comments_doc
            .reply(
                thread_id,
                message_id,
                body,
                after_message_id.as_deref(),
                created_at,
            )
            .map_err(|e| JsError::new(&format!("reply to comment thread: {e}")))?;
        self.serialize_comments_projection_event()
    }

    /// Mark a comment thread as resolved in CommentsDoc.
    pub fn resolve_comment_thread(
        &mut self,
        thread_id: &str,
        resolved_at: &str,
    ) -> Result<JsValue, JsError> {
        let comments_doc = self.comments_doc_mut()?;
        comments_doc
            .resolve_thread(thread_id, resolved_at)
            .map_err(|e| JsError::new(&format!("resolve comment thread: {e}")))?;
        self.serialize_comments_projection_event()
    }

    /// Reopen a resolved comment thread in CommentsDoc.
    pub fn reopen_comment_thread(&mut self, thread_id: &str) -> Result<JsValue, JsError> {
        let comments_doc = self.comments_doc_mut()?;
        comments_doc
            .reopen_thread(thread_id)
            .map_err(|e| JsError::new(&format!("reopen comment thread: {e}")))?;
        self.serialize_comments_projection_event()
    }

    /// Project any pending execution-view changes across NotebookDoc and
    /// RuntimeStateDoc.
    ///
    /// This is used after local notebook mutations (which do not pass through
    /// `receive_frame`) and during initial materialization to seed stores from
    /// the same Rust/WASM projector that handles inbound sync frames.
    pub fn project_execution_view_changeset(&mut self) -> JsValue {
        let state = self.state_doc.read_state();
        let changeset = self
            .execution_view_projector
            .project_all(notebook_execution_pointers(&self.doc), &state);
        serialize_to_js(&changeset).unwrap_or(JsValue::UNDEFINED)
    }

    /// Resolve ContentRef values in a comm's state for frontend consumption.
    ///
    /// Walks the state **recursively**, resolving ContentRef objects:
    /// - `{"blob": hash, "size": N, "media_type": M?}` → plain URL string
    /// - `{"inline": value}` → unwrapped inner value
    /// - Plain values → passed through unchanged
    ///
    /// Returns `{ state, buffer_paths, text_paths }`:
    /// - `buffer_paths` — JSON paths of blob refs with binary MIME types (or no
    ///   media_type). The caller fetches these as ArrayBuffers for ipywidgets
    ///   buffer handling.
    /// - `text_paths` — JSON paths of blob refs whose `media_type` classifies
    ///   as text (`text/*`, `application/json`, `application/javascript`, etc.).
    ///   The caller must fetch each URL, decode as UTF-8, and replace the URL
    ///   string at that path with the decoded content before handing the state
    ///   to widget code. Widgets that consume synced string traits (e.g.
    ///   anywidget `_py_render`) expect the actual content, not a URL.
    /// - `OutputModel.outputs` is omitted from `state` and from both path
    ///   lists. Output widget manifests are resolved through the notebook
    ///   output resolver, not through the widget binary-traitlet protocol.
    ///
    /// Returns undefined if blob_port is not set or comm doesn't exist.
    pub fn resolve_comm_state(&self, comm_id: &str) -> JsValue {
        let Some(port) = self.blob_port else {
            return JsValue::UNDEFINED;
        };
        let state = self.state_doc.read_state();
        let Some(entry) = state.comms.get(comm_id) else {
            return JsValue::UNDEFINED;
        };
        let comm_state = self
            .comms_doc
            .get_comm_state(comm_id)
            .unwrap_or_else(|| serde_json::json!({}));

        let is_output_model = entry.model_name == "OutputModel"
            || comm_state.get("_model_name").and_then(|v| v.as_str()) == Some("OutputModel");
        let (resolved, buffer_paths, text_paths) =
            resolve_comm_state_for_frontend(&comm_state, port, is_output_model);

        serialize_to_js(&serde_json::json!({
            "state": resolved,
            "buffer_paths": buffer_paths,
            "text_paths": text_paths,
        }))
        .unwrap_or(JsValue::UNDEFINED)
    }

    /// Reset the sync state. Call this when reconnecting to a new daemon session.
    pub fn reset_sync_state(&mut self) {
        self.sync_state = sync::State::new();
        self.state_sync_state = sync::State::new();
        self.comms_sync_state = sync::State::new();
        self.comments_sync_state = sync::State::new();
        self.pool_sync_state = sync::State::new();
    }

    /// Normalize sync state by round-tripping through encode→decode.
    ///
    /// Preserves `shared_heads` (what we've agreed on with the daemon) while
    /// clearing all transient state (`sent_hashes`, `in_flight`, `their_heads`,
    /// `their_need`, etc.). This is the frontend equivalent of automerge-repo's
    /// `decodeSyncState(encodeSyncState(state))` defensive pattern, which
    /// prevents infinite sync loops caused by corrupted ephemeral state.
    ///
    /// Falls back to `State::new()` if encoding itself is corrupted.
    fn normalize_sync_state(&mut self) {
        let encoded = self.sync_state.encode();
        self.sync_state = sync::State::decode(&encoded).unwrap_or_else(|_| sync::State::new());
    }

    /// Normalize the RuntimeStateDoc sync state (same pattern as notebook sync).
    fn normalize_state_sync_state(&mut self) {
        let encoded = self.state_sync_state.encode();
        self.state_sync_state =
            sync::State::decode(&encoded).unwrap_or_else(|_| sync::State::new());
    }

    /// Normalize the CommsDoc sync state (same pattern as notebook sync).
    fn normalize_comms_sync_state(&mut self) {
        let encoded = self.comms_sync_state.encode();
        self.comms_sync_state =
            sync::State::decode(&encoded).unwrap_or_else(|_| sync::State::new());
    }

    /// Normalize the CommentsDoc sync state (same pattern as notebook sync).
    fn normalize_comments_sync_state(&mut self) {
        let encoded = self.comments_sync_state.encode();
        self.comments_sync_state =
            sync::State::decode(&encoded).unwrap_or_else(|_| sync::State::new());
    }

    /// Rebuild the notebook doc via save→load to clear corrupted internal indices.
    ///
    /// Delegates to `NotebookDoc::rebuild_from_save`, which preserves the actor
    /// and refuses cell-losing rebuilds.
    fn rebuild_doc(&mut self) {
        let _ = self.doc.rebuild_from_save();
    }

    /// Rebuild the PoolDoc via save→load.
    ///
    /// PoolDoc has no crate-level `rebuild_from_save`, so preserves the actor manually.
    fn rebuild_pool_doc(&mut self) {
        let actor = self.pool_doc.doc_mut().get_actor().clone();
        let bytes = self.pool_doc.doc_mut().save();
        if let Ok(mut doc) = automerge::AutoCommit::load(&bytes) {
            doc.set_actor(actor);
            *self.pool_doc.doc_mut() = doc;
        }
    }

    /// Rebuild the CommsDoc via save→load.
    ///
    /// Delegates to `CommsDoc::rebuild_from_save`, which preserves the actor.
    fn rebuild_comms_doc(&mut self) {
        let _ = self.comms_doc.rebuild_from_save();
    }

    /// Rebuild the CommentsDoc via save→load.
    ///
    /// Delegates to `CommentsDoc::rebuild_from_save`, which preserves the actor
    /// and required comments document identity.
    fn rebuild_comments_doc(&mut self) {
        if let Some(comments_doc) = self.comments_doc.as_mut() {
            let _ = comments_doc.rebuild_from_save();
        }
    }

    fn comments_doc_mut(&mut self) -> Result<&mut CommentsDoc, JsError> {
        self.comments_doc
            .as_mut()
            .ok_or_else(|| JsError::new("CommentsDoc is not initialized"))
    }

    fn comments_projection(&mut self) -> Result<CommentsProjection, JsError> {
        let cell_order: Vec<String> = self
            .doc
            .get_cells()
            .into_iter()
            .map(|cell| cell.id)
            .collect();
        self.comments_doc
            .as_ref()
            .ok_or_else(|| JsError::new("CommentsDoc is not initialized"))?
            .read_projection(Some(&cell_order))
            .map_err(|e| JsError::new(&format!("read comments projection: {e}")))
    }

    fn serialize_comments_projection_event(&mut self) -> Result<JsValue, JsError> {
        let event = FrameEvent::CommentsDocSyncApplied {
            changed: true,
            projection: Some(Box::new(self.comments_projection()?)),
        };
        serialize_to_js(&event)
            .map_err(|e| JsError::new(&format!("serialize comments projection event: {e}")))
    }

    /// Normalize pool sync state via encode→decode round-trip.
    fn normalize_pool_sync_state(&mut self) {
        let encoded = self.pool_sync_state.encode();
        self.pool_sync_state = sync::State::decode(&encoded).unwrap_or_else(|_| sync::State::new());
    }

    /// Rebuild the RuntimeStateDoc via save→load.
    ///
    /// Delegates to `RuntimeStateDoc::rebuild_from_save`, which preserves the actor.
    fn rebuild_state_doc(&mut self) {
        let _ = self.state_doc.rebuild_from_save();
        self.bump_output_identity_epoch();
    }

    /// Receive a typed frame from the daemon, demux by type byte, return events for the frontend.
    ///
    /// The input is the raw frame bytes from the host transport:
    /// `[frame_type_byte, ...payload]`.
    ///
    /// Returns a JS array of `FrameEvent` objects directly via `serde-wasm-bindgen`
    /// (no JSON string intermediate). Sync frames return a single `sync_applied`
    /// event with an optional `CellChangeset` and an optional `reply`.
    ///
    /// **Sync replies are generated atomically** within this method after applying
    /// each inbound `AUTOMERGE_SYNC` frame. The reply bytes (if any) are returned
    /// in `FrameEvent::SyncApplied.reply` — the caller should send them immediately
    /// via `sendFrame(0x00, reply)`. This eliminates the consumption race from #1067
    /// where a separate `generate_sync_reply()` call could be preempted by
    /// `flushSync`'s `generate_sync_message()`, both competing on the same
    /// `sync_state`.
    ///
    /// Returns `undefined` if the frame is empty or cannot be processed.
    pub fn receive_frame(&mut self, frame_bytes: &[u8]) -> JsValue {
        if frame_bytes.is_empty() {
            return JsValue::UNDEFINED;
        }

        let frame_type = frame_bytes[0];
        let payload = &frame_bytes[1..];

        let mut events: Vec<FrameEvent> = Vec::new();

        match frame_type {
            frame_types::AUTOMERGE_SYNC => {
                // Decode and apply the sync message to our local doc
                let Ok(msg) = sync::Message::decode(payload) else {
                    return JsValue::UNDEFINED;
                };
                let heads_before = self.doc.doc_mut().get_heads();
                if self
                    .doc
                    .receive_sync_message(&mut self.sync_state, msg)
                    .is_err()
                {
                    // Recovery: rebuild doc indices via save→load, then
                    // normalize sync state via encode→decode round-trip
                    // (preserves shared_heads, clears transient state).
                    // Finally generate a fresh sync message to restart
                    // negotiation with the daemon.
                    self.rebuild_doc();
                    self.normalize_sync_state();
                    // Check if the doc advanced before the error (partial apply).
                    // If so, the UI needs a full materialization to reflect the
                    // recovered state — otherwise it can stay stuck or stale.
                    let heads_after = self.doc.doc_mut().get_heads();
                    let changed = heads_before != heads_after;
                    if changed {
                        self.metadata_fingerprint_cache = None;
                    }
                    let reply = self
                        .doc
                        .generate_sync_message(&mut self.sync_state)
                        .map(|msg| msg.encode());
                    events.push(FrameEvent::SyncError { changed, reply });
                    return serialize_to_js(&events).unwrap_or(JsValue::UNDEFINED);
                }
                let heads_after = self.doc.doc_mut().get_heads();
                let changed = heads_before != heads_after;

                let (changeset, attributions) = if changed {
                    // One doc.diff() walk covers cells + metadata + text patches.
                    let doc_changeset = diff_doc(self.doc.doc_mut(), &heads_before, &heads_after);
                    // Invalidate the fingerprint cache only when the notebook
                    // metadata actually moved — cell source edits and output
                    // streaming no longer bust the cache.
                    if doc_changeset.metadata_changed {
                        self.metadata_fingerprint_cache = None;
                    }
                    let attrs = build_text_attributions(
                        self.doc.doc_mut(),
                        &heads_before,
                        &doc_changeset.text_patches,
                    );
                    (Some(doc_changeset.cells), attrs)
                } else {
                    (None, Vec::new())
                };

                // Generate sync reply atomically — within the same &mut self
                // borrow as receive_sync_message. This eliminates the race from
                // #1067 where a separate generate_sync_reply() call could be
                // preempted by flushSync's generate_sync_message().
                let reply = self
                    .doc
                    .generate_sync_message(&mut self.sync_state)
                    .map(|msg| msg.encode());

                let execution_view_changeset = if changed {
                    let state = self.state_doc.read_state();
                    self.execution_view_projector
                        .project_all(notebook_execution_pointers(&self.doc), &state)
                } else {
                    ExecutionViewChangeset::default()
                };

                events.push(FrameEvent::SyncApplied {
                    changed,
                    changeset,
                    attributions,
                    reply,
                    execution_view_changeset,
                });
            }
            frame_types::BROADCAST => {
                // Parse JSON broadcast payload
                let value = match serde_json::from_slice::<serde_json::Value>(payload) {
                    Ok(v) => v,
                    Err(e) => {
                        web_sys::console::warn_1(
                            &format!("[wasm] broadcast frame parse failed: {e}").into(),
                        );
                        return JsValue::UNDEFINED;
                    }
                };
                events.push(FrameEvent::Broadcast { payload: value });
            }
            frame_types::PRESENCE => {
                // Decode CBOR presence and convert to JSON value for the frontend
                let msg = match presence::decode_message(payload) {
                    Ok(m) => m,
                    Err(e) => {
                        web_sys::console::warn_1(
                            &format!("[wasm] presence frame decode failed: {e}").into(),
                        );
                        return JsValue::UNDEFINED;
                    }
                };
                let value = match serde_json::to_value(&msg) {
                    Ok(v) => v,
                    Err(e) => {
                        web_sys::console::warn_1(
                            &format!("[wasm] presence frame serialize failed: {e}").into(),
                        );
                        return JsValue::UNDEFINED;
                    }
                };
                events.push(FrameEvent::Presence { payload: value });
            }
            frame_types::SESSION_CONTROL => {
                let msg = match serde_json::from_slice::<SessionControlMessage>(payload) {
                    Ok(m) => m,
                    Err(e) => {
                        web_sys::console::warn_1(
                            &format!("[wasm] session_control frame parse failed: {e}").into(),
                        );
                        return JsValue::UNDEFINED;
                    }
                };
                match msg {
                    SessionControlMessage::SyncStatus(status) => {
                        events.push(FrameEvent::SessionControl { status });
                    }
                }
            }
            frame_types::RUNTIME_STATE_SYNC => {
                // Apply a server-authored RuntimeStateDoc sync message to our local replica.
                // We use the raw Automerge sync (no change stripping) because the
                // browser WASM peer is a read-only RuntimeStateDoc consumer. The
                // host applies write policy on inbound client/runtime-peer frames.
                let Ok(msg) = sync::Message::decode(payload) else {
                    return JsValue::UNDEFINED;
                };
                let heads_before = self.state_doc.doc_mut().get_heads();
                if self
                    .state_doc
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut self.state_sync_state, msg)
                    .is_err()
                {
                    // Recovery: rebuild state doc + normalize sync state,
                    // then generate a fresh sync message. Include the
                    // recovered state snapshot so the UI stays current.
                    self.rebuild_state_doc();
                    self.normalize_state_sync_state();
                    let heads_after = self.state_doc.doc_mut().get_heads();
                    let changed = heads_before != heads_after;
                    let state = if changed {
                        Some(Box::new(self.state_doc.read_state()))
                    } else {
                        None
                    };
                    let execution_view_changeset = state
                        .as_ref()
                        .map(|state| self.execution_view_projector.project_runtime(state))
                        .unwrap_or_default();
                    let reply = self
                        .state_doc
                        .doc_mut()
                        .sync()
                        .generate_sync_message(&mut self.state_sync_state)
                        .map(|msg| msg.encode());
                    events.push(FrameEvent::RuntimeStateSyncError {
                        changed,
                        state,
                        reply,
                        execution_view_changeset,
                    });
                    return serialize_to_js(&events).unwrap_or(JsValue::UNDEFINED);
                }
                let heads_after = self.state_doc.doc_mut().get_heads();
                let changed = heads_before != heads_after;

                let state = if changed {
                    Some(Box::new(self.state_doc.read_state()))
                } else {
                    None
                };

                let output_changeset = if let Some(current_state) = state.as_ref() {
                    self.build_output_changeset(current_state)
                } else {
                    OutputChangeset::default()
                };

                let execution_view_changeset = state
                    .as_ref()
                    .map(|state| self.execution_view_projector.project_runtime(state))
                    .unwrap_or_default();

                events.push(FrameEvent::RuntimeStateSyncApplied {
                    changed,
                    state,
                    output_changeset,
                    execution_view_changeset,
                });
            }
            frame_types::COMMS_DOC_SYNC => {
                let Ok(msg) = sync::Message::decode(payload) else {
                    return JsValue::UNDEFINED;
                };
                let heads_before = self.comms_doc.doc_mut().get_heads();
                if self
                    .comms_doc
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut self.comms_sync_state, msg)
                    .is_err()
                {
                    self.rebuild_comms_doc();
                    self.normalize_comms_sync_state();
                    let heads_after = self.comms_doc.doc_mut().get_heads();
                    let changed = heads_before != heads_after;
                    let state = if changed {
                        Some(Box::new(self.comms_doc.read_state()))
                    } else {
                        None
                    };
                    let reply = self
                        .comms_doc
                        .doc_mut()
                        .sync()
                        .generate_sync_message(&mut self.comms_sync_state)
                        .map(|msg| msg.encode());
                    events.push(FrameEvent::CommsDocSyncError {
                        changed,
                        state,
                        reply,
                    });
                    return serialize_to_js(&events).unwrap_or(JsValue::UNDEFINED);
                }
                let heads_after = self.comms_doc.doc_mut().get_heads();
                let changed = heads_before != heads_after;
                let state = if changed {
                    Some(Box::new(self.comms_doc.read_state()))
                } else {
                    None
                };

                events.push(FrameEvent::CommsDocSyncApplied { changed, state });
            }
            frame_types::COMMENTS_DOC_SYNC => {
                let Ok(msg) = sync::Message::decode(payload) else {
                    return JsValue::UNDEFINED;
                };
                let expected_comments_identity = self.expected_comments_identity();
                let Some(comments_doc) = self.comments_doc.as_mut() else {
                    web_sys::console::warn_1(
                        &"[wasm] comments sync received before comments doc initialization".into(),
                    );
                    return JsValue::UNDEFINED;
                };
                let heads_before = comments_doc.get_heads();
                let receive_result = match expected_comments_identity {
                    Some((comments_doc_id, notebook_ref)) => comments_doc
                        .receive_sync_message_with_changes_repairing_identity_recovering(
                            &mut self.comments_sync_state,
                            msg,
                            &comments_doc_id,
                            &notebook_ref,
                            "wasm-comments-receive-sync",
                        ),
                    None => {
                        web_sys::console::warn_1(
                            &"[wasm] comments sync received without expected comments identity; skipping identity repair".into(),
                        );
                        comments_doc
                            .receive_sync_message_with_changes(&mut self.comments_sync_state, msg)
                            .map(|changed| CommentsDocReceiveRepairResult {
                                changed,
                                repaired_identity: false,
                                incoming_actor_labels: Vec::new(),
                            })
                    }
                };
                let receive_result = match receive_result {
                    Ok(result) => result,
                    Err(_) => {
                        self.rebuild_comments_doc();
                        self.normalize_comments_sync_state();
                        let heads_after = self
                            .comments_doc
                            .as_mut()
                            .map(CommentsDoc::get_heads)
                            .unwrap_or_default();
                        let changed = heads_before != heads_after;
                        let projection = if changed {
                            self.comments_projection().ok().map(Box::new)
                        } else {
                            None
                        };
                        let reply = self.comments_doc.as_mut().and_then(|comments_doc| {
                            comments_doc
                                .generate_sync_message(&mut self.comments_sync_state)
                                .map(|msg| msg.encode())
                        });
                        events.push(FrameEvent::CommentsDocSyncError {
                            changed,
                            projection,
                            reply,
                        });
                        return serialize_to_js(&events).unwrap_or(JsValue::UNDEFINED);
                    }
                };
                let changed = receive_result.changed;
                let projection = if changed {
                    self.comments_projection().ok().map(Box::new)
                } else {
                    None
                };

                events.push(FrameEvent::CommentsDocSyncApplied {
                    changed,
                    projection,
                });
            }
            frame_types::POOL_STATE_SYNC => {
                // Apply daemon's PoolDoc sync message to our local replica.
                let Ok(msg) = sync::Message::decode(payload) else {
                    return JsValue::UNDEFINED;
                };
                let heads_before = self.pool_doc.doc_mut().get_heads();
                if self
                    .pool_doc
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut self.pool_sync_state, msg)
                    .is_err()
                {
                    self.rebuild_pool_doc();
                    self.normalize_pool_sync_state();
                    let heads_after = self.pool_doc.doc_mut().get_heads();
                    let changed = heads_before != heads_after;
                    let state = if changed {
                        Some(Box::new(self.pool_doc.read_state()))
                    } else {
                        None
                    };
                    let reply = self
                        .pool_doc
                        .doc_mut()
                        .sync()
                        .generate_sync_message(&mut self.pool_sync_state)
                        .map(|msg| msg.encode());
                    events.push(FrameEvent::PoolStateSyncError {
                        changed,
                        state,
                        reply,
                    });
                    return serialize_to_js(&events).unwrap_or(JsValue::UNDEFINED);
                }
                let heads_after = self.pool_doc.doc_mut().get_heads();
                let changed = heads_before != heads_after;

                let state = if changed {
                    Some(Box::new(self.pool_doc.read_state()))
                } else {
                    None
                };

                events.push(FrameEvent::PoolStateSyncApplied { changed, state });
            }
            _ => {
                events.push(FrameEvent::Unknown { frame_type });
            }
        }

        serialize_to_js(&events).unwrap_or(JsValue::UNDEFINED)
    }
}

/// Parse hex change hashes (the `get_heads_hex()` format) into
/// `ChangeHash`es, naming the offending value on failure.
fn parse_heads_hex(heads_hex: &[String]) -> Result<Vec<automerge::ChangeHash>, String> {
    heads_hex
        .iter()
        .map(|head| {
            head.parse::<automerge::ChangeHash>()
                .map_err(|e| format!("invalid change hash {head:?}: {e}"))
        })
        .collect()
}

// ── Attribution extraction ───────────────────────────────────────────

/// Combine raw text patches with actor attribution to produce
/// `TextAttribution` ranges for the frontend.
///
/// The text patches come from a single `diff_doc` walk, so this function
/// only does the actor-extraction query (`get_changes`) and zips the two
/// streams together. `diff()` no longer runs here — the caller already
/// paid for that walk.
fn build_text_attributions(
    doc: &mut automerge::AutoCommit,
    before: &[automerge::ChangeHash],
    text_patches: &[TextPatch],
) -> Vec<TextAttribution> {
    if text_patches.is_empty() {
        return Vec::new();
    }

    use std::collections::BTreeSet;
    let new_changes = doc.get_changes(before);
    let actors: Vec<String> = new_changes
        .iter()
        .map(|c| notebook_doc::actor_label_from_id(c.actor_id()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    if actors.is_empty() {
        return Vec::new();
    }

    text_patches
        .iter()
        .map(|tp| TextAttribution {
            cell_id: tp.cell_id.clone(),
            index: tp.index,
            text: tp.text.clone(),
            deleted: tp.deleted,
            actors: actors.clone(),
        })
        .collect()
}

// ── Presence encoding (free functions for wasm_bindgen export) ────────

/// Encode a cursor position as a presence frame payload (CBOR).
///
/// The frontend should prepend the frame type byte (0x04) and send
/// via `invoke("send_frame", { frameData })`.
///
/// `peer_label` is the human-readable name shown in cursor flags
/// (e.g. the OS username). Pass an empty string to omit.
#[wasm_bindgen]
pub fn encode_cursor_presence(
    peer_id: &str,
    peer_label: &str,
    actor_label: &str,
    cell_id: &str,
    line: u32,
    column: u32,
) -> Result<Vec<u8>, JsError> {
    let label = if peer_label.is_empty() {
        None
    } else {
        Some(peer_label)
    };
    let actor = if actor_label.is_empty() {
        None
    } else {
        Some(actor_label)
    };
    presence::encode_cursor_update_labeled(
        peer_id,
        label,
        actor,
        &presence::CursorPosition {
            cell_id: cell_id.to_string(),
            line,
            column,
        },
    )
    .map_err(|e| JsError::new(&e.to_string()))
}

/// Encode a selection range as a presence frame payload (CBOR).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn encode_selection_presence(
    peer_id: &str,
    peer_label: &str,
    actor_label: &str,
    cell_id: &str,
    anchor_line: u32,
    anchor_col: u32,
    head_line: u32,
    head_col: u32,
) -> Result<Vec<u8>, JsError> {
    let label = if peer_label.is_empty() {
        None
    } else {
        Some(peer_label)
    };
    let actor = if actor_label.is_empty() {
        None
    } else {
        Some(actor_label)
    };
    presence::encode_selection_update_labeled(
        peer_id,
        label,
        actor,
        &presence::SelectionRange {
            cell_id: cell_id.to_string(),
            anchor_line,
            anchor_col,
            head_line,
            head_col,
        },
    )
    .map_err(|e| JsError::new(&e.to_string()))
}

/// Encode a cell focus as a presence frame payload (CBOR).
/// Focus means "I'm on this cell" without an editor cursor position.
#[wasm_bindgen]
pub fn encode_focus_presence(
    peer_id: &str,
    peer_label: &str,
    actor_label: &str,
    cell_id: &str,
) -> Result<Vec<u8>, JsError> {
    let label = if peer_label.is_empty() {
        None
    } else {
        Some(peer_label)
    };
    let actor = if actor_label.is_empty() {
        None
    } else {
        Some(actor_label)
    };
    presence::encode_focus_update_labeled(peer_id, label, actor, cell_id)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Encode a notebook interaction target as a presence frame payload (CBOR).
///
/// The `target` object uses the same shape as decoded presence messages:
/// `{ kind: "cell", cell_id }`, `{ kind: "editor", cell_id }`,
/// `{ kind: "markdown_anchor", cell_id, anchor_id }`, or
/// `{ kind: "output", cell_id, output_id? }`.
#[wasm_bindgen]
pub fn encode_interaction_presence(
    peer_id: &str,
    peer_label: &str,
    actor_label: &str,
    target: JsValue,
) -> Result<Vec<u8>, JsError> {
    let label = if peer_label.is_empty() {
        None
    } else {
        Some(peer_label)
    };
    let actor = if actor_label.is_empty() {
        None
    } else {
        Some(actor_label)
    };
    let target: presence::InteractionTarget =
        serde_wasm_bindgen::from_value(target).map_err(|e| JsError::new(&e.to_string()))?;
    presence::encode_interaction_update_labeled(peer_id, label, actor, &target)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Encode a heartbeat as a presence frame payload (CBOR).
///
/// The desktop client sends these on a fixed interval so the daemon's
/// idle-peer timeout (which only resets on Request and Presence frames)
/// does not fire on a quiet but live notebook window.
#[wasm_bindgen]
pub fn encode_heartbeat_presence(peer_id: &str) -> Result<Vec<u8>, JsError> {
    presence::encode_heartbeat(peer_id).map_err(|e| JsError::new(&e.to_string()))
}

/// Encode a clear-channel message as a presence frame payload (CBOR).
/// Removes a single presence channel (e.g. cursor or selection) for this peer.
#[wasm_bindgen]
pub fn encode_clear_channel_presence(peer_id: &str, channel: &str) -> Result<Vec<u8>, JsError> {
    let ch = match channel {
        "cursor" => presence::Channel::Cursor,
        "selection" => presence::Channel::Selection,
        "focus" => presence::Channel::Focus,
        "interaction" => presence::Channel::Interaction,
        other => return Err(JsError::new(&format!("unknown presence channel: {other}"))),
    };
    presence::encode_clear_channel(peer_id, ch).map_err(|e| JsError::new(&e.to_string()))
}

/// Decode a presence frame payload from CBOR into a JS object.
///
/// This is intentionally standalone from `NotebookHandle.receive_frame()` so
/// Worker and test harness code can inspect real presence bytes without owning
/// a notebook document replica.
#[wasm_bindgen]
pub fn decode_presence_frame(payload: &[u8]) -> Result<JsValue, JsError> {
    let message = presence::decode_message(payload).map_err(|e| JsError::new(&e.to_string()))?;
    serialize_to_js(&message).map_err(|e| JsError::new(&e.to_string()))
}

/// Encode a JS presence message object into the canonical CBOR frame payload.
///
/// The object shape is the same as `decode_presence_frame()` returns:
/// `{ type: "update", peer_id, channel, data, ... }`, `{ type: "heartbeat",
/// peer_id }`, etc.
#[wasm_bindgen]
pub fn encode_presence_frame(message: JsValue) -> Result<Vec<u8>, JsError> {
    let message: presence::PresenceMessage =
        serde_wasm_bindgen::from_value(message).map_err(|e| JsError::new(&e.to_string()))?;
    presence::encode_message(&message).map_err(|e| JsError::new(&e.to_string()))
}

/// Rewrite client-authored presence for trusted server ingress.
///
/// Room hosts should authenticate the connection first, then use this helper
/// before relaying a client presence payload. It decodes canonical CBOR,
/// overwrites the peer id, rewrites update actor labels to the authenticated
/// principal while preserving the presented operator suffix, and re-encodes
/// canonical CBOR. Malformed or missing actor labels use `fallback_operator`.
/// Pass an empty `peer_label` to omit display text from rewritten updates.
/// The operator suffix is self-declared attribution metadata only; authorization
/// must use the authenticated principal and connection scope.
#[wasm_bindgen]
pub fn rewrite_presence_ingress(
    payload: &[u8],
    peer_id: &str,
    peer_label: &str,
    principal: &str,
    fallback_operator: &str,
) -> Result<Vec<u8>, JsError> {
    let principal =
        Principal::new(principal.to_string()).map_err(|e| JsError::new(&e.to_string()))?;
    let fallback_operator =
        Operator::new(fallback_operator.to_string()).map_err(|e| JsError::new(&e.to_string()))?;
    let message = presence::decode_message(payload).map_err(|e| JsError::new(&e.to_string()))?;
    let peer_label = if peer_label.is_empty() {
        None
    } else {
        Some(peer_label.to_string())
    };

    let rewritten = match message {
        presence::PresenceMessage::Update {
            peer_id: _,
            peer_label: _,
            actor_label,
            data,
        } => {
            let data = match data {
                client_data @ (presence::ChannelData::Cursor(_)
                | presence::ChannelData::Selection(_)
                | presence::ChannelData::Focus(_)
                | presence::ChannelData::Interaction(_)
                | presence::ChannelData::Custom(_)) => client_data,
                presence::ChannelData::KernelState(_) => {
                    return Err(JsError::new(
                        "client presence updates cannot publish kernel state",
                    ));
                }
            };
            let operator = actor_label
                .as_deref()
                .and_then(|label| Operator::from_actor_label_or_operator(label).ok())
                .unwrap_or(fallback_operator);
            let actor_label = ActorLabel::new(principal, operator);
            presence::PresenceMessage::Update {
                peer_id: peer_id.to_string(),
                peer_label,
                actor_label: Some(actor_label.as_str().to_string()),
                data,
            }
        }
        presence::PresenceMessage::Heartbeat { .. } => presence::PresenceMessage::Heartbeat {
            peer_id: peer_id.to_string(),
        },
        presence::PresenceMessage::ClearChannel { channel, .. } => {
            presence::PresenceMessage::ClearChannel {
                peer_id: peer_id.to_string(),
                channel,
            }
        }
        presence::PresenceMessage::Left { .. } => presence::PresenceMessage::Left {
            peer_id: peer_id.to_string(),
        },
        presence::PresenceMessage::Snapshot { .. } => {
            return Err(JsError::new(
                "client presence ingress cannot publish snapshots",
            ));
        }
    };

    presence::encode_message(&rewritten).map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolve(val: serde_json::Value) -> (serde_json::Value, Vec<Vec<String>>, Vec<Vec<String>>) {
        resolve_comm_state_for_frontend(&val, 1234, false)
    }

    fn resolve_output_model(
        val: serde_json::Value,
    ) -> (serde_json::Value, Vec<Vec<String>>, Vec<Vec<String>>) {
        resolve_comm_state_for_frontend(&val, 1234, true)
    }

    #[test]
    fn comments_bootstrap_uses_daemon_provided_notebook_ref() {
        for (comments_doc_id, notebook_ref) in [
            (
                "comments:local-room:room-1",
                NotebookCommentRef::LocalRoom {
                    room_id: "room-1".to_string(),
                },
            ),
            (
                "comments:local-path:63bbd3f2251d51b5bde4331cdcd8a860e338635079eb34f9572bd7d039113550",
                NotebookCommentRef::LocalPath {
                    canonical_path: "/tmp/notebook.ipynb".to_string(),
                },
            ),
            (
                "comments:hosted-room-1",
                NotebookCommentRef::HostedRoom {
                    room_locator: "hosted-room-1".to_string(),
                },
            ),
        ] {
            let notebook_ref_json =
                serde_json::to_string(&notebook_ref).expect("serialize notebook ref");
            let handle = NotebookHandle::create_bootstrap_with_comments_ref(
                "user:dev:alice/browser:a",
                comments_doc_id,
                &notebook_ref_json,
            )
            .expect("create comments bootstrap handle");
            assert_eq!(
                handle.comments_doc.as_ref().and_then(CommentsDoc::notebook_ref),
                Some(notebook_ref)
            );
        }
    }

    #[test]
    fn comments_sync_repairs_with_bootstrap_identity_not_stale_doc_identity() {
        let expected_comments_doc_id = hosted_comments_doc_id("demo");
        let expected_ref = NotebookCommentRef::HostedRoom {
            room_locator: "demo".to_string(),
        };
        let expected_ref_json =
            serde_json::to_string(&expected_ref).expect("serialize expected ref");
        let mut handle = NotebookHandle::create_bootstrap_with_comments_ref(
            "user:dev:alice/browser:a",
            &expected_comments_doc_id,
            &expected_ref_json,
        )
        .expect("create comments bootstrap handle");

        let stale_ref = NotebookCommentRef::HostedRoom {
            room_locator: "stale-demo".to_string(),
        };
        handle.comments_doc = Some(CommentsDoc::new_with_actor(
            "comments:stale-demo",
            &stale_ref,
            "user:dev:alice/browser:a",
        ));
        let mut sender = CommentsDoc::new_with_actor(
            "comments:stale-demo",
            &stale_ref,
            "system/schema:notebook-cloud-room",
        );
        sender
            .create_thread(
                "thread-stale",
                "message-stale",
                &comments_doc::CommentAnchor::Notebook,
                "stale identity should be repaired by the browser handle",
                None,
                "2026-06-28T00:00:00Z",
            )
            .expect("create stale-id comment");

        let changes = sender.doc_mut().save_after(&[]);
        assert!(!changes.is_empty(), "expected stale-id sender changes");
        let message = sync::Message {
            heads: sender.get_heads(),
            need: Vec::new(),
            have: Vec::new(),
            changes: sync::ChunkList::from(changes),
            flags: None,
            version: sync::MessageVersion::V1,
        };
        let (comments_doc_id, notebook_ref) = handle
            .expected_comments_identity()
            .expect("cached comments identity");
        let comments_doc = handle.comments_doc.as_mut().expect("comments doc");
        let result = comments_doc
            .receive_sync_message_with_changes_repairing_identity_recovering(
                &mut handle.comments_sync_state,
                message,
                &comments_doc_id,
                &notebook_ref,
                "test-comments-receive-sync",
            )
            .expect("stale identity repaired from bootstrap identity");
        assert!(result.changed);
        assert!(result.repaired_identity);
        assert_eq!(
            comments_doc.raw_comments_doc_id().as_deref(),
            Some(expected_comments_doc_id.as_str())
        );
        assert_eq!(comments_doc.notebook_ref().as_ref(), Some(&expected_ref));
        let projection = comments_doc
            .read_projection(None)
            .expect("comments projection");
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(projection.threads[0].id, "thread-stale");
    }

    #[test]
    fn room_host_seeds_initial_code_cell_idempotently() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        assert!(host.doc.is_pristine(), "a brand-new room host is pristine");
        assert_eq!(host.doc.cell_count(), 0);

        let seeded = host
            .seed_initial_code_cell_if_empty("cell-initial")
            .expect("seed initial cell");
        assert!(seeded);
        assert_eq!(host.doc.cell_count(), 1);
        assert_eq!(
            host.doc.get_cell_type("cell-initial").as_deref(),
            Some("code")
        );

        let seeded_again = host
            .seed_initial_code_cell_if_empty("cell-second")
            .expect("skip second seed");
        assert!(!seeded_again);
        assert_eq!(host.doc.cell_count(), 1);
        assert!(host.doc.get_cell("cell-second").is_none());
    }

    #[test]
    fn room_host_accepts_editor_comments_doc_change_fans_out_and_persists() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut editor = hosted_comments_client("demo", "user:dev:alice/browser:a");
        let mut editor_state = sync::State::new();
        let mut viewer = hosted_comments_client("demo", "user:dev:bob/browser:b");
        let mut viewer_state = sync::State::new();

        sync_comments_doc_with_host(
            &mut host,
            "peer-editor",
            "user:dev:alice",
            true,
            &mut editor,
            &mut editor_state,
        );
        sync_comments_doc_with_host(
            &mut host,
            "peer-viewer",
            "user:dev:bob",
            true,
            &mut viewer,
            &mut viewer_state,
        );

        editor
            .create_thread(
                "thread-1",
                "message-1",
                &comments_doc::CommentAnchor::Notebook,
                "ship the comments path",
                None,
                "2026-06-18T00:00:00Z",
            )
            .expect("create comment");

        let accepted = apply_comments_client_change_to_host(
            &mut host,
            "peer-editor",
            "user:dev:alice",
            true,
            &mut editor,
            &mut editor_state,
        )
        .expect("editor comment accepted");
        assert!(accepted.changed);
        assert!(accepted.outbound.iter().any(|frame| {
            frame.peer_id == "peer-viewer" && frame.frame_type == frame_types::COMMENTS_DOC_SYNC
        }));

        apply_comments_outbound_to_client(
            &accepted.outbound,
            "peer-viewer",
            &mut viewer,
            &mut viewer_state,
        );
        let viewer_projection = viewer.read_projection(None).expect("viewer projection");
        assert_eq!(viewer_projection.threads.len(), 1);
        assert_eq!(
            viewer_projection.threads[0]
                .created_by_actor_label
                .as_deref(),
            Some("user:dev:alice/browser:a")
        );
        assert_eq!(
            viewer_projection.threads[0].messages[0].body,
            "ship the comments path"
        );

        let saved = host.save_comments_doc();
        let mut reloaded =
            RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
                .expect("create reloaded room host");
        reloaded
            .load_comments_doc(&saved)
            .expect("load saved comments doc");
        let projection = reloaded
            .comments_doc
            .read_projection(None)
            .expect("reloaded projection");
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(projection.threads[0].id, "thread-1");
    }

    #[test]
    fn room_host_repairs_stale_comments_doc_identity_from_editor_change() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let stale_ref = NotebookCommentRef::HostedRoom {
            room_locator: "stale-demo".to_string(),
        };
        let mut editor = CommentsDoc::new_with_actor(
            "comments:stale-demo",
            &stale_ref,
            "user:dev:alice/browser:a",
        );
        editor
            .create_thread(
                "thread-stale",
                "message-stale",
                &comments_doc::CommentAnchor::Notebook,
                "stale identity should be repaired by the room host",
                None,
                "2026-06-28T00:00:00Z",
            )
            .expect("create stale-id comment");

        let changes = editor.doc_mut().save_after(&[]);
        assert!(!changes.is_empty(), "expected stale-id editor changes");
        let payload = sync::Message {
            heads: editor.get_heads(),
            need: Vec::new(),
            have: Vec::new(),
            changes: sync::ChunkList::from(changes),
            flags: None,
            version: sync::MessageVersion::V1,
        }
        .encode();
        let accepted = host
            .receive_comments_doc_sync_inner("peer-editor", "user:dev:alice", true, &payload)
            .expect("editor comment accepted with repaired identity");
        let expected_comments_doc_id = hosted_comments_doc_id("demo");

        assert!(accepted.changed);
        assert_eq!(
            host.comments_doc.raw_comments_doc_id().as_deref(),
            Some(expected_comments_doc_id.as_str())
        );
        assert_eq!(
            host.comments_doc.notebook_ref().as_ref(),
            Some(&NotebookCommentRef::HostedRoom {
                room_locator: "demo".to_string(),
            })
        );
        let projection = host
            .comments_doc
            .read_projection(None)
            .expect("host projection");
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(projection.threads[0].id, "thread-stale");
        assert_eq!(
            projection.threads[0].created_by_actor_label.as_deref(),
            Some("user:dev:alice/browser:a")
        );
    }

    #[test]
    fn room_host_rejects_forged_comments_doc_change_without_applying() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut forged = comments_doc_from_host(&mut host, "user:dev:mallory/browser:m");
        let mut forged_state = sync::State::new();
        sync_comments_doc_with_host(
            &mut host,
            "peer-alice",
            "user:dev:alice",
            true,
            &mut forged,
            &mut forged_state,
        );
        forged
            .create_thread(
                "thread-forged",
                "message-forged",
                &comments_doc::CommentAnchor::Notebook,
                "not alice",
                None,
                "2026-06-18T00:00:00Z",
            )
            .expect("create forged comment");

        let error = apply_comments_client_change_to_host(
            &mut host,
            "peer-alice",
            "user:dev:alice",
            true,
            &mut forged,
            &mut forged_state,
        )
        .expect_err("forged actor should be rejected");
        let error_text = format!("{error:?}");
        assert!(
            error_text.contains("authenticated principal user:dev:alice"),
            "unexpected error: {error:?}"
        );
        assert!(host
            .comments_doc
            .read_projection(None)
            .expect("host projection")
            .threads
            .is_empty());
    }

    #[test]
    fn room_host_rejects_mixed_author_comments_doc_payload_wholesale() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut mixed = comments_doc_from_host(&mut host, "user:dev:alice/browser:a");
        let mut mixed_state = sync::State::new();
        sync_comments_doc_with_host(
            &mut host,
            "peer-alice",
            "user:dev:alice",
            true,
            &mut mixed,
            &mut mixed_state,
        );
        mixed
            .create_thread(
                "thread-alice",
                "message-alice",
                &comments_doc::CommentAnchor::Notebook,
                "from alice",
                None,
                "2026-06-18T00:00:00Z",
            )
            .expect("create alice comment");
        mixed.doc_mut().set_actor(automerge::ActorId::from(
            "user:dev:mallory/browser:m".as_bytes(),
        ));
        mixed
            .create_thread(
                "thread-mallory",
                "message-mallory",
                &comments_doc::CommentAnchor::Notebook,
                "from mallory",
                None,
                "2026-06-18T00:00:01Z",
            )
            .expect("create mallory comment");

        let error = apply_comments_client_change_to_host(
            &mut host,
            "peer-alice",
            "user:dev:alice",
            true,
            &mut mixed,
            &mut mixed_state,
        )
        .expect_err("mixed actor payload should be rejected");
        let error_text = format!("{error:?}");
        assert!(
            error_text.contains("user:dev:mallory"),
            "unexpected error: {error:?}"
        );
        assert!(host
            .comments_doc
            .read_projection(None)
            .expect("host projection")
            .threads
            .is_empty());
    }

    #[test]
    fn room_host_rejects_viewer_comments_doc_change() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut viewer = comments_doc_from_host(&mut host, "user:dev:bob/browser:b");
        let heads_before = host.comments_doc.get_heads();
        viewer
            .create_thread(
                "thread-viewer",
                "message-viewer",
                &comments_doc::CommentAnchor::Notebook,
                "viewer cannot write",
                None,
                "2026-06-18T00:00:00Z",
            )
            .expect("create viewer comment");
        let payload = comments_change_payload(&mut viewer, &heads_before);
        let error = host
            .receive_comments_doc_sync_inner("peer-viewer", "user:dev:bob", false, &payload)
            .expect_err("viewer comment should be rejected");
        let error_text = format!("{error:?}");
        assert!(
            error_text.contains("cannot write CommentsDoc"),
            "unexpected error: {error:?}"
        );
        assert!(host
            .comments_doc
            .read_projection(None)
            .expect("host projection")
            .threads
            .is_empty());
    }

    #[test]
    fn room_host_rejects_runtime_peer_comments_doc_change() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut runtime_peer = comments_doc_from_host(&mut host, "user:dev:runtime/runtime:py");
        let mut runtime_state = sync::State::new();
        sync_comments_doc_with_host(
            &mut host,
            "peer-runtime",
            "user:dev:runtime",
            true,
            &mut runtime_peer,
            &mut runtime_state,
        );
        runtime_peer
            .create_thread(
                "thread-runtime",
                "message-runtime",
                &comments_doc::CommentAnchor::Notebook,
                "runtime peer cannot write",
                None,
                "2026-06-18T00:00:00Z",
            )
            .expect("create runtime peer comment");
        runtime_state = sync::State::new();

        let error = apply_comments_client_change_to_host(
            &mut host,
            "peer-runtime",
            "user:dev:runtime",
            false,
            &mut runtime_peer,
            &mut runtime_state,
        )
        .expect_err("runtime peer comment should be rejected");
        let error_text = format!("{error:?}");
        assert!(
            error_text.contains("cannot write CommentsDoc"),
            "unexpected error: {error:?}"
        );
        assert!(host
            .comments_doc
            .read_projection(None)
            .expect("host projection")
            .threads
            .is_empty());
    }

    #[test]
    fn room_host_rejects_comments_doc_checkpoint_with_wrong_id() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let wrong_ref = NotebookCommentRef::HostedRoom {
            room_locator: "other".to_string(),
        };
        let mut wrong_doc =
            CommentsDoc::new_with_actor("comments:other", &wrong_ref, "user:dev:alice/browser:a");
        let bytes = wrong_doc.save();

        let error = host
            .load_comments_doc_inner(&bytes)
            .expect_err("wrong comments_doc_id should be rejected");
        assert!(
            error.contains("comments_doc_id mismatch"),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn room_host_repairs_comments_doc_checkpoint_with_conflicting_identity() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let stale_ref = NotebookCommentRef::HostedRoom {
            room_locator: "stale-demo".to_string(),
        };
        let mut stale = CommentsDoc::new_with_actor(
            "comments:stale-demo",
            &stale_ref,
            "user:dev:alice/browser:a",
        );
        stale
            .create_thread(
                "thread-stale",
                "message-stale",
                &comments_doc::CommentAnchor::Notebook,
                "stale checkpoint identity should be repaired by load",
                None,
                "2026-06-28T00:00:00Z",
            )
            .expect("create stale-id comment");
        let mut checkpoint =
            hosted_comments_client("demo", "system/schema:notebook-cloud-room/comments");
        sync_comments_raw_without_projection_check(&mut stale, &mut checkpoint);
        let bytes = checkpoint.save();

        host.load_comments_doc_inner(&bytes)
            .expect("repair conflicting checkpoint identity");
        let expected_comments_doc_id = hosted_comments_doc_id("demo");

        assert_eq!(
            host.comments_doc.raw_comments_doc_id().as_deref(),
            Some(expected_comments_doc_id.as_str())
        );
        assert_eq!(
            host.comments_doc.notebook_ref().as_ref(),
            Some(&NotebookCommentRef::HostedRoom {
                room_locator: "demo".to_string(),
            })
        );
        let projection = host
            .comments_doc
            .read_projection(None)
            .expect("host projection");
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(projection.threads[0].id, "thread-stale");
    }

    // -- runtime_peer-gone reconciliation (Phase 3d watchdog core) --------

    use runtime_doc::KernelActivity;

    /// Build a host whose RuntimeStateDoc looks like a live runtime peer left
    /// mid-flight: kernel Running(Busy), one running + one queued execution.
    fn host_with_inflight_work() -> RoomHostHandle {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let sd = &mut host.state_doc;
        sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))
            .unwrap();
        sd.create_execution_with_source("exec-running", "x = 1", 0)
            .unwrap();
        sd.set_execution_running("exec-running").unwrap();
        sd.create_execution_with_source("exec-queued", "y = 2", 1)
            .unwrap();
        sd.set_queue(
            Some(&runtime_doc::QueueEntry {
                execution_id: "exec-running".into(),
            }),
            &[runtime_doc::QueueEntry {
                execution_id: "exec-queued".into(),
            }],
        )
        .unwrap();
        host
    }

    fn workstation_attachment_fixture() -> WorkstationAttachmentState {
        WorkstationAttachmentState {
            workstation_id: "runtime-peer".to_string(),
            display_name: "Attached workstation".to_string(),
            provider: "runtime_peer".to_string(),
            default_environment_label: "Current Python".to_string(),
            environment_policy: "runtime_peer".to_string(),
            status: "ready".to_string(),
            status_message: None,
            cpu_count: None,
            memory_bytes: None,
            accelerators: None,
            working_directory: None,
            updated_at: Some("2026-06-07T00:00:00.000Z".to_string()),
            runtime_session_id: Some("job-runtime".to_string()),
        }
    }

    fn hosted_comments_client(notebook_id: &str, actor_label: &str) -> CommentsDoc {
        let (comments_doc_id, notebook_ref) = hosted_comments_identity(notebook_id);
        CommentsDoc::new_with_actor(&comments_doc_id, &notebook_ref, actor_label)
    }

    fn comments_doc_from_host(host: &mut RoomHostHandle, actor_label: &str) -> CommentsDoc {
        let comments_doc_id = host
            .expected_comments_identity()
            .map(|(comments_doc_id, _)| comments_doc_id)
            .expect("host comments doc id");
        let bytes = host.save_comments_doc();
        CommentsDoc::load_with_actor(&bytes, &comments_doc_id, actor_label)
            .expect("load comments doc from host")
    }

    fn sync_comments_raw_without_projection_check(
        sender: &mut CommentsDoc,
        receiver: &mut CommentsDoc,
    ) {
        // Test-only helper for constructing invalid/conflicted snapshots that
        // production projection reads would reject before load repair can run.
        let mut sender_sync = sync::State::new();
        let mut receiver_sync = sync::State::new();
        let mut receives = 0;
        for _ in 0..8 {
            if let Some(message) = sender.generate_sync_message(&mut sender_sync) {
                receiver
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut receiver_sync, message)
                    .expect("raw comments sync receiver apply");
                receives += 1;
            }
            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                sender
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut sender_sync, reply)
                    .expect("raw comments sync sender apply");
                receives += 1;
            }
        }
        assert!(receives > 0, "expected raw comments sync to apply messages");
    }

    fn sync_comments_doc_with_host(
        host: &mut RoomHostHandle,
        peer_id: &str,
        principal: &str,
        can_write: bool,
        client: &mut CommentsDoc,
        client_state: &mut sync::State,
    ) {
        let mut outbound = Vec::new();
        host.queue_comments_doc_sync_for_peer(peer_id, can_write, &mut outbound)
            .expect("queue comments sync");
        for _ in 0..8 {
            let replies =
                apply_comments_outbound_to_client(&outbound, peer_id, client, client_state);
            if replies.is_empty() {
                return;
            }
            outbound = Vec::new();
            for reply in replies {
                let result = host
                    .receive_comments_doc_sync(peer_id, principal, can_write, &reply)
                    .expect("apply comments sync reply");
                outbound.extend(result.outbound);
            }
        }
    }

    fn apply_comments_client_change_to_host(
        host: &mut RoomHostHandle,
        peer_id: &str,
        principal: &str,
        can_write: bool,
        client: &mut CommentsDoc,
        client_state: &mut sync::State,
    ) -> Result<RoomHostFrameResult, String> {
        let mut last = RoomHostFrameResult::empty();
        for _ in 0..8 {
            let Some(message) = client.generate_sync_message(client_state) else {
                continue;
            };
            let result = host.receive_comments_doc_sync_inner(
                peer_id,
                principal,
                can_write,
                &message.encode(),
            )?;
            if result.changed {
                return Ok(result);
            }
            let replies =
                apply_comments_outbound_to_client(&result.outbound, peer_id, client, client_state);
            last = result;
            for reply in replies {
                let next =
                    host.receive_comments_doc_sync_inner(peer_id, principal, can_write, &reply)?;
                if next.changed {
                    return Ok(next);
                }
                last = next;
            }
        }
        if last.outbound.is_empty() {
            Err("comments doc change did not produce sync message".to_string())
        } else {
            Ok(last)
        }
    }

    fn apply_comments_outbound_to_client(
        outbound: &[RoomHostOutboundFrame],
        peer_id: &str,
        client: &mut CommentsDoc,
        client_state: &mut sync::State,
    ) -> Vec<Vec<u8>> {
        let mut replies = Vec::new();
        for frame in outbound {
            if frame.peer_id != peer_id || frame.frame_type != frame_types::COMMENTS_DOC_SYNC {
                continue;
            }
            let message = sync::Message::decode(&frame.payload).expect("decode comments sync");
            let _ = client
                .receive_sync_message_with_changes_recovering(
                    client_state,
                    message,
                    "comments-test-client-receive",
                )
                .expect("client receive comments sync");
            if let Some(reply) = client.generate_sync_message(client_state) {
                replies.push(reply.encode());
            }
        }
        replies
    }

    fn comments_change_payload(
        client: &mut CommentsDoc,
        heads_before: &[automerge::ChangeHash],
    ) -> Vec<u8> {
        let changes = client.doc_mut().save_after(heads_before);
        assert!(!changes.is_empty(), "expected incremental comments changes");
        sync::Message {
            heads: client.get_heads(),
            need: Vec::new(),
            have: Vec::new(),
            changes: sync::ChunkList::from(changes),
            flags: None,
            version: sync::MessageVersion::V1,
        }
        .encode()
    }

    #[test]
    fn reconcile_runtime_peer_gone_terminalizes_inflight_and_errors_live_kernel() {
        let mut host = host_with_inflight_work();
        host.set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("seed attachment");

        let result = host
            .reconcile_runtime_peer_gone_inner("daemon dropped")
            .expect("reconcile ok");
        assert!(result.changed, "reconciliation changed the doc");
        assert!(result.runtime_state_changed);

        let state = host.state_doc.read_state();
        // Both in-flight executions are now terminal, not spinning: the
        // running one errored mid-run, the queued one never ran.
        assert_eq!(state.executions["exec-running"].status, "error");
        assert_eq!(state.executions["exec-queued"].status, "cancelled");
        // Queue drained so the idempotency guard can't suppress re-runs.
        assert!(state.queue.executing.is_none());
        assert!(state.queue.queued.is_empty());
        // Phantom-live kernel flipped to Error with a diagnostic note.
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(
            state.kernel.error_details.as_deref(),
            Some("runtime peer disconnected: daemon dropped")
        );
        assert_eq!(
            state.workstation.as_ref().map(|ws| ws.status.as_str()),
            Some("disconnected")
        );
        assert_eq!(
            state
                .workstation
                .as_ref()
                .and_then(|ws| ws.status_message.as_deref()),
            Some("compute disconnected: daemon dropped")
        );
        assert_eq!(
            state
                .workstation
                .as_ref()
                .and_then(|ws| ws.updated_at.as_deref()),
            Some("2026-06-07T00:00:00.000Z"),
            "peer-gone reconciliation preserves the publish timestamp"
        );
    }

    #[test]
    fn runtime_execution_activity_reports_running_and_queued_work() {
        let host = host_with_inflight_work();
        let activity = runtime_execution_activity(&host.state_doc.read_state());

        assert!(activity.executing);
        assert_eq!(activity.queue_depth, 1);
    }

    #[test]
    fn reconcile_runtime_idle_timeout_shuts_down_idle_kernel_and_idles_attachment() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .expect("set idle lifecycle");
        host.set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("seed attachment");

        let result = host
            .reconcile_runtime_idle_timeout_inner(
                "Compute stopped after 30 minutes without queued or active execution.",
            )
            .expect("idle reconcile");

        assert!(result.changed);
        assert!(result.runtime_state_changed);
        let state = host.state_doc.read_state();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Shutdown);
        assert!(state.queue.executing.is_none());
        assert!(state.queue.queued.is_empty());
        assert_eq!(
            state.workstation.as_ref().map(|ws| ws.status.as_str()),
            Some("idle")
        );
        assert_eq!(
            state
                .workstation
                .as_ref()
                .and_then(|ws| ws.status_message.as_deref()),
            Some("Compute stopped after 30 minutes without queued or active execution.")
        );
        assert_eq!(
            state
                .workstation
                .as_ref()
                .and_then(|ws| ws.updated_at.as_deref()),
            Some("2026-06-07T00:00:00.000Z"),
            "idle reconciliation preserves the original publish timestamp"
        );
    }

    #[test]
    fn reconcile_runtime_idle_timeout_keeps_session_and_timestamp_for_monotonic_guard() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .expect("set idle lifecycle");
        let mut current = workstation_attachment_fixture();
        current.runtime_session_id = Some("job-current".to_string());
        current.updated_at = Some("2026-06-07T00:00:02.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&current))
            .expect("seed attachment");

        host.reconcile_runtime_idle_timeout_inner(
            "Compute stopped after 30 minutes without queued or active execution.",
        )
        .expect("idle reconcile");

        let state = host.state_doc.read_state();
        let attachment = state.workstation.as_ref().expect("attachment remains");
        assert_eq!(attachment.status, "idle");
        assert_eq!(
            attachment.runtime_session_id.as_deref(),
            Some("job-current")
        );
        assert_eq!(
            attachment.updated_at.as_deref(),
            Some("2026-06-07T00:00:02.000Z"),
            "internal idle rewrite must not outrank a newer cross-session publish"
        );
    }

    #[test]
    fn reconcile_runtime_idle_timeout_noops_while_execution_is_active() {
        let mut host = host_with_inflight_work();

        let result = host
            .reconcile_runtime_idle_timeout_inner(
                "Compute stopped after 30 minutes without queued or active execution.",
            )
            .expect("idle reconcile");

        assert!(!result.changed);
        let state = host.state_doc.read_state();
        assert_eq!(
            state.kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy)
        );
        assert!(state.queue.executing.is_some());
        assert_eq!(state.queue.queued.len(), 1);
    }

    #[test]
    fn reconcile_runtime_peer_gone_is_idempotent() {
        let mut host = host_with_inflight_work();
        let first = host
            .reconcile_runtime_peer_gone_inner("blip")
            .expect("first reconcile");
        assert!(first.changed);
        let state = host.state_doc.read_state();
        let attachment = state
            .workstation
            .as_ref()
            .expect("peer loss writes a disconnected attachment");
        assert_eq!(attachment.status, "disconnected");
        assert_eq!(
            attachment.status_message.as_deref(),
            Some("compute disconnected: blip")
        );

        // A second alarm (e.g. the grace timer re-firing) is a safe no-op:
        // everything is already terminal, so nothing changes and no frames are
        // broadcast.
        let second = host
            .reconcile_runtime_peer_gone_inner("blip")
            .expect("second reconcile");
        assert!(!second.changed, "second reconcile is a no-op");
        assert!(second.outbound.is_empty());
    }

    #[test]
    fn reconcile_runtime_peer_gone_does_not_relabel_a_clean_shutdown() {
        // A clean shutdown that raced the disconnect: kernel already Shutdown,
        // no in-flight work. Reconciliation must leave the terminal lifecycle
        // intact rather than rewriting it to Error, while still marking the
        // selected runtime-peer workstation as disconnected for viewers.
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle(&RuntimeLifecycle::Shutdown)
            .unwrap();
        host.set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("seed attachment");

        let result = host
            .reconcile_runtime_peer_gone_inner("late disconnect")
            .expect("reconcile ok");
        assert!(
            result.changed,
            "workstation attachment still records the disconnect"
        );
        let state = host.state_doc.read_state();
        assert_eq!(
            state.kernel.lifecycle,
            RuntimeLifecycle::Shutdown,
            "a clean shutdown is not relabeled to Error"
        );
        assert_eq!(
            state.workstation.as_ref().map(|ws| ws.status.as_str()),
            Some("disconnected")
        );
        assert_eq!(
            state
                .workstation
                .as_ref()
                .and_then(|ws| ws.status_message.as_deref()),
            Some("compute disconnected: late disconnect")
        );
        assert_eq!(
            state
                .workstation
                .as_ref()
                .and_then(|ws| ws.runtime_session_id.as_deref()),
            Some("job-runtime")
        );
        assert_eq!(
            state
                .workstation
                .as_ref()
                .and_then(|ws| ws.updated_at.as_deref()),
            Some("2026-06-07T00:00:00.000Z")
        );
    }

    #[test]
    fn reconcile_runtime_peer_gone_does_not_demote_idle_attachment() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle(&RuntimeLifecycle::Shutdown)
            .unwrap();
        let mut attachment = workstation_attachment_fixture();
        attachment.status = "idle".to_string();
        attachment.status_message = Some(
            "Compute stopped after 30 minutes without queued or active execution.".to_string(),
        );
        attachment.runtime_session_id = Some("job-idle".to_string());
        attachment.updated_at = Some("2026-06-07T00:00:02.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&attachment))
            .expect("seed idle attachment");

        let result = host
            .reconcile_runtime_peer_gone_inner("late disconnect")
            .expect("reconcile ok");

        assert!(!result.changed, "idle peer-gone reconcile is a no-op");
        assert!(result.outbound.is_empty());
        let state = host.state_doc.read_state();
        assert_ne!(
            state.kernel.lifecycle,
            RuntimeLifecycle::Error,
            "peer-gone reconcile must not write an error kernel state for idle"
        );
        assert!(
            !state
                .kernel
                .error_details
                .as_deref()
                .unwrap_or_default()
                .starts_with("runtime peer disconnected:"),
            "peer-gone reconcile must not write a peer-gone kernel error for idle"
        );
        let attachment = state.workstation.as_ref().expect("idle attachment remains");
        assert_eq!(attachment.status, "idle");
        assert_eq!(attachment.runtime_session_id.as_deref(), Some("job-idle"));
        assert_eq!(
            attachment.updated_at.as_deref(),
            Some("2026-06-07T00:00:02.000Z")
        );
    }

    #[test]
    fn reconcile_runtime_peer_gone_does_not_demote_error_attachment() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle(&RuntimeLifecycle::Shutdown)
            .unwrap();
        let mut attachment = workstation_attachment_fixture();
        attachment.status = "error".to_string();
        attachment.status_message =
            Some("Launch failed while creating the workstation session.".to_string());
        attachment.runtime_session_id = Some("job-error".to_string());
        attachment.updated_at = Some("2026-06-07T00:00:03.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&attachment))
            .expect("seed error attachment");

        let result = host
            .reconcile_runtime_peer_gone_inner("late disconnect")
            .expect("reconcile ok");

        assert!(!result.changed, "error peer-gone reconcile is a no-op");
        assert!(result.outbound.is_empty());
        let state = host.state_doc.read_state();
        assert_ne!(
            state.kernel.lifecycle,
            RuntimeLifecycle::Error,
            "peer-gone reconcile must not write an error kernel state for a terminal lifecycle"
        );
        let attachment = state
            .workstation
            .as_ref()
            .expect("error attachment remains");
        assert_eq!(attachment.status, "error");
        assert_eq!(
            attachment.status_message.as_deref(),
            Some("Launch failed while creating the workstation session.")
        );
        assert_eq!(attachment.runtime_session_id.as_deref(), Some("job-error"));
        assert_eq!(
            attachment.updated_at.as_deref(),
            Some("2026-06-07T00:00:03.000Z")
        );
    }

    #[test]
    fn reconcile_runtime_peer_gone_is_noop_for_clean_shutdown_without_attachment() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle(&RuntimeLifecycle::Shutdown)
            .unwrap();

        let result = host
            .reconcile_runtime_peer_gone_inner("late disconnect")
            .expect("reconcile ok");
        assert!(!result.changed);
        let state = host.state_doc.read_state();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Shutdown);
        assert!(state.workstation.is_none());
    }

    #[test]
    fn ready_runtime_peer_attachment_clears_stale_peer_gone_kernel_error() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle_with_error_details(
                &RuntimeLifecycle::Error,
                None,
                Some("runtime peer disconnected: runtime peer left the room"),
            )
            .unwrap();
        host.state_doc
            .set_runtime_agent_id("user:dev:alice/agent:runt:old")
            .unwrap();

        let result = host
            .set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("publish ready attachment");
        assert!(result.changed);

        let state = host.state_doc.read_state();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::NotStarted);
        assert_eq!(state.kernel.error_details.as_deref(), Some(""));
        assert_eq!(state.kernel.runtime_agent_id, "");
        assert_eq!(
            state.workstation.as_ref().map(|ws| ws.status.as_str()),
            Some("ready")
        );
    }

    #[test]
    fn ready_runtime_peer_attachment_preserves_non_watchdog_kernel_error() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.state_doc
            .set_lifecycle_with_error_details(
                &RuntimeLifecycle::Error,
                None,
                Some("kernel launch failed: missing module"),
            )
            .unwrap();

        host.set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("publish ready attachment");

        let state = host.state_doc.read_state();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(
            state.kernel.error_details.as_deref(),
            Some("kernel launch failed: missing module")
        );
    }

    #[test]
    fn set_workstation_attachment_keeps_launch_failure_error_status() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut attachment = workstation_attachment_fixture();
        attachment.status = "error".to_string();
        attachment.status_message = Some("Failed to launch kernel: missing module".to_string());

        host.set_workstation_attachment_inner(Some(&attachment))
            .expect("publish launch failure attachment");

        let state = host.state_doc.read_state();
        let attachment = state.workstation.as_ref().expect("attachment remains");
        assert_eq!(attachment.status, "error");
        assert_eq!(
            attachment.status_message.as_deref(),
            Some("Failed to launch kernel: missing module")
        );
    }

    #[test]
    fn reconcile_broadcasts_to_remaining_peers() {
        let mut host = host_with_inflight_work();
        // A surviving viewer peer is registered for runtime-state sync.
        host.runtime_peer_states
            .insert("viewer-1".to_string(), room_peer_sync_state(false));

        let result = host
            .reconcile_runtime_peer_gone_inner("gone")
            .expect("reconcile ok");
        assert!(result.changed);
        assert!(
            result
                .outbound
                .iter()
                .any(|f| f.peer_id == "viewer-1"
                    && f.frame_type == frame_types::RUNTIME_STATE_SYNC),
            "the reconciled state is broadcast to the surviving viewer"
        );
    }

    #[test]
    fn set_workstation_attachment_broadcasts_to_registered_peers() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.runtime_peer_states
            .insert("viewer-1".to_string(), room_peer_sync_state(false));

        let result = host
            .set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("set attachment");

        assert!(result.changed);
        assert!(result.runtime_state_changed);
        assert!(result.outbound.iter().any(|f| {
            f.peer_id == "viewer-1" && f.frame_type == frame_types::RUNTIME_STATE_SYNC
        }));
        let state = host.state_doc.read_state();
        assert_eq!(
            state
                .workstation
                .as_ref()
                .map(|ws| ws.workstation_id.as_str()),
            Some("runtime-peer")
        );
        assert_eq!(
            state.workstation.as_ref().map(|ws| ws.provider.as_str()),
            Some("runtime_peer")
        );
    }

    #[test]
    fn set_workstation_attachment_ignores_cross_session_strictly_older_publish() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut current = workstation_attachment_fixture();
        current.workstation_id = "ws-current".to_string();
        current.runtime_session_id = Some("job-current".to_string());
        current.updated_at = Some("2026-06-07T00:00:02.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&current))
            .expect("seed current attachment");
        let heads_before = host.state_doc.get_heads();

        let mut stale = current.clone();
        stale.workstation_id = "ws-stale".to_string();
        stale.runtime_session_id = Some("job-stale".to_string());
        stale.updated_at = Some("2026-06-07T00:00:01.000Z".to_string());

        let result = host
            .set_workstation_attachment_inner(Some(&stale))
            .expect("stale publish is handled");

        assert!(!result.changed);
        assert!(result.ignored_stale);
        assert_eq!(result.outbound.len(), 0);
        assert_eq!(host.state_doc.get_heads(), heads_before);
        assert_eq!(host.state_doc.read_state().workstation, Some(current));
    }

    #[test]
    fn set_workstation_attachment_allows_same_session_older_timestamp() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut current = workstation_attachment_fixture();
        current.runtime_session_id = Some("job-current".to_string());
        current.updated_at = Some("2026-06-07T00:00:02.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&current))
            .expect("seed current attachment");

        let mut same_session = current.clone();
        same_session.status = "connecting".to_string();
        same_session.updated_at = Some("2026-06-07T00:00:01.000Z".to_string());
        let result = host
            .set_workstation_attachment_inner(Some(&same_session))
            .expect("same-session publish passes");

        assert!(result.changed);
        assert!(!result.ignored_stale);
        assert_eq!(host.state_doc.read_state().workstation, Some(same_session));
    }

    #[test]
    fn set_workstation_attachment_allows_cross_session_equal_timestamp_tie() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut current = workstation_attachment_fixture();
        current.runtime_session_id = Some("job-current".to_string());
        current.updated_at = Some("2026-06-07T00:00:01.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&current))
            .expect("seed current attachment");

        let mut tied = current.clone();
        tied.status = "connecting".to_string();
        tied.runtime_session_id = Some("job-tied".to_string());
        let result = host
            .set_workstation_attachment_inner(Some(&tied))
            .expect("equal timestamp publish passes");

        assert!(result.changed);
        assert!(!result.ignored_stale);
        assert_eq!(host.state_doc.read_state().workstation, Some(tied));
    }

    #[test]
    fn set_workstation_attachment_allows_sessionless_incoming_publish() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut current = workstation_attachment_fixture();
        current.runtime_session_id = Some("job-current".to_string());
        current.updated_at = Some("2026-06-07T00:00:02.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&current))
            .expect("seed current attachment");

        let mut legacy = current.clone();
        legacy.status = "connecting".to_string();
        legacy.runtime_session_id = None;
        legacy.updated_at = Some("2026-06-07T00:00:01.000Z".to_string());
        let result = host
            .set_workstation_attachment_inner(Some(&legacy))
            .expect("sessionless publish passes");

        assert!(result.changed);
        assert!(!result.ignored_stale);
        assert_eq!(host.state_doc.read_state().workstation, Some(legacy));
    }

    #[test]
    fn set_workstation_attachment_allows_publish_with_missing_updated_at() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let mut current = workstation_attachment_fixture();
        current.runtime_session_id = Some("job-current".to_string());
        current.updated_at = Some("2026-06-07T00:00:02.000Z".to_string());
        host.set_workstation_attachment_inner(Some(&current))
            .expect("seed current attachment");

        let mut missing_updated_at = current.clone();
        missing_updated_at.status = "connecting".to_string();
        missing_updated_at.runtime_session_id = Some("job-missing-updated-at".to_string());
        missing_updated_at.updated_at = None;
        let result = host
            .set_workstation_attachment_inner(Some(&missing_updated_at))
            .expect("publish without updated_at passes");

        assert!(result.changed);
        assert!(!result.ignored_stale);
        assert_eq!(
            host.state_doc.read_state().workstation,
            Some(missing_updated_at)
        );
    }

    #[test]
    fn get_workstation_attachment_json_reads_current_attachment() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        assert_eq!(
            host.get_workstation_attachment_json()
                .expect("read empty attachment"),
            "null"
        );

        host.set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("set attachment");
        let attachment = serde_json::from_str::<Option<WorkstationAttachmentState>>(
            &host
                .get_workstation_attachment_json()
                .expect("read attachment"),
        )
        .expect("attachment json");
        assert_eq!(
            attachment.map(|ws| (ws.workstation_id, ws.provider, ws.status)),
            Some((
                "runtime-peer".to_string(),
                "runtime_peer".to_string(),
                "ready".to_string(),
            ))
        );
    }

    #[test]
    fn set_workstation_attachment_is_idempotent() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        let attachment = workstation_attachment_fixture();
        let first = host
            .set_workstation_attachment_inner(Some(&attachment))
            .expect("first set");
        assert!(first.changed);

        let second = host
            .set_workstation_attachment_inner(Some(&attachment))
            .expect("second set");
        assert!(!second.changed);
        assert!(second.outbound.is_empty());
    }

    #[test]
    fn hosted_execute_cell_queues_with_provenance_and_is_idempotent() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.seed_initial_code_cell_if_empty("cell-1")
            .expect("seed code cell");
        host.doc
            .update_source("cell-1", "print('hi')")
            .expect("set source");

        let actor = "user:anaconda:alice/browser:cloud";
        let req = json!({ "action": "execute_cell", "cell_id": "cell-1" });
        let result = host
            .handle_execute_cell(&req, "peer-1", actor)
            .expect("dispatch ok");
        assert!(result.runtime_state_changed);
        assert!(result.notebook_changed);

        let state = host.state_doc.read_state();
        assert_eq!(state.executions.len(), 1, "exactly one queued execution");
        let (eid, exec) = state.executions.iter().next().unwrap();
        assert_eq!(exec.status, "queued");
        assert_eq!(exec.source.as_deref(), Some("print('hi')"));
        assert_eq!(exec.seq, Some(0));
        // submitted_by carries the full principal/operator actor label, not a bare
        // principal, matching every other execution producer.
        assert_eq!(exec.submitted_by_actor_label.as_deref(), Some(actor));
        assert_eq!(
            state.queue.queued,
            vec![QueueEntry {
                execution_id: eid.clone()
            }],
            "accepted hosted execution intent is immediately visible in the queue projection"
        );
        assert_eq!(
            host.get_runtime_queue_depth(),
            1,
            "queue-depth accessor reflects RuntimeStateDoc queued executions"
        );
        assert_eq!(
            host.doc.get_execution_id("cell-1").as_deref(),
            Some(eid.as_str()),
            "the cell points at its queued execution"
        );

        // Re-running while the execution is still queued is an idempotent no-op:
        // no duplicate execution, no document change (the AlreadyActive guard).
        let again = host
            .handle_execute_cell(&req, "peer-1", actor)
            .expect("dispatch ok (no-op)");
        assert!(!again.runtime_state_changed);
        assert!(!again.notebook_changed);
        assert_eq!(
            host.state_doc.read_state().executions.len(),
            1,
            "still exactly one execution after a duplicate run"
        );
    }

    #[test]
    fn hosted_run_all_queues_code_cells_and_publishes_queue_projection() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.seed_initial_code_cell_if_empty("cell-1")
            .expect("seed code cell");
        host.doc
            .update_source("cell-1", "print('one')")
            .expect("source 1");
        host.doc
            .add_cell_after("markdown-1", "markdown", Some("cell-1"))
            .expect("add markdown");
        host.doc
            .add_cell_after("cell-2", "code", Some("markdown-1"))
            .expect("add code");
        host.doc
            .update_source("cell-2", "print('two')")
            .expect("source 2");

        // Register a runtime peer so the accepted queue is fanned out to the
        // executor as well as visible to the browser peer.
        let mut initial = Vec::new();
        host.queue_current_sync_for_peer("runtime-peer", false, true, true, false, &mut initial)
            .expect("initial runtime peer sync");

        let supplied = "22222222-2222-4222-8222-222222222222";
        let actor = "user:anaconda:alice/browser:cloud";
        let result = host
            .handle_run_all_cells(
                &json!({
                    "action": "run_all_cells",
                    "cell_execution_ids": {
                        "cell-2": supplied
                    }
                }),
                "owner-peer",
                actor,
            )
            .expect("dispatch ok");

        assert!(result.runtime_state_changed);
        assert!(result.notebook_changed);
        assert!(
            result.outbound.iter().any(|f| {
                f.peer_id == "runtime-peer" && f.frame_type == frame_types::RUNTIME_STATE_SYNC
            }),
            "run-all should fan out queued executions to the registered runtime peer"
        );

        let state = host.state_doc.read_state();
        assert_eq!(state.executions.len(), 2, "only code cells are queued");
        let cell_1_execution_id = host
            .doc
            .get_execution_id("cell-1")
            .expect("cell 1 execution pointer");
        let cell_2_execution_id = host
            .doc
            .get_execution_id("cell-2")
            .expect("cell 2 execution pointer");
        assert_eq!(cell_2_execution_id, supplied);
        assert_eq!(
            host.doc.get_execution_id("markdown-1"),
            None,
            "markdown cells are not queued"
        );

        let first = state
            .executions
            .get(&cell_1_execution_id)
            .expect("cell 1 execution");
        let second = state
            .executions
            .get(&cell_2_execution_id)
            .expect("cell 2 execution");
        assert_eq!(first.status, "queued");
        assert_eq!(first.source.as_deref(), Some("print('one')"));
        assert_eq!(first.cell_id.as_deref(), Some("cell-1"));
        assert_eq!(first.seq, Some(0));
        assert_eq!(first.submitted_by_actor_label.as_deref(), Some(actor));
        assert_eq!(second.status, "queued");
        assert_eq!(second.source.as_deref(), Some("print('two')"));
        assert_eq!(second.cell_id.as_deref(), Some("cell-2"));
        assert_eq!(second.seq, Some(1));
        assert_eq!(second.submitted_by_actor_label.as_deref(), Some(actor));
        assert_eq!(
            state.queue.queued,
            vec![
                QueueEntry {
                    execution_id: cell_1_execution_id
                },
                QueueEntry {
                    execution_id: cell_2_execution_id
                },
            ],
            "run-all publishes the visible queue in notebook order"
        );
        assert_eq!(
            host.get_runtime_queue_depth(),
            2,
            "queue-depth accessor reflects every queued run-all execution"
        );
    }

    #[test]
    fn hosted_execute_cell_fans_out_runtime_state_to_runtime_peer() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.seed_initial_code_cell_if_empty("cell-1")
            .expect("seed code cell");
        host.doc
            .update_source("cell-1", "print('from owner')")
            .expect("set source");

        // Register a runtime_peer the same way cloud_room_ready + sync_peer do:
        // the initial sync advances that peer's room-host sync state, so a
        // later ExecuteCell should fan out only the new queued execution.
        let mut initial = Vec::new();
        host.queue_current_sync_for_peer("runtime-peer", false, true, true, false, &mut initial)
            .expect("initial runtime peer sync");
        assert!(
            initial
                .iter()
                .any(|f| f.peer_id == "runtime-peer"
                    && f.frame_type == frame_types::RUNTIME_STATE_SYNC),
            "initial sync registers the runtime peer for RuntimeStateDoc updates"
        );

        let result = host
            .handle_execute_cell(
                &json!({ "action": "execute_cell", "cell_id": "cell-1" }),
                "owner-peer",
                "user:anaconda:alice/browser:cloud",
            )
            .expect("dispatch ok");

        assert!(result.runtime_state_changed);
        assert!(
            result.outbound.iter().any(|f| {
                f.peer_id == "runtime-peer" && f.frame_type == frame_types::RUNTIME_STATE_SYNC
            }),
            "queued execution should be broadcast to the registered runtime peer"
        );
    }

    #[test]
    fn hosted_execute_cell_honors_client_supplied_execution_id() {
        let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.seed_initial_code_cell_if_empty("cell-1")
            .expect("seed code cell");
        host.doc.update_source("cell-1", "1 + 1").expect("source");

        // A valid client-supplied UUID is used verbatim as the execution id.
        // The rejection paths (missing/non-code cell, malformed execution_id)
        // construct a JsError, which wasm-bindgen cannot build off-wasm, so a
        // native unit test panics on them; those are covered by review and the
        // live integration path instead.
        let supplied = "11111111-1111-4111-8111-111111111111";
        host.handle_execute_cell(
            &json!({ "action": "execute_cell", "cell_id": "cell-1", "execution_id": supplied }),
            "peer-1",
            "user:anaconda:alice/browser:cloud",
        )
        .expect("a valid client-supplied uuid is honored");
        assert!(host
            .state_doc
            .read_state()
            .executions
            .contains_key(supplied));
    }

    #[test]
    fn notebook_actor_validation_accepts_only_the_canonical_schema_seed_hash() {
        let seed_hash = NotebookDoc::canonical_schema_seed_change_hashes()
            .into_iter()
            .next()
            .expect("seed hash");

        validate_room_notebook_change_actors_inner(
            "user:dev:alice",
            [ChangeActor {
                actor_label: "nteract:notebook-schema:v5".to_string(),
                hash: seed_hash,
            }]
            .iter(),
        )
        .expect("canonical seed change is allowed");

        let error = validate_room_notebook_change_actors_inner(
            "user:dev:alice",
            [ChangeActor {
                actor_label: "nteract:notebook-schema:v5".to_string(),
                hash: automerge::ChangeHash([1; 32]),
            }]
            .iter(),
        )
        .expect_err("spoofed seed actor must remain rejected");

        assert!(error.contains("actor label"));
    }

    #[test]
    fn editor_policy_ignores_canonical_schema_seed_maps() {
        let seed_hash = NotebookDoc::canonical_schema_seed_change_hashes()
            .into_iter()
            .next()
            .expect("seed hash");
        let mut preview = NotebookDoc::bootstrap(
            notebook_doc::TextEncoding::UnicodeCodePoint,
            "user:dev:alice/desktop:a",
        );

        validate_editor_notebook_changes(
            &mut preview,
            &[],
            [ChangeActor {
                actor_label: "nteract:notebook-schema:v5".to_string(),
                hash: seed_hash,
            }]
            .iter(),
        )
        .expect("canonical schema seed maps are not editor metadata edits");
    }

    #[test]
    fn editor_changes_allow_adding_cells() {
        let mut preview = NotebookDoc::bootstrap(
            notebook_doc::TextEncoding::UnicodeCodePoint,
            "user:dev:alice/desktop:a",
        );
        let heads_before = preview.get_heads();
        preview
            .add_cell_after("cell-1", "code", None)
            .expect("add cell");

        validate_editor_notebook_changes(
            &mut preview,
            &heads_before,
            std::iter::empty::<&ChangeActor>(),
        )
        .expect("editor scope may add cells");
    }

    #[test]
    fn editor_changes_allow_editing_code_cell_source() {
        let mut preview = NotebookDoc::bootstrap(
            notebook_doc::TextEncoding::UnicodeCodePoint,
            "user:dev:alice/desktop:a",
        );
        preview
            .add_cell_after("cell-1", "code", None)
            .expect("add cell");
        let heads_before = preview.get_heads();
        preview
            .update_source("cell-1", "print(1)")
            .expect("edit source");

        validate_editor_notebook_changes(
            &mut preview,
            &heads_before,
            std::iter::empty::<&ChangeActor>(),
        )
        .expect("editor scope may edit code cell source");
    }

    #[test]
    fn editor_changes_reject_notebook_metadata_edits() {
        let mut preview = NotebookDoc::bootstrap(
            notebook_doc::TextEncoding::UnicodeCodePoint,
            "user:dev:alice/desktop:a",
        );
        let heads_before = preview.get_heads();
        preview
            .set_metadata("trust", "tampered")
            .expect("set metadata");

        assert!(
            validate_editor_notebook_changes(
                &mut preview,
                &heads_before,
                std::iter::empty::<&ChangeActor>(),
            )
            .is_err(),
            "editor scope cannot change notebook metadata",
        );
    }

    #[test]
    fn editor_changes_reject_runtime_state_doc_id_writes() {
        let mut preview = NotebookDoc::bootstrap(
            notebook_doc::TextEncoding::UnicodeCodePoint,
            "user:dev:alice/desktop:a",
        );
        let heads_before = preview.get_heads();
        preview
            .set_runtime_state_doc_id("forged-runtime-doc")
            .expect("forge runtime_state_doc_id");

        assert!(
            validate_editor_notebook_changes(
                &mut preview,
                &heads_before,
                std::iter::empty::<&ChangeActor>(),
            )
            .is_err(),
            "editor scope cannot repoint runtime_state_doc_id",
        );
    }

    #[test]
    fn editor_changes_reject_comms_doc_id_writes() {
        let mut preview = NotebookDoc::bootstrap(
            notebook_doc::TextEncoding::UnicodeCodePoint,
            "user:dev:alice/desktop:a",
        );
        let heads_before = preview.get_heads();
        preview
            .set_comms_doc_id("forged-comms-doc")
            .expect("forge comms_doc_id");

        assert!(
            validate_editor_notebook_changes(
                &mut preview,
                &heads_before,
                std::iter::empty::<&ChangeActor>(),
            )
            .is_err(),
            "editor scope cannot repoint comms_doc_id",
        );
    }

    #[test]
    fn inline_content_ref_is_unwrapped() {
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "value": { "inline": 42 },
        }));
        assert_eq!(resolved, json!({ "value": 42 }));
        assert!(buffer_paths.is_empty());
        assert!(text_paths.is_empty());
    }

    #[test]
    fn ordinary_inline_and_blob_properties_are_preserved() {
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "layout": { "inline": true, "display": "flex" },
            "marker": { "blob": "not-a-content-ref" },
            "payload": { "blob": "also-not-a-content-ref", "size": 3, "extra": "state" },
        }));
        assert_eq!(
            resolved,
            json!({
                "layout": { "inline": true, "display": "flex" },
                "marker": { "blob": "not-a-content-ref" },
                "payload": { "blob": "also-not-a-content-ref", "size": 3, "extra": "state" },
            })
        );
        assert!(buffer_paths.is_empty());
        assert!(text_paths.is_empty());
    }

    #[test]
    fn markdown_projection_narrowing_keeps_markdown_fallback() {
        let mut handle = NotebookHandle::create_empty().expect("create handle");
        handle.mime_priority = vec![
            MARKDOWN_PROJECTION_MIME.to_string(),
            MARKDOWN_SOURCE_MIME.to_string(),
            "text/html".to_string(),
            "text/plain".to_string(),
        ];

        let narrowed = handle.narrow_output_data(json!({
            "output_type": "display_data",
            "data": {
                MARKDOWN_PROJECTION_MIME: { "inline": "{\"version\":1,\"blocks\":[],\"runs\":[]}" },
                MARKDOWN_SOURCE_MIME: { "inline": "raw markdown fallback" },
                "text/html": { "inline": "<p>html fallback</p>" },
                "text/plain": { "inline": "plain fallback" },
            },
            "metadata": {},
        }));
        let data = narrowed["data"].as_object().expect("narrowed data object");

        assert!(data.contains_key(MARKDOWN_PROJECTION_MIME));
        assert!(data.contains_key(MARKDOWN_SOURCE_MIME));
        assert!(data.contains_key("text/plain"));
        assert!(
            !data.contains_key("text/html"),
            "non-winning rich text fallbacks should still be dropped"
        );
    }

    #[test]
    fn bokeh_narrowing_keeps_marker_javascript_and_html_bundle() {
        let mut handle = NotebookHandle::create_empty().expect("create handle");
        handle.mime_priority = vec![
            BOKEHJS_EXEC_MIME.to_string(),
            BOKEHJS_LOAD_MIME.to_string(),
            "text/html".to_string(),
            BOKEHJS_SCRIPT_MIME.to_string(),
            "text/plain".to_string(),
        ];

        let narrowed = handle.narrow_output_data(json!({
            "output_type": "display_data",
            "data": {
                BOKEHJS_EXEC_MIME: { "inline": "" },
                BOKEHJS_SCRIPT_MIME: { "inline": "Bokeh.embed.embed_items_notebook([]);" },
                BOKEHJS_HTML_MIME: { "inline": "<div id=\"p1011\"></div>" },
                "text/plain": { "inline": "fallback" },
            },
            "metadata": {
                BOKEHJS_EXEC_MIME: { "id": "p1011" },
            },
        }));
        let data = narrowed["data"].as_object().expect("narrowed data object");

        assert!(data.contains_key(BOKEHJS_EXEC_MIME));
        assert!(data.contains_key(BOKEHJS_SCRIPT_MIME));
        assert!(data.contains_key(BOKEHJS_HTML_MIME));
        assert!(data.contains_key("text/plain"));
    }

    #[test]
    fn panel_narrowing_keeps_marker_javascript_and_html_bundle() {
        let mut handle = NotebookHandle::create_empty().expect("create handle");
        handle.mime_priority = vec![
            PANEL_EXEC_MIME.to_string(),
            PANEL_LOAD_MIME.to_string(),
            "text/html".to_string(),
            BOKEHJS_SCRIPT_MIME.to_string(),
            "text/plain".to_string(),
        ];

        let narrowed = handle.narrow_output_data(json!({
            "output_type": "display_data",
            "data": {
                PANEL_EXEC_MIME: { "inline": "" },
                BOKEHJS_SCRIPT_MIME: { "inline": "window.__panelExecRan = true;" },
                BOKEHJS_HTML_MIME: { "inline": "<div id=\"p1011\"></div><script>window.__panelHtmlRan = true;</script>" },
                "text/plain": { "inline": "fallback" },
            },
            "metadata": {
                PANEL_EXEC_MIME: { "id": "p1011" },
            },
        }));
        let data = narrowed["data"].as_object().expect("narrowed data object");

        assert!(data.contains_key(PANEL_EXEC_MIME));
        assert!(data.contains_key(BOKEHJS_SCRIPT_MIME));
        assert!(data.contains_key(BOKEHJS_HTML_MIME));
        assert!(data.contains_key("text/plain"));
    }

    #[test]
    fn binary_blob_ref_goes_to_buffer_paths() {
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "image": { "blob": "abc123", "size": 100, "media_type": "image/png" },
        }));
        assert_eq!(
            resolved,
            json!({ "image": "http://127.0.0.1:1234/blob/abc123" })
        );
        assert_eq!(buffer_paths, vec![vec!["image".to_string()]]);
        assert!(text_paths.is_empty());
    }

    #[test]
    fn output_model_outputs_are_not_widget_buffer_paths() {
        let (resolved, buffer_paths, text_paths) = resolve_output_model(json!({
            "_model_name": "OutputModel",
            "outputs": [{
                "output_type": "display_data",
                "data": {
                    "image/png": { "blob": "pnghash", "size": 2048, "media_type": "image/png" },
                    "text/plain": { "blob": "txthash", "size": 12, "media_type": "text/plain" },
                },
                "metadata": {},
            }],
            "value": { "blob": "traitlet-bin", "size": 8, "media_type": "application/octet-stream" },
        }));

        assert!(resolved.as_object().unwrap().get("outputs").is_none());
        assert_eq!(
            resolved["value"],
            json!("http://127.0.0.1:1234/blob/traitlet-bin")
        );
        assert_eq!(buffer_paths, vec![vec!["value".to_string()]]);
        assert!(text_paths.is_empty());
    }

    #[test]
    fn text_blob_ref_goes_to_text_paths() {
        // `_py_render` is consumed as a literal string by Pyodide, so it
        // must be text-inlined. `_esm` and `_css` are excluded from
        // text_paths even though their MIMEs are text — see the
        // `esm_and_css_stay_as_url` tests below for the rationale.
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "_py_render": { "blob": "def456", "size": 2048, "media_type": "text/plain" },
            "value": { "blob": "jkl012", "size": 4096, "media_type": "text/html" },
        }));
        assert_eq!(
            resolved["_py_render"],
            json!("http://127.0.0.1:1234/blob/def456")
        );
        assert_eq!(
            resolved["value"],
            json!("http://127.0.0.1:1234/blob/jkl012")
        );
        assert!(buffer_paths.is_empty());
        assert_eq!(text_paths.len(), 2);
        assert!(text_paths.contains(&vec!["_py_render".to_string()]));
        assert!(text_paths.contains(&vec!["value".to_string()]));
    }

    #[test]
    fn esm_blob_stays_as_url_not_text_inlined() {
        // Anywidget's `_esm` loads via native `import(url)`; pre-fetching
        // the text in the sync engine just to re-import it defeats
        // browser caching. Emit neither buffer_paths nor text_paths so the
        // iframe's blob-URL resolver leaves the string alone — `loadESM`
        // reads it as a URL by key name.
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "_esm": { "blob": "esmhash", "size": 50000, "media_type": "text/javascript" },
        }));
        assert_eq!(
            resolved["_esm"],
            json!("http://127.0.0.1:1234/blob/esmhash")
        );
        assert!(
            buffer_paths.is_empty(),
            "_esm must not appear in buffer_paths"
        );
        assert!(text_paths.is_empty(), "_esm must not appear in text_paths");
    }

    #[test]
    fn css_blob_stays_as_url_not_text_inlined() {
        // Anywidget's `_css` is rendered as `<link rel=stylesheet
        // href=url>`; the browser fetches + caches it directly. Emit
        // neither buffer_paths nor text_paths — `injectCSS` reads the URL
        // by key name and nothing else should touch the value.
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "_css": { "blob": "csshash", "size": 2048, "media_type": "text/css" },
        }));
        assert_eq!(
            resolved["_css"],
            json!("http://127.0.0.1:1234/blob/csshash")
        );
        assert!(
            buffer_paths.is_empty(),
            "_css must not appear in buffer_paths"
        );
        assert!(text_paths.is_empty(), "_css must not appear in text_paths");
    }

    #[test]
    fn esm_under_nested_parent_also_excluded() {
        // Exclusion matches the last path segment, not the full path.
        // Collateral: a stray `_esm` buried in user state is also
        // URL-routed (no buffer/text path entry). Acceptable since the
        // identifier is reserved.
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "children": [
                {
                    "_esm": { "blob": "h", "size": 100, "media_type": "text/javascript" },
                },
            ],
        }));
        assert_eq!(
            resolved["children"][0]["_esm"],
            json!("http://127.0.0.1:1234/blob/h"),
        );
        assert!(buffer_paths.is_empty());
        assert!(text_paths.is_empty());
    }

    #[test]
    fn svg_is_text_not_binary() {
        // image/svg+xml is a common gotcha — it's text despite the image/ prefix.
        let (_, buffer_paths, text_paths) = resolve(json!({
            "svg": { "blob": "s1", "size": 200, "media_type": "image/svg+xml" },
        }));
        assert!(buffer_paths.is_empty());
        assert_eq!(text_paths, vec![vec!["svg".to_string()]]);
    }

    #[test]
    fn missing_media_type_defaults_to_binary() {
        // Legacy comms without media_type must stay URL-shaped so existing
        // ipywidgets binary-buffer paths keep working.
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "buf": { "blob": "h", "size": 10 },
        }));
        assert_eq!(resolved, json!({ "buf": "http://127.0.0.1:1234/blob/h" }));
        assert_eq!(buffer_paths, vec![vec!["buf".to_string()]]);
        assert!(text_paths.is_empty());
    }

    #[test]
    fn application_json_is_text() {
        let (_, buffer_paths, text_paths) = resolve(json!({
            "spec": { "blob": "j", "size": 9999, "media_type": "application/json" },
        }));
        assert!(buffer_paths.is_empty());
        assert_eq!(text_paths, vec![vec!["spec".to_string()]]);
    }

    #[test]
    fn nested_paths_are_tracked_correctly() {
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "outer": {
                "list": [
                    { "inline": "first" },
                    { "blob": "binhash", "size": 1, "media_type": "image/png" },
                    { "blob": "txthash", "size": 1, "media_type": "text/plain" },
                ],
            },
        }));
        assert_eq!(resolved["outer"]["list"][0], json!("first"));
        assert_eq!(
            resolved["outer"]["list"][1],
            json!("http://127.0.0.1:1234/blob/binhash")
        );
        assert_eq!(
            resolved["outer"]["list"][2],
            json!("http://127.0.0.1:1234/blob/txthash")
        );
        assert_eq!(
            buffer_paths,
            vec![vec![
                "outer".to_string(),
                "list".to_string(),
                "1".to_string()
            ]]
        );
        assert_eq!(
            text_paths,
            vec![vec![
                "outer".to_string(),
                "list".to_string(),
                "2".to_string()
            ]]
        );
    }

    #[test]
    fn primitives_pass_through_unchanged() {
        let (resolved, buffer_paths, text_paths) = resolve(json!({
            "n": 1,
            "s": "hello",
            "b": true,
            "nil": null,
            "arr": [1, 2, 3],
        }));
        assert_eq!(
            resolved,
            json!({
                "n": 1,
                "s": "hello",
                "b": true,
                "nil": null,
                "arr": [1, 2, 3],
            })
        );
        assert!(buffer_paths.is_empty());
        assert!(text_paths.is_empty());
    }

    // -- Actor preservation tests (hotfix #3579 follow-up) -----------------

    #[test]
    fn set_actor_covers_all_docs_on_notebook_handle() {
        let mut handle = NotebookHandle::create_bootstrap("user:dev:a/browser:x")
            .expect("create bootstrap handle");

        // Set a new actor
        handle.set_actor("user:dev:b/browser:y");

        // Verify all three docs have the new actor
        let expected_actor = automerge::ActorId::from("user:dev:b/browser:y".as_bytes());

        assert_eq!(
            handle.doc.get_actor_id(),
            "user:dev:b/browser:y",
            "NotebookDoc actor mismatch"
        );
        assert_eq!(
            handle.state_doc.doc().get_actor(),
            &expected_actor,
            "RuntimeStateDoc actor mismatch"
        );
        assert_eq!(
            handle.comms_doc.doc().get_actor(),
            &expected_actor,
            "CommsDoc actor mismatch"
        );
    }

    #[test]
    fn set_actor_covers_both_docs_on_runtime_peer_handle() {
        let mut handle =
            RuntimeStatePeerHandle::new("user:dev:a/browser:x").expect("create handle");

        // Set a new actor
        handle.set_actor("user:dev:b/browser:y");

        // Verify both docs have the new actor
        let expected_actor = automerge::ActorId::from("user:dev:b/browser:y".as_bytes());

        assert_eq!(
            handle.state_doc.doc().get_actor(),
            &expected_actor,
            "RuntimeStateDoc actor mismatch"
        );
        assert_eq!(
            handle.comms_doc.doc().get_actor(),
            &expected_actor,
            "CommsDoc actor mismatch"
        );
    }

    #[test]
    fn load_comms_doc_preserves_actor() {
        // Create handle A with actor X and write a comm
        let mut handle_a =
            NotebookHandle::create_bootstrap("user:dev:a/browser:x").expect("create handle A");
        let success = handle_a.set_comm_state_property("test-comm", "key", r#""value""#);
        assert!(success, "write comm property");
        let bytes = handle_a.save_comms_doc();

        // Create handle B, set actor Y, then load A's comms doc
        let mut handle_b =
            NotebookHandle::create_bootstrap("user:dev:tmp/browser:tmp").expect("create handle B");
        handle_b.set_actor("user:dev:b/browser:y");

        handle_b
            .load_comms_doc(&bytes)
            .expect("load comms doc should succeed");

        // Verify handle B's comms doc still has actor Y, not a random actor
        let expected_actor = automerge::ActorId::from("user:dev:b/browser:y".as_bytes());
        assert_eq!(
            handle_b.comms_doc.doc().get_actor(),
            &expected_actor,
            "load_comms_doc should preserve the handle's actor"
        );

        // Verify handle B can still write to the comms doc
        let success = handle_b.set_comm_state_property("test-comm", "key2", r#""value2""#);
        assert!(success, "should be able to write after load");
    }

    #[test]
    fn load_state_doc_preserves_actor() {
        // Create handle A with actor X
        let mut handle_a =
            NotebookHandle::create_bootstrap("user:dev:a/browser:x").expect("create handle A");
        let bytes = handle_a.state_doc.doc_mut().save();

        // Create handle B, set actor Y, then load A's state doc
        let mut handle_b =
            NotebookHandle::create_bootstrap("user:dev:tmp/browser:tmp").expect("create handle B");
        handle_b.set_actor("user:dev:b/browser:y");

        handle_b
            .load_state_doc(&bytes)
            .expect("load state doc should succeed");

        // Verify handle B's state doc still has actor Y, not a random actor
        let expected_actor = automerge::ActorId::from("user:dev:b/browser:y".as_bytes());
        assert_eq!(
            handle_b.state_doc.doc().get_actor(),
            &expected_actor,
            "load_state_doc should preserve the handle's actor"
        );
    }

    #[test]
    fn rebuild_comms_doc_preserves_actor() {
        let mut handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:x").expect("create handle");

        // Write a comm property so the doc is non-empty
        let success = handle.set_comm_state_property("test-comm", "key", r#""value""#);
        assert!(success, "write comm property");

        let expected_actor = automerge::ActorId::from("user:dev:test/browser:x".as_bytes());

        // Call rebuild directly (test has private field access)
        handle.rebuild_comms_doc();

        // Verify the actor is still the same
        assert_eq!(
            handle.comms_doc.doc().get_actor(),
            &expected_actor,
            "rebuild_comms_doc should preserve the actor"
        );
    }

    // -- save_since_heads / apply_change_bytes (chunked persistence + tab bridge) --

    fn handle_with_cell(cell_id: &str, source: &str) -> NotebookHandle {
        let mut handle = NotebookHandle::new("chunks-test").expect("create handle");
        handle.set_actor("user:dev:test/browser:a");
        handle
            .add_cell(handle.cell_count(), cell_id, "code")
            .expect("add cell");
        handle.update_source(cell_id, source).expect("set source");
        handle
    }

    fn changed_local_mutation<T: Serialize>(
        mutation: LocalMutationResult<T>,
    ) -> (T, CellChangeset) {
        let LocalMutationResult { result, event } = mutation;
        match event {
            Some(FrameEvent::SyncApplied {
                changed,
                changeset,
                attributions,
                reply,
                ..
            }) => {
                assert!(changed, "local mutation event must report changed=true");
                assert!(
                    reply.is_none(),
                    "local mutation event must not carry a sync reply"
                );
                assert!(
                    attributions.is_empty(),
                    "local mutation event must not carry remote text attributions"
                );
                (
                    result,
                    changeset.expect("changed local mutation carries a changeset"),
                )
            }
            _ => panic!("expected a sync_applied local mutation event"),
        }
    }

    fn assert_no_local_event<T>(mutation: LocalMutationResult<T>, expected_result: T)
    where
        T: Serialize + std::fmt::Debug + PartialEq,
    {
        assert_eq!(mutation.result, expected_result);
        assert!(
            mutation.event.is_none(),
            "no-op local mutation must not emit an event"
        );
    }

    fn changed_cell<'a>(
        changeset: &'a CellChangeset,
        cell_id: &str,
    ) -> &'a notebook_doc::diff::ChangedCell {
        changeset
            .changed
            .iter()
            .find(|cell| cell.cell_id == cell_id)
            .unwrap_or_else(|| panic!("missing changed cell {cell_id}: {changeset:?}"))
    }

    #[test]
    fn local_add_cell_after_with_changeset_reports_added_cell() {
        let mut handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:a").expect("create handle");

        let mutation = handle
            .add_cell_after_with_changeset_inner("cell-1", "code", None)
            .expect("add cell with changeset");
        let (position, changeset) = changed_local_mutation(mutation);

        assert_eq!(
            handle.get_cell_position("cell-1").as_deref(),
            Some(position.as_str())
        );
        assert_eq!(changeset.added, vec!["cell-1".to_string()]);
        assert!(changeset.removed.is_empty());
        assert!(changeset.changed.is_empty());
        assert!(changeset.order_changed);
    }

    #[test]
    fn local_move_cell_with_changeset_reports_position_change() {
        let mut handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:a").expect("create handle");
        handle.add_cell_after("cell-1", "code", None).unwrap();
        handle
            .add_cell_after("cell-2", "code", Some("cell-1".to_string()))
            .unwrap();

        let mutation = handle
            .move_cell_with_changeset_inner("cell-2", None)
            .expect("move cell with changeset");
        let (position, changeset) = changed_local_mutation(mutation);
        let moved = changed_cell(&changeset, "cell-2");

        assert_eq!(
            handle.get_cell_position("cell-2").as_deref(),
            Some(position.as_str())
        );
        assert!(moved.fields.position);
        assert!(changeset.order_changed);
        assert!(changeset.added.is_empty());
        assert!(changeset.removed.is_empty());
    }

    #[test]
    fn local_delete_cell_with_changeset_reports_removed_and_noops_missing() {
        let mut handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:a").expect("create handle");
        handle.add_cell_after("cell-1", "code", None).unwrap();

        let mutation = handle
            .delete_cell_with_changeset_inner("cell-1")
            .expect("delete cell with changeset");
        let (deleted, changeset) = changed_local_mutation(mutation);

        assert!(deleted);
        assert_eq!(changeset.removed, vec!["cell-1".to_string()]);
        assert!(changeset.added.is_empty());
        assert!(changeset.changed.is_empty());
        assert!(changeset.order_changed);

        let missing = handle
            .delete_cell_with_changeset_inner("missing")
            .expect("delete missing cell");
        assert_no_local_event(missing, false);
    }

    #[test]
    fn local_clear_outputs_with_changeset_reports_output_pointer_change_and_noops_missing() {
        let mut handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:a").expect("create handle");
        handle.add_cell_after("cell-1", "code", None).unwrap();
        handle
            .doc
            .set_execution_id("cell-1", Some("exec-1"))
            .expect("seed execution pointer");

        let mutation = handle
            .clear_outputs_with_changeset_inner("cell-1")
            .expect("clear outputs with changeset");
        let (cleared, changeset) = changed_local_mutation(mutation);
        let changed = changed_cell(&changeset, "cell-1");

        assert!(cleared);
        assert!(changed.fields.outputs);
        assert!(changeset.added.is_empty());
        assert!(changeset.removed.is_empty());

        let missing = handle
            .clear_outputs_with_changeset_inner("missing")
            .expect("clear outputs for missing cell");
        assert_no_local_event(missing, false);
    }

    #[test]
    fn local_visibility_wrappers_report_metadata_changes_and_noop_missing() {
        let mut handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:a").expect("create handle");
        handle.add_cell_after("cell-1", "code", None).unwrap();

        let source_mutation = handle
            .set_cell_source_hidden_with_changeset_inner("cell-1", true)
            .expect("set source hidden with changeset");
        let (source_changed, source_changeset) = changed_local_mutation(source_mutation);
        assert!(source_changed);
        assert!(changed_cell(&source_changeset, "cell-1").fields.metadata);

        let outputs_mutation = handle
            .set_cell_outputs_hidden_with_changeset_inner("cell-1", true)
            .expect("set outputs hidden with changeset");
        let (outputs_changed, outputs_changeset) = changed_local_mutation(outputs_mutation);
        assert!(outputs_changed);
        assert!(changed_cell(&outputs_changeset, "cell-1").fields.metadata);

        let missing = handle
            .set_cell_source_hidden_with_changeset_inner("missing", true)
            .expect("set source hidden on missing cell");
        assert_no_local_event(missing, false);
    }

    fn runtime_output_manifest(output_id: &str, text: &str) -> serde_json::Value {
        json!({
            "output_type": "stream",
            "output_id": output_id,
            "name": "stdout",
            "text": { "inline": text },
        })
    }

    fn handle_with_runtime_output(text: &str) -> NotebookHandle {
        let mut handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:a").expect("create handle");
        handle.add_cell_after("cell-1", "code", None).unwrap();
        handle
            .doc
            .set_execution_id("cell-1", Some("exec-1"))
            .expect("seed execution pointer");
        handle
            .state_doc
            .create_execution("exec-1")
            .expect("create execution");
        handle
            .state_doc
            .append_output("exec-1", &runtime_output_manifest("out-1", text))
            .expect("append output");
        handle
    }

    fn output_cache_key(output: &serde_json::Value) -> &str {
        output
            .get(RUNT_OUTPUT_CACHE_KEY)
            .and_then(|value| value.as_str())
            .expect("output cache key")
    }

    #[test]
    fn output_cache_key_stays_stable_for_unchanged_outputs_and_bumps_on_payload_change() {
        let mut handle = handle_with_runtime_output("first\n");

        let state = handle.state_doc.read_state();
        let first_changeset = handle.build_output_changeset(&state);
        assert_eq!(first_changeset.changed.len(), 1);
        let first_key = output_cache_key(&first_changeset.changed[0].1).to_string();
        assert_eq!(first_key, "output:out-1:0:1");

        let fetched = handle.fetch_and_narrow_outputs("cell-1");
        assert_eq!(output_cache_key(&fetched[0]), first_key);

        let state = handle.state_doc.read_state();
        let unchanged = handle.build_output_changeset(&state);
        assert!(unchanged.is_empty());
        let stable = handle.fetch_and_narrow_outputs("cell-1");
        assert_eq!(output_cache_key(&stable[0]), first_key);

        let replacement = runtime_output_manifest("out-1", "second\n");
        assert!(handle
            .state_doc
            .replace_output("exec-1", "out-1", &replacement)
            .expect("replace output"));
        let state = handle.state_doc.read_state();
        let bumped = handle.build_output_changeset(&state);
        assert_eq!(bumped.changed.len(), 1);
        let bumped_key = output_cache_key(&bumped.changed[0].1);
        assert_eq!(bumped_key, "output:out-1:0:2");
        assert_ne!(bumped_key, first_key);

        let lookup = handle
            .get_output_by_id_value("out-1")
            .expect("lookup output");
        assert_eq!(output_cache_key(&lookup), bumped_key);
        let stored = handle
            .state_doc
            .get_output("exec-1", "out-1")
            .expect("stored output");
        assert!(
            stored.get(RUNT_OUTPUT_CACHE_KEY).is_none(),
            "cache key must be stamped on cloned output values only"
        );
    }

    #[test]
    fn output_cache_epoch_increments_after_load_state_doc() {
        let mut handle = handle_with_runtime_output("first\n");
        let before = handle.fetch_and_narrow_outputs("cell-1");
        assert_eq!(output_cache_key(&before[0]), "output:out-1:0:0");

        let bytes = handle.state_doc.doc_mut().save();
        handle.load_state_doc(&bytes).expect("reload state doc");

        let after = handle.fetch_and_narrow_outputs("cell-1");
        assert_eq!(output_cache_key(&after[0]), "output:out-1:1:0");
    }

    #[test]
    fn output_identity_epoch_bump_reemits_known_outputs_after_blob_port_change() {
        let mut handle = handle_with_runtime_output("first\n");

        let state = handle.state_doc.read_state();
        let first = handle.build_output_changeset(&state);
        assert_eq!(first.changed.len(), 1);

        let state = handle.state_doc.read_state();
        let unchanged = handle.build_output_changeset(&state);
        assert!(unchanged.is_empty());

        handle.set_blob_port(49152);
        assert!(
            handle.prev_output_by_id.is_empty(),
            "identity-affecting changes must invalidate the output diff basis"
        );

        let state = handle.state_doc.read_state();
        let reemitted = handle.build_output_changeset(&state);
        assert_eq!(reemitted.changed.len(), 1);
        assert_eq!(reemitted.changed[0].0, "out-1");
    }

    #[test]
    fn output_cache_key_requires_non_empty_output_id() {
        let handle =
            NotebookHandle::create_bootstrap("user:dev:test/browser:a").expect("create handle");

        let missing = handle.stamp_output_cache_key(json!({
            "output_type": "stream",
            "text": {"inline": "missing id\n"},
        }));
        assert!(missing.get(RUNT_OUTPUT_CACHE_KEY).is_none());

        let empty = handle.stamp_output_cache_key(json!({
            "output_type": "stream",
            "output_id": "",
            "text": {"inline": "empty id\n"},
        }));
        assert!(empty.get(RUNT_OUTPUT_CACHE_KEY).is_none());
    }

    #[test]
    fn save_since_heads_with_empty_basis_is_a_full_loadable_save() {
        let mut handle = handle_with_cell("cell-1", "x = 1");
        let bytes = handle
            .save_since_heads_inner(&[])
            .expect("save with empty basis");
        assert_eq!(bytes, handle.save(), "empty basis must equal save()");

        let loaded = NotebookHandle::load(&bytes).expect("load full bytes");
        assert_eq!(loaded.cell_count(), 1);
        assert_eq!(loaded.get_cell_source("cell-1").as_deref(), Some("x = 1"));
    }

    #[test]
    fn save_since_heads_yields_only_the_tail_and_concatenated_chunks_load() {
        let mut handle = handle_with_cell("cell-1", "x = 1");
        let snapshot = handle.save_since_heads_inner(&[]).expect("full save");
        let basis = handle.get_heads_hex();

        handle
            .add_cell(handle.cell_count(), "cell-2", "markdown")
            .expect("add second cell");
        handle.update_source("cell-2", "# title").expect("source");

        let incremental = handle
            .save_since_heads_inner(&basis)
            .expect("incremental save");
        assert!(!incremental.is_empty(), "tail changes must serialize");
        assert!(
            incremental.len() < snapshot.len(),
            "incremental must not re-serialize the whole doc"
        );

        // The chunk-store load path: snapshot chunk first, then the
        // incremental chunk, one load over the concatenation.
        let mut concatenated = snapshot.clone();
        concatenated.extend_from_slice(&incremental);
        let loaded = NotebookHandle::load(&concatenated).expect("load concatenated chunks");
        assert_eq!(loaded.cell_count(), 2);
        assert_eq!(loaded.get_cell_source("cell-2").as_deref(), Some("# title"));
    }

    #[test]
    fn save_since_heads_at_current_heads_is_empty() {
        let mut handle = handle_with_cell("cell-1", "x = 1");
        let heads = handle.get_heads_hex();
        let bytes = handle
            .save_since_heads_inner(&heads)
            .expect("save at current heads");
        assert!(bytes.is_empty(), "no changes beyond the current heads");
    }

    #[test]
    fn save_since_heads_rejects_malformed_heads() {
        let mut handle = handle_with_cell("cell-1", "x = 1");
        let err = handle
            .save_since_heads_inner(&["not-hex".to_string()])
            .expect_err("malformed hash must error");
        assert!(err.contains("invalid change hash"), "{err}");
    }

    #[test]
    fn save_since_heads_ignores_unknown_heads_yielding_overlap_never_a_gap() {
        let mut handle = handle_with_cell("cell-1", "x = 1");
        // A valid-format hash this doc has never seen (a stale basis from
        // another session). The dependency filter drops it, degrading to
        // a full-history payload.
        let unknown = "ab".repeat(32);
        let bytes = handle
            .save_since_heads_inner(&[unknown])
            .expect("unknown heads are filtered, not fatal");
        assert!(!bytes.is_empty(), "stale basis must still serialize");

        let mut fresh = NotebookHandle::create_bootstrap("user:dev:test/browser:b")
            .expect("create bootstrap peer");
        let event = fresh
            .apply_change_bytes_inner(&bytes)
            .expect("apply overlap payload");
        assert!(matches!(
            event,
            FrameEvent::SyncApplied { changed: true, .. }
        ));
        assert_eq!(fresh.cell_count(), 1);
    }

    #[test]
    fn apply_change_bytes_reports_sync_applied_shape_then_dedupes_known_changes() {
        let mut author = handle_with_cell("cell-1", "x = 1");
        let bytes = author.save_since_heads_inner(&[]).expect("full save");

        let mut peer = NotebookHandle::create_bootstrap("user:dev:test/browser:b")
            .expect("create bootstrap peer");
        let first = peer
            .apply_change_bytes_inner(&bytes)
            .expect("first apply succeeds");
        match first {
            FrameEvent::SyncApplied {
                changed,
                changeset,
                reply,
                ..
            } => {
                assert!(changed, "fresh changes must report changed=true");
                assert!(reply.is_none(), "apply path never carries a sync reply");
                let changeset = changeset.expect("changed apply carries a changeset");
                assert!(
                    changeset.added.contains(&"cell-1".to_string()),
                    "changeset must surface the added cell: {changeset:?}"
                );
            }
            _ => panic!("expected sync_applied event"),
        }
        assert_eq!(peer.cell_count(), 1);
        assert_eq!(peer.get_cell_source("cell-1").as_deref(), Some("x = 1"));

        // Re-applying the identical bytes is the two-tab ping-pong case:
        // load_incremental dedupes, changed must be false, and no
        // changeset may be emitted (nothing to re-trigger a broadcast).
        let second = peer
            .apply_change_bytes_inner(&bytes)
            .expect("re-apply succeeds");
        match second {
            FrameEvent::SyncApplied {
                changed, changeset, ..
            } => {
                assert!(!changed, "known changes must report changed=false");
                assert!(changeset.is_none(), "no changeset for a no-op apply");
            }
            _ => panic!("expected sync_applied event"),
        }
    }

    #[test]
    fn apply_change_bytes_applies_incremental_tails() {
        let mut author = handle_with_cell("cell-1", "x = 1");
        let snapshot = author.save_since_heads_inner(&[]).expect("full save");
        let basis = author.get_heads_hex();
        author.update_source("cell-1", "x = 2").expect("edit");
        let tail = author.save_since_heads_inner(&basis).expect("tail save");

        let mut peer = NotebookHandle::create_bootstrap("user:dev:test/browser:b")
            .expect("create bootstrap peer");
        peer.apply_change_bytes_inner(&snapshot)
            .expect("apply snapshot");
        let event = peer.apply_change_bytes_inner(&tail).expect("apply tail");
        match event {
            FrameEvent::SyncApplied {
                changed, changeset, ..
            } => {
                assert!(changed);
                let changeset = changeset.expect("tail apply carries a changeset");
                assert!(
                    changeset
                        .changed
                        .iter()
                        .any(|cell| cell.cell_id == "cell-1"),
                    "edited cell must appear in the changeset: {changeset:?}"
                );
            }
            _ => panic!("expected sync_applied event"),
        }
        assert_eq!(peer.get_cell_source("cell-1").as_deref(), Some("x = 2"));
        assert_eq!(peer.get_heads_hex(), author.get_heads_hex());
    }

    // -- pinned fork load contract for the chunked store ------------------
    //
    // The chunk store's crash/recovery invariants lean on two
    // fork-revision-sensitive behaviors of `Automerge::load` (pinned rev
    // 992effbf): an incremental-only buffer with absent dependencies must
    // HARD-ERROR (the resolver treats it as corruption: clear +
    // bootstrap), while a snapshot-first buffer with a dep-orphaned
    // incremental must load SILENTLY without materializing the orphan. A
    // future automerge bump that flips either would otherwise pass every
    // existing test.

    #[test]
    fn load_rejects_incremental_only_bytes_with_missing_dependencies() {
        let mut author = handle_with_cell("cell-1", "x = 1");
        let basis = author.get_heads_hex();
        author
            .add_cell(author.cell_count(), "cell-2", "code")
            .expect("add cell");
        let incremental = author
            .save_since_heads_inner(&basis)
            .expect("incremental save");
        assert!(!incremental.is_empty());

        // The deps (everything up to `basis`) exist only outside these
        // bytes: first chunk is a change chunk, queue stays non-empty,
        // OnPartialLoad::Error (the default) returns MissingDeps. Pinned
        // through NotebookDoc::load_with_encoding — the exact call
        // NotebookHandle::load wraps (its JsError wrapper aborts on
        // native targets, so the inner Result is asserted instead).
        assert!(
            NotebookDoc::load_with_encoding(
                &incremental,
                notebook_doc::TextEncoding::Utf16CodeUnit
            )
            .is_err(),
            "incremental-only buffer with missing deps must fail to load"
        );
    }

    #[test]
    fn load_tolerates_a_dep_orphaned_incremental_behind_a_snapshot_chunk() {
        let mut author = handle_with_cell("cell-1", "x = 1");
        let snapshot = author.save_since_heads_inner(&[]).expect("full save");
        let snapshot_heads = author.get_heads_hex();

        // c1: snapshot_heads -> mid (NOT serialized below — the gap).
        author.update_source("cell-1", "x = 2").expect("edit c1");
        let mid_heads = author.get_heads_hex();
        // c2: mid -> tip, serialized alone so its parent is missing.
        author
            .add_cell(author.cell_count(), "cell-2", "markdown")
            .expect("add cell");
        let orphan = author.save_since_heads_inner(&mid_heads).expect("tail");
        assert!(!orphan.is_empty());

        let mut concatenated = snapshot.clone();
        concatenated.extend_from_slice(&orphan);
        let mut loaded =
            NotebookHandle::load(&concatenated).expect("doc-chunk-first union must load");
        // The orphan is queued, never materialized: state is exactly the
        // snapshot's.
        assert_eq!(loaded.cell_count(), 1);
        assert_eq!(loaded.get_cell_source("cell-1").as_deref(), Some("x = 1"));
        assert_eq!(loaded.get_heads_hex(), snapshot_heads);
        // And `save()` (SaveOptions::default has retain_orphans: true)
        // keeps carrying the orphan rather than silently shedding it.
        let resaved = loaded.save();
        let mut reloaded = NotebookHandle::load(&resaved).expect("re-saved union loads");
        assert_eq!(reloaded.cell_count(), 1);
        assert_eq!(reloaded.get_heads_hex(), snapshot_heads);
    }

    #[test]
    fn apply_change_bytes_treats_garbage_as_a_no_op() {
        let mut peer = handle_with_cell("cell-1", "x = 1");
        let heads = peer.get_heads_hex();
        // On a non-empty doc, automerge's incremental load degrades an
        // unparseable buffer to a partial load of zero changes (it warns
        // and applies what parsed) — the bridge contract is that a bad
        // peer message can never corrupt the doc or report changed=true.
        let event = peer
            .apply_change_bytes_inner(&[1, 2, 3, 4])
            .expect("garbage degrades to a no-op apply");
        assert!(matches!(
            event,
            FrameEvent::SyncApplied { changed: false, .. }
        ));
        assert_eq!(peer.get_heads_hex(), heads, "doc heads must be untouched");
        assert_eq!(peer.cell_count(), 1);
    }
}
