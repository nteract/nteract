//! Runner and agent-loop tests against in-memory RuntimeStateDocs prepared
//! the way the coordinator would.

use std::sync::Arc;
use std::time::Duration;

use notebook_protocol::connection::{NotebookFrameType, TypedNotebookFrame};
use runtime_doc::{ExecutionState, QueueEntry, RuntimeStateDoc, RuntimeStateHandle};
use tokio::sync::{broadcast, mpsc};

use super::backend::ModelBackend;
use super::fake::{FakeBackend, Step};
use super::runner::PromptWorker;
use crate::blob_store::BlobStore;
use crate::prompt_cells::EXPLORE_SYSTEM_PROMPT;
use crate::runtime_agent::tests::{channel_connection, ChannelTransport};

const CONTEXT: &str = "<notebook>\n</notebook>\n\nwhy is the sky blue?";

struct Room {
    state: RuntimeStateHandle,
    blobs: Arc<BlobStore>,
    _tmp: tempfile::TempDir,
}

impl Room {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, _rx) = broadcast::channel(64);
        Self {
            state: RuntimeStateHandle::new(RuntimeStateDoc::new(), tx),
            blobs: Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            _tmp: tmp,
        }
    }

    /// What the coordinator does: an execution with capability "prompt" and
    /// its context blob (which makes it runnable).
    async fn submit(&self, eid: &str, seq: u64) {
        let hash = self
            .blobs
            .put(CONTEXT.as_bytes(), "text/plain")
            .await
            .unwrap();
        self.state
            .with_doc(|sd| {
                sd.create_execution_with_capability(
                    eid,
                    "why is the sky blue?",
                    seq,
                    None,
                    Some("prompt-cell"),
                    "prompt",
                )?;
                sd.set_execution_context(eid, &hash)
            })
            .unwrap();
    }

    fn execution(&self, eid: &str) -> ExecutionState {
        self.state
            .read(|sd| sd.get_execution(eid))
            .unwrap()
            .unwrap()
    }

    fn outputs(&self, eid: &str) -> Vec<serde_json::Value> {
        self.state.read(|sd| sd.get_outputs(eid)).unwrap()
    }

    fn markdown(&self, eid: &str) -> String {
        let outputs = self.outputs(eid);
        assert_eq!(outputs.len(), 1, "one output: {outputs:?}");
        outputs[0]["data"]["text/markdown"]["inline"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// What the daemon's Stop does to a dispatched execution.
    fn stop(&self, eid: &str) {
        self.state
            .with_doc(|sd| sd.request_execution_stop(eid).map(|_| ()))
            .unwrap();
    }
}

fn run_one(
    room: &Room,
    backend: Arc<dyn ModelBackend>,
) -> (PromptWorker, mpsc::UnboundedReceiver<String>) {
    let (mut worker, done_rx) = PromptWorker::new(room.state.clone(), room.blobs.clone(), backend);
    worker.maybe_start();
    (worker, done_rx)
}

async fn finished(done_rx: &mut mpsc::UnboundedReceiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(10), done_rx.recv())
        .await
        .expect("run should finish")
        .unwrap()
}

#[tokio::test]
async fn success_writes_markdown_then_done_and_starts_the_next_prompt() {
    let room = Room::new();
    room.submit("e1", 1).await;
    room.submit("e2", 2).await;
    let backend = FakeBackend::new(vec![Step::Text("The sky "), Step::Text("is **blue**.")]);
    let (mut worker, mut done_rx) = run_one(&room, Arc::new(backend.clone()));

    // Claimed synchronously, in seq order: e1 running, e2 still queued.
    assert_eq!(room.execution("e1").status, "running");
    assert_eq!(room.execution("e2").status, "queued");

    let eid = finished(&mut done_rx).await;
    assert_eq!(eid, "e1");
    let e1 = room.execution("e1");
    assert_eq!(e1.status, "done");
    assert_eq!(e1.success, Some(true));
    assert_eq!(room.markdown("e1"), "The sky is **blue**.");
    let outputs = room.outputs("e1");
    assert_eq!(outputs[0]["output_type"], "display_data");
    assert!(outputs[0]["metadata"].get("nteract").is_none());

    // The model got the context blob verbatim plus the explore system prompt.
    let requests = backend.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].input, CONTEXT);
    assert_eq!(requests[0].system, EXPLORE_SYSTEM_PROMPT);

    // e1 released: e2 starts and is claimed.
    worker.run_finished(&eid);
    assert_eq!(room.execution("e2").status, "running");
    assert_eq!(finished(&mut done_rx).await, "e2");
    worker.run_finished("e2");
    assert_eq!(room.execution("e2").status, "done");
}

