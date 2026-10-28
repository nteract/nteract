//! Bokeh document sessions on the generic output hook seams.

use std::collections::{HashMap, HashSet};

use futures::future::BoxFuture;
use notebook_doc::NotebookDoc;
use notebook_protocol::protocol::RuntimeAgentRequest;
use runtime_doc::{BokehSessionStatus, RuntimeStateDoc, RuntimeStateError};

use super::{prepare_initial_session, PreparedInitialBokehSession, BOKEH_SESSION_MIME};
use crate::output_hooks::{OutputHook, OutputHookInput, PreparedOutput};

pub(crate) struct BokehOutputHook;

impl OutputHook for BokehOutputHook {
    fn mime(&self) -> &'static str {
        BOKEH_SESSION_MIME
    }

    fn prepare<'a>(
        &'a self,
        input: OutputHookInput<'a>,
    ) -> BoxFuture<'a, anyhow::Result<Option<Box<dyn PreparedOutput>>>> {
        Box::pin(async move {
            let session = prepare_initial_session(
                input.execution_id,
                input.nbformat_value,
                input.manifest,
                input.ctx,
            )
            .await?;
            Ok(session.map(|session| Box::new(session) as Box<dyn PreparedOutput>))
        })
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

impl PreparedOutput for PreparedInitialBokehSession {
    fn apply_in_txn(&mut self, state: &mut RuntimeStateDoc) -> Result<bool, RuntimeStateError> {
        // Session provenance and terminal state survive delayed or repeated
        // publication of the same initial descriptor.
        if state.get_bokeh_session(&self.session_id).is_some() {
            return Ok(false);
        }
        state.put_bokeh_session(&self.session_id, &self.state)?;
        Ok(true)
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
                "kernel_id": "kernel-1", "status": "connected", "head_revision": 0,
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
    use std::sync::Arc;

    use super::*;
    use crate::blob_store::BlobStore;
    use crate::output_blob_publisher::OutputBlobPublisher;
    use crate::output_commit_context::OutputCommitContext;
    use crate::output_committer::{
        start_output_committer, OrdinaryOutputCommit, OrdinaryOutputKind,
    };
    use crate::output_redaction::OutputRedactor;

    #[tokio::test]
    async fn initial_bokeh_output_records_document_session_atomically() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state_doc = RuntimeStateDoc::try_new_with_actor("test-runtime").expect("state doc");
        let (state_changed_tx, _state_changed_rx) = tokio::sync::broadcast::channel(8);
        let state = runtime_doc::RuntimeStateHandle::new(state_doc, state_changed_tx);
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
        let (lifecycle_tx, _lifecycle_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = start_output_committer(OutputCommitContext::new(
            state.clone(),
            blob_store.clone(),
            OutputBlobPublisher::none(),
            "rt:kernel:test".to_string(),
            "kernel-test".to_string(),
            lifecycle_tx,
            Arc::new(OutputRedactor::disabled()),
        ));
        let output = serde_json::json!({
            "output_type": "display_data",
            "data": {
                BOKEH_SESSION_MIME: {
                    "schema_version": 1,
                    "session_id": "session-1",
                    "revision": 0,
                    "producer": {"name": "panel", "version": "1.9.3"},
                    "bokeh_version": "3.9.1",
                    "document": {"version": "3.9.1", "roots": [{"id": "p1001"}]},
                    "root_ids": ["p1001"],
                    "resources": {"javascript": [], "stylesheets": []},
                    "buffers": [],
                },
                "text/plain": "FloatSlider(value=4)",
            },
            "metadata": {},
        });

        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: output.clone(),
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::DisplayData,
            })
            .await;
        handle.flush_for_ordering().await;

        let session = state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .expect("read state")
            .expect("Bokeh session");
        assert_eq!(session.cell_id, "cell-1");
        assert_eq!(session.execution_id, "exec-1");
        assert_eq!(session.kernel_id, "kernel-test");
        assert_eq!(session.head_revision, 0);
        let checkpoint = session.checkpoint.clone().expect("checkpoint");
        assert_eq!(checkpoint.revision, 0);
        let bytes = blob_store
            .get(&checkpoint.content_ref.blob)
            .await
            .expect("read checkpoint")
            .expect("checkpoint bytes");
        let payload: serde_json::Value = serde_json::from_slice(&bytes).expect("checkpoint JSON");
        assert_eq!(payload["session_id"], "session-1");
        assert_eq!(payload["document"]["roots"][0]["id"], "p1001");

        let outputs = state
            .read(|doc| doc.get_outputs("exec-1"))
            .expect("read outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["output_id"], session.output_id);

        let mut closed = session;
        closed.status = BokehSessionStatus::Closed;
        closed.head_revision = 3;
        state
            .with_doc(|doc| doc.put_bokeh_session("session-1", &closed))
            .unwrap();
        handle
            .enqueue_output(OrdinaryOutputCommit {
                execution_id: "exec-1".to_string(),
                nbformat_value: output,
                buffers: Vec::new(),
                kind: OrdinaryOutputKind::DisplayData,
            })
            .await;
        handle.flush_for_ordering().await;
        assert_eq!(
            state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap(),
            Some(closed),
            "late initial output must not reopen a retired session or rewind its revision"
        );
    }

    #[test]
    fn retirement_requests_are_sent_once_per_connection() {
        let (mut doc, state) = retirement_fixture();
        let mut sent = HashSet::new();
        assert!(BokehOutputHook
            .retirement_requests(&doc, &state, &mut sent)
            .is_empty());
        doc.delete_cell("cell-1").unwrap();
        let requests = BokehOutputHook.retirement_requests(&doc, &state, &mut sent);
        assert!(matches!(
            requests.as_slice(),
            [RuntimeAgentRequest::RetireBokehSessions { kernel_id, session_ids }]
                if kernel_id == "kernel-1" && session_ids == &["session-1"]
        ));
        assert!(BokehOutputHook
            .retirement_requests(&doc, &state, &mut sent)
            .is_empty());
        assert!(
            BokehOutputHook
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
