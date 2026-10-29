//! Per-kernel extension hooks: custom IOPub message routes and background
//! tasks that live exactly as long as one launched kernel.
//!
//! `JupyterKernel` knows no extension by name. At launch it calls
//! [`KernelExtensions::launch`] with the agent's registered
//! [`KernelExtension`]s, forwards IOPub `UnknownMessage`s whose `msg_type`
//! has a route, and calls [`KernelExtensions::shutdown`] when the kernel goes.

use std::collections::HashMap;
use std::sync::Arc;

use runtime_doc::RuntimeStateHandle;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tracing::warn;

use crate::blob_store::BlobStore;
use crate::kernel_shell_requester::KernelShellRequester;
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_redaction::OutputRedactor;
use crate::protocol::NotebookBroadcast;

/// An IOPub message with a `msg_type` the Jupyter protocol does not model.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawIopubMessage {
    pub(crate) msg_type: String,
    pub(crate) content: Value,
    pub(crate) buffers: Vec<Vec<u8>>,
}

#[derive(Clone)]
pub(crate) struct IopubRoute {
    pub(crate) tx: mpsc::UnboundedSender<RawIopubMessage>,
    /// Commit every output received before this message first, for messages
    /// that refer to state an earlier display output creates.
    pub(crate) after_outputs: bool,
}

/// What a kernel extension can use while it is launched.
pub(crate) struct KernelLaunchCtx<'a> {
    pub(crate) kernel_id: &'a str,
    pub(crate) kernel_actor_id: &'a str,
    pub(crate) state: &'a RuntimeStateHandle,
    pub(crate) blob_store: &'a Arc<BlobStore>,
    pub(crate) blob_publisher: &'a OutputBlobPublisher,
    pub(crate) broadcast_tx: &'a broadcast::Sender<NotebookBroadcast>,
    pub(crate) redactor: &'a Arc<OutputRedactor>,
    pub(crate) shell: &'a KernelShellRequester,
}

pub(crate) trait KernelExtension: Send + Sync + 'static {
    fn on_launch(&self, ctx: &KernelLaunchCtx<'_>) -> KernelExtensionInstance;
}

#[derive(Default)]
pub(crate) struct KernelExtensionInstance {
    pub(crate) iopub: Vec<(&'static str, IopubRoute)>,
    pub(crate) tasks: Vec<JoinHandle<()>>,
    pub(crate) on_shutdown: Option<Box<dyn FnOnce() + Send>>,
}

/// IOPub routes by `msg_type`, shared with the IOPub reader task.
#[derive(Clone, Default)]
pub(crate) struct IopubRoutes(Arc<HashMap<&'static str, IopubRoute>>);

impl IopubRoutes {
    pub(crate) fn get(&self, msg_type: &str) -> Option<&IopubRoute> {
        self.0.get(msg_type)
    }
}

/// The extension instances of one launched kernel.
#[derive(Default)]
pub(crate) struct KernelExtensions {
    routes: IopubRoutes,
    instances: Vec<KernelExtensionInstance>,
}

impl KernelExtensions {
    pub(crate) fn launch(exts: &[Arc<dyn KernelExtension>], ctx: &KernelLaunchCtx<'_>) -> Self {
        let mut routes = HashMap::new();
        let mut instances = Vec::with_capacity(exts.len());
        for ext in exts {
            let mut instance = ext.on_launch(ctx);
            for (msg_type, route) in instance.iopub.drain(..) {
                if routes.insert(msg_type, route).is_some() {
                    warn!("[kernel-extensions] Two extensions route IOPub {msg_type}; the later one wins");
                }
            }
            instances.push(instance);
        }
        Self {
            routes: IopubRoutes(Arc::new(routes)),
            instances,
        }
    }

    pub(crate) fn routes(&self) -> IopubRoutes {
        self.routes.clone()
    }

    /// Run each instance's shutdown hook and abort its tasks. Idempotent.
    pub(crate) fn shutdown(&mut self) {
        self.routes = IopubRoutes::default();
        for mut instance in self.instances.drain(..) {
            if let Some(on_shutdown) = instance.on_shutdown.take() {
                on_shutdown();
            }
            for task in instance.tasks.drain(..) {
                task.abort();
            }
        }
    }
}

impl Drop for KernelExtensions {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Probe {
        shutdowns: Arc<AtomicUsize>,
    }

    impl KernelExtension for Probe {
        fn on_launch(&self, ctx: &KernelLaunchCtx<'_>) -> KernelExtensionInstance {
            let (tx, mut rx) = mpsc::unbounded_channel::<RawIopubMessage>();
            let kernel_id = ctx.kernel_id.to_string();
            let shutdowns = self.shutdowns.clone();
            KernelExtensionInstance {
                iopub: vec![(
                    "probe_event",
                    IopubRoute {
                        tx,
                        after_outputs: true,
                    },
                )],
                tasks: vec![tokio::spawn(async move {
                    while rx.recv().await.is_some() {
                        let _ = &kernel_id;
                    }
                })],
                on_shutdown: Some(Box::new(move || {
                    shutdowns.fetch_add(1, Ordering::SeqCst);
                })),
            }
        }
    }

    #[tokio::test]
    async fn launch_routes_by_msg_type_and_shutdown_runs_hooks_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
        let state =
            RuntimeStateHandle::new(runtime_doc::RuntimeStateDoc::new(), broadcast::channel(4).0);
        let (broadcast_tx, _) = broadcast::channel(4);
        let redactor = Arc::new(OutputRedactor::default());
        let (shell, _shell_rx) = KernelShellRequester::for_test();
        let shutdowns = Arc::new(AtomicUsize::new(0));
        let exts: Vec<Arc<dyn KernelExtension>> = vec![Arc::new(Probe {
            shutdowns: shutdowns.clone(),
        })];
        let mut launched = KernelExtensions::launch(
            &exts,
            &KernelLaunchCtx {
                kernel_id: "kernel-1",
                kernel_actor_id: "rt:kernel:test",
                state: &state,
                blob_store: &blob_store,
                blob_publisher: &OutputBlobPublisher::none(),
                broadcast_tx: &broadcast_tx,
                redactor: &redactor,
                shell: &shell,
            },
        );
        let routes = launched.routes();
        let route = routes.get("probe_event").expect("routed");
        assert!(route.after_outputs);
        assert!(routes.get("other_event").is_none());

        launched.shutdown();
        launched.shutdown();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        assert!(launched.routes().get("probe_event").is_none());
        drop(launched);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }
}
