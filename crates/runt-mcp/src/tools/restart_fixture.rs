//! In-memory daemon boundary for restart tools. Notebook and runtime documents
//! use real Automerge sync; only daemon RPC outcomes are scripted. Each fixture
//! owns one peer and records requests so a rejection cannot hide a fallback launch.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use automerge::sync::{Message, State};
use notebook_doc::{NotebookDoc, TextEncoding};
use notebook_protocol::connection::{
    EnvSource, FrameSink, FrameSource, NotebookFrameType, TypedNotebookFrame,
};
use notebook_protocol::protocol::{
    InitialLoadPhaseWire, NotebookDocPhaseWire, NotebookRequest, NotebookRequestEnvelope,
    NotebookResponse, NotebookResponseEnvelope, RuntimeStatePhaseWire, SessionControlMessage,
    SessionSyncStatusWire,
};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use runtime_doc::{KernelActivity, RuntimeLifecycle, RuntimeStateDoc};
use tokio::sync::{mpsc, oneshot};

use crate::{session::NotebookSession, NteractMcp};

struct Frames {
    incoming: mpsc::UnboundedReceiver<TypedNotebookFrame>,
    stop: oneshot::Receiver<()>,
}

impl FrameSource for Frames {
    async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
        tokio::select! {
            biased;
            _ = &mut self.stop => None,
            frame = self.incoming.recv() => frame.map(Ok),
        }
    }
}

struct Peer {
    notebook: NotebookDoc,
    notebook_sync: State,
    runtime: RuntimeStateDoc,
    runtime_sync: State,
    incoming: mpsc::UnboundedSender<TypedNotebookFrame>,
    launch_response: NotebookResponse,
    requests: Vec<NotebookRequest>,
}

impl Peer {
    fn send(&self, frame_type: NotebookFrameType, payload: Vec<u8>) {
        self.incoming
            .send(TypedNotebookFrame {
                frame_type,
                payload,
            })
            .unwrap();
    }

    fn sync_runtime(&mut self) {
        if let Some(message) = self.runtime.generate_sync_message(&mut self.runtime_sync) {
            self.send(NotebookFrameType::RuntimeStateSync, message.encode());
        }
    }
}

struct Sink(Arc<Mutex<Peer>>);

impl FrameSink for Sink {
    async fn send_frame(
        &mut self,
        frame_type: NotebookFrameType,
        payload: &[u8],
    ) -> std::io::Result<()> {
        let mut peer = self.0.lock().unwrap();
        match frame_type {
            NotebookFrameType::AutomergeSync => {
                let Peer {
                    notebook,
                    notebook_sync,
                    ..
                } = &mut *peer;
                notebook
                    .receive_sync_message(notebook_sync, Message::decode(payload).unwrap())
                    .unwrap();
                if let Some(message) = notebook.generate_sync_message(notebook_sync) {
                    peer.send(NotebookFrameType::AutomergeSync, message.encode());
                }
            }
            NotebookFrameType::RuntimeStateSync => {
                let Peer {
                    runtime,
                    runtime_sync,
                    ..
                } = &mut *peer;
                runtime
                    .receive_sync_message(runtime_sync, Message::decode(payload).unwrap())
                    .unwrap();
                peer.sync_runtime();
            }
            NotebookFrameType::Request => {
                let envelope: NotebookRequestEnvelope = serde_json::from_slice(payload).unwrap();
                let response = match &envelope.request {
                    NotebookRequest::ApproveTrust { .. } => NotebookResponse::Ok {},
                    // The daemon releases a parked room after either decision
                    // and leaves the launch to the client.
                    NotebookRequest::ApproveProjectTrust { .. }
                    | NotebookRequest::DeclineProjectTrust { .. } => {
                        peer.runtime
                            .set_lifecycle(&RuntimeLifecycle::NotStarted)
                            .unwrap();
                        peer.sync_runtime();
                        NotebookResponse::Ok {}
                    }
                    NotebookRequest::ShutdownKernel {} => {
                        peer.runtime
                            .set_lifecycle(&RuntimeLifecycle::Shutdown)
                            .unwrap();
                        peer.sync_runtime();
                        NotebookResponse::KernelShuttingDown {}
                    }
                    NotebookRequest::LaunchKernel { .. } => {
                        if matches!(
                            peer.launch_response,
                            NotebookResponse::KernelLaunched { .. }
                        ) {
                            peer.runtime
                                .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
                                .unwrap();
                            peer.sync_runtime();
                        }
                        peer.launch_response.clone()
                    }
                    other => panic!("unexpected restart request: {other:?}"),
                };
                peer.requests.push(envelope.request);
                peer.send(
                    NotebookFrameType::Response,
                    serde_json::to_vec(&NotebookResponseEnvelope {
                        id: envelope.id,
                        response,
                    })
                    .unwrap(),
                );
            }
            _ => {}
        }
        Ok(())
    }
}

