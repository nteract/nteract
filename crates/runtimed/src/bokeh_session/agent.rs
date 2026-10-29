//! The runtime agent's Bokeh extension: the single owner of the agent's
//! [`BokehSessionStore`], which it hands to `AgentDocs` (keyed document),
//! the output committer (output hook) and each launched kernel (kernel
//! extension), and the handler of Bokeh runtime-agent requests.

use std::collections::HashMap;
use std::sync::Arc;

use futures::future::BoxFuture;
use notebook_protocol::protocol::{
    BokehSessionPatchRequest, RuntimeAgentRequest, RuntimeAgentResponse,
    RuntimeAgentResponseEnvelope,
};
use runtime_doc::{BokehSessionStatus, RuntimeStateHandle};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use super::kernel::{BokehKernelExtension, BokehKernelRequester, INGEST_DRAIN_TIMEOUT};
use super::output_hook::BokehAgentOutputHook;
use super::store::{replacement_policy_from_env, BokehSessionStore};
use super::BOKEH_SESSION_KIND;
use crate::kernel_extensions::KernelExtension;
use crate::keyed_doc::AgentKeyedDoc;
use crate::output_hooks::OutputHook;
use crate::runtime_agent_extension::{
    AgentExtensionInit, AgentLifecycleCtx, AgentRequestCtx, ExtensionStart, RuntimeAgentExtension,
};
use crate::task_supervisor::spawn_best_effort;

pub(crate) struct BokehAgentExtension {
    store: BokehSessionStore,
}

impl BokehAgentExtension {
    pub(crate) fn new(init: &AgentExtensionInit) -> Self {
        Self {
            store: BokehSessionStore::new(replacement_policy_from_env(), init.availability.clone()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_store(store: BokehSessionStore) -> Self {
        Self { store }
    }

    #[cfg(test)]
    pub(crate) fn store(&self) -> &BokehSessionStore {
        &self.store
    }
}

impl RuntimeAgentExtension for BokehAgentExtension {
    fn name(&self) -> &'static str {
        BOKEH_SESSION_KIND
    }

    fn keyed_docs(&self) -> Vec<Arc<dyn AgentKeyedDoc>> {
        vec![Arc::new(self.store.clone())]
    }

    fn output_hooks(&self) -> Vec<Arc<dyn OutputHook>> {
        vec![Arc::new(BokehAgentOutputHook::new(Some(
            self.store.clone(),
        )))]
    }

    fn kernel_extension(&self) -> Option<Arc<dyn KernelExtension>> {
        Some(Arc::new(BokehKernelExtension {
            store: self.store.clone(),
        }))
    }

    fn claims(&self, request: &RuntimeAgentRequest) -> bool {
        matches!(
            request,
            RuntimeAgentRequest::ApplyBokehSessionPatch { .. }
                | RuntimeAgentRequest::GetBokehSessionData { .. }
                | RuntimeAgentRequest::RetireBokehSessions { .. }
        )
    }

    fn start(
        &self,
        id: String,
        request: RuntimeAgentRequest,
        ctx: AgentRequestCtx<'_>,
    ) -> ExtensionStart {
        let kernel_id = ctx.kernel.as_ref().map(|kernel| kernel.kernel_id);
        match request {
            RuntimeAgentRequest::RetireBokehSessions {
                kernel_id: expected,
                session_ids,
            } => {
                if kernel_id == Some(expected.as_str()) {
                    if let Err(error) = retire_sessions(
                        &self.store,
                        ctx.state,
                        &expected,
                        &session_ids,
                        ctx.kernel_tasks,
                    ) {
                        warn!("[bokeh-session] Failed to retire output sessions: {error}");
                    }
                    // Retired outputs are gone; nothing to freeze.
                    self.store.remove_sessions(&session_ids);
                }
                ExtensionStart::NoReply
            }
            RuntimeAgentRequest::ApplyBokehSessionPatch { request } => {
                match self.start_patch(id, *request, kernel_id, &ctx) {
                    Ok(()) => ExtensionStart::Deferred,
                    Err(error) => ExtensionStart::Reply(RuntimeAgentResponse::Error { error }),
                }
            }
            RuntimeAgentRequest::GetBokehSessionData {
                session_id,
                source_ids,
                request_folds,
            } => {
                let Some(data) = self.store.data_tail(&session_id, source_ids.as_deref()) else {
                    return ExtensionStart::Reply(RuntimeAgentResponse::Error {
                        error: format!("unknown Bokeh session {session_id}"),
                    });
                };
                if request_folds && !data.fold_requested.is_empty() {
                    if let Some(requester) = kernel_id.and_then(|id| self.store.requester(id)) {
                        self.request_folds(&requester, &session_id, &data.fold_requested);
                    }
                }
                ExtensionStart::Reply(RuntimeAgentResponse::BokehSessionData { data })
            }
            _ => ExtensionStart::Reply(RuntimeAgentResponse::Error {
                error: "not a Bokeh session request".to_string(),
            }),
        }
    }

    fn on_kernel_lost<'a>(
        &'a self,
        kernel_id: &'a str,
        ctx: AgentLifecycleCtx<'a>,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            // The kernel's last deltas belong in the frozen state. The ingest
            // bounds its own drain; this bound only guards a lost signal.
            let drain_bound = INGEST_DRAIN_TIMEOUT + std::time::Duration::from_secs(1);
            if tokio::time::timeout(drain_bound, self.store.ingest_drained(kernel_id))
                .await
                .is_err()
            {
                warn!("[bokeh-session] Freezing {kernel_id}'s sessions before its ingest drained");
            }
            let sessions = self.store.remove_kernel_sessions(kernel_id);
            freeze_sessions(sessions, Disconnect::Kernel(kernel_id), &ctx).await;
        })
    }

    /// After a reconnect the coordinator has frozen every session this agent
    /// served; adopting its records drops them here so the store stops
    /// ingesting, broadcasting and syncing them.
    fn on_runtime_state_synced(&self, ctx: AgentLifecycleCtx<'_>) {
        let dropped = self.store.drop_unconnected_sessions(ctx.state);
        if !dropped.is_empty() {
            debug!("[bokeh-session] Dropped sessions the coordinator ended: {dropped:?}");
        }
    }

    /// Without routing nobody can sync the documents any more, so they end
    /// as on kernel loss: frozen into their outputs and read-only. Later
    /// outputs stay static because the store stops accepting sessions.
    fn on_keyed_doc_unavailable<'a>(
        &'a self,
        kind: &'a str,
        ctx: AgentLifecycleCtx<'a>,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if kind == BOKEH_SESSION_KIND {
                freeze_sessions(self.store.remove_all_sessions(), Disconnect::All, &ctx).await;
            }
        })
    }
}

