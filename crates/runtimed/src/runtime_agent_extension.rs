//! Runtime agent extensions: request handlers, kernel-loss hooks, keyed
//! documents, output hooks and kernel extensions contributed by one feature.
//!
//! The agent loop names no extension. It asks [`AgentExtensions::claim`]
//! whether an extension handles a request before its own dispatch, calls
//! [`AgentExtensions::on_kernel_lost`] when a kernel dies, restarts or shuts
//! down, and hands every extension's keyed documents to `AgentDocs`. The
//! registration site is `crate::extensions::agent_extensions`.

use std::collections::HashMap;
use std::sync::Arc;

use futures::future::BoxFuture;
use notebook_protocol::protocol::{
    RuntimeAgentRequest, RuntimeAgentResponse, RuntimeAgentResponseEnvelope,
};
use runtime_doc::RuntimeStateHandle;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::blob_store::BlobStore;
use crate::kernel_extensions::KernelExtension;
use crate::keyed_doc::agent::KeyedDocAvailability;
use crate::keyed_doc::{AgentDocs, AgentKeyedDoc};
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_hooks::{OutputHook, OutputHookRegistry};

/// How the agent loop answers a request an extension started.
#[derive(Debug)]
pub(crate) enum ExtensionStart {
    /// Send this response now.
    Reply(RuntimeAgentResponse),
    /// The extension replies later through `AgentRequestCtx::responses`.
    Deferred,
    /// A command: no response.
    NoReply,
}

/// The active kernel, as an extension sees it. An extension that talks to
/// the kernel binds its shell requester at launch (`KernelLaunchCtx`), where
/// the kernel's output redactor is also available.
pub(crate) struct AgentKernelView<'a> {
    pub(crate) kernel_id: &'a str,
}

pub(crate) struct AgentRequestCtx<'a> {
    pub(crate) state: &'a RuntimeStateHandle,
    pub(crate) blob_store: &'a Arc<BlobStore>,
    pub(crate) blob_publisher: &'a OutputBlobPublisher,
    pub(crate) kernel: Option<AgentKernelView<'a>>,
    pub(crate) responses: &'a mpsc::UnboundedSender<RuntimeAgentResponseEnvelope>,
    /// Tasks bound to the active kernel's channels, aborted when they change.
    pub(crate) kernel_tasks: &'a mut HashMap<String, JoinHandle<()>>,
}

pub(crate) struct AgentLifecycleCtx<'a> {
    pub(crate) state: &'a RuntimeStateHandle,
    pub(crate) blob_store: &'a Arc<BlobStore>,
    pub(crate) blob_publisher: &'a OutputBlobPublisher,
}

/// What the agent provides to extensions when it builds them.
pub(crate) struct AgentExtensionInit {
    /// Keyed document kinds the current coordinator routes.
    pub(crate) availability: KeyedDocAvailability,
}