#[tokio::test]
async fn the_final_output_is_written_before_the_terminal_status() {
    // Record every doc change and check that no state with a terminal status
    // lacks the final text.
    let room = Room::new();
    room.submit("e1", 1).await;
    let mut changes = room.state.subscribe();
    let backend = Arc::new(FakeBackend::new(vec![
        Step::Text("one "),
        Step::Text("two"),
    ]));
    let (_worker, mut done_rx) = run_one(&room, backend);

    let violated = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let state = room.state.clone();
        let violated = violated.clone();
        tokio::spawn(async move {
            while changes.recv().await.is_ok() {
                let (status, text) = state
                    .read(|sd| {
                        let status = sd.get_execution("e1").map(|e| e.status);
                        let text = sd.get_outputs("e1").first().and_then(|o| {
                            o["data"]["text/markdown"]["inline"]
                                .as_str()
                                .map(String::from)
                        });
                        (status, text)
                    })
                    .unwrap();
                if status.as_deref() == Some("done") && text.as_deref() != Some("one two") {
                    violated.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
        })
    };
    finished(&mut done_rx).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    watcher.abort();
    assert!(
        !violated.load(std::sync::atomic::Ordering::SeqCst),
        "a terminal status was visible before the final text"
    );
    assert_eq!(room.execution("e1").status, "done");
    assert_eq!(room.markdown("e1"), "one two");
}

#[tokio::test]
async fn failure_without_text_writes_an_error_output_and_error_status() {
    let room = Room::new();
    room.submit("e1", 1).await;
    let backend = Arc::new(FakeBackend::new(vec![Step::Fail("not logged in")]));
    let (_worker, mut done_rx) = run_one(&room, backend);
    finished(&mut done_rx).await;

    let e1 = room.execution("e1");
    assert_eq!(e1.status, "error");
    assert_eq!(e1.success, Some(false));
    let outputs = room.outputs("e1");
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0]["output_type"], "error");
    assert_eq!(outputs[0]["ename"], "PromptError");
    assert_eq!(outputs[0]["evalue"], "not logged in");
}

#[tokio::test]
async fn failure_after_partial_text_keeps_the_text_and_appends_the_reason() {
    let room = Room::new();
    room.submit("e1", 1).await;
    let backend = Arc::new(FakeBackend::new(vec![
        Step::Text("half an answer"),
        Step::Fail("connection lost"),
    ]));
    let (_worker, mut done_rx) = run_one(&room, backend);
    finished(&mut done_rx).await;
    assert_eq!(room.execution("e1").status, "error");
    assert_eq!(
        room.markdown("e1"),
        "half an answer\n\n**Agent error:** connection lost"
    );
}

#[tokio::test]
async fn an_empty_successful_answer_is_an_error() {
    let room = Room::new();
    room.submit("e1", 1).await;
    let (_worker, mut done_rx) = run_one(&room, Arc::new(FakeBackend::new(vec![])));
    finished(&mut done_rx).await;
    assert_eq!(room.execution("e1").status, "error");
    assert_eq!(room.outputs("e1")[0]["output_type"], "error");
}

#[tokio::test]
async fn stopping_mid_stream_keeps_partial_text_with_the_stop_marker() {
    let room = Room::new();
    room.submit("e1", 1).await;
    let backend = Arc::new(FakeBackend::new(vec![
        Step::Text("partial"),
        Step::UntilInterrupt,
    ]));
    let (mut worker, mut done_rx) = run_one(&room, backend);

    // Wait until the text reached the doc (the first write is immediate).
    tokio::time::timeout(Duration::from_secs(10), async {
        while room.outputs("e1").is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("partial text streams out");
    assert_eq!(room.execution("e1").status, "running");

    room.stop("e1");
    worker.maybe_start();
    finished(&mut done_rx).await;
    let e1 = room.execution("e1");
    assert_eq!(e1.status, "error");
    assert_eq!(e1.success, Some(false));
    assert_eq!(room.markdown("e1"), "partial");
    assert_eq!(
        room.outputs("e1")[0]["metadata"]["nteract"]["prompt_stopped"],
        true
    );
}

#[tokio::test]
async fn a_second_stop_escalates_to_kill() {
    let room = Room::new();
    room.submit("e1", 1).await;
    let backend = Arc::new(FakeBackend::new(vec![Step::Text("x"), Step::UntilKill]));
    let (mut worker, mut done_rx) = run_one(&room, backend);
    room.stop("e1");
    worker.maybe_start();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), done_rx.recv())
            .await
            .is_err(),
        "the first stop is not enough for this backend"
    );
    room.stop("e1");
    worker.maybe_start();
    finished(&mut done_rx).await;
    assert_eq!(room.execution("e1").status, "error");
}

