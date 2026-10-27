//! The Bokeh half of a launched kernel: delta ingest, the foreign-change
//! forwarder, and patch/fold/close requests over the kernel's extension shell.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use notebook_protocol::protocol::BokehSessionPatchRequest;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::warn;

use super::store::{run_ingest, BokehForeignForward, BokehSessionStore, IngestContext};
use super::{
    kernel_error_text, parse_patch_reply, patch_request_wire, BokehKernelPatchResponse,
    RawBokehKernelMessage, BOKEH_CLOSE_REPLY, BOKEH_CLOSE_REQUEST, BOKEH_DELTA, BOKEH_FOLD_REPLY,
    BOKEH_FOLD_REQUEST, BOKEH_PATCH_REQUEST, BOKEH_WIRE_SCHEMA_VERSION,
};
use crate::blob_store::BlobStore;
use crate::kernel_extensions::{
    IopubRoute, KernelExtension, KernelExtensionInstance, KernelLaunchCtx,
};
use crate::kernel_shell_requester::{KernelShellRequester, ShellReply};
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_redaction::OutputRedactor;
use crate::task_supervisor::spawn_best_effort;

/// A Panel callback runs inside the patch request, so allow long ones.
const BOKEH_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const BOKEH_CLOSE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
const BOKEH_CLOSE_RETRY_DELAY: Duration = Duration::from_secs(5);

impl From<ShellReply> for RawBokehKernelMessage {
    fn from(reply: ShellReply) -> Self {
        Self {
            msg_type: reply.msg_type,
            content: reply.content,
            buffers: reply.buffers,
        }
    }
}

/// Bokeh requests on one kernel's serial extension shell.
///
/// Each method enqueues when called, so callers keep arrival order without
/// awaiting the kernel; the returned futures only wait for the reply.
#[derive(Clone)]
pub(crate) struct BokehKernelRequester {
    shell: KernelShellRequester,
    redactor: Arc<OutputRedactor>,
}

impl BokehKernelRequester {
    pub(crate) fn new(shell: KernelShellRequester, redactor: Arc<OutputRedactor>) -> Self {
        Self { shell, redactor }
    }

    pub(crate) fn patch(
        &self,
        request: &BokehSessionPatchRequest,
    ) -> impl Future<Output = anyhow::Result<BokehKernelPatchResponse>> + Send + 'static {
        let (content, buffers) = patch_request_wire(request);
        let reply =
            self.shell
                .request(BOKEH_PATCH_REQUEST, content, buffers, BOKEH_REQUEST_TIMEOUT);
        let redactor = self.redactor.clone();
        async move {
            let mut response = parse_patch_reply(reply.await?.into())?;
            response.stdout = redactor.redact_text(&response.stdout).into_owned();
            response.stderr = redactor.redact_text(&response.stderr).into_owned();
            if let Some(error) = response.error_output.take() {
                response.error_output = Some(redactor.redact_output_value(&error));
            }
            Ok(response)
        }
    }

    /// Ask the kernel to fold sources; the folds arrive as a delta.
    pub(crate) fn fold(
        &self,
        session_id: &str,
        source_ids: Vec<String>,
    ) -> impl Future<Output = anyhow::Result<()>> + Send + 'static {
        let content = json!({
            "schema_version": BOKEH_WIRE_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": uuid::Uuid::new_v4().to_string(),
            "source_ids": source_ids,
        });
        let reply = self.shell.request(
            BOKEH_FOLD_REQUEST,
            content,
            Vec::new(),
            BOKEH_REQUEST_TIMEOUT,
        );
        async move {
            let raw = reply.await?;
            anyhow::ensure!(
                raw.msg_type == BOKEH_FOLD_REPLY,
                "expected {BOKEH_FOLD_REPLY}, got {}",
                raw.msg_type
            );
            anyhow::ensure!(
                raw.content.get("status").and_then(Value::as_str) == Some("ok"),
                "Bokeh fold failed: {}",
                kernel_error_text(raw.content.get("error"))
            );
            Ok(())
        }
    }

    /// Close a retired session. Close is idempotent, so transport failures
    /// are retried until the caller drops (aborts) the future on shutdown,
    /// restart or kernel death. Runs on its own connection so queued
    /// callbacks cannot delay it.
    pub(crate) fn close(
        &self,
        session_id: String,
    ) -> impl Future<Output = anyhow::Result<()>> + Send + 'static {
        let shell = self.shell.clone();
        async move {
            loop {
                let content = json!({
                    "schema_version": BOKEH_WIRE_SCHEMA_VERSION,
                    "session_id": session_id,
                    "transaction_id": uuid::Uuid::new_v4().to_string(),
                });
                let result = shell
                    .request_isolated(BOKEH_CLOSE_REQUEST, content, BOKEH_CLOSE_ATTEMPT_TIMEOUT)
                    .await
                    .and_then(|reply| check_close_reply(&session_id, &reply));
                match result {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        warn!("[bokeh-session] Retrying close for {session_id}: {error}")
                    }
                }
                tokio::time::sleep(BOKEH_CLOSE_RETRY_DELAY).await;
            }
        }
    }
}

