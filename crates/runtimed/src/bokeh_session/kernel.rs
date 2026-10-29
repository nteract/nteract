//! The Bokeh half of a launched kernel: delta ingest, the foreign-change
//! forwarder, and patch/fold/close requests over the kernel's extension shell.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use notebook_protocol::protocol::BokehSessionPatchRequest;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;
use tracing::warn;

use super::store::{run_ingest, BokehSessionStore, IngestContext};
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

    /// Ask the kernel to fold sources; the folds arrive as a delta. Resolves
    /// to whether the kernel deferred them until its document is free, in
    /// which case the delta comes after the reply.
    pub(crate) fn fold(
        &self,
        session_id: &str,
        source_ids: Vec<String>,
    ) -> impl Future<Output = anyhow::Result<bool>> + Send + 'static {
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
            Ok(raw.content.get("deferred").and_then(Value::as_bool) == Some(true))
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

/// One-off events a kernel's outbox holds at most; more are refused, since
/// unlike property writes they cannot be merged.
const MAX_PENDING_ONE_OFFS: usize = 256;
/// How long a stopped kernel's ingest may take to apply the deltas it
/// already received.
pub(crate) const INGEST_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

type PatchReply = oneshot::Sender<anyhow::Result<BokehKernelPatchResponse>>;

enum Outbound {
    /// Foreign property writes for one session, one `(model, property,
    /// encoded value)` per key, ordered by each key's last write.
    Props {
        session_id: String,
        changes: Vec<(String, String, String)>,
    },
    /// A peer's `ApplyBokehSessionPatch`; never merged.
    OneOff {
        request: BokehSessionPatchRequest,
        reply: PatchReply,
    },
}

#[derive(Default)]
struct OutboxQueue {
    pending: VecDeque<Outbound>,
    one_offs: usize,
    closed: bool,
}

/// Everything a kernel's Bokeh sessions send to it, in arrival order, with
/// one patch at a time on the shell. While one is in flight, property writes
/// merge, so a slider dragged during a long cell sends its latest value once
/// instead of queueing every intermediate one.
#[derive(Clone, Default)]
pub(crate) struct BokehKernelOutbox {
    queue: Arc<StdMutex<OutboxQueue>>,
    wake: Arc<Notify>,
    #[cfg(test)]
    tap: Option<mpsc::UnboundedSender<super::store::BokehForeignForward>>,
}

impl BokehKernelOutbox {
    /// An outbox that hands each forward to `tap` instead of a kernel.
    #[cfg(test)]
    pub(crate) fn tap_for_test(
        tap: mpsc::UnboundedSender<super::store::BokehForeignForward>,
    ) -> Self {
        Self {
            tap: Some(tap),
            ..Self::default()
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, OutboxQueue> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.queue, &other.queue)
    }

    /// Queue foreign property writes. They merge into the session's pending
    /// writes unless a one-off event was queued since: a callback for that
    /// event must see the values written before it, and only those.
    /// Merging can move a write ahead of another session's queued writes;
    /// sessions are separate Bokeh documents, so only per-session order
    /// matters.
    pub(crate) fn forward_props(&self, session_id: &str, changes: Vec<(String, String, String)>) {
        if changes.is_empty() {
            return;
        }
        #[cfg(test)]
        if let Some(tap) = &self.tap {
            let _ = tap.send(super::store::BokehForeignForward {
                session_id: session_id.to_string(),
                changes,
            });
            return;
        }
        let mut queue = self.lock();
        if queue.closed {
            return;
        }
        let merge_into = queue
            .pending
            .iter_mut()
            .rev()
            .take_while(|entry| matches!(entry, Outbound::Props { .. }))
            .find_map(|entry| match entry {
                Outbound::Props {
                    session_id: id,
                    changes,
                } if id == session_id => Some(changes),
                _ => None,
            });
        match merge_into {
            Some(pending) => {
                for change in changes {
                    pending.retain(|(model, prop, _)| (model, prop) != (&change.0, &change.1));
                    pending.push(change);
                }
            }
            None => queue.pending.push_back(Outbound::Props {
                session_id: session_id.to_string(),
                changes,
            }),
        }
        drop(queue);
        self.wake.notify_one();
    }

    /// Queue a one-off patch behind everything written before it. Returns
    /// the kernel's reply, or an error when too many are already waiting.
    pub(crate) fn one_off(
        &self,
        request: BokehSessionPatchRequest,
    ) -> Result<
        impl Future<Output = anyhow::Result<BokehKernelPatchResponse>> + Send + 'static,
        String,
    > {
        let (reply, response) = oneshot::channel();
        {
            let mut queue = self.lock();
            if queue.closed {
                return Err("the kernel's Bokeh outbox is closed".to_string());
            }
            if queue.one_offs >= MAX_PENDING_ONE_OFFS {
                return Err(format!(
                    "{MAX_PENDING_ONE_OFFS} Bokeh events are already waiting for the kernel"
                ));
            }
            queue.one_offs += 1;
            queue.pending.push_back(Outbound::OneOff { request, reply });
        }
        self.wake.notify_one();
        Ok(async move {
            // Dropped unsent on close, or in flight when shutdown aborted the
            // outbox, after which the kernel may still have run it.
            response.await.map_err(|_| {
                anyhow::anyhow!("the kernel stopped before it replied to the Bokeh event")
            })?
        })
    }