pub(crate) trait RuntimeAgentExtension: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    fn keyed_docs(&self) -> Vec<Arc<dyn AgentKeyedDoc>> {
        Vec::new()
    }

    fn output_hooks(&self) -> Vec<Arc<dyn OutputHook>> {
        Vec::new()
    }

    fn kernel_extension(&self) -> Option<Arc<dyn KernelExtension>> {
        None
    }

    fn claims(&self, request: &RuntimeAgentRequest) -> bool;

    /// Handle a claimed request. Must not await the kernel: the agent loop
    /// also drains lifecycle signals and sync frames.
    fn start(
        &self,
        id: String,
        request: RuntimeAgentRequest,
        ctx: AgentRequestCtx<'_>,
    ) -> ExtensionStart;

    /// The kernel died, restarted or shut down; release what it owned.
    fn on_kernel_lost<'a>(
        &'a self,
        kernel_id: &'a str,
        ctx: AgentLifecycleCtx<'a>,
    ) -> BoxFuture<'a, ()>;

    /// An inbound RuntimeStateDoc sync changed the agent's replica, e.g.
    /// the coordinator's view after a reconnect. Must not block.
    fn on_runtime_state_synced(&self, _ctx: AgentLifecycleCtx<'_>) {}

    /// The coordinator stopped routing a keyed document kind on this
    /// connection.
    fn on_keyed_doc_unavailable<'a>(
        &'a self,
        _kind: &'a str,
        _ctx: AgentLifecycleCtx<'a>,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

/// Every extension of one runtime agent.
#[derive(Default)]
pub(crate) struct AgentExtensions {
    exts: Vec<Arc<dyn RuntimeAgentExtension>>,
    /// Keyed documents registered directly rather than by an extension.
    keyed_docs: Vec<Arc<dyn AgentKeyedDoc>>,
    pub(crate) output_hooks: OutputHookRegistry,
    pub(crate) kernel: Vec<Arc<dyn KernelExtension>>,
}

impl AgentExtensions {
    pub(crate) fn new(exts: Vec<Arc<dyn RuntimeAgentExtension>>) -> Self {
        let output_hooks =
            OutputHookRegistry::new(exts.iter().flat_map(|ext| ext.output_hooks()).collect());
        let kernel = exts
            .iter()
            .filter_map(|ext| ext.kernel_extension())
            .collect();
        Self {
            exts,
            keyed_docs: Vec::new(),
            output_hooks,
            kernel,
        }
    }

    pub(crate) fn with_keyed_docs(mut self, docs: Vec<Arc<dyn AgentKeyedDoc>>) -> Self {
        self.keyed_docs.extend(docs);
        self
    }

    pub(crate) fn register_keyed_docs(&self, docs: &mut AgentDocs) {
        for doc in self
            .exts
            .iter()
            .flat_map(|ext| ext.keyed_docs())
            .chain(self.keyed_docs.iter().cloned())
        {
            docs.register(doc);
        }
    }

    pub(crate) fn claim(
        &self,
        request: &RuntimeAgentRequest,
    ) -> Option<&Arc<dyn RuntimeAgentExtension>> {
        self.exts.iter().find(|ext| ext.claims(request))
    }

    pub(crate) async fn on_kernel_lost(&self, kernel_id: &str, ctx: AgentLifecycleCtx<'_>) {
        for ext in &self.exts {
            ext.on_kernel_lost(
                kernel_id,
                AgentLifecycleCtx {
                    state: ctx.state,
                    blob_store: ctx.blob_store,
                    blob_publisher: ctx.blob_publisher,
                },
            )
            .await;
        }
    }

    pub(crate) fn on_runtime_state_synced(&self, ctx: AgentLifecycleCtx<'_>) {
        for ext in &self.exts {
            ext.on_runtime_state_synced(AgentLifecycleCtx {
                state: ctx.state,
                blob_store: ctx.blob_store,
                blob_publisher: ctx.blob_publisher,
            });
        }
    }

    pub(crate) async fn on_keyed_doc_unavailable(&self, kind: &str, ctx: AgentLifecycleCtx<'_>) {
        for ext in &self.exts {
            ext.on_keyed_doc_unavailable(
                kind,
                AgentLifecycleCtx {
                    state: ctx.state,
                    blob_store: ctx.blob_store,
                    blob_publisher: ctx.blob_publisher,
                },
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct Probe {
        lost: AtomicUsize,
    }

    impl RuntimeAgentExtension for Probe {
        fn name(&self) -> &'static str {
            "probe"
        }

        fn claims(&self, request: &RuntimeAgentRequest) -> bool {
            matches!(request, RuntimeAgentRequest::InterruptExecution)
        }

        fn start(
            &self,
            _id: String,
            _request: RuntimeAgentRequest,
            _ctx: AgentRequestCtx<'_>,
        ) -> ExtensionStart {
            ExtensionStart::Reply(RuntimeAgentResponse::Ok)
        }

        fn on_kernel_lost<'a>(
            &'a self,
            _kernel_id: &'a str,
            _ctx: AgentLifecycleCtx<'a>,
        ) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.lost.fetch_add(1, Ordering::SeqCst);
            })
        }
    }

    #[tokio::test]
    async fn claim_and_kernel_loss_reach_registered_extensions() {
        let probe = Arc::new(Probe::default());
        let exts = AgentExtensions::new(vec![probe.clone()]);
        assert!(exts
            .claim(&RuntimeAgentRequest::InterruptExecution)
            .is_some());
        assert!(exts.claim(&RuntimeAgentRequest::ShutdownKernel).is_none());
        assert!(AgentExtensions::default()
            .claim(&RuntimeAgentRequest::InterruptExecution)
            .is_none());

        let dir = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state = RuntimeStateHandle::new(
            runtime_doc::RuntimeStateDoc::new(),
            tokio::sync::broadcast::channel(4).0,
        );
        exts.on_kernel_lost(
            "kernel-1",
            AgentLifecycleCtx {
                state: &state,
                blob_store: &blob_store,
                blob_publisher: &OutputBlobPublisher::none(),
            },
        )
        .await;
        assert_eq!(probe.lost.load(Ordering::SeqCst), 1);
    }
}