fn check_close_reply(session_id: &str, reply: &ShellReply) -> anyhow::Result<()> {
    anyhow::ensure!(
        reply.msg_type == BOKEH_CLOSE_REPLY
            && reply.content.get("session_id").and_then(Value::as_str) == Some(session_id)
            && matches!(
                reply.content.get("status").and_then(Value::as_str),
                Some("ok" | "not_found")
            ),
        "Bokeh close failed: {}",
        reply.content
    );
    Ok(())
}

/// Turn forwarded property changes into `ModelChanged` patch requests, in
/// arrival order, and route each callback's output once it replies.
async fn run_bokeh_forwarder(
    mut forwards: mpsc::UnboundedReceiver<BokehForeignForward>,
    requester: BokehKernelRequester,
    state: runtime_doc::RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    blob_publisher: OutputBlobPublisher,
) {
    while let Some(forward) = forwards.recv().await {
        let mut events = Vec::with_capacity(forward.changes.len());
        for (model, attr, encoded) in &forward.changes {
            match super::materialize::resolve_value(encoded, &blob_store).await {
                Ok(new) => events.push(json!({
                    "kind": "ModelChanged",
                    "model": {"id": model},
                    "attr": attr,
                    "new": new,
                })),
                Err(error) => warn!("[bokeh-session] Cannot forward {model}.{attr}: {error}"),
            }
        }
        if events.is_empty() {
            continue;
        }
        let request = BokehSessionPatchRequest {
            session_id: forward.session_id,
            transaction_id: forward.transaction_id,
            patch: json!({"events": events}),
            buffers: Vec::new(),
            buffer_refs: Vec::new(),
        };
        // Enqueued here, in order; only the reply is awaited off this loop.
        let reply = requester.patch(&request);
        let state = state.clone();
        let blob_store = blob_store.clone();
        let blob_publisher = blob_publisher.clone();
        spawn_best_effort("bokeh-forward-reply", async move {
            match reply.await {
                Ok(response) => {
                    if let Err(error) = super::append_callback_outputs(
                        &request.session_id,
                        &response,
                        &state,
                        &blob_store,
                        &blob_publisher,
                    )
                    .await
                    {
                        warn!("[bokeh-session] Failed to append callback output: {error}");
                    }
                }
                Err(error) => warn!(
                    "[bokeh-session] Forwarding {} to the kernel failed: {error}",
                    request.session_id
                ),
            }
        });
    }
}

/// Per-kernel Bokeh tasks: ingest of `nteract_bokeh_delta` and the
/// forwarder of foreign property changes. Both write the agent's store.
pub(crate) struct BokehKernelExtension {
    pub(crate) store: BokehSessionStore,
}