    /// Drop everything pending; later sends are ignored or refused.
    pub(crate) fn close(&self) {
        let mut queue = self.lock();
        queue.closed = true;
        queue.pending.clear();
        queue.one_offs = 0;
        drop(queue);
        self.wake.notify_one();
    }

    async fn next(&self) -> Option<Outbound> {
        loop {
            {
                let mut queue = self.lock();
                if let Some(entry) = queue.pending.pop_front() {
                    if matches!(entry, Outbound::OneOff { .. }) {
                        queue.one_offs -= 1;
                    }
                    return Some(entry);
                }
                if queue.closed {
                    return None;
                }
            }
            // `notify_one` stores a permit, so a send between the check and
            // this await is not missed.
            self.wake.notified().await;
        }
    }
}

/// Send the outbox to the kernel one patch at a time and route each
/// callback's output once it replies.
async fn run_bokeh_outbox(
    outbox: BokehKernelOutbox,
    requester: BokehKernelRequester,
    state: runtime_doc::RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    blob_publisher: OutputBlobPublisher,
) {
    while let Some(entry) = outbox.next().await {
        let (request, reply) = match entry {
            Outbound::Props {
                session_id,
                changes,
            } => {
                let mut events = Vec::with_capacity(changes.len());
                for (model, attr, encoded) in &changes {
                    match super::materialize::resolve_value(encoded, &blob_store).await {
                        Ok(new) => events.push(json!({
                            "kind": "ModelChanged",
                            "model": {"id": model},
                            "attr": attr,
                            "new": new,
                        })),
                        Err(error) => {
                            warn!("[bokeh-session] Cannot forward {model}.{attr}: {error}")
                        }
                    }
                }
                if events.is_empty() {
                    continue;
                }
                let request = BokehSessionPatchRequest {
                    session_id,
                    transaction_id: uuid::Uuid::new_v4().to_string(),
                    patch: json!({"events": events}),
                    buffers: Vec::new(),
                    buffer_refs: Vec::new(),
                };
                (request, None)
            }
            Outbound::OneOff { request, reply } => (request, Some(reply)),
        };
        let result = requester.patch(&request).await;
        match reply {
            Some(reply) => {
                let _ = reply.send(result);
            }
            None => {
                let state = state.clone();
                let blob_store = blob_store.clone();
                let blob_publisher = blob_publisher.clone();
                spawn_best_effort("bokeh-forward-reply", async move {
                    match result {
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
    }
}

/// Start a kernel's outbox task; it ends when the outbox is closed.
pub(crate) fn spawn_outbox(
    requester: BokehKernelRequester,
    state: runtime_doc::RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    blob_publisher: OutputBlobPublisher,
) -> (BokehKernelOutbox, JoinHandle<()>) {
    let outbox = BokehKernelOutbox::default();
    let task = spawn_best_effort(
        "bokeh-session-outbox",
        run_bokeh_outbox(outbox.clone(), requester, state, blob_store, blob_publisher),
    );
    (outbox, task)
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
        let (stop_ingest, stop) = oneshot::channel();
        let (drained_tx, drained) = oneshot::channel::<()>();
        // Not in `tasks`, which shutdown aborts: deltas the kernel sent before
        // it went must reach the documents before they are frozen.
        spawn_best_effort("bokeh-session-ingest", {
            let ctx = IngestContext {
                store: self.store.clone(),
                blob_store: ctx.blob_store.clone(),
                blob_publisher: ctx.blob_publisher.clone(),
                state: ctx.state.clone(),
                broadcast_tx: ctx.broadcast_tx.clone(),
                kernel_actor_id: ctx.kernel_actor_id.to_string(),
            };
            async move {
                run_ingest(delta_rx, ctx, stop).await;
                drop(drained_tx);
            }
        });
        let (outbox, outbox_task) = spawn_outbox(
            requester.clone(),
            ctx.state.clone(),
            ctx.blob_store.clone(),
            ctx.blob_publisher.clone(),
        );
        self.store
            .attach_kernel(ctx.kernel_id, requester, outbox.clone(), drained);
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
            tasks: vec![outbox_task],
            on_shutdown: Some(Box::new(move || {
                let _ = stop_ingest.send(());
                outbox.close();
                store.detach_kernel(&kernel_id, &outbox);
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
        for (content, deferred) in [
            (json!({"status": "ok", "source_ids": ["p3"]}), false),
            (
                json!({"status": "ok", "source_ids": [], "deferred": true}),
                true,
            ),
        ] {
            let fold = requester.fold("session-1", vec!["p3".into()]);
            reply(rx.try_recv().unwrap(), BOKEH_FOLD_REPLY, content);
            assert_eq!(fold.await.unwrap(), deferred);
        }

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

    fn patch_events(command: &ShellCommand) -> Vec<(String, String, Value)> {
        assert_eq!(command.msg_type, BOKEH_PATCH_REQUEST);
        command.content["patch"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| {
                (
                    event["model"]["id"].as_str().unwrap().to_string(),
                    event["attr"].as_str().unwrap().to_string(),
                    event["new"].clone(),
                )
            })
            .collect()
    }

    fn patch_ok(command: ShellCommand) {
        let session_id = command.content["session_id"].clone();
        let transaction_id = command.content["transaction_id"].clone();
        reply(
            command,
            super::super::BOKEH_PATCH_REPLY,
            json!({"status": "ok", "session_id": session_id, "transaction_id": transaction_id,
                   "stdout": "", "stderr": ""}),
        );
    }

    async fn next_command(rx: &mut mpsc::UnboundedReceiver<ShellCommand>) -> ShellCommand {
        tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("a request reaches the shell")
            .unwrap()
    }

    async fn assert_no_command(rx: &mut mpsc::UnboundedReceiver<ShellCommand>) {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Ok(command) = rx.try_recv() {
            panic!("unexpected request {}", command.content);
        }
    }

    /// A launched Bokeh kernel over a test shell, plus a synced peer.
    struct Harness {
        store: BokehSessionStore,
        shell_rx: mpsc::UnboundedReceiver<ShellCommand>,
        states: crate::keyed_doc::KeyedSyncStates,
        peer: runtime_doc::BokehSessionDoc,
        peer_state: automerge::sync::State,
        launched: KernelExtensions,
        _blob_dir: tempfile::TempDir,
    }

    impl Harness {
        fn new() -> Self {
            let dir = tempfile::TempDir::new().unwrap();
            let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
            let state = runtime_doc::RuntimeStateHandle::new(
                runtime_doc::RuntimeStateDoc::new(),
                broadcast::channel(4).0,
            );
            let (broadcast_tx, _) = broadcast::channel(16);
            let redactor = Arc::new(OutputRedactor::default());
            let (shell, shell_rx) = KernelShellRequester::for_test();
            let store = super::super::store::tests::store_with_session();
            let exts: Vec<Arc<dyn KernelExtension>> = vec![Arc::new(BokehKernelExtension {
                store: store.clone(),
            })];
            let launched = KernelExtensions::launch(
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
            let mut harness = Self {
                store,
                shell_rx,
                states: crate::keyed_doc::KeyedSyncStates::new(),
                peer: runtime_doc::BokehSessionDoc::new_empty("user:dev:alice/browser"),
                peer_state: automerge::sync::State::new(),
                launched,
                _blob_dir: dir,
            };
            harness.sync();
            harness
        }

        fn sync(&mut self) {
            super::super::store::tests::sync_peer(
                &self.store,
                &mut self.states,
                &mut self.peer,
                &mut self.peer_state,
                0,
            );
        }

        fn write(&mut self, model: &str, prop: &str, value: &str) {
            self.peer.set_prop(model, prop, value).unwrap();
            self.peer.commit();
            self.sync();
        }
    }

    #[tokio::test]
    async fn property_writes_coalesce_while_a_patch_is_in_flight() {
        let mut h = Harness::new();
        h.write("p2", "value", "0.1");
        let first = next_command(&mut h.shell_rx).await;
        assert_eq!(
            patch_events(&first),
            vec![("p2".into(), "value".into(), json!(0.1))]
        );
        // A drag while the kernel is busy with the first patch.
        for i in 0..200 {
            h.write("p2", "value", &format!("0.{}", 200 + i));
            if i == 100 {
                h.write("p2", "title", r#""Beta""#);
            }
        }
        h.write("p2", "title", r#""Gamma""#);
        h.write("p2", "value", "0.75");
        assert_no_command(&mut h.shell_rx).await;

        patch_ok(first);
        let second = next_command(&mut h.shell_rx).await;
        assert_eq!(
            patch_events(&second),
            vec![
                ("p2".into(), "title".into(), json!("Gamma")),
                ("p2".into(), "value".into(), json!(0.75)),
            ],
            "latest value per property, in last-write order"
        );
        patch_ok(second);
        assert_no_command(&mut h.shell_rx).await;
    }

    fn one_off(transaction_id: &str) -> BokehSessionPatchRequest {
        BokehSessionPatchRequest {
            session_id: "session-1".into(),
            transaction_id: transaction_id.into(),
            patch: json!({"events": [{"kind": "MessageSent", "msg_type": "bokeh_event",
                                      "msg_data": {"event_name": "button_click"}}]}),
            buffers: Vec::new(),
            buffer_refs: Vec::new(),
        }
    }

    #[tokio::test]
    async fn one_off_events_are_never_merged_and_writes_do_not_cross_them() {
        let mut h = Harness::new();
        let outbox = h.store.outbox("kernel-1").expect("bound at launch");
        h.write("p2", "value", "0.1");
        let busy = next_command(&mut h.shell_rx).await;

        h.write("p2", "value", "0.2");
        let clicks = [
            outbox.one_off(one_off("click-1")).unwrap(),
            outbox.one_off(one_off("click-2")).unwrap(),
        ];
        h.write("p2", "value", "0.3");
        h.write("p2", "value", "0.4");
        assert_no_command(&mut h.shell_rx).await;

        patch_ok(busy);
        let before = next_command(&mut h.shell_rx).await;
        assert_eq!(
            patch_events(&before),
            vec![("p2".into(), "value".into(), json!(0.2))],
            "the value written before the click goes first"
        );
        patch_ok(before);
        for transaction_id in ["click-1", "click-2"] {
            let click = next_command(&mut h.shell_rx).await;
            assert_eq!(click.content["transaction_id"], transaction_id);
            patch_ok(click);
        }
        let after = next_command(&mut h.shell_rx).await;
        assert_eq!(
            patch_events(&after),
            vec![("p2".into(), "value".into(), json!(0.4))]
        );
        patch_ok(after);
        for click in clicks {
            assert!(matches!(
                click.await.unwrap().reply,
                notebook_protocol::protocol::BokehSessionPatchReply::Accepted { .. }
            ));
        }
    }

    #[tokio::test]
    async fn pending_one_off_events_are_bounded() {
        let mut h = Harness::new();
        let outbox = h.store.outbox("kernel-1").unwrap();
        let mut pending: Vec<_> = (0..MAX_PENDING_ONE_OFFS)
            .map(|n| outbox.one_off(one_off(&format!("click-{n}"))).unwrap())
            .collect();
        assert!(outbox.one_off(one_off("refused")).is_err());
        // One goes in flight, which frees one slot.
        let busy = next_command(&mut h.shell_rx).await;
        pending.push(outbox.one_off(one_off("last")).unwrap());
        let error = outbox
            .one_off(one_off("one-too-many"))
            .err()
            .expect("refused");
        assert!(error.contains("already waiting"), "{error}");
        patch_ok(busy);
        pending.remove(0).await.unwrap();
        next_command(&mut h.shell_rx).await;
        assert!(outbox.one_off(one_off("room-again")).is_ok());
    }

    /// Review R6b: shutdown aborts the outbox with an event in flight, which
    /// the kernel may already have run; the error must not claim otherwise.
    #[tokio::test]
    async fn an_event_in_flight_at_shutdown_is_not_reported_as_unsent() {
        let mut h = Harness::new();
        let outbox = h.store.outbox("kernel-1").unwrap();
        let in_flight = outbox.one_off(one_off("click-1")).unwrap();
        let queued = outbox.one_off(one_off("click-2")).unwrap();
        let _sent = next_command(&mut h.shell_rx).await;
        h.launched.shutdown();
        for reply in [in_flight, queued] {
            let error = reply.await.expect_err("no reply").to_string();
            assert!(error.contains("before it replied"), "{error}");
        }
    }

    #[tokio::test]
    async fn shutdown_drains_deltas_already_received() {
        let dir = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = runtime_doc::RuntimeStateHandle::new(
            runtime_doc::RuntimeStateDoc::new(),
            broadcast::channel(4).0,
        );
        let (broadcast_tx, _broadcasts) = broadcast::channel(16);
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
        let route = launched.routes().get(BOKEH_DELTA).cloned().unwrap();
        route
            .tx
            .send(RawIopubMessage {
                msg_type: BOKEH_DELTA.into(),
                content: super::super::ingest::tests::wire_delta(
                    "tx-final",
                    json!({"props_changed": {"p2": {"value": 0.9}}}),
                ),
                buffers: Vec::new(),
            })
            .unwrap();
        drop(route);
        // Within the coalescing window, as when the kernel exits mid-burst.
        launched.shutdown();
        tokio::time::timeout(Duration::from_secs(5), store.ingest_drained("kernel-1"))
            .await
            .expect("drained within its bound");
        store.with_doc("session-1", |doc| {
            assert_eq!(doc.get_prop("p2", "value").as_deref(), Some("0.9"));
        });
    }
}