pub(in crate::tools) struct RestartFixture {
    pub(in crate::tools) server: NteractMcp,
    pub(in crate::tools) handle: notebook_sync::DocHandle,
    peer: Arc<Mutex<Peer>>,
    // Dropping the fixture closes its sync task even while the peer owns incoming.
    _stop: oneshot::Sender<()>,
}

impl RestartFixture {
    pub(in crate::tools) async fn new(launch_response: NotebookResponse) -> Self {
        let (incoming, frames) = mpsc::unbounded_channel();
        let (stop, stopped) = oneshot::channel();
        let mut runtime = RuntimeStateDoc::new_with_actor("restart-daemon");
        runtime
            .set_kernel_info("python", "python", "conda:existing:local")
            .unwrap();
        runtime
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        let peer = Arc::new(Mutex::new(Peer {
            notebook: NotebookDoc::bootstrap(TextEncoding::UnicodeCodePoint, "restart-daemon"),
            notebook_sync: State::new(),
            runtime,
            runtime_sync: State::new(),
            incoming,
            launch_response,
            requests: Vec::new(),
        }));
        let handle = notebook_sync::connect::connect_frame_io(
            "restart-notebook".into(),
            "restart-client",
            Frames {
                incoming: frames,
                stop: stopped,
            },
            Sink(peer.clone()),
        )
        .await
        .unwrap()
        .handle;
        handle
            .with_metadata(|metadata| metadata.add_uv_dependency("numpy"))
            .unwrap();
        {
            let mut peer = peer.lock().unwrap();
            peer.sync_runtime();
            peer.send(
                NotebookFrameType::SessionControl,
                serde_json::to_vec(&SessionControlMessage::SyncStatus(SessionSyncStatusWire {
                    notebook_doc: NotebookDocPhaseWire::Interactive,
                    runtime_state: RuntimeStatePhaseWire::Ready,
                    initial_load: InitialLoadPhaseWire::NotNeeded,
                }))
                .unwrap(),
            );
        }
        handle
            .await_session_ready_timeout(Duration::from_secs(5))
            .await
            .unwrap();
        handle.confirm_state_sync().await.unwrap();
        handle.confirm_sync().await.unwrap();
        let server = NteractMcp::new("unused.sock".into(), None, None);
        *server.session().write().await = Some(NotebookSession::local(
            handle.clone(),
            "restart-notebook".into(),
            None,
            None,
        ));
        Self {
            server,
            handle,
            peer,
            _stop: stop,
        }
    }

    pub(in crate::tools) fn launched() -> NotebookResponse {
        NotebookResponse::KernelLaunched {
            kernel_type: "python".into(),
            env_source: EnvSource::ExistingConda,
            launched_config: Default::default(),
        }
    }

    /// Park the room the way the daemon does when a project file's folder
    /// is untrusted, and wait until the client sees it.
    pub(in crate::tools) async fn park_on_project_trust(
        &self,
        state: runtime_doc::ProjectTrustRuntimeState,
    ) {
        {
            let mut peer = self.peer.lock().unwrap();
            peer.runtime.set_kernel_info("", "", "").unwrap();
            peer.runtime.set_project_trust(&state).unwrap();
            peer.runtime
                .set_lifecycle(&RuntimeLifecycle::AwaitingProjectTrust)
                .unwrap();
            peer.sync_runtime();
        }
        self.handle.confirm_state_sync().await.unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while self.handle.get_runtime_state().unwrap().kernel.lifecycle
            != RuntimeLifecycle::AwaitingProjectTrust
        {
            assert!(
                std::time::Instant::now() < deadline,
                "client never saw park"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub(in crate::tools) fn requests(&self) -> Vec<NotebookRequest> {
        self.peer.lock().unwrap().requests.clone()
    }

    pub(in crate::tools) fn synced_dependencies(&self) -> Vec<String> {
        self.peer
            .lock()
            .unwrap()
            .notebook
            .get_metadata_snapshot()
            .unwrap()
            .uv_dependencies()
            .to_vec()
    }

    pub(in crate::tools) fn assert_single_restart(&self) {
        let peer = self.peer.lock().unwrap();
        let lifecycle_requests: Vec<_> = peer
            .requests
            .iter()
            .filter(|request| !matches!(request, NotebookRequest::ApproveTrust { .. }))
            .collect();
        assert_eq!(
            lifecycle_requests.len(),
            2,
            "no fallback launch: {:?}",
            peer.requests
        );
        assert!(matches!(
            lifecycle_requests[0],
            NotebookRequest::ShutdownKernel {}
        ));
        assert!(
            matches!(lifecycle_requests[1], NotebookRequest::LaunchKernel { kernel_type, .. } if kernel_type == "python")
        );
    }
}

pub(in crate::tools) fn request(name: &str, arguments: serde_json::Value) -> CallToolRequestParams {
    let mut request = CallToolRequestParams::new(name.to_owned());
    request.arguments = arguments.as_object().cloned();
    request
}

pub(in crate::tools) fn result_json(result: &CallToolResult) -> serde_json::Value {
    serde_json::from_str(&result.content[0].as_text().unwrap().text).unwrap()
}