impl BokehAgentExtension {
    /// Ask the kernel to fold the sources that have no fold pending.
    fn request_folds(
        &self,
        requester: &BokehKernelRequester,
        session_id: &str,
        sources: &[String],
    ) {
        let new = self.store.claim_folds(session_id, sources);
        if new.is_empty() {
            return;
        }
        let fold = requester.fold(session_id, new.clone());
        let store = self.store.clone();
        let session_id = session_id.to_string();
        spawn_best_effort("bokeh-fold", async move {
            match fold.await {
                // The delta clears the claim; asking again would only queue
                // another fold behind the deferred one.
                Ok(true) => store.defer_folds(&session_id, &new),
                Ok(false) => store.release_folds(&session_id, &new),
                Err(error) => {
                    warn!("[bokeh-session] On-demand fold failed: {error}");
                    store.release_folds(&session_id, &new);
                }
            }
        });
    }

    /// Queue the patch now, behind property writes that arrived before it,
    /// and reply through `ctx.responses` once the kernel's callback ran.
    fn start_patch(
        &self,
        id: String,
        request: BokehSessionPatchRequest,
        kernel_id: Option<&str>,
        ctx: &AgentRequestCtx<'_>,
    ) -> Result<(), String> {
        let kernel_id = kernel_id.ok_or_else(|| "No kernel running".to_string())?;
        let owns_session = ctx
            .state
            .read(|state_doc| {
                state_doc
                    .get_bokeh_session(&request.session_id)
                    .is_some_and(|session| {
                        session.kernel_id == kernel_id
                            && session.status == BokehSessionStatus::Connected
                    })
            })
            .unwrap_or(false);
        if !owns_session {
            return Err(format!(
                "Bokeh session {} is not owned by the active kernel",
                request.session_id
            ));
        }
        let outbox = self
            .store
            .outbox(kernel_id)
            .ok_or_else(|| "kernel does not support Bokeh document sessions".to_string())?;
        let session_id = request.session_id.clone();
        let reply = outbox.one_off(request)?;
        let state = ctx.state.clone();
        let blob_store = ctx.blob_store.clone();
        let blob_publisher = ctx.blob_publisher.clone();
        let responses: mpsc::UnboundedSender<RuntimeAgentResponseEnvelope> = ctx.responses.clone();
        spawn_best_effort("bokeh-patch-reply", async move {
            let response = match reply.await {
                Ok(response) => {
                    if let Err(error) = super::append_callback_outputs(
                        &session_id,
                        &response,
                        &state,
                        &blob_store,
                        &blob_publisher,
                    )
                    .await
                    {
                        warn!("[bokeh-session] Failed to append callback output: {error}");
                    }
                    RuntimeAgentResponse::BokehSessionPatch {
                        reply: response.reply,
                    }
                }
                Err(error) => RuntimeAgentResponse::Error {
                    error: format!("Failed to apply Bokeh patch: {error}"),
                },
            };
            let _ = responses.send(RuntimeAgentResponseEnvelope { id, response });
        });
        Ok(())
    }
}

/// Mark retired sessions closed before their close request is dispatched, so
/// in-flight events are rejected, and close them in the kernel off the agent
/// loop. The close tasks die with the kernel's channels.
fn retire_sessions(
    store: &BokehSessionStore,
    state: &RuntimeStateHandle,
    kernel_id: &str,
    session_ids: &[String],
    tasks: &mut HashMap<String, JoinHandle<()>>,
) -> anyhow::Result<()> {
    let Some(requester) = store.requester(kernel_id) else {
        return Ok(());
    };
    tasks.retain(|_, task| !task.is_finished());
    for session_id in session_ids {
        let retired = state.with_doc(|doc| {
            let Some(mut session) = doc.get_bokeh_session(session_id) else {
                return Ok(false);
            };
            if session.kernel_id != kernel_id || session.status != BokehSessionStatus::Connected {
                return Ok(false);
            }
            // Only the runtime agent writes this terminal transition.
            session.status = BokehSessionStatus::Closed;
            doc.put_bokeh_session(session_id, &session)?;
            Ok(true)
        })?;
        if retired {
            let close = requester.close(session_id.clone());
            let id = session_id.clone();
            let task = spawn_best_effort("bokeh-session-close", async move {
                if let Err(error) = close.await {
                    warn!("[bokeh-session] Failed to close retired session {id}: {error}");
                }
            });
            tasks.insert(session_id.clone(), task);
        }
    }
    Ok(())
}

