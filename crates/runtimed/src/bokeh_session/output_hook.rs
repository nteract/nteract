//! Bokeh document sessions on the generic output hook seams.
//!
//! Agent side ([`BokehAgentOutputHook`]): strip the ingested `session_doc`
//! from the stored payload, build the epoch-0 session document, write its
//! RuntimeStateDoc record in the output's transaction and hand the document
//! to the agent's store after the commit. Room side
//! ([`BokehRoomOutputHook`]): write a connected session's live state into the
//! saved payload's `snapshot` and retire sessions whose outputs are gone.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures::future::BoxFuture;
use notebook_doc::NotebookDoc;
use notebook_protocol::protocol::RuntimeAgentRequest;
use runtime_doc::{BokehSessionStatus, RuntimeStateDoc, RuntimeStateError, RuntimeStateHandle};
use serde_json::Value;
use tracing::warn;

use super::hub::BokehRoomKind;
use super::materialize::frozen_payload;
use super::store::BokehSessionStore;
use super::{
    prepare_initial_session, strip_ingested_session_doc, PreparedInitialBokehSession,
    BOKEH_SESSION_MIME,
};
use crate::blob_store::BlobStore;
use crate::keyed_doc::KeyedDocHub;
use crate::output_hooks::{OutputHook, OutputHookInput, PreparedOutput};

/// Top-level payload keys a save or freeze may rewrite. Everything else,
/// `document` included, stays byte-equal to the durable execution record.
const MUTABLE_REPLAY_FIELDS: &[&str] = &["snapshot"];

pub(crate) struct BokehAgentOutputHook {
    store: Option<BokehSessionStore>,
}

impl BokehAgentOutputHook {
    /// `store` adopts each committed epoch-0 document; without one every
    /// Bokeh output stays a static render.
    pub(crate) fn new(store: Option<BokehSessionStore>) -> Self {
        Self { store }
    }
}

impl OutputHook for BokehAgentOutputHook {
    fn mime(&self) -> &'static str {
        BOKEH_SESSION_MIME
    }

    fn transform_for_storage(&self, nbformat_value: &Value) -> Option<Value> {
        strip_ingested_session_doc(nbformat_value)
    }

    fn prepare<'a>(
        &'a self,
        input: OutputHookInput<'a>,
    ) -> BoxFuture<'a, anyhow::Result<Option<Box<dyn PreparedOutput>>>> {
        Box::pin(async move {
            // A coordinator that does not route session documents would leave
            // a live record nobody can sync; the payload renders statically.
            let Some(store) = self.store.as_ref().filter(|store| store.accepts_sessions()) else {
                return Ok(None);
            };
            let session = prepare_initial_session(
                input.execution_id,
                input.nbformat_value,
                input.manifest,
                input.ctx,
            )
            .await?;
            Ok(session.map(|session| {
                Box::new(PreparedBokehSession {
                    session,
                    store: store.clone(),
                    state: input.ctx.state.clone(),
                    kernel_actor: input.ctx.kernel_actor_id.clone(),
                }) as Box<dyn PreparedOutput>
            }))
        })
    }
}

struct PreparedBokehSession {
    session: PreparedInitialBokehSession,
    store: BokehSessionStore,
    state: RuntimeStateHandle,
    kernel_actor: String,
}

impl PreparedOutput for PreparedBokehSession {
    fn apply_in_txn(&mut self, state: &mut RuntimeStateDoc) -> Result<bool, RuntimeStateError> {
        // Session provenance and terminal state survive delayed or repeated
        // publication of the same initial descriptor.
        if state.get_bokeh_session(&self.session.session_id).is_some() {
            return Ok(false);
        }
        state.put_bokeh_session(&self.session.session_id, &self.session.state)?;
        Ok(true)
    }