/// The coordinator's view can lag: a Stop it records for an execution that
/// already ended here must not stop the prompt running now.
#[tokio::test]
async fn a_stale_stop_for_another_execution_never_touches_the_running_one() {
    let room = Room::new();
    room.submit("e1", 1).await;
    room.submit("e2", 2).await;
    let backend = Arc::new(FakeBackend::new(vec![
        Step::Text("x"),
        Step::UntilInterrupt,
    ]));
    let (mut worker, mut done_rx) = run_one(&room, backend);
    room.stop("e1");
    worker.maybe_start();
    assert_eq!(finished(&mut done_rx).await, "e1");
    worker.run_finished("e1");
    assert_eq!(room.execution("e2").status, "running");

    // A second, late Stop on e1 (the user double-clicked).
    room.stop("e1");
    worker.maybe_start();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), done_rx.recv())
            .await
            .is_err(),
        "e2 must keep running"
    );
    assert_eq!(room.execution("e2").status, "running");
    assert_eq!(room.execution("e2").stop_requested, 0);

    room.stop("e2");
    worker.maybe_start();
    assert_eq!(finished(&mut done_rx).await, "e2");
}

/// Stop raced the claim: the daemon recorded the Stop while the agent
/// concurrently claimed the run. The daemon leaves a dispatched execution's
/// status to the agent, so there is no status conflict: the agent sees the
/// Stop on its run and stops it.
#[tokio::test]
async fn a_stop_concurrent_with_the_claim_still_stops_the_run() {
    let room = Room::new();
    room.submit("e1", 1).await;
    let mut daemon = room
        .state
        .with_doc(|sd| Ok(sd.fork_with_actor("daemon")))
        .unwrap();
    daemon.request_execution_stop("e1").unwrap();

    let backend = Arc::new(FakeBackend::new(vec![
        Step::Text("x"),
        Step::UntilInterrupt,
    ]));
    let (mut worker, mut done_rx) = run_one(&room, backend);
    assert_eq!(room.execution("e1").status, "running");

    room.state
        .with_doc(|sd| sd.merge(&mut daemon).map(|_| ()).map_err(Into::into))
        .unwrap();
    worker.maybe_start();

    assert_eq!(finished(&mut done_rx).await, "e1");
    let e1 = room.execution("e1");
    assert_eq!(e1.status, "error", "{e1:?}");
    assert_eq!(e1.stop_requested, 1);
    assert_eq!(
        room.outputs("e1")[0]["metadata"]["nteract"]["prompt_stopped"],
        true
    );
}

/// A Stop on a dispatched prompt the agent has not claimed: the agent
/// cancels it and never runs it.
#[tokio::test]
async fn a_stopped_dispatched_prompt_is_cancelled_and_never_runs() {
    let room = Room::new();
    room.submit("e1", 1).await;
    room.stop("e1");
    let backend = FakeBackend::new(vec![Step::Text("never")]);
    let (_worker, mut done_rx) = run_one(&room, Arc::new(backend.clone()));

    assert_eq!(room.execution("e1").status, "cancelled");
    assert!(room.outputs("e1").is_empty());
    assert!(
        tokio::time::timeout(Duration::from_millis(200), done_rx.recv())
            .await
            .is_err(),
        "nothing runs"
    );
    assert!(backend.requests().is_empty());
}

/// A Stop on a prompt queued behind a long run is applied at once, not when
/// the running prompt ends; the running one is not touched.
#[tokio::test]
async fn a_stop_while_busy_cancels_the_queued_prompt_at_once() {
    let room = Room::new();
    room.submit("e1", 1).await;
    room.submit("e2", 2).await;
    let backend = Arc::new(FakeBackend::new(vec![Step::Text("x"), Step::UntilKill]));
    let (mut worker, mut done_rx) = run_one(&room, backend);
    assert_eq!(room.execution("e1").status, "running");

    room.stop("e2");
    worker.maybe_start();
    assert_eq!(room.execution("e2").status, "cancelled");
    assert_eq!(room.execution("e1").status, "running");
    assert_eq!(room.execution("e1").stop_requested, 0);

    room.stop("e1");
    room.stop("e1");
    worker.maybe_start();
    assert_eq!(finished(&mut done_rx).await, "e1");
    worker.run_finished("e1");
    assert_eq!(room.execution("e2").status, "cancelled", "never claimed");
}