impl KernelExtension for BokehKernelExtension {
    fn on_launch(&self, ctx: &KernelLaunchCtx<'_>) -> KernelExtensionInstance {
        let requester = BokehKernelRequester::new(ctx.shell.clone(), ctx.redactor.clone());
        let (delta_tx, delta_rx) = mpsc::unbounded_channel();
        let ingest = spawn_best_effort(
            "bokeh-session-ingest",
            run_ingest(
                delta_rx,
                IngestContext {
                    store: self.store.clone(),
                    blob_store: ctx.blob_store.clone(),
                    blob_publisher: ctx.blob_publisher.clone(),
                    state: ctx.state.clone(),
                    broadcast_tx: ctx.broadcast_tx.clone(),
                    kernel_actor_id: ctx.kernel_actor_id.to_string(),
                },
            ),
        );
        let (forward_tx, forward_rx) = mpsc::unbounded_channel();
        self.store
            .attach_kernel(ctx.kernel_id, requester.clone(), forward_tx.clone());
        let forwarder = spawn_best_effort(
            "bokeh-session-forwarder",
            run_bokeh_forwarder(
                forward_rx,
                requester,
                ctx.state.clone(),
                ctx.blob_store.clone(),
                ctx.blob_publisher.clone(),
            ),
        );
        let store = self.store.clone();
        let kernel_id = ctx.kernel_id.to_string();
        KernelExtensionInstance {
            iopub: vec![(
                BOKEH_DELTA,
                IopubRoute {
                    tx: delta_tx,
                    // The display output creates the session document, so a
                    // delta from the same ordered IOPub stream must find it.
                    after_outputs: true,
                },
            )],
            tasks: vec![ingest, forwarder],
            on_shutdown: Some(Box::new(move || {
                store.detach_kernel(&kernel_id, &forward_tx);
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel_extensions::{KernelExtensions, RawIopubMessage};
    use crate::kernel_shell_requester::ShellCommand;
    use notebook_protocol::protocol::BokehSessionPatchReply;
    use tokio::sync::broadcast;

    fn reply(command: ShellCommand, msg_type: &str, content: Value) {
        command
            .reply
            .send(Ok(ShellReply {
                msg_type: msg_type.to_string(),
                content,
                buffers: Vec::new(),
            }))
            .unwrap();
    }

    #[tokio::test]
    async fn patch_replies_are_parsed_and_redacted() {
        let (shell, mut rx) = KernelShellRequester::for_test();
        let redactor = Arc::new(OutputRedactor::from_values_for_test([
            "hunter2secret".to_string()
        ]));
        let requester = BokehKernelRequester::new(shell, redactor);
        let request = BokehSessionPatchRequest {
            session_id: "session-1".into(),
            transaction_id: "tx-1".into(),
            patch: json!({"events": []}),
            buffers: Vec::new(),
            buffer_refs: Vec::new(),
        };
        let pending = requester.patch(&request);
        let command = rx.try_recv().expect("enqueued on call");
        assert_eq!(command.msg_type, BOKEH_PATCH_REQUEST);
        assert_eq!(command.timeout, BOKEH_REQUEST_TIMEOUT);
        assert_eq!(command.content["session_id"], "session-1");
        reply(
            command,
            super::super::BOKEH_PATCH_REPLY,
            json!({"status": "ok", "session_id": "session-1", "transaction_id": "tx-1",
                   "stdout": "pw hunter2secret\n", "stderr": ""}),
        );
        let response = pending.await.unwrap();
        assert_eq!(
            response.reply,
            BokehSessionPatchReply::Accepted {
                session_id: "session-1".into(),
                transaction_id: "tx-1".into(),
            }
        );
        assert!(
            !response.stdout.contains("hunter2secret"),
            "{}",
            response.stdout
        );
    }

    #[tokio::test]
    async fn fold_and_close_check_the_kernel_reply() {
        let (shell, mut rx) = KernelShellRequester::for_test();
        let requester = BokehKernelRequester::new(shell, Arc::new(OutputRedactor::default()));
        let fold = requester.fold("session-1", vec!["p3".into()]);
        let command = rx.try_recv().unwrap();
        assert_eq!(command.content["source_ids"], json!(["p3"]));
        reply(
            command,
            BOKEH_FOLD_REPLY,
            json!({"status": "error", "error": {"ename": "KeyError", "evalue": "p3"}}),
        );
        let error = fold.await.unwrap_err();
        assert!(error.to_string().contains("KeyError: p3"), "{error}");

        let close = tokio::spawn(requester.close("session-1".into()));
        let command = rx.recv().await.unwrap();
        assert!(command.isolated, "close does not wait behind the queue");
        assert_eq!(command.msg_type, BOKEH_CLOSE_REQUEST);
        reply(
            command,
            BOKEH_CLOSE_REPLY,
            json!({"status": "not_found", "session_id": "session-1"}),
        );
        close.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn launch_routes_deltas_binds_the_kernel_and_shutdown_unbinds_it() {
        let dir = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_doc::RuntimeStateHandle::new(
            runtime_doc::RuntimeStateDoc::new(),
            broadcast::channel(4).0,
        );
        let (broadcast_tx, mut broadcasts) = broadcast::channel(16);
        let redactor = Arc::new(OutputRedactor::default());
        let (shell, _shell_rx) = KernelShellRequester::for_test();
        let store = super::super::store::tests::store_with_session();
        let exts: Vec<Arc<dyn KernelExtension>> = vec![Arc::new(BokehKernelExtension {
            store: store.clone(),
        })];
        let mut launched = KernelExtensions::launch(
            &exts,
            &KernelLaunchCtx {
                kernel_id: "kernel-1",
                kernel_actor_id: super::super::store::tests::KERNEL,
                state: &state,
                blob_store: &blob_store,
                blob_publisher: &OutputBlobPublisher::none(),
                broadcast_tx: &broadcast_tx,
                redactor: &redactor,
                shell: &shell,
            },
        );
        assert!(store.requester("kernel-1").is_some());
        let route = launched.routes().get(BOKEH_DELTA).cloned().expect("routed");
        assert!(route.after_outputs);
        route
            .tx
            .send(RawIopubMessage {
                msg_type: BOKEH_DELTA.into(),
                content: super::super::ingest::tests::wire_delta(
                    "tx-1",
                    json!({"messages": [{"msg_type": "toast", "msg_data": {}}]}),
                ),
                buffers: Vec::new(),
            })
            .unwrap();
        let events = tokio::time::timeout(Duration::from_secs(2), broadcasts.recv())
            .await
            .expect("ingested and broadcast")
            .unwrap();
        assert!(matches!(
            events,
            crate::protocol::NotebookBroadcast::BokehSessionEvents { .. }
        ));

        launched.shutdown();
        assert!(store.requester("kernel-1").is_none());
    }
}