    fn after_commit(self: Box<Self>) {
        let PreparedBokehSession {
            session,
            store,
            state,
            kernel_actor,
        } = *self;
        let session_id = session.session_id;
        if store.insert(
            &session_id,
            session.doc,
            &session.state.kernel_id,
            &kernel_actor,
        ) || store.contains(&session_id)
        {
            return;
        }
        // Routing ended between prepare and commit: nothing will ever sync
        // this record, so it must not claim to be live.
        if let Err(error) = state.with_doc(|doc| {
            let Some(mut record) = doc.get_bokeh_session(&session_id) else {
                return Ok(());
            };
            if record.status == BokehSessionStatus::Connected {
                record.status = BokehSessionStatus::Disconnected;
                doc.put_bokeh_session(&session_id, &record)?;
            }
            Ok(())
        }) {
            warn!("[bokeh-session] Failed to disconnect unadopted session {session_id}: {error}");
        }
    }
}

/// The room state a save reads a session's live state from.
#[derive(Clone)]
pub(crate) struct BokehRoomOutputs {
    pub(crate) kind: Arc<BokehRoomKind>,
    pub(crate) hub: Arc<KeyedDocHub>,
    pub(crate) state: RuntimeStateHandle,
    pub(crate) blob_store: Arc<BlobStore>,
}

pub(crate) struct BokehRoomOutputHook {
    room: Option<BokehRoomOutputs>,
}

impl BokehRoomOutputHook {
    /// Without `room`, saves keep payloads as stored; used for the
    /// process-wide replay field policy.
    pub(crate) fn new(room: Option<BokehRoomOutputs>) -> Self {
        Self { room }
    }
}

impl BokehRoomOutputs {
    /// The payload with `snapshot` set to the live state, only for sessions
    /// whose record is connected: a frozen payload is final, and a session
    /// whose state cannot be fully materialized keeps the stored payload.
    async fn saved_payload(&self, payload: &Value) -> Option<Value> {
        let parsed;
        let payload = match payload {
            Value::String(text) => {
                parsed = serde_json::from_str::<Value>(text).ok()?;
                &parsed
            }
            other => other,
        };
        let session_id = payload.get("session_id")?.as_str()?;
        let connected = self
            .state
            .read(|doc| doc.get_bokeh_session(session_id))
            .ok()
            .flatten()
            .is_some_and(|record| record.status == BokehSessionStatus::Connected);
        if !connected {
            return None;
        }
        let session = self.kind.snapshot_with_tail(&self.hub, session_id)?;
        match frozen_payload(payload, &session, &self.blob_store).await {
            Ok(saved) => Some(saved),
            Err(error) => {
                warn!("[bokeh-session] Saving {session_id} without its live state: {error}");
                None
            }
        }
    }
}

impl OutputHook for BokehRoomOutputHook {
    fn mime(&self) -> &'static str {
        BOKEH_SESSION_MIME
    }

    fn materialize_for_save<'a>(&'a self, payload: &'a Value) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async move { self.room.as_ref()?.saved_payload(payload).await })
    }

    fn mutable_replay_fields(&self) -> &'static [&'static str] {
        MUTABLE_REPLAY_FIELDS
    }

    fn retirement_requests(
        &self,
        notebook: &NotebookDoc,
        state: &RuntimeStateDoc,
        sent: &mut HashSet<String>,
    ) -> Vec<RuntimeAgentRequest> {
        let mut requests = Vec::new();
        for (kernel_id, session_ids) in retired_sessions(notebook, state) {
            let session_ids: Vec<_> = session_ids
                .into_iter()
                .filter(|session_id| {
                    sent.insert(format!("{BOKEH_SESSION_MIME}\0{kernel_id}\0{session_id}"))
                })
                .collect();
            if !session_ids.is_empty() {
                requests.push(RuntimeAgentRequest::RetireBokehSessions {
                    kernel_id,
                    session_ids,
                });
            }
        }
        requests
    }
}