/// The daemon ended the run while it was going (agent teardown): the agent
/// kills it, writes no final output and does not overwrite the status.
#[tokio::test]
async fn a_run_ended_by_the_daemon_is_killed_and_not_overwritten() {
    let room = Room::new();
    room.submit("e1", 1).await;
    room.submit("e2", 2).await;
    let backend = Arc::new(FakeBackend::new(vec![Step::Text("x"), Step::UntilKill]));
    let (mut worker, mut done_rx) = run_one(&room, backend);
    assert_eq!(room.execution("e1").status, "running");

    room.state
        .with_doc(|sd| sd.set_execution_done("e1", false))
        .unwrap();
    // The next state change from the daemon reaches the worker.
    worker.maybe_start();

    assert_eq!(finished(&mut done_rx).await, "e1");
    assert_eq!(room.execution("e1").status, "error");
    assert!(
        room.outputs("e1")
            .iter()
            .all(|o| o["metadata"].get("nteract").is_none()),
        "no final (stopped) output after the execution ended"
    );
    // The next prompt starts.
    worker.run_finished("e1");
    assert_eq!(room.execution("e2").status, "running");
}

#[tokio::test]
async fn only_dispatched_unstopped_prompts_are_claimed_and_kernel_state_is_never_touched() {
    let room = Room::new();
    room.submit("cancelled", 1).await;
    room.submit("stopped", 2).await;
    room.submit("stale", 3).await;
    room.state
        .with_doc(|sd| {
            // Cancelled before it started.
            sd.set_execution_cancelled("cancelled")?;
            sd.request_execution_stop("stopped")?;
            // Left running by a previous agent.
            sd.set_execution_running("stale")?;
            // Not dispatched yet: no context.
            sd.create_execution_with_capability("waiting", "q", 4, None, Some("c"), "prompt")?;
            // A kernel execution and queue of its own.
            sd.create_execution_with_source_provenance(
                "kernel-exec",
                "1+1",
                5,
                None,
                Some("code"),
            )?;
            sd.set_queue(
                None,
                &[QueueEntry {
                    execution_id: "kernel-exec".into(),
                }],
            )
        })
        .unwrap();
    room.submit("e2", 6).await;
    let kernel_before = room
        .state
        .read(|sd| sd.get_execution("kernel-exec"))
        .unwrap();
    let kernel_queue_before = room.state.read(|sd| sd.read_state().queue).unwrap();

    let backend = Arc::new(FakeBackend::new(vec![Step::Text("ok")]));
    let (_worker, mut done_rx) = run_one(&room, backend);
    assert_eq!(finished(&mut done_rx).await, "e2");

    assert_eq!(room.execution("cancelled").status, "cancelled");
    assert_eq!(room.execution("stopped").status, "cancelled");
    assert_eq!(room.execution("stale").status, "error");
    assert_eq!(room.execution("waiting").status, "queued");
    assert_eq!(room.execution("e2").status, "done");
    assert_eq!(
        room.state
            .read(|sd| sd.get_execution("kernel-exec"))
            .unwrap(),
        kernel_before
    );
    assert_eq!(
        room.state.read(|sd| sd.read_state().queue).unwrap(),
        kernel_queue_before
    );
}

#[tokio::test]
async fn a_missing_context_blob_is_an_error_output() {
    let room = Room::new();
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_capability("e1", "q", 1, None, Some("c"), "prompt")?;
            sd.set_execution_context("e1", "not-in-the-blob-store")
        })
        .unwrap();
    let backend = Arc::new(FakeBackend::new(vec![Step::Text("never")]));
    let (_worker, mut done_rx) = run_one(&room, backend.clone());
    finished(&mut done_rx).await;
    assert_eq!(room.execution("e1").status, "error");
    assert!(backend.requests().is_empty());
    assert_eq!(room.outputs("e1")[0]["output_type"], "error");
}

// -- agent loop over an in-memory wire ---------------------------------------

struct Coordinator {
    doc: RuntimeStateDoc,
    sync: automerge::sync::State,
    to_agent: crate::runtime_agent::tests::InboundTx,
    from_agent: crate::runtime_agent::tests::OutboundRx,
}

impl Coordinator {
    fn send_sync(&mut self) {
        if let Some(message) = self.doc.generate_sync_message(&mut self.sync) {
            self.to_agent
                .send(Ok(TypedNotebookFrame {
                    frame_type: NotebookFrameType::RuntimeStateSync,
                    payload: message.encode(),
                }))
                .unwrap();
        }
    }

