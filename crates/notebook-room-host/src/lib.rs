//! Host-neutral state machine for one live notebook room.
//!
//! This crate owns document materialization, per-peer Automerge sync state,
//! authorization policy, execution intent, and room-host lifecycle repair. It
//! deliberately performs no network or storage I/O. Hosts feed it authenticated
//! peer events and persist the checkpoint bytes it returns.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use automerge::patches::PatchAction;
use automerge::sync;
use automerge::Prop;
use comments_doc::{CommentsDoc, CommentsProjection, NotebookCommentRef};
use notebook_doc::diff::{extract_change_actor_hashes, extract_change_actors, ChangeActor};
use notebook_doc::NotebookDoc;
use notebook_wire::frame_types;
use nteract_identity::{ActorLabel, ConnectionScope, Principal};
use runtime_doc::{
    runtime_state_policy_snapshot, validate_runtime_state_sync_scope, CommsDoc, QueueEntry,
    RuntimeLifecycle, RuntimeState, RuntimeStateDoc, RuntimeStateWriteScope,
    WorkstationAttachmentState,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use thiserror::Error;

/// A host-neutral room-engine failure.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct RoomHostError {
    message: String,
}

impl RoomHostError {
    fn new(message: impl AsRef<str>) -> Self {
        Self {
            message: message.as_ref().to_string(),
        }
    }
}

impl From<String> for RoomHostError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

impl From<&str> for RoomHostError {
    fn from(message: &str) -> Self {
        Self {
            message: message.to_string(),
        }
    }
}

/// One typed frame the host must deliver to a connected peer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RoomHostOutboundFrame {
    pub peer_id: String,
    pub frame_type: u8,
    pub payload: Vec<u8>,
}