/// A session is live while any current notebook cell references its output.
/// Historical execution records and viewer presence do not own live resources.
fn retired_sessions(doc: &NotebookDoc, state: &RuntimeStateDoc) -> HashMap<String, Vec<String>> {
    let sessions: Vec<_> = state
        .get_bokeh_sessions()
        .into_iter()
        .filter(|(_, session)| session.status == BokehSessionStatus::Connected)
        .collect();
    if sessions.is_empty() {
        return HashMap::new();
    }
    let live_executions: HashSet<_> = doc
        .get_cell_ids()
        .iter()
        .filter_map(|cell_id| doc.get_execution_id(cell_id))
        .collect();
    let outputs: Vec<_> = live_executions
        .iter()
        .flat_map(|id| state.get_outputs(id))
        .collect();
    let mut retired = HashMap::<String, Vec<String>>::new();
    for (session_id, session) in sessions {
        let original = state.get_output(&session.execution_id, &session.output_id);
        let original_payload = original
            .as_ref()
            .and_then(|output| output.get("data"))
            .and_then(|data| data.get(BOKEH_SESSION_MIME));
        let referenced = outputs.iter().any(|output| {
            let Some(payload) = output
                .get("data")
                .and_then(|data| data.get(BOKEH_SESSION_MIME))
            else {
                return false;
            };
            if let Some(id) = output
                .get("metadata")
                .and_then(|metadata| metadata.get(BOKEH_SESSION_MIME))
                .and_then(|metadata| metadata.get("session_id"))
                .and_then(serde_json::Value::as_str)
            {
                // An update may retain output_id while replacing the Bokeh
                // session. Conversely, copied outputs may mint a new id.
                return id == session_id;
            }
            output.get("output_id").and_then(serde_json::Value::as_str)
                == Some(session.output_id.as_str())
                || original_payload == Some(payload)
        });
        if !referenced {
            retired
                .entry(session.kernel_id)
                .or_default()
                .push(session_id);
        }
    }
    retired
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) fn retirement_fixture() -> (NotebookDoc, RuntimeStateDoc) {
    let mut doc = NotebookDoc::new("bokeh-retirement");
    doc.add_cell(0, "cell-1", "code").unwrap();
    doc.set_execution_id("cell-1", Some("exec-1")).unwrap();
    let mut state = RuntimeStateDoc::new();
    state
        .create_execution_with_source_provenance("exec-1", "panel_output", 0, None, Some("cell-1"))
        .unwrap();
    state
        .append_output(
            "exec-1",
            &serde_json::json!({
                "output_type": "display_data", "output_id": "output-1",
                "data": {BOKEH_SESSION_MIME: {"blob": "descriptor", "size": 2000}},
                "metadata": {BOKEH_SESSION_MIME: {"session_id": "session-1"}}
            }),
        )
        .unwrap();
    state
        .put_bokeh_session(
            "session-1",
            &serde_json::from_value(serde_json::json!({
                "output_id": "output-1", "execution_id": "exec-1", "cell_id": "cell-1",
                "kernel_id": "kernel-1", "status": "connected", "epoch": 0,
                "producer_name": "panel", "producer_version": "1", "bokeh_version": "3"
            }))
            .unwrap(),
        )
        .unwrap();
    (doc, state)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::keyed_doc::AgentDocs;
    use crate::output_blob_publisher::OutputBlobPublisher;
    use crate::output_commit_context::OutputCommitContext;
    use crate::output_committer::{
        start_output_committer, OrdinaryOutputCommit, OrdinaryOutputKind, OutputCommitterHandle,
    };
    use crate::output_hooks::OutputHookRegistry;
    use crate::output_redaction::OutputRedactor;
    use crate::output_store::ContentRef;

    /// A store whose availability follows the coordinator's advertised
    /// kinds, as in production.
    fn routed_store(routed: bool) -> (BokehSessionStore, AgentDocs) {
        let mut docs = AgentDocs::new(
            tokio::sync::broadcast::channel(1).0,
            tokio::sync::broadcast::channel(1).0,
        );
        let store = BokehSessionStore::new(
            runtime_doc::BokehReplacementPolicy::default(),
            docs.availability(),
        );
        docs.register(Arc::new(store.clone()));
        docs.set_coordinator_kinds(routed.then(|| super::super::BOKEH_SESSION_KIND.to_string()));
        (store, docs)
    }

    struct Committer {
        _dir: tempfile::TempDir,
        blob_store: Arc<BlobStore>,
        state: RuntimeStateHandle,
        store: BokehSessionStore,
        _docs: AgentDocs,
        handle: OutputCommitterHandle,
    }

    impl Committer {
        fn new(routed: bool) -> Self {
            let dir = tempfile::TempDir::new().expect("tempdir");
            let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
            let state_doc = RuntimeStateDoc::try_new_with_actor("test-runtime").expect("state doc");
            let state = RuntimeStateHandle::new(state_doc, tokio::sync::broadcast::channel(8).0);
            state
                .with_doc(|doc| {
                    doc.create_execution_with_source_provenance(
                        "exec-1",
                        "panel_output",
                        0,
                        None,
                        Some("cell-1"),
                    )?;
                    Ok(())
                })
                .expect("execution entry");
            let (store, docs) = routed_store(routed);
            let hooks = OutputHookRegistry::new(vec![Arc::new(BokehAgentOutputHook::new(Some(
                store.clone(),
            )))]);
            let handle = start_output_committer(
                OutputCommitContext::new(
                    state.clone(),
                    blob_store.clone(),
                    OutputBlobPublisher::none(),
                    "rt:kernel:test".to_string(),
                    "kernel-test".to_string(),
                    tokio::sync::mpsc::unbounded_channel().0,
                    Arc::new(OutputRedactor::disabled()),
                )
                .with_output_hooks(hooks),
            );
            Self {
                _dir: dir,
                blob_store,
                state,
                store,
                _docs: docs,
                handle,
            }
        }

        async fn commit(&self, output: &Value) {
            self.handle
                .enqueue_output(OrdinaryOutputCommit {
                    execution_id: "exec-1".to_string(),
                    nbformat_value: output.clone(),
                    buffers: Vec::new(),
                    kind: OrdinaryOutputKind::DisplayData,
                })
                .await;
            self.handle.flush_for_ordering().await;
        }

        async fn stored_payload(&self) -> Value {
            let outputs = self.state.read(|doc| doc.get_outputs("exec-1")).unwrap();
            let content: ContentRef =
                serde_json::from_value(outputs[0]["data"][BOKEH_SESSION_MIME].clone()).unwrap();
            serde_json::from_str(&content.resolve(&self.blob_store).await.unwrap()).unwrap()
        }
    }

    async fn initial_output(blob_store: &BlobStore) -> Value {
        let column = serde_json::json!({"type": "ndarray", "array": {"type": "bytes", "data": {"id": "b1"}}});
        let buffer_hash = blob_store
            .put(&[1u8, 2, 3, 4], "application/octet-stream")
            .await
            .unwrap();
        serde_json::json!({
            "output_type": "display_data",
            "data": {
                BOKEH_SESSION_MIME: {
                    "schema_version": 1,
                    "session_id": "session-1",
                    "producer": {"name": "panel", "version": "1.9.3"},
                    "bokeh_version": "3.9.1",
                    "document": {"version": "3.9.1", "roots": [{"id": "p1001"}]},
                    "session_doc": {
                        "meta": {"session_id": "session-1", "producer_name": "panel",
                                 "producer_version": "1.9.3", "bokeh_version": "3.9.1",
                                 "root_ids": ["p1001"], "title": "Bokeh Application"},
                        "models": {
                            "p1001": {"type": "Slider", "ref_props": ["js_property_callbacks"],
                                      "props": {"value": 4, "title": "Value"}},
                            "p1002": {"type": "ColumnDataSource", "ref_props": ["selected"],
                                      "props": {}},
                        },
                        "data_events": [{"kind": "ColumnsFolded", "source_id": "p1002",
                                         "version": 0, "columns": {"x": column}}],
                    },
                    "root_ids": ["p1001"],
                    "resources": {"javascript": [], "stylesheets": []},
                    "buffers": [],
                    "session_doc_buffers": [{"id": "b1", "hash": buffer_hash, "size": 4,
                                             "buffer_index": 0}],
                },
                "text/plain": "FloatSlider(value=4)",
            },
            "metadata": {},
        })
    }

    #[tokio::test]
    async fn initial_bokeh_output_records_document_session_atomically() {
        let committer = Committer::new(true);
        let output = initial_output(&committer.blob_store).await;
        committer.commit(&output).await;

        let session = committer
            .state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("Bokeh session");
        assert_eq!(session.cell_id, "cell-1");
        assert_eq!(session.execution_id, "exec-1");
        assert_eq!(session.kernel_id, "kernel-test");
        assert_eq!(session.epoch, 0);
        assert_eq!(committer.store.epoch("session-1"), Some(0));
        let doc_heads = committer
            .store
            .with_doc("session-1", |doc| {
                let snapshot = doc.read_snapshot().unwrap();
                assert_eq!(snapshot.meta.title.as_deref(), Some("Bokeh Application"));
                assert_eq!(snapshot.models["p1001"].props["value"], "4");
                assert_eq!(
                    snapshot.models["p1001"].ref_props,
                    vec!["js_property_callbacks"]
                );
                assert_eq!(snapshot.columns["p1002"]["x"].version, 0);
                super::super::hex_heads(&doc.get_heads())
            })
            .unwrap();
        assert_eq!(session.doc_heads, doc_heads);

        let outputs = committer
            .state
            .read(|doc| doc.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["output_id"], session.output_id);
        let stored = committer.stored_payload().await;
        assert!(
            stored.get("session_doc").is_none() && stored.get("session_doc_buffers").is_none(),
            "ingested state is not duplicated"
        );
        assert_eq!(stored["document"]["roots"][0]["id"], "p1001");

        let mut closed = session;
        closed.status = BokehSessionStatus::Closed;
        committer
            .state
            .with_doc(|doc| doc.put_bokeh_session("session-1", &closed))
            .unwrap();
        committer.commit(&output).await;
        assert_eq!(
            committer
                .state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap(),
            Some(closed),
            "late initial output must not reopen a retired session"
        );
    }

    /// Fix 1: a coordinator that does not route `bokeh_session` gets a
    /// static output, with no record and no session in the store.
    #[tokio::test]
    async fn unrouted_bokeh_outputs_stay_static() {
        let committer = Committer::new(false);
        let output = initial_output(&committer.blob_store).await;
        committer.commit(&output).await;
        assert_eq!(
            committer
                .state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap(),
            None
        );
        assert_eq!(committer.store.epoch("session-1"), None);
        let stored = committer.stored_payload().await;
        assert!(stored.get("session_doc").is_none());
        assert_eq!(stored["document"]["roots"][0]["id"], "p1001");
    }

    /// Routing can end (reconnect reset or frame rejection) between prepare
    /// and the commit; the record then ends disconnected, not live forever.
    #[tokio::test]
    async fn a_refused_adoption_after_commit_disconnects_the_record() {
        let mut committer = Committer::new(true);
        let output = initial_output(&committer.blob_store).await;
        let hook = BokehAgentOutputHook::new(Some(committer.store.clone()));
        let manifest = crate::output_store::create_manifest(
            &output,
            &committer.blob_store,
            crate::output_store::DEFAULT_INLINE_THRESHOLD,
        )
        .await
        .unwrap();
        let ctx = OutputCommitContext::new(
            committer.state.clone(),
            committer.blob_store.clone(),
            OutputBlobPublisher::none(),
            "rt:kernel:test".to_string(),
            "kernel-test".to_string(),
            tokio::sync::mpsc::unbounded_channel().0,
            Arc::new(OutputRedactor::disabled()),
        );
        let mut prepared = hook
            .prepare(OutputHookInput {
                execution_id: "exec-1",
                nbformat_value: &output,
                manifest: &manifest,
                ctx: &ctx,
            })
            .await
            .unwrap()
            .expect("live while routed");
        assert!(committer
            .state
            .with_doc(|doc| prepared.apply_in_txn(doc))
            .unwrap());

        committer._docs.set_coordinator_kinds(None::<String>);
        prepared.after_commit();

        assert!(!committer.store.contains("session-1"));
        let record = committer
            .state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .unwrap()
            .unwrap();
        assert_eq!(record.status, BokehSessionStatus::Disconnected);
    }

    #[tokio::test]
    async fn a_payload_without_session_doc_is_static_even_when_routed() {
        let committer = Committer::new(true);
        let mut output = initial_output(&committer.blob_store).await;
        let payload = output["data"][BOKEH_SESSION_MIME].as_object_mut().unwrap();
        payload.remove("session_doc");
        payload.remove("session_doc_buffers");
        // A missing producer would fail a live prepare; static skips it.
        payload.remove("producer");
        let hook = BokehAgentOutputHook::new(Some(committer.store.clone()));
        let manifest = crate::output_store::create_manifest(
            &output,
            &committer.blob_store,
            crate::output_store::DEFAULT_INLINE_THRESHOLD,
        )
        .await
        .unwrap();
        let ctx = OutputCommitContext::new(
            committer.state.clone(),
            committer.blob_store.clone(),
            OutputBlobPublisher::none(),
            "rt:kernel:test".to_string(),
            "kernel-test".to_string(),
            tokio::sync::mpsc::unbounded_channel().0,
            Arc::new(OutputRedactor::disabled()),
        );
        let prepared = hook
            .prepare(OutputHookInput {
                execution_id: "exec-1",
                nbformat_value: &output,
                manifest: &manifest,
                ctx: &ctx,
            })
            .await
            .expect("not an error");
        assert!(prepared.is_none());

        committer.commit(&output).await;
        assert_eq!(
            committer
                .state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap(),
            None
        );
        assert!(!committer.store.contains("session-1"));
        assert_eq!(
            committer.stored_payload().await["document"]["roots"][0]["id"],
            "p1001"
        );
    }

    #[tokio::test]
    async fn a_room_hook_without_room_state_keeps_payloads_and_declares_snapshot() {
        let hook = BokehRoomOutputHook::new(None);
        assert_eq!(hook.mutable_replay_fields(), ["snapshot"]);
        let payload = serde_json::json!({"session_id": "session-1", "document": {}});
        assert_eq!(hook.materialize_for_save(&payload).await, None);
    }

    #[test]
    fn retirement_requests_are_sent_once_per_connection() {
        let (mut doc, state) = retirement_fixture();
        let mut sent = HashSet::new();
        assert!(BokehRoomOutputHook::new(None)
            .retirement_requests(&doc, &state, &mut sent)
            .is_empty());
        doc.delete_cell("cell-1").unwrap();
        let requests = BokehRoomOutputHook::new(None).retirement_requests(&doc, &state, &mut sent);
        assert!(matches!(
            requests.as_slice(),
            [RuntimeAgentRequest::RetireBokehSessions { kernel_id, session_ids }]
                if kernel_id == "kernel-1" && session_ids == &["session-1"]
        ));
        assert!(BokehRoomOutputHook::new(None)
            .retirement_requests(&doc, &state, &mut sent)
            .is_empty());
        assert!(
            BokehRoomOutputHook::new(None)
                .retirement_requests(&doc, &state, &mut HashSet::new())
                .len()
                == 1
        );
    }

    #[test]
    fn bokeh_retirement_replacement_clear_and_delete() {
        for operation in [
            "replace",
            "clear",
            "delete",
            "clear_output",
            "replace_output",
            "replace_bokeh_output",
        ] {
            let (mut doc, mut state) = retirement_fixture();
            assert!(retired_sessions(&doc, &state).is_empty());
            match operation {
                "replace" => {
                    doc.set_execution_id("cell-1", Some("exec-2")).unwrap();
                }
                "clear" => {
                    doc.set_execution_id("cell-1", None).unwrap();
                }
                "delete" => {
                    doc.delete_cell("cell-1").unwrap();
                }
                "clear_output" => {
                    state.set_outputs("exec-1", &[]).unwrap();
                }
                "replace_output" => {
                    state.set_outputs("exec-1", &[serde_json::json!({
                    "output_type": "display_data", "output_id": "output-1", "data": {"text/plain": {"inline": "replaced"}}
                })]).unwrap();
                }
                "replace_bokeh_output" => {
                    let mut replacement = state.get_outputs("exec-1").remove(0);
                    replacement["metadata"][BOKEH_SESSION_MIME]["session_id"] =
                        serde_json::json!("replacement-session");
                    state.set_outputs("exec-1", &[replacement]).unwrap();
                }
                _ => unreachable!(),
            }
            assert_eq!(
                retired_sessions(&doc, &state)["kernel-1"],
                vec!["session-1"],
                "{operation}"
            );
        }
    }

    #[test]
    fn bokeh_retirement_keeps_shared_executions_and_copied_outputs() {
        let (mut doc, mut state) = retirement_fixture();
        doc.add_cell(1, "cell-2", "code").unwrap();
        doc.set_execution_id("cell-2", Some("exec-1")).unwrap();
        doc.delete_cell("cell-1").unwrap();
        assert!(retired_sessions(&doc, &state).is_empty());

        state
            .create_execution_with_source_provenance("exec-copy", "copy", 1, None, Some("cell-2"))
            .unwrap();
        let mut copy = state.get_outputs("exec-1").remove(0);
        copy["output_id"] = serde_json::json!("copied-output");
        copy["data"][BOKEH_SESSION_MIME] =
            serde_json::json!({"blob": "new-descriptor", "size": 3000});
        state.append_output("exec-copy", &copy).unwrap();
        doc.set_execution_id("cell-2", Some("exec-copy")).unwrap();
        state.set_outputs("exec-1", &[]).unwrap();
        assert!(
            retired_sessions(&doc, &state).is_empty(),
            "session metadata protects copied outputs even after the original is cleared"
        );
        doc.delete_cell("cell-2").unwrap();
        assert_eq!(
            retired_sessions(&doc, &state)["kernel-1"],
            vec!["session-1"]
        );
    }

    #[test]
    fn bokeh_retirement_viewer_reload_and_multiple_viewers_keep_outputs_live() {
        let (mut doc, state) = retirement_fixture();
        let snapshot = doc.save();
        let viewer_a = NotebookDoc::load_with_actor(&snapshot, "viewer-a").unwrap();
        let viewer_b = NotebookDoc::load_with_actor(&snapshot, "viewer-b").unwrap();
        assert!(retired_sessions(&viewer_a, &state).is_empty());
        assert!(retired_sessions(&viewer_b, &state).is_empty());
        drop(viewer_a);
        let reloaded = NotebookDoc::load_with_actor(&snapshot, "reloaded-viewer").unwrap();
        assert!(retired_sessions(&doc, &state).is_empty());
        assert!(retired_sessions(&reloaded, &state).is_empty());
    }

    #[test]
    fn bokeh_retirement_initial_output_sync_and_late_publication() {
        let (mut doc, mut agent) = retirement_fixture();
        let mut coordinator = RuntimeStateDoc::new();
        let mut sender = automerge::sync::State::new();
        let mut receiver = automerge::sync::State::new();
        // The NotebookDoc execution pointer can arrive before RuntimeStateDoc.
        assert!(retired_sessions(&doc, &coordinator).is_empty());
        for _ in 0..8 {
            if let Some(msg) = agent.generate_sync_message(&mut sender) {
                coordinator
                    .receive_sync_message_with_changes(&mut receiver, msg)
                    .unwrap();
                assert!(
                    retired_sessions(&doc, &coordinator).is_empty(),
                    "a session and its output arrive atomically"
                );
            }
            if let Some(msg) = coordinator.generate_sync_message(&mut receiver) {
                agent
                    .receive_sync_message_with_changes(&mut sender, msg)
                    .unwrap();
            }
        }
        assert!(coordinator.get_bokeh_session("session-1").is_some());
        // The reverse ordering is also safe: the native coordinator stamps
        // the notebook pointer before it admits the execution to the agent.
        // A late session publication for a genuinely retired execution closes.
        doc.set_execution_id("cell-1", Some("exec-2")).unwrap();
        assert_eq!(
            retired_sessions(&doc, &coordinator)["kernel-1"],
            vec!["session-1"]
        );
    }
}