    /// What the coordinator does: dispatch a prompt execution with its
    /// context and sync it to the agent.
    fn dispatch(&mut self, eid: &str, context_hash: &str) {
        self.doc
            .create_execution_with_capability(eid, "why?", 1, None, Some("p"), "prompt")
            .unwrap();
        self.doc.set_execution_context(eid, context_hash).unwrap();
        self.send_sync();
    }

    /// Process agent frames until `done` holds for the doc.
    async fn pump_until(&mut self, what: &str, done: impl Fn(&RuntimeStateDoc) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if done(&self.doc) {
                return;
            }
            let (frame_type, payload) = tokio::time::timeout_at(deadline, self.from_agent.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for: {what}"))
                .expect("agent connection open");
            match frame_type {
                NotebookFrameType::RuntimeStateSync => {
                    let message = automerge::sync::Message::decode(&payload).unwrap();
                    self.doc
                        .receive_sync_message_with_changes_recovering(
                            &mut self.sync,
                            message,
                            "test-coordinator",
                        )
                        .unwrap();
                    self.send_sync();
                }
                other => panic!("unexpected frame {other:?}"),
            }
        }
    }
}

fn spawn_agent(
    backend: Arc<dyn ModelBackend>,
    blob_root: std::path::PathBuf,
) -> (Coordinator, tokio::task::JoinHandle<anyhow::Result<()>>) {
    let (conn, in_tx, out_rx) = channel_connection();
    let transport = ChannelTransport(std::sync::Mutex::new([conn].into_iter().collect()));
    let agent = tokio::spawn(super::run_prompt_agent_on_transport(
        transport,
        "prompt-agent:test".to_string(),
        blob_root,
        backend,
    ));
    (
        Coordinator {
            doc: RuntimeStateDoc::new(),
            sync: automerge::sync::State::new(),
            to_agent: in_tx,
            from_agent: out_rx,
        },
        agent,
    )
}

#[tokio::test]
async fn the_agent_acknowledges_the_initial_sync_and_runs_a_dispatched_prompt_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let blob_root = tmp.path().join("blobs");
    let blobs = BlobStore::new(blob_root.clone());
    let hash = blobs.put(CONTEXT.as_bytes(), "text/plain").await.unwrap();
    let backend = Arc::new(FakeBackend::new(vec![
        Step::Text("Rayleigh "),
        Step::Text("scattering."),
    ]));
    let (mut coordinator, agent) = spawn_agent(backend.clone(), blob_root);

    // Initial sync: the agent must reply promptly so the coordinator can
    // see it as ready.
    coordinator.send_sync();
    let (frame_type, _) =
        tokio::time::timeout(Duration::from_secs(10), coordinator.from_agent.recv())
            .await
            .expect("the agent replies to the initial sync")
            .unwrap();
    assert_eq!(frame_type, NotebookFrameType::RuntimeStateSync);

    coordinator.dispatch("e1", &hash);
    coordinator
        .pump_until("prompt done", |doc| {
            doc.get_execution("e1").is_some_and(|e| e.status == "done")
        })
        .await;

    let outputs = coordinator.doc.get_outputs("e1");
    assert_eq!(outputs.len(), 1);
    assert_eq!(
        outputs[0]["data"]["text/markdown"]["inline"],
        "Rayleigh scattering."
    );
    assert_eq!(backend.requests()[0].input, CONTEXT);

    // Closing the wire shuts the agent down cleanly.
    drop(coordinator.to_agent);
    let result = tokio::time::timeout(Duration::from_secs(10), agent)
        .await
        .expect("agent exits on EOF")
        .unwrap();
    assert!(result.is_ok());
}

#[tokio::test]
async fn a_synced_stop_stops_the_running_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let blob_root = tmp.path().join("blobs");
    let blobs = BlobStore::new(blob_root.clone());
    let hash = blobs.put(CONTEXT.as_bytes(), "text/plain").await.unwrap();
    let backend = Arc::new(FakeBackend::new(vec![
        Step::Text("so far"),
        Step::UntilInterrupt,
    ]));
    let (mut coordinator, agent) = spawn_agent(backend, blob_root);

    coordinator.dispatch("e1", &hash);
    coordinator
        .pump_until("partial text", |doc| !doc.get_outputs("e1").is_empty())
        .await;

    coordinator.doc.request_execution_stop("e1").unwrap();
    coordinator.send_sync();
    coordinator
        .pump_until("stopped", |doc| {
            doc.get_execution("e1").is_some_and(|e| e.status == "error")
        })
        .await;
    let outputs = coordinator.doc.get_outputs("e1");
    assert_eq!(outputs[0]["data"]["text/markdown"]["inline"], "so far");
    assert_eq!(outputs[0]["metadata"]["nteract"]["prompt_stopped"], true);

    agent.abort();
}