/// Effects produced by applying one room event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RoomHostFrameResult {
    /// Execution receipt; the host must persist changes before sending it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_response: Option<RoomExecutionResponse>,
    pub changed: bool,
    pub ignored_stale: bool,
    pub notebook_changed: bool,
    pub runtime_state_changed: bool,
    pub outbound: Vec<RoomHostOutboundFrame>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum RoomExecutionResponse {
    CellQueued {
        cell_id: String,
        execution_id: String,
    },
    AllCellsQueued {
        queued: Vec<RoomQueuedCell>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RoomQueuedCell {
    pub cell_id: String,
    pub execution_id: String,
}

impl RoomHostFrameResult {
    fn empty() -> Self {
        Self {
            changed: false,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: false,
            execution_response: None,
            outbound: Vec::new(),
        }
    }
}

fn parse_requested_cell_execution_ids(
    request: &serde_json::Value,
) -> Result<Option<HashMap<String, String>>, RoomHostError> {
    let Some(raw) = request.get("cell_execution_ids") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    serde_json::from_value(raw.clone())
        .map(Some)
        .map_err(|error| RoomHostError::new(format!("decode cell_execution_ids: {error}")))
}

fn validate_requested_execution_ids(
    requested_execution_ids: Option<&HashMap<String, String>>,
    existing_execution_ids: &HashSet<String>,
    allocated_execution_ids: &mut HashSet<String>,
) -> Result<(), RoomHostError> {
    let Some(requested_execution_ids) = requested_execution_ids else {
        return Ok(());
    };

    let mut supplied = HashSet::new();
    for execution_id in requested_execution_ids.values() {
        if uuid::Uuid::parse_str(execution_id).is_err() {
            return Err(RoomHostError::new(format!(
                "execution_id is not a valid UUID: {execution_id}"
            )));
        }
        if !supplied.insert(execution_id.clone()) {
            return Err(RoomHostError::new(format!(
                "duplicate execution_id in request: {execution_id}"
            )));
        }
        if existing_execution_ids.contains(execution_id) {
            return Err(RoomHostError::new(format!(
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

/// The synchronous, host-neutral state machine for one live notebook room.
pub struct RoomHostEngine {
    doc: NotebookDoc,
    state_doc: RuntimeStateDoc,
    comms_doc: CommsDoc,
    comments_doc: CommentsDoc,
    notebook_peer_states: HashMap<String, sync::State>,
    runtime_peer_states: HashMap<String, sync::State>,
    comms_peer_states: HashMap<String, sync::State>,
    comments_peer_states: HashMap<String, sync::State>,
}

impl RoomHostEngine {
    /// Create an empty room from the canonical schema seeds.
    pub fn create_empty(notebook_id: &str, actor_label: &str) -> Result<Self, RoomHostError> {
        let (comments_doc_id, comments_ref) = hosted_comments_identity(notebook_id);
        Ok(Self {
            doc: NotebookDoc::new_with_actor(notebook_id, actor_label),
            state_doc: RuntimeStateDoc::try_new_empty().map_err(|error| {
                RoomHostError::new(format!("create runtime state doc failed: {error}"))
            })?,
            comms_doc: CommsDoc::try_new_empty()
                .map_err(|error| RoomHostError::new(format!("create comms doc failed: {error}")))?,
            comments_doc: CommentsDoc::try_new_empty(&comments_doc_id, &comments_ref).map_err(
                |error| RoomHostError::new(format!("create comments doc failed: {error}")),
            )?,
            notebook_peer_states: HashMap::new(),
            runtime_peer_states: HashMap::new(),
            comms_peer_states: HashMap::new(),
            comments_peer_states: HashMap::new(),
        })
    }

    /// Load the core room documents from persisted bytes.
    pub fn load_snapshot(
        notebook_bytes: &[u8],
        runtime_state_bytes: &[u8],
    ) -> Result<Self, RoomHostError> {
        let doc = NotebookDoc::load_with_encoding(
            notebook_bytes,
            notebook_doc::TextEncoding::Utf16CodeUnit,
        )
        .map_err(|error| RoomHostError::new(format!("load notebook snapshot failed: {error}")))?;
        let runtime_doc = automerge::AutoCommit::load(runtime_state_bytes).map_err(|error| {
            RoomHostError::new(format!("load runtime snapshot failed: {error}"))
        })?;
        let notebook_id = doc
            .notebook_id()
            .ok_or_else(|| RoomHostError::new("load room host snapshot missing notebook_id"))?;
        let (comments_doc_id, comments_ref) = hosted_comments_identity(&notebook_id);
        Ok(Self {
            doc,
            state_doc: RuntimeStateDoc::from_doc(runtime_doc),
            comms_doc: CommsDoc::try_new_empty()
                .map_err(|error| RoomHostError::new(format!("create comms doc failed: {error}")))?,
            comments_doc: CommentsDoc::try_new_empty(&comments_doc_id, &comments_ref).map_err(
                |error| RoomHostError::new(format!("create comments doc failed: {error}")),
            )?,
            notebook_peer_states: HashMap::new(),
            runtime_peer_states: HashMap::new(),
            comms_peer_states: HashMap::new(),
            comments_peer_states: HashMap::new(),
        })
    }

    /// Seed one initial code cell if the authoritative notebook is pristine.
    pub fn seed_initial_code_cell_if_empty(
        &mut self,
        cell_id: &str,
    ) -> Result<bool, RoomHostError> {
        if !self.doc.is_pristine() {
            return Ok(false);
        }
        self.doc
            .add_cell_after(cell_id, "code", None)
            .map_err(|error| {
                RoomHostError::new(format!("seed initial code cell failed: {error}"))
            })?;
        Ok(true)
    }

    /// Forget all ephemeral sync state for a disconnected peer.
    pub fn remove_peer(&mut self, peer_id: &str) {
        self.notebook_peer_states.remove(peer_id);
        self.runtime_peer_states.remove(peer_id);
        self.comms_peer_states.remove(peer_id);
        self.comments_peer_states.remove(peer_id);
    }

    /// Generate current document sync frames for a newly connected peer.
    pub fn sync_peer(
        &mut self,
        peer_id: &str,
        connection_scope: &str,
    ) -> Result<RoomHostFrameResult, RoomHostError> {
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
        Ok(result)
    }

    /// Apply one authenticated typed frame and return the resulting host effects.
    pub fn receive_peer_frame(
        &mut self,
        peer_id: &str,
        principal: &str,
        submitter_actor_label: &str,
        connection_scope: &str,
        can_write_all_notebook_changes: bool,
        frame_bytes: &[u8],
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        if frame_bytes.is_empty() {
            return Err(RoomHostError::new("typed frame cannot be empty"));
        }
        let connection_scope = parse_connection_scope(connection_scope)?;
        let runtime_scope = runtime_state_write_scope(connection_scope);
        let can_write_notebook = connection_scope.allows_notebook_write();
        let can_submit_execution_requests = allows_execution_request_submit(connection_scope);
        let can_write_comms = allows_comms_doc_write(connection_scope);
        let can_write_comments = allows_comments_doc_write(connection_scope);
        let frame_type = frame_bytes[0];
        let payload = &frame_bytes[1..];
        match frame_type {
            frame_types::AUTOMERGE_SYNC => self.receive_notebook_sync(
                peer_id,
                principal,
                can_write_notebook,
                can_write_all_notebook_changes,
                payload,
            ),
            frame_types::RUNTIME_STATE_SYNC => {
                self.receive_runtime_state_sync(peer_id, principal, runtime_scope, payload)
            }
            frame_types::COMMS_DOC_SYNC => {
                self.receive_comms_doc_sync(peer_id, principal, can_write_comms, payload)
            }
            frame_types::COMMENTS_DOC_SYNC => {
                self.receive_comments_doc_sync(peer_id, principal, can_write_comments, payload)
            }
            frame_types::REQUEST => self.receive_request(
                peer_id,
                submitter_actor_label,
                can_submit_execution_requests,
                payload,
            ),
            _ => Ok(RoomHostFrameResult::empty()),
        }
    }

    pub fn reconcile_runtime_peer_gone(
        &mut self,
        reason: &str,
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        self.reconcile_runtime_peer_gone_inner(reason)
    }

    pub fn reconcile_runtime_idle_timeout(
        &mut self,
        reason: &str,
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        self.reconcile_runtime_idle_timeout_inner(reason)
    }

    pub fn set_workstation_attachment(
        &mut self,
        attachment: Option<&WorkstationAttachmentState>,
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        self.set_workstation_attachment_inner(attachment)
    }

    pub fn workstation_attachment(&self) -> Option<WorkstationAttachmentState> {
        self.state_doc.workstation_attachment()
    }

    pub fn runtime_queue_depth(&self) -> usize {
        self.state_doc.read_state().queue.queued.len()
    }

    pub fn runtime_execution_activity(&self) -> RuntimeExecutionActivity {
        runtime_execution_activity(&self.state_doc.read_state())
    }

    pub fn save_notebook(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    pub fn save_runtime_state_doc(&mut self) -> Vec<u8> {
        self.state_doc.doc_mut().save()
    }

    pub fn save_comms_doc(&mut self) -> Vec<u8> {
        self.comms_doc.doc_mut().save()
    }

    pub fn save_comments_doc(&mut self) -> Vec<u8> {
        self.comments_doc.save()
    }

    pub fn load_comms_doc(&mut self, bytes: &[u8]) -> Result<(), RoomHostError> {
        let doc = automerge::AutoCommit::load(bytes)
            .map_err(|error| RoomHostError::new(format!("load comms snapshot failed: {error}")))?;
        self.comms_doc = CommsDoc::from_doc(doc);
        self.comms_peer_states.clear();
        Ok(())
    }

    pub fn load_comments_doc(&mut self, bytes: &[u8]) -> Result<(), RoomHostError> {
        self.load_comments_doc_inner(bytes)
            .map_err(RoomHostError::from)
    }

    pub fn notebook_heads_hex(&mut self) -> Vec<String> {
        self.doc.get_heads_hex()
    }

    pub fn runtime_state_heads_hex(&mut self) -> Vec<String> {
        self.state_doc
            .get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    pub fn comms_doc_heads_hex(&mut self) -> Vec<String> {
        self.comms_doc
            .get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    pub fn comments_doc_heads_hex(&mut self) -> Vec<String> {
        self.comments_doc
            .get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    pub fn comments_projection(&mut self) -> Result<CommentsProjection, RoomHostError> {
        let cell_order = self
            .doc
            .get_cells()
            .into_iter()
            .map(|cell| cell.id)
            .collect::<Vec<_>>();
        self.comments_doc
            .read_projection(Some(&cell_order))
            .map_err(|error| {
                RoomHostError::new(format!("read comments projection failed: {error}"))
            })
    }
}

impl RoomHostEngine {
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let message = sync::Message::decode(payload)
            .map_err(|e| RoomHostError::new(format!("decode notebook sync: {e}")))?;
        let has_changes = !message.changes.is_empty();
        if has_changes && !can_write {
            return Err(RoomHostError::new(
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
                .map_err(|e| RoomHostError::new(format!("notebook auth preview failed: {e}")))?;
            let actors = extract_change_actor_hashes(preview.doc_mut(), &heads_before);
            validate_room_notebook_change_actors(principal, actors.iter())?;
            if !can_write_all_notebook_changes {
                validate_editor_notebook_changes(&mut preview, &heads_before, actors.iter())
                    .map_err(|e| RoomHostError::new(&e))?;
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
                .map_err(|e| RoomHostError::new(format!("receive notebook sync: {e}")))?;
        }
        let heads_after = self.doc.get_heads();
        let changed = heads_before != heads_after;

        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: changed,
            runtime_state_changed: false,
            execution_response: None,
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let message = sync::Message::decode(payload)
            .map_err(|e| RoomHostError::new(format!("decode runtime state sync: {e}")))?;
        let has_changes = !message.changes.is_empty();
        let can_write = scope.allows_runtime_state_write();
        if has_changes && !can_write {
            return Err(RoomHostError::new(
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
                .map_err(|e| {
                    RoomHostError::new(format!("runtime state auth preview failed: {e}"))
                })?;
            let actors = extract_change_actors(preview.doc_mut(), &heads_before);
            validate_room_actor_labels(principal, actors.iter().map(String::as_str))?;
            let state_before = runtime_state_policy_snapshot(&self.state_doc);
            let state_after = runtime_state_policy_snapshot(&preview);
            validate_runtime_state_sync_scope(&state_before, &state_after, scope)
                .map_err(|e| RoomHostError::new(e.to_string()))?;
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
                .map_err(|e| RoomHostError::new(format!("receive runtime state sync: {e}")))?;
        }
        let heads_after = self.state_doc.get_heads();
        let changed = heads_before != heads_after;

        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            execution_response: None,
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let message = sync::Message::decode(payload)
            .map_err(|e| RoomHostError::new(format!("decode comms doc sync: {e}")))?;
        let has_changes = !message.changes.is_empty();
        if has_changes && !can_write {
            return Err(RoomHostError::new(
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
                .map_err(|e| RoomHostError::new(format!("comms auth preview failed: {e}")))?;
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
                .map_err(|e| RoomHostError::new(format!("receive comms doc sync: {e}")))?;
        }
        let heads_after = self.comms_doc.get_heads();
        let changed = heads_before != heads_after;

        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: false,
            execution_response: None,
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        self.receive_comments_doc_sync_inner(peer_id, principal, can_write, payload)
            .map_err(|error| RoomHostError::new(&error))
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
            execution_response: None,
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        if !can_submit_execution_requests {
            return Err(RoomHostError::new(
                "connection scope cannot submit execution requests",
            ));
        }
        let request: serde_json::Value = serde_json::from_slice(payload)
            .map_err(|e| RoomHostError::new(format!("decode request: {e}")))?;
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let cell_id = request
            .get("cell_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RoomHostError::new("ExecuteCell request missing cell_id"))?;

        let cell = self
            .doc
            .get_cell(cell_id)
            .ok_or_else(|| RoomHostError::new(format!("cell not found: {cell_id}")))?;
        if cell.cell_type != "code" {
            return Err(RoomHostError::new(format!(
                "cannot execute non-code cell {cell_id} (type {})",
                cell.cell_type
            )));
        }

        // Validate a caller-supplied ID even when the cell is already active.
        let requested_id = request.get("execution_id").and_then(|v| v.as_str());
        if let Some(id) = requested_id {
            if uuid::Uuid::parse_str(id).is_err() {
                return Err(RoomHostError::new(format!(
                    "execution_id is not a valid UUID: {id}"
                )));
            }
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
                // Match the daemon: explicit IDs cannot claim existing work,
                // even when the supplied ID matches the active execution.
                if requested_id.is_some() {
                    return Err(RoomHostError::new(format!(
                        "Cell already has an active execution: {active_id}"
                    )));
                }
                // No-op: nothing changed. The room logs the materialized frame
                // (notebook-room.ts room.materialized_frame.applied) with
                // changed=false, which is the observable signal here.
                let mut result = RoomHostFrameResult::empty();
                result.execution_response = Some(RoomExecutionResponse::CellQueued {
                    cell_id: cell_id.to_string(),
                    execution_id: active_id,
                });
                return Ok(result);
            }
        }

        // Absent a caller-supplied ID, the room mints it.
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
            .map_err(|e| RoomHostError::new(format!("create execution: {e}")))?;
        if !created {
            // Preserve the existing no-op for a previously used ID. This is
            // not a new queue acceptance, so it has no execution receipt.
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
            return Err(RoomHostError::new(format!(
                "stamp execution_id on cell: {e}"
            )));
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
            execution_response: Some(RoomExecutionResponse::CellQueued {
                cell_id: cell_id.to_string(),
                execution_id,
            }),
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let requested_execution_ids = parse_requested_cell_execution_ids(request)?;
        let cells = self.doc.get_cells();
        let code_cells: Vec<_> = cells
            .into_iter()
            .filter(|cell| cell.cell_type == "code")
            .collect();
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

        if code_cells.is_empty() {
            let mut result = RoomHostFrameResult::empty();
            result.execution_response =
                Some(RoomExecutionResponse::AllCellsQueued { queued: vec![] });
            return Ok(result);
        }

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
                .map_err(|e| RoomHostError::new(format!("create execution: {e}")))?;
            if !created {
                let _ = self.state_doc.remove_executions(&created_execution_ids);
                return Err(RoomHostError::new(format!(
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
                return Err(RoomHostError::new(format!(
                    "stamp execution_id on cell: {e}"
                )));
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
            execution_response: Some(RoomExecutionResponse::AllCellsQueued {
                queued: entries
                    .iter()
                    .map(|(execution_id, cell_id, _, _, _)| RoomQueuedCell {
                        cell_id: cell_id.clone(),
                        execution_id: execution_id.clone(),
                    })
                    .collect(),
            }),
            outbound: Vec::new(),
        };
        self.queue_runtime_state_sync_for_peer(peer_id, true, &mut result.outbound)?;
        self.queue_runtime_state_sync_for_other_peers(peer_id, &mut result.outbound)?;
        self.queue_notebook_sync_for_peer(peer_id, true, &mut result.outbound)?;
        self.queue_notebook_sync_for_other_peers(peer_id, &mut result.outbound)?;
        Ok(result)
    }

    fn append_queued_entries(&mut self, entries: &[QueueEntry]) -> Result<(), RoomHostError> {
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
            .map_err(|e| RoomHostError::new(format!("publish queued executions: {e}")))
    }

    fn queue_current_sync_for_peer(
        &mut self,
        peer_id: &str,
        can_write_notebook: bool,
        can_write_runtime_state: bool,
        can_write_comms: bool,
        can_write_comments: bool,
        outbound: &mut Vec<RoomHostOutboundFrame>,
    ) -> Result<(), RoomHostError> {
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
    ) -> Result<(), RoomHostError> {
        let peer_state = self
            .notebook_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .doc
            .generate_sync_message_recovering(peer_state, "cloud-room-doc-sync-outbound")
            .map_err(|e| RoomHostError::new(format!("generate notebook sync: {e}")))?
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
    ) -> Result<(), RoomHostError> {
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
    ) -> Result<(), RoomHostError> {
        let peer_state = self
            .runtime_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .state_doc
            .generate_sync_message_recovering(peer_state, "cloud-room-state-sync-outbound")
            .map_err(|e| RoomHostError::new(format!("generate runtime state sync: {e}")))?
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
    ) -> Result<(), RoomHostError> {
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
    ) -> Result<(), RoomHostError> {
        let peer_state = self
            .comms_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .comms_doc
            .generate_sync_message_recovering(peer_state, "cloud-room-comms-sync-outbound")
            .map_err(|e| RoomHostError::new(format!("generate comms doc sync: {e}")))?
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
    ) -> Result<(), RoomHostError> {
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
    ) -> Result<(), RoomHostError> {
        let peer_state = self
            .comments_peer_states
            .entry(peer_id.to_string())
            .or_insert_with(|| room_peer_sync_state(can_write));
        if let Some(message) = self
            .comments_doc
            .generate_sync_message_recovering(peer_state, "cloud-room-comments-sync-outbound")
            .map_err(|e| RoomHostError::new(format!("generate comments doc sync: {e}")))?
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
    ) -> Result<(), RoomHostError> {
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let heads_before = self.state_doc.get_heads();

        // 1. Resolve in-flight executions (running → error, queued →
        //    cancelled) and clear the queue, so viewers stop seeing
        //    perpetually-spinning cells and the idempotency guard in
        //    handle_execute_cell no longer suppresses re-runs of the
        //    orphaned work.
        self.state_doc
            .abort_inflight_executions()
            .map_err(|e| RoomHostError::new(format!("reconcile executions: {e}")))?;
        self.state_doc
            .set_queue(None, &[])
            .map_err(|e| RoomHostError::new(format!("reconcile queue: {e}")))?;

        // 2. Flip a still-live kernel to Error. Leave an already-terminal kernel
        //    (Error/Shutdown/NotStarted) untouched so a clean shutdown that raced
        //    the disconnect is not relabeled. "Live" = Running or any starting
        //    phase the dead peer last published.
        let lifecycle = self.state_doc.read_state().kernel.lifecycle;
        if lifecycle_is_live(&lifecycle) {
            let details = format!("runtime peer disconnected: {reason}");
            self.state_doc
                .set_lifecycle_with_error_details(&RuntimeLifecycle::Error, None, Some(&details))
                .map_err(|e| RoomHostError::new(format!("reconcile lifecycle: {e}")))?;
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
                .map_err(|e| {
                    RoomHostError::new(format!("reconcile workstation attachment: {e}"))
                })?;
        }

        let changed = self.state_doc.get_heads() != heads_before;
        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            execution_response: None,
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let state = self.state_doc.read_state();
        let activity = runtime_execution_activity(&state);
        if activity.executing || activity.queue_depth > 0 {
            return Ok(RoomHostFrameResult::empty());
        }
        drop(state);

        let heads_before = self.state_doc.get_heads();
        self.state_doc
            .set_queue(None, &[])
            .map_err(|e| RoomHostError::new(format!("reconcile idle queue: {e}")))?;

        let lifecycle = self.state_doc.read_state().kernel.lifecycle;
        if lifecycle_is_live(&lifecycle) {
            self.state_doc
                .set_lifecycle(&RuntimeLifecycle::Shutdown)
                .map_err(|e| RoomHostError::new(format!("reconcile idle lifecycle: {e}")))?;
        }

        if let Some(attachment) = runtime_idle_timeout_workstation_attachment(
            self.state_doc.workstation_attachment(),
            reason,
        ) {
            self.state_doc
                .set_workstation_attachment(Some(&attachment))
                .map_err(|e| {
                    RoomHostError::new(format!("reconcile idle workstation attachment: {e}"))
                })?;
        }

        let changed = self.state_doc.get_heads() != heads_before;
        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            execution_response: None,
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
    ) -> Result<RoomHostFrameResult, RoomHostError> {
        let heads_before = self.state_doc.get_heads();
        let current_attachment = self.state_doc.workstation_attachment();
        if workstation_attachment_publish_is_stale(current_attachment.as_ref(), attachment) {
            return Ok(RoomHostFrameResult {
                changed: false,
                ignored_stale: true,
                notebook_changed: false,
                runtime_state_changed: false,
                execution_response: None,
                outbound: Vec::new(),
            });
        }
        if attachment.is_some_and(runtime_peer_attachment_is_ready) {
            self.clear_stale_runtime_peer_gone_error()?;
        }
        self.state_doc
            .set_workstation_attachment(attachment)
            .map_err(|e| RoomHostError::new(format!("set workstation attachment: {e}")))?;
        let changed = self.state_doc.get_heads() != heads_before;
        let mut result = RoomHostFrameResult {
            changed,
            ignored_stale: false,
            notebook_changed: false,
            runtime_state_changed: changed,
            execution_response: None,
            outbound: Vec::new(),
        };
        if changed {
            self.queue_runtime_state_sync_for_other_peers("", &mut result.outbound)?;
        }
        Ok(result)
    }

    fn clear_stale_runtime_peer_gone_error(&mut self) -> Result<(), RoomHostError> {
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
            .map_err(|e| RoomHostError::new(format!("clear runtime peer gone lifecycle: {e}")))?;
        self.state_doc
            .set_runtime_agent_id("")
            .map_err(|e| RoomHostError::new(format!("clear runtime peer gone agent id: {e}")))
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RuntimeExecutionActivity {
    pub executing: bool,
    pub queue_depth: usize,
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

fn parse_connection_scope(scope: &str) -> Result<ConnectionScope, RoomHostError> {
    scope
        .parse()
        .map_err(|e| RoomHostError::new(format!("unknown connection scope: {e}")))
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
) -> Result<(), RoomHostError> {
    validate_room_actor_labels_inner(principal, labels).map_err(|error| RoomHostError::new(&error))
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
) -> Result<(), RoomHostError> {
    validate_room_notebook_change_actors_inner(principal, changes)
        .map_err(|error| RoomHostError::new(&error))
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

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::sync::SyncDoc;
    use serde_json::json;

    #[test]
    fn room_host_seeds_initial_code_cell_idempotently() {
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
            RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
    fn host_with_inflight_work() -> RoomHostEngine {
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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

    fn comments_doc_from_host(host: &mut RoomHostEngine, actor_label: &str) -> CommentsDoc {
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
        host: &mut RoomHostEngine,
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
        host: &mut RoomHostEngine,
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
    fn workstation_attachment_reads_current_attachment() {
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        assert_eq!(host.workstation_attachment(), None);

        host.set_workstation_attachment_inner(Some(&workstation_attachment_fixture()))
            .expect("set attachment");
        let attachment = host.workstation_attachment();
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
            host.runtime_queue_depth(),
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
            host.runtime_queue_depth(),
            2,
            "queue-depth accessor reflects every queued run-all execution"
        );
    }

    #[test]
    fn hosted_execute_cell_fans_out_runtime_state_to_runtime_peer() {
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
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
        let mut host = RoomHostEngine::create_empty("demo", "system/schema:notebook-cloud-room")
            .expect("create room host");
        host.seed_initial_code_cell_if_empty("cell-1")
            .expect("seed code cell");
        host.doc.update_source("cell-1", "1 + 1").expect("source");

        // A valid client-supplied UUID is used verbatim as the execution id.
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
    fn execution_receipts_identify_new_and_already_active_executions() {
        let mut host = RoomHostEngine::create_empty("receipt", "system/host").unwrap();
        host.seed_initial_code_cell_if_empty("cell-1").unwrap();
        let request = json!({"action":"execute_cell", "cell_id":"cell-1"});
        let first = host
            .handle_execute_cell(&request, "peer", "user:dev:alice/client:a")
            .unwrap();
        let id = host.doc.get_execution_id("cell-1").unwrap();
        let expected = json!({"result":"cell_queued", "cell_id":"cell-1", "execution_id":id});
        assert_eq!(
            serde_json::to_value(&first.execution_response).unwrap(),
            expected
        );
        let retry = host
            .handle_execute_cell(&request, "peer", "user:dev:alice/client:a")
            .unwrap();
        assert!(!retry.changed);
        assert_eq!(retry.execution_response, first.execution_response);
        assert_eq!(host.runtime_queue_depth(), 1);
        let invalid = json!({"action":"execute_cell", "cell_id":"missing"});
        assert!(host
            .handle_execute_cell(&invalid, "peer", "user:dev:alice/client:a")
            .is_err());
    }

    #[test]
    fn idle_execution_rejects_malformed_id_without_mutation() {
        let mut host = RoomHostEngine::create_empty("receipt", "system/host").unwrap();
        host.seed_initial_code_cell_if_empty("cell-1").unwrap();
        let notebook_heads = host.doc.get_heads();
        let runtime_heads = host.state_doc.get_heads();
        let error = host
            .handle_execute_cell(
                &json!({"cell_id":"cell-1", "execution_id":"invalid"}),
                "peer",
                "user:dev:alice/client:a",
            )
            .unwrap_err();
        assert!(error.to_string().contains("valid UUID"));
        assert_eq!(host.doc.get_heads(), notebook_heads);
        assert_eq!(host.state_doc.get_heads(), runtime_heads);
        assert!(host.state_doc.read_state().executions.is_empty());
        assert!(host.doc.get_execution_id("cell-1").is_none());
    }

    #[test]
    fn active_execution_rejects_supplied_ids_without_mutation() {
        for running in [false, true] {
            let mut host = RoomHostEngine::create_empty("receipt", "system/host").unwrap();
            host.seed_initial_code_cell_if_empty("cell-1").unwrap();
            let request = json!({"action":"execute_cell", "cell_id":"cell-1"});
            let first = host
                .handle_execute_cell(&request, "peer", "user:dev:alice/client:a")
                .unwrap();
            let active_id = host.doc.get_execution_id("cell-1").unwrap();
            if running {
                host.state_doc.set_execution_running(&active_id).unwrap();
            }
            let notebook_heads = host.doc.get_heads();
            let runtime_heads = host.state_doc.get_heads();
            for (supplied, expected) in [
                (active_id.as_str(), "active execution"),
                ("11111111-1111-4111-8111-111111111111", "active execution"),
                ("invalid", "valid UUID"),
            ] {
                let error = host.handle_execute_cell(
                    &json!({"action":"execute_cell", "cell_id":"cell-1", "execution_id":supplied}),
                    "peer", "user:dev:alice/client:a",
                ).unwrap_err();
                assert!(error.to_string().contains(expected), "{error}");
                assert_eq!(host.doc.get_heads(), notebook_heads);
                assert_eq!(host.state_doc.get_heads(), runtime_heads);
            }
            // Requests without an ID still discover the existing execution.
            let retry = host
                .handle_execute_cell(&request, "peer", "user:dev:alice/client:a")
                .unwrap();
            assert_eq!(retry.execution_response, first.execution_response);
            assert_eq!(host.state_doc.read_state().executions.len(), 1);
        }
    }

    #[test]
    fn empty_run_all_validates_supplied_ids_without_mutation() {
        let mut host = RoomHostEngine::create_empty("receipt", "system/host").unwrap();
        host.seed_initial_code_cell_if_empty("cell-1").unwrap();
        host.handle_execute_cell(
            &json!({"cell_id":"cell-1"}),
            "peer",
            "user:dev:alice/client:a",
        )
        .unwrap();
        let existing_id = host.doc.get_execution_id("cell-1").unwrap();
        host.doc.delete_cell("cell-1").unwrap();
        let fresh_id = "11111111-1111-4111-8111-111111111111";
        let notebook_heads = host.doc.get_heads();
        let runtime_heads = host.state_doc.get_heads();
        for (ids, expected) in [
            (json!({"missing":"invalid"}), "valid UUID"),
            (json!({"missing":existing_id}), "already exists"),
            (
                json!({"one":fresh_id,"two":fresh_id}),
                "duplicate execution_id",
            ),
        ] {
            let error = host
                .handle_run_all_cells(
                    &json!({"cell_execution_ids":ids}),
                    "peer",
                    "user:dev:alice/client:a",
                )
                .unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
            assert_eq!(host.doc.get_heads(), notebook_heads);
            assert_eq!(host.state_doc.get_heads(), runtime_heads);
        }
        let empty = host
            .handle_run_all_cells(
                &json!({"cell_execution_ids":{"missing":fresh_id}}),
                "peer",
                "user:dev:alice/client:a",
            )
            .unwrap();
        assert_eq!(
            empty.execution_response,
            Some(RoomExecutionResponse::AllCellsQueued { queued: vec![] })
        );
        assert_eq!(host.doc.get_heads(), notebook_heads);
        assert_eq!(host.state_doc.get_heads(), runtime_heads);
    }

    #[test]
    fn run_all_receipt_matches_persisted_queue() {
        let mut host = RoomHostEngine::create_empty("receipt", "system/host").unwrap();
        let empty = host
            .handle_run_all_cells(&json!({}), "peer", "user:dev:alice/client:a")
            .unwrap();
        assert_eq!(
            serde_json::to_value(empty.execution_response).unwrap(),
            json!({"result":"all_cells_queued","queued":[]})
        );
        host.seed_initial_code_cell_if_empty("cell-1").unwrap();
        let result = host
            .handle_run_all_cells(&json!({}), "peer", "user:dev:alice/client:a")
            .unwrap();
        let id = host.doc.get_execution_id("cell-1").unwrap();
        assert_eq!(
            serde_json::to_value(result.execution_response).unwrap(),
            json!({"result":"all_cells_queued","queued":[{"cell_id":"cell-1","execution_id":id}]})
        );
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
}