/// Whose records a freeze marks disconnected.
enum Disconnect<'a> {
    Kernel(&'a str),
    All,
}

/// Write each removed session's final state, retained data tail included,
/// into its output payload's `snapshot`, then mark the records disconnected
/// (read-only). Records go regardless of the store: one whose document was
/// never adopted would otherwise stay connected with nothing behind it.
async fn freeze_sessions(
    sessions: Vec<(String, super::materialize::SnapshotWithTail)>,
    disconnect: Disconnect<'_>,
    ctx: &AgentLifecycleCtx<'_>,
) {
    for (session_id, snapshot) in sessions {
        if let Err(error) = super::materialize::freeze_session_output(
            &session_id,
            &snapshot,
            ctx.state,
            None,
            ctx.blob_store,
            ctx.blob_publisher,
        )
        .await
        {
            warn!("[bokeh-session] Failed to freeze session {session_id}: {error}");
        }
    }
    if let Err(error) = ctx.state.with_doc(|state_doc| {
        match disconnect {
            Disconnect::Kernel(kernel_id) => {
                state_doc.disconnect_bokeh_sessions_for_kernel(kernel_id)
            }
            Disconnect::All => state_doc.disconnect_all_bokeh_sessions(),
        }
        .map(|_| ())
    }) {
        warn!("[runtime-state] Failed to disconnect Bokeh sessions: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_store::BlobStore;
    use crate::bokeh_session::store::tests::{snapshot, store_with_session, KERNEL};
    use crate::bokeh_session::BOKEH_SESSION_MIME;
    use crate::kernel_shell_requester::KernelShellRequester;
    use crate::output_blob_publisher::OutputBlobPublisher;
    use crate::output_redaction::OutputRedactor;
    use crate::runtime_agent_extension::{AgentExtensions, AgentKernelView};
    use runtime_doc::{BokehSessionDoc, BokehSessionState, RuntimeStateDoc};
    use serde_json::json;
    use tokio::sync::broadcast;

    struct Fixture {
        state: RuntimeStateHandle,
        blob_store: Arc<BlobStore>,
        responses: mpsc::UnboundedSender<RuntimeAgentResponseEnvelope>,
        responses_rx: mpsc::UnboundedReceiver<RuntimeAgentResponseEnvelope>,
        tasks: HashMap<String, JoinHandle<()>>,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::TempDir::new().unwrap();
        let (responses, responses_rx) = mpsc::unbounded_channel();
        Fixture {
            state: RuntimeStateHandle::new(RuntimeStateDoc::new(), broadcast::channel(16).0),
            blob_store: Arc::new(BlobStore::new(dir.path().to_path_buf())),
            responses,
            responses_rx,
            tasks: HashMap::new(),
            _dir: dir,
        }
    }

    impl Fixture {
        fn start(
            &mut self,
            ext: &BokehAgentExtension,
            kernel_id: Option<&str>,
            id: &str,
            request: RuntimeAgentRequest,
        ) -> ExtensionStart {
            let publisher = OutputBlobPublisher::none();
            ext.start(
                id.to_string(),
                request,
                AgentRequestCtx {
                    state: &self.state,
                    blob_store: &self.blob_store,
                    blob_publisher: &publisher,
                    kernel: kernel_id.map(|kernel_id| AgentKernelView { kernel_id }),
                    responses: &self.responses,
                    kernel_tasks: &mut self.tasks,
                },
            )
        }
    }

    fn record(kernel_id: &str, output_id: &str) -> BokehSessionState {
        BokehSessionState {
            output_id: output_id.into(),
            cell_id: "cell-1".into(),
            execution_id: "exec-1".into(),
            kernel_id: kernel_id.into(),
            status: BokehSessionStatus::Connected,
            producer_name: "panel".into(),
            producer_version: "1.9.4".into(),
            bokeh_version: "3.9.2".into(),
            root_ids: vec!["p1".into()],
            epoch: 0,
            doc_heads: vec!["a".repeat(64)],
            previous_heads: Vec::new(),
        }
    }

    fn bind_test_kernel(
        fx: &Fixture,
        store: &BokehSessionStore,
        kernel_id: &str,
    ) -> mpsc::UnboundedReceiver<crate::kernel_shell_requester::ShellCommand> {
        let (shell, rx) = KernelShellRequester::for_test();
        let requester = BokehKernelRequester::new(shell, Arc::new(OutputRedactor::default()));
        let (outbox, _task) = crate::bokeh_session::kernel::spawn_outbox(
            requester.clone(),
            fx.state.clone(),
            fx.blob_store.clone(),
            OutputBlobPublisher::none(),
        );
        store.attach_kernel(
            kernel_id,
            requester,
            outbox,
            tokio::sync::oneshot::channel().1,
        );
        rx
    }

    #[test]
    fn the_extension_claims_exactly_its_request_variants() {
        let exts = AgentExtensions::new(vec![Arc::new(BokehAgentExtension::with_store(
            BokehSessionStore::default(),
        ))]);
        let patch = RuntimeAgentRequest::ApplyBokehSessionPatch {
            request: Box::new(BokehSessionPatchRequest {
                session_id: "s".into(),
                transaction_id: "t".into(),
                patch: json!({"events": []}),
                buffers: Vec::new(),
                buffer_refs: Vec::new(),
            }),
        };
        let data = RuntimeAgentRequest::GetBokehSessionData {
            session_id: "s".into(),
            source_ids: None,
            request_folds: true,
        };
        let retire = RuntimeAgentRequest::RetireBokehSessions {
            kernel_id: "k".into(),
            session_ids: Vec::new(),
        };
        for request in [&patch, &data, &retire] {
            assert_eq!(
                exts.claim(request).map(|ext| ext.name()),
                Some(BOKEH_SESSION_KIND)
            );
        }
        assert!(exts
            .claim(&RuntimeAgentRequest::InterruptExecution)
            .is_none());
        assert!(exts.claim(&RuntimeAgentRequest::ShutdownKernel).is_none());
        assert_eq!(exts.kernel.len(), 1);
    }

    enum LossTrigger {
        KernelLost,
        RoutingStopped,
    }

    /// Freezing on kernel loss and on the coordinator ending `bokeh_session`
    /// routing: the live state lands in the output's `snapshot` and the
    /// record turns read-only.
    async fn assert_live_sessions_freeze_on(trigger: LossTrigger) {
        let fx = fixture();
        let payload = json!({
            "schema_version": 1, "session_id": "session-1", "bokeh_version": "3.9.2",
            "document": {"version": "3.9.2", "roots": []}, "buffers": [],
        });
        let manifest = crate::output_store::create_manifest(
            &json!({
                "output_type": "display_data",
                "data": {BOKEH_SESSION_MIME: payload.clone()},
                "metadata": {},
            }),
            &fx.blob_store,
            crate::output_store::DEFAULT_INLINE_THRESHOLD,
        )
        .await
        .unwrap();
        let output_id = manifest.output_id().to_string();
        fx.state
            .with_doc(|doc| {
                doc.create_execution("exec-1")?;
                doc.append_outputs("exec-1", &[manifest.to_json()])?;
                doc.put_bokeh_session("session-1", &record("kernel-1", &output_id))?;
                // A record whose document the store never adopted (insert
                // refused after commit) must not stay connected either.
                doc.put_bokeh_session("orphan", &record("kernel-1", "output-orphan"))
            })
            .unwrap();
        let ext = BokehAgentExtension::with_store(store_with_session());
        let exts = AgentExtensions::new(vec![Arc::new(BokehAgentExtension::with_store(
            ext.store().clone(),
        ))]);

        let publisher = OutputBlobPublisher::none();
        let ctx = || AgentLifecycleCtx {
            state: &fx.state,
            blob_store: &fx.blob_store,
            blob_publisher: &publisher,
        };
        let expected_value = match trigger {
            LossTrigger::KernelLost => json!(0.9),
            LossTrigger::RoutingStopped => json!(0.5),
        };
        match trigger {
            LossTrigger::KernelLost => {
                // The kernel's last delta is still in the ingest window when
                // the kernel goes; it must reach the frozen state.
                let (shell, _shell_rx) = KernelShellRequester::for_test();
                let mut launched = crate::kernel_extensions::KernelExtensions::launch(
                    &[ext.kernel_extension().unwrap()],
                    &crate::kernel_extensions::KernelLaunchCtx {
                        kernel_id: "kernel-1",
                        kernel_actor_id: KERNEL,
                        state: &fx.state,
                        blob_store: &fx.blob_store,
                        blob_publisher: &publisher,
                        broadcast_tx: &broadcast::channel(4).0,
                        redactor: &Arc::new(OutputRedactor::default()),
                        shell: &shell,
                    },
                );
                launched
                    .routes()
                    .get(super::super::BOKEH_DELTA)
                    .unwrap()
                    .tx
                    .send(crate::kernel_extensions::RawIopubMessage {
                        msg_type: super::super::BOKEH_DELTA.into(),
                        content: crate::bokeh_session::ingest::tests::wire_delta(
                            "tx-final",
                            json!({"props_changed": {"p2": {"value": 0.9}}}),
                        ),
                        buffers: Vec::new(),
                    })
                    .unwrap();
                launched.shutdown();
                exts.on_kernel_lost("kernel-1", ctx()).await
            }
            LossTrigger::RoutingStopped => {
                exts.on_keyed_doc_unavailable("test_kv", ctx()).await;
                assert!(ext.store().contains("session-1"), "other kinds are ignored");
                exts.on_keyed_doc_unavailable(BOKEH_SESSION_KIND, ctx())
                    .await;
            }
        }

        let session = fx
            .state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .unwrap()
            .unwrap();
        assert_eq!(session.status, BokehSessionStatus::Disconnected);
        let orphan = fx
            .state
            .read(|doc| doc.get_bokeh_session("orphan"))
            .unwrap()
            .unwrap();
        assert_eq!(orphan.status, BokehSessionStatus::Disconnected);
        assert!(ext.store().data_tail("session-1", None).is_none());
        let output = fx
            .state
            .read(|doc| doc.get_output("exec-1", &output_id))
            .unwrap()
            .unwrap();
        let content: crate::output_store::ContentRef =
            serde_json::from_value(output["data"][BOKEH_SESSION_MIME].clone()).unwrap();
        let frozen: serde_json::Value =
            serde_json::from_str(&content.resolve(&fx.blob_store).await.unwrap()).unwrap();
        // The live state goes to `snapshot`; `document` stays byte-equal to
        // the durable record.
        assert_eq!(frozen["document"], payload["document"]);
        let root = &frozen["snapshot"]["document"]["roots"][0];
        assert_eq!(root["name"], "Row");
        assert_eq!(
            root["attributes"]["children"][0]["attributes"]["value"],
            expected_value
        );
        assert_eq!(frozen["snapshot"]["document"]["title"], "Page");
    }

    #[tokio::test]
    async fn kernel_loss_freezes_bokeh_sessions_into_their_output_read_only() {
        assert_live_sessions_freeze_on(LossTrigger::KernelLost).await;
    }

    #[tokio::test]
    async fn losing_bokeh_session_routing_freezes_live_sessions_read_only() {
        assert_live_sessions_freeze_on(LossTrigger::RoutingStopped).await;
    }

    #[test]
    fn bokeh_data_requests_answer_from_the_store_without_a_kernel() {
        let mut fx = fixture();
        let ext = BokehAgentExtension::with_store(BokehSessionStore::default());
        let data = |session_id: &str| RuntimeAgentRequest::GetBokehSessionData {
            session_id: session_id.into(),
            source_ids: None,
            request_folds: false,
        };
        let missing = fx.start(&ext, None, "req-1", data("session-1"));
        assert!(matches!(
            missing,
            ExtensionStart::Reply(RuntimeAgentResponse::Error { .. })
        ));

        ext.store().insert(
            "session-1",
            BokehSessionDoc::build(&snapshot(), KERNEL).unwrap(),
            "kernel-1",
            KERNEL,
        );
        let ExtensionStart::Reply(RuntimeAgentResponse::BokehSessionData { data }) =
            fx.start(&ext, None, "req-2", data("session-1"))
        else {
            panic!("expected a data tail");
        };
        assert_eq!(data.session_id, "session-1");
        assert!(data.events.is_empty());

        let patch = fx.start(
            &ext,
            None,
            "req-3",
            RuntimeAgentRequest::ApplyBokehSessionPatch {
                request: Box::new(BokehSessionPatchRequest {
                    session_id: "session-1".into(),
                    transaction_id: "tx".into(),
                    patch: json!({"events": []}),
                    buffers: Vec::new(),
                    buffer_refs: Vec::new(),
                }),
            },
        );
        assert!(matches!(
            patch,
            ExtensionStart::Reply(RuntimeAgentResponse::Error { error }) if error.contains("No kernel")
        ));
    }

    #[tokio::test]
    async fn patches_reply_later_without_blocking_the_agent_loop() {
        let mut fx = fixture();
        let ext = BokehAgentExtension::with_store(store_with_session());
        fx.state
            .with_doc(|doc| {
                doc.create_execution("exec-1")?;
                doc.put_bokeh_session("session-1", &record("kernel-1", "output-1"))
            })
            .unwrap();
        let request = |transaction_id: &str| RuntimeAgentRequest::ApplyBokehSessionPatch {
            request: Box::new(BokehSessionPatchRequest {
                session_id: "session-1".into(),
                transaction_id: transaction_id.into(),
                patch: json!({"events": []}),
                buffers: Vec::new(),
                buffer_refs: Vec::new(),
            }),
        };
        // A kernel without the Bokeh kernel extension cannot take patches.
        assert!(matches!(
            fx.start(&ext, Some("kernel-1"), "req-0", request("tx-0")),
            ExtensionStart::Reply(RuntimeAgentResponse::Error { error })
                if error.contains("does not support")
        ));
        // Another kernel's session is refused.
        let mut shell_rx = bind_test_kernel(&fx, ext.store(), "kernel-2");
        assert!(matches!(
            fx.start(&ext, Some("kernel-2"), "req-1", request("tx-1")),
            ExtensionStart::Reply(RuntimeAgentResponse::Error { error })
                if error.contains("not owned")
        ));

        let mut shell_rx_1 = bind_test_kernel(&fx, ext.store(), "kernel-1");
        assert!(matches!(
            fx.start(&ext, Some("kernel-1"), "req-2", request("tx-2")),
            ExtensionStart::Deferred
        ));
        assert!(matches!(
            fx.start(&ext, Some("kernel-1"), "req-3", request("tx-3")),
            ExtensionStart::Deferred
        ));
        async fn next(
            rx: &mut mpsc::UnboundedReceiver<crate::kernel_shell_requester::ShellCommand>,
        ) -> crate::kernel_shell_requester::ShellCommand {
            tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .expect("sent to the kernel")
                .unwrap()
        }
        let reply = |command: crate::kernel_shell_requester::ShellCommand, tx: &str, out: &str| {
            command
                .reply
                .send(Ok(crate::kernel_shell_requester::ShellReply {
                    msg_type: super::super::BOKEH_PATCH_REPLY.into(),
                    content: json!({"status": "ok", "session_id": "session-1",
                                    "transaction_id": tx, "stdout": out, "stderr": ""}),
                    buffers: Vec::new(),
                }))
                .unwrap();
        };
        // In arrival order, one at a time.
        let first = next(&mut shell_rx_1).await;
        assert_eq!(first.content["transaction_id"], "tx-2");
        assert!(shell_rx_1.try_recv().is_err());
        reply(first, "tx-2", "callback ran\n");
        let second = next(&mut shell_rx_1).await;
        assert_eq!(second.content["transaction_id"], "tx-3");
        reply(second, "tx-3", "");
        assert!(shell_rx.try_recv().is_err());
        let mut ids = Vec::new();
        for _ in 0..2 {
            let envelope =
                tokio::time::timeout(std::time::Duration::from_secs(2), fx.responses_rx.recv())
                    .await
                    .unwrap()
                    .unwrap();
            assert!(matches!(
                envelope.response,
                RuntimeAgentResponse::BokehSessionPatch { .. }
            ));
            ids.push(envelope.id);
        }
        ids.sort();
        assert_eq!(ids, ["req-2", "req-3"]);
        let outputs = fx.state.read(|doc| doc.get_outputs("exec-1")).unwrap();
        assert_eq!(
            outputs.len(),
            1,
            "callback stdout joins the owning execution"
        );
    }

    type ShellRx = mpsc::UnboundedReceiver<crate::kernel_shell_requester::ShellCommand>;

    /// A session whose `p3` tail outgrew its fold, bound to `kernel-1`.
    async fn oversized_tail() -> (Fixture, BokehAgentExtension, ShellRx) {
        use crate::bokeh_session::ingest::tests::wire_delta;
        use crate::bokeh_session::store::tests::flush;

        let fx = fixture();
        let ext = BokehAgentExtension::with_store(store_with_session());
        let shell_rx = bind_test_kernel(&fx, ext.store(), "kernel-1");
        flush(
            ext.store(),
            &fx.blob_store,
            wire_delta(
                "tx-0",
                json!({"data_events": [{"kind": "ColumnsFolded", "source_id": "p3", "version": 0,
                                         "columns": {"x": [1]}}]}),
            ),
            &[],
        )
        .await;
        flush(
            ext.store(),
            &fx.blob_store,
            wire_delta(
                "tx-1",
                json!({"data_events": [{"kind": "ColumnsStreamed", "source_id": "p3",
                    "base_version": 0, "new_version": 1, "rollover": null,
                    "data": {"type": "map", "entries": [["x", ["a"]]]}}]}),
            ),
            &[],
        )
        .await;
        (fx, ext, shell_rx)
    }

    fn request_data(fx: &mut Fixture, ext: &BokehAgentExtension, id: &str, request_folds: bool) {
        let started = fx.start(
            ext,
            Some("kernel-1"),
            id,
            RuntimeAgentRequest::GetBokehSessionData {
                session_id: "session-1".into(),
                source_ids: None,
                request_folds,
            },
        );
        let ExtensionStart::Reply(RuntimeAgentResponse::BokehSessionData { data }) = started else {
            panic!("expected a data tail");
        };
        assert_eq!(
            data.fold_requested,
            ["p3"],
            "the caller still learns of the fold"
        );
    }

    fn reply_to_fold(
        fold: crate::kernel_shell_requester::ShellCommand,
        content: serde_json::Value,
    ) {
        fold.reply
            .send(Ok(crate::kernel_shell_requester::ShellReply {
                msg_type: super::super::BOKEH_FOLD_REPLY.into(),
                content,
                buffers: Vec::new(),
            }))
            .unwrap();
    }

    async fn wait_for_folds_pending(ext: &BokehAgentExtension, expected: &[&str]) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while ext.store().folds_pending("session-1") != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("folds pending never became {expected:?}"));
    }

    /// Viewers never make the kernel fold, and a pending fold is not
    /// requested again until the kernel answers it.
    #[tokio::test]
    async fn oversized_tails_fold_once_per_source_and_only_for_writers() {
        let (mut fx, ext, mut shell_rx) = oversized_tail().await;

        request_data(&mut fx, &ext, "viewer", false);
        assert!(shell_rx.try_recv().is_err(), "viewers queue no kernel work");

        request_data(&mut fx, &ext, "writer-1", true);
        request_data(&mut fx, &ext, "writer-2", true);
        let fold = shell_rx.try_recv().expect("one fold");
        assert_eq!(fold.content["source_ids"], json!(["p3"]));
        assert!(
            shell_rx.try_recv().is_err(),
            "no second fold while one is pending"
        );

        reply_to_fold(fold, json!({"status": "ok"}));
        wait_for_folds_pending(&ext, &[]).await;
        request_data(&mut fx, &ext, "writer-3", true);
        assert!(
            shell_rx.try_recv().is_ok(),
            "a still-oversized tail folds again"
        );
    }

    /// A fold the kernel deferred stays pending past its reply, so readers
    /// do not queue more folds behind it, until its delta lands.
    #[tokio::test]
    async fn a_deferred_fold_stays_pending_until_its_delta_lands() {
        use crate::bokeh_session::ingest::tests::wire_delta;
        use crate::bokeh_session::store::tests::flush;

        let (mut fx, ext, mut shell_rx) = oversized_tail().await;
        request_data(&mut fx, &ext, "writer-1", true);
        let fold = shell_rx.try_recv().expect("one fold");
        reply_to_fold(
            fold,
            json!({"status": "ok", "source_ids": [], "deferred": true}),
        );
        // Let the reply task run; the claim must survive it.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert_eq!(ext.store().folds_pending("session-1"), ["p3"]);
        request_data(&mut fx, &ext, "writer-2", true);
        assert!(
            shell_rx.try_recv().is_err(),
            "the deferred fold is not requested again"
        );

        flush(
            ext.store(),
            &fx.blob_store,
            wire_delta(
                "tx-fold",
                json!({"data_events": [{"kind": "ColumnsFolded", "source_id": "p3", "version": 1,
                                         "columns": {"x": [1, 2]}}]}),
            ),
            &[],
        )
        .await;
        assert!(
            ext.store().folds_pending("session-1").is_empty(),
            "the fold delta ends the claim"
        );
    }

    /// Review R6b: the delta carrying a deferred fold can be lost (a failed
    /// `prepare_flush`, or the kernel's deferred fold raising). The claim
    /// must not block on-demand folds of that source for good.
    #[tokio::test]
    async fn a_deferred_fold_whose_delta_never_lands_expires() {
        let (mut fx, ext, mut shell_rx) = oversized_tail().await;
        request_data(&mut fx, &ext, "writer-1", true);
        let fold = shell_rx.try_recv().expect("one fold");
        reply_to_fold(
            fold,
            json!({"status": "ok", "source_ids": [], "deferred": true}),
        );
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        let half = super::super::store::FOLD_CLAIM_TTL_MS / 2;
        ext.store().advance_clock_for_test(half);
        request_data(&mut fx, &ext, "writer-2", true);
        assert!(shell_rx.try_recv().is_err(), "still within the claim's TTL");

        ext.store().advance_clock_for_test(half);
        request_data(&mut fx, &ext, "writer-3", true);
        assert!(
            shell_rx.try_recv().is_ok(),
            "an expired claim lets readers ask again"
        );
    }

    /// After a reconnect the room has frozen this agent's sessions; once
    /// the agent's replica shows that, the store drops them without
    /// freezing again, and replacements no longer publish over them.
    #[tokio::test]
    async fn sessions_the_coordinator_ended_leave_the_store_without_a_freeze() {
        let fx = fixture();
        let ext = BokehAgentExtension::with_store(store_with_session());
        let exts = AgentExtensions::new(vec![Arc::new(BokehAgentExtension::with_store(
            ext.store().clone(),
        ))]);
        let mut ended = record("kernel-1", "output-1");
        fx.state
            .with_doc(|doc| doc.put_bokeh_session("session-1", &ended))
            .unwrap();
        let publisher = OutputBlobPublisher::none();
        let ctx = || AgentLifecycleCtx {
            state: &fx.state,
            blob_store: &fx.blob_store,
            blob_publisher: &publisher,
        };
        exts.on_runtime_state_synced(ctx());
        assert!(ext.store().contains("session-1"), "connected sessions stay");

        ended.status = BokehSessionStatus::Disconnected;
        fx.state
            .with_doc(|doc| doc.put_bokeh_session("session-1", &ended))
            .unwrap();
        exts.on_runtime_state_synced(ctx());
        assert!(!ext.store().contains("session-1"));
        assert_eq!(
            fx.state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap(),
            Some(ended),
            "the room's frozen record is left as it is"
        );
    }

    #[tokio::test]
    async fn bokeh_retirement_closes_before_reply_and_rejects_old_kernel_identity() {
        let mut fx = fixture();
        let ext = BokehAgentExtension::with_store(store_with_session());
        let original = record("kernel-1", "output-1");
        fx.state
            .with_doc(|doc| doc.put_bokeh_session("session-1", &original))
            .unwrap();
        let mut shell_rx = bind_test_kernel(&fx, ext.store(), "kernel-1");
        let retire = |kernel_id: &str| RuntimeAgentRequest::RetireBokehSessions {
            kernel_id: kernel_id.into(),
            session_ids: vec!["session-1".into()],
        };

        assert!(matches!(
            fx.start(&ext, Some("kernel-1"), "r-0", retire("previous-kernel")),
            ExtensionStart::NoReply
        ));
        assert!(fx.tasks.is_empty());
        assert!(ext.store().contains("session-1"));
        assert_eq!(
            fx.state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap(),
            Some(original.clone())
        );

        fx.start(&ext, Some("kernel-1"), "r-1", retire("kernel-1"));
        let closed = fx
            .state
            .read(|doc| doc.get_bokeh_session("session-1"))
            .unwrap()
            .unwrap();
        assert_eq!(closed.status, BokehSessionStatus::Closed);
        assert_eq!(closed.epoch, original.epoch);
        assert!(
            !ext.store().contains("session-1"),
            "retired sessions leave the store"
        );
        assert_eq!(fx.tasks.len(), 1);
        assert!(
            !fx.tasks["session-1"].is_finished(),
            "kernel acknowledgement must not block the agent loop"
        );
        let close = tokio::time::timeout(std::time::Duration::from_secs(2), shell_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(close.isolated);
        assert_eq!(close.msg_type, super::super::BOKEH_CLOSE_REQUEST);

        fx.start(&ext, Some("kernel-1"), "r-2", retire("kernel-1"));
        assert_eq!(fx.tasks.len(), 1, "duplicate retirement is idempotent");
        fx.tasks.remove("session-1").unwrap().abort();
    }

    fn panel_output(session_id: &str) -> serde_json::Value {
        json!({
            "output_type": "display_data",
            "data": {
                BOKEH_SESSION_MIME: {
                    "schema_version": 1,
                    "session_id": session_id,
                    "producer": {"name": "panel", "version": "1.9.4"},
                    "bokeh_version": "3.9.2",
                    "document": {"version": "3.9.2", "roots": [{"id": "p1"}]},
                    "session_doc": {
                        "meta": {"session_id": session_id, "producer_name": "panel",
                                 "producer_version": "1.9.4", "bokeh_version": "3.9.2",
                                 "root_ids": ["p1"], "title": "Panel"},
                        "models": {"p1": {"type": "Slider", "ref_props": [],
                                          "props": {"value": 4}}},
                        "data_events": [],
                    },
                    "root_ids": ["p1"],
                    "resources": {"javascript": [], "stylesheets": []},
                    "buffers": [],
                    "session_doc_buffers": [],
                },
                "text/plain": "FloatSlider(value=4)",
            },
            "metadata": {},
        })
    }

    /// Fix 1 through the real agent loop and the Bokeh extension: a
    /// coordinator that does not route `bokeh_session` gets a static Panel
    /// output (no record, no session, no `0x0b`) and the agent keeps running;
    /// once it routes the kind, the next output is live.
    #[tokio::test]
    async fn panel_output_stays_static_until_the_coordinator_routes_bokeh_session() {
        use crate::output_committer::{
            start_output_committer, OrdinaryOutputCommit, OrdinaryOutputKind,
        };
        use crate::runtime_agent::tests::{
            channel_connection, coordinator_kinds, keyed_frames_within, next_keyed_frame,
            ChannelTransport,
        };

        let fx = fixture();
        fx.state
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
            .unwrap();
        let (connection, coordinator, mut outbound) = channel_connection();
        let transport = ChannelTransport(std::sync::Mutex::new([connection].into_iter().collect()));
        let hooks = Arc::new(std::sync::Mutex::new(None));
        let agent = tokio::spawn(crate::runtime_agent::run_runtime_agent_on_transport(
            transport,
            "bokeh-fix-1".to_string(),
            fx._dir.path().join("agent-blobs"),
            |_| Ok("runtime-agent:bokeh-fix-1".to_string()),
            OutputBlobPublisher::none(),
            None,
            {
                let hooks = hooks.clone();
                move |init: &AgentExtensionInit| {
                    let ext = BokehAgentExtension::new(init);
                    let store = ext.store().clone();
                    let exts = AgentExtensions::new(vec![Arc::new(ext)]);
                    *hooks.lock().unwrap() = Some((exts.output_hooks.clone(), store));
                    exts
                }
            },
        ));
        let quiet = std::time::Duration::from_millis(300);
        coordinator.send(coordinator_kinds(&[])).unwrap();
        assert!(keyed_frames_within(&mut outbound, quiet).await.is_empty());

        let (hooks, store) = hooks.lock().unwrap().clone().expect("extensions built");
        let committer = start_output_committer(
            crate::output_commit_context::OutputCommitContext::new(
                fx.state.clone(),
                fx.blob_store.clone(),
                OutputBlobPublisher::none(),
                KERNEL.to_string(),
                "kernel-1".to_string(),
                mpsc::unbounded_channel().0,
                Arc::new(OutputRedactor::disabled()),
            )
            .with_output_hooks(hooks),
        );
        let commit = |session_id: &str| OrdinaryOutputCommit {
            execution_id: "exec-1".to_string(),
            nbformat_value: panel_output(session_id),
            buffers: Vec::new(),
            kind: OrdinaryOutputKind::DisplayData,
        };
        committer.enqueue_output(commit("session-1")).await;
        committer.flush_for_ordering().await;

        let outputs = fx.state.read(|doc| doc.get_outputs("exec-1")).unwrap();
        assert_eq!(outputs.len(), 1, "the output is committed");
        let content: crate::output_store::ContentRef =
            serde_json::from_value(outputs[0]["data"][BOKEH_SESSION_MIME].clone()).unwrap();
        let stored: serde_json::Value =
            serde_json::from_str(&content.resolve(&fx.blob_store).await.unwrap()).unwrap();
        assert_eq!(
            stored["document"]["roots"][0]["id"], "p1",
            "static render kept"
        );
        assert!(stored.get("session_doc").is_none());
        assert!(
            fx.state
                .read(|doc| doc.get_bokeh_session("session-1"))
                .unwrap()
                .is_none(),
            "no live record"
        );
        assert!(
            keyed_frames_within(&mut outbound, quiet).await.is_empty(),
            "no 0x0b without routing"
        );
        assert!(!agent.is_finished(), "the agent keeps running");

        coordinator
            .send(coordinator_kinds(&[BOKEH_SESSION_KIND]))
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        committer.enqueue_output(commit("session-2")).await;
        committer.flush_for_ordering().await;
        assert!(fx
            .state
            .read(|doc| doc.get_bokeh_session("session-2"))
            .unwrap()
            .is_some());
        let frame = next_keyed_frame(&mut outbound).await;
        let (header, _) = notebook_wire::KeyedDocFrameHeader::try_parse(&frame).unwrap();
        assert_eq!(
            (header.kind.as_str(), header.id.as_str(), header.epoch),
            (BOKEH_SESSION_KIND, "session-2", 0)
        );
        assert!(store.contains("session-2"));

        // The coordinator stops routing the kind: the live session is frozen
        // out of the store, and the agent keeps running without `0x0b`.
        coordinator
            .send(Ok(notebook_protocol::connection::TypedNotebookFrame {
                frame_type: notebook_protocol::connection::NotebookFrameType::SessionControl,
                payload: serde_json::to_vec(&json!({
                    "type": "cloud_frame_rejected",
                    "frame_type": notebook_wire::frame_types::KEYED_DOC_SYNC,
                    "reason": "keyed_doc_sync is not routed",
                }))
                .unwrap(),
            }))
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while store.contains("session-2") {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the session leaves the store");
        assert!(!store.accepts_sessions());
        assert!(keyed_frames_within(&mut outbound, quiet).await.is_empty());
        assert!(!agent.is_finished());

        drop(coordinator);
        tokio::time::timeout(std::time::Duration::from_secs(10), agent)
            .await
            .expect("agent exits on EOF")
            .unwrap()
            .unwrap();
    }
}
