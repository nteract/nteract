//! Readiness policy for one-shot CLI calls. MCP keeps its progressive attach contract.

use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData;
use runtime_doc::RuntimeLifecycle;
use tokio::time::Instant;

use crate::session::SessionRequirement;
use crate::NteractMcp;

pub use mcp_transport::notebook_scoped_tool;

const READY_TIMEOUT: Duration = Duration::from_secs(125);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Wait on the same attachment before dispatching once. Never retry a tool:
/// a tool can report a readiness error after it has already mutated a cell.
pub async fn dispatch(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, ErrorData> {
    mcp_transport::validate_tool_target_params(request)?;
    if let Some(handle) = request
        .arguments
        .as_ref()
        .and_then(|args| args.get("notebook_handle"))
        .and_then(serde_json::Value::as_str)
    {
        if server.attachment_identity(handle).await.is_none() {
            return Err(ErrorData::invalid_params(
                "Notebook attachment expired; connect again and obtain a new handle",
                None,
            ));
        }
        let error = crate::targets::with_handle(
            handle.to_owned(),
            wait_until_ready(server, request, READY_TIMEOUT),
        )
        .await?;
        if let Some(error) = error {
            return Ok(error);
        }
    }
    crate::targets::dispatch(server, request).await
}

fn requirement(request: &CallToolRequestParams) -> Option<SessionRequirement> {
    if matches!(
        request.name.as_ref(),
        "get_results"
            | "list_notebooks"
            | "list_active_notebooks"
            | "connect_notebook"
            | "open_notebook"
            | "create_notebook"
            | "disconnect_notebook"
            | "show_notebook"
            | "launch_app"
    ) {
        // Historical results and session control have their own access rules.
        return None;
    }
    let args = request.arguments.as_ref();
    let and_run = args
        .and_then(|args| args.get("and_run"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let executes = match request.name.as_ref() {
        "execute_cell" | "run_all_cells" | "sync_environment" => true,
        "create_cell" => {
            and_run
                && args
                    .and_then(|args| args.get("cell_type"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("code")
                    == "code"
        }
        "set_cell" | "replace_match" | "replace_regex" => and_run,
        _ => false,
    };
    if executes {
        Some(SessionRequirement::Execute)
    } else {
        // Even projection readers need current document state in a one-shot call.
        // Reads, edits, and kernel controls do not need a running kernel.
        Some(SessionRequirement::DocumentRead)
    }
}

async fn wait_until_ready(
    server: &NteractMcp,
    request: &CallToolRequestParams,
    timeout: Duration,
) -> Result<Option<CallToolResult>, ErrorData> {
    let Some(requirement) = requirement(request) else {
        return Ok(None);
    };
    let deadline = Instant::now() + timeout;
    loop {
        let mut error = match server.session_access(requirement).await {
            Ok(_) => return Ok(None), // No attachment: let the tool validate its own target.
            Err(error) => error,
        };
        let retryable = matches!(error.code, "notebook_not_ready" | "runtime_not_ready");
        let kernel_blocker = if error.code == "runtime_not_ready" {
            let session = if let Some(handle) = crate::targets::current() {
                server
                    .attachments
                    .read_entries()
                    .get(&handle)
                    .map(|entry| entry.session.clone())
            } else {
                server.session().read().await.clone()
            };
            session.as_ref().and_then(|session| {
                if session.handle.status().runtime_state
                    != notebook_sync::status::RuntimeStatePhase::Ready
                {
                    return None;
                }
                let state = session.handle.get_runtime_state().ok()?;
                match state.kernel.lifecycle {
                    RuntimeLifecycle::Error
                    | RuntimeLifecycle::AwaitingTrust
                    | RuntimeLifecycle::AwaitingEnvBuild
                    | RuntimeLifecycle::Shutdown => Some(format!(
                        "Kernel is {}: {}",
                        state.kernel.lifecycle.variant_str(),
                        state
                            .kernel
                            .error_details
                            .as_deref()
                            .filter(|details| !details.is_empty())
                            .or(state
                                .kernel
                                .error_reason
                                .as_deref()
                                .filter(|reason| !reason.is_empty()))
                            .unwrap_or("resolve the kernel state before executing")
                    )),
                    _ => None,
                }
            })
        } else {
            None
        };
        if let Some(message) = kernel_blocker {
            error.message = message;
        } else if retryable && Instant::now() < deadline {
            tokio::time::sleep_until(deadline.min(Instant::now() + POLL_INTERVAL)).await;
            continue;
        } else if retryable {
            error.message = format!("Timed out waiting for CLI readiness: {}", error.message);
        }
        // Keep the normal structured readiness error, including the final state.
        return crate::tools::session_access_error(error).map(Some);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::NotebookSession;
    use crate::session_activation::CanonicalNotebookTarget;
    use automerge::sync::{Message, State};
    use notebook_protocol::connection::{
        FrameSink, FrameSource, NotebookFrameType, TypedNotebookFrame,
    };
    use notebook_protocol::protocol::{
        InitialLoadPhaseWire, NotebookDocPhaseWire, RuntimeStatePhaseWire, SessionControlMessage,
        SessionSyncStatusWire,
    };
    use runtime_doc::{KernelActivity, RuntimeStateDoc};
    use std::sync::{Arc, Mutex};
    use tokio::sync::mpsc;

    struct Frames(mpsc::UnboundedReceiver<TypedNotebookFrame>);
    impl FrameSource for Frames {
        async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
            self.0.recv().await.map(Ok)
        }
    }

    // Real RuntimeStateDoc sync over in-memory channels: no daemon, sockets,
    // subprocesses, environment changes, or process cleanup routines.
    struct RuntimePeer {
        doc: RuntimeStateDoc,
        sync: State,
        tx: mpsc::UnboundedSender<TypedNotebookFrame>,
    }
    impl RuntimePeer {
        fn send(&mut self) {
            if let Some(message) = self.doc.generate_sync_message(&mut self.sync) {
                self.tx
                    .send(TypedNotebookFrame {
                        frame_type: NotebookFrameType::RuntimeStateSync,
                        payload: message.encode(),
                    })
                    .unwrap();
            }
        }
    }
    struct Sink(Arc<Mutex<RuntimePeer>>);
    impl FrameSink for Sink {
        async fn send_frame(
            &mut self,
            frame_type: NotebookFrameType,
            payload: &[u8],
        ) -> std::io::Result<()> {
            if frame_type == NotebookFrameType::RuntimeStateSync {
                let mut peer = self.0.lock().unwrap();
                let RuntimePeer { doc, sync, .. } = &mut *peer;
                doc.receive_sync_message(sync, Message::decode(payload).unwrap())
                    .unwrap();
                peer.send();
            }
            Ok(())
        }
    }

    struct Fixture {
        server: NteractMcp,
        handle: notebook_sync::DocHandle,
        notebook_handle: String,
        peer: Arc<Mutex<RuntimePeer>>,
    }
    impl Fixture {
        async fn new(projection: bool) -> Self {
            let (tx, rx) = mpsc::unbounded_channel();
            let peer = Arc::new(Mutex::new(RuntimePeer {
                doc: RuntimeStateDoc::new_with_actor("cli-readiness-test"),
                sync: State::new(),
                tx,
            }));
            let handle = notebook_sync::connect::connect_frame_io(
                "test".into(),
                "cli-test",
                Frames(rx),
                Sink(peer.clone()),
            )
            .await
            .unwrap()
            .handle;
            handle
                .add_cell_with_source("live-cell", "code", None, "print('current document')")
                .unwrap();
            let session = if projection {
                use runtimed_client::protocol::*;
                let projection = NotebookProjection {
                    schema_version: 1,
                    load_generation: 1,
                    notebook_id: "test".into(),
                    notebook_path: Some("test.ipynb".into()),
                    cells: vec![],
                    dependencies: vec![],
                    runtime: NotebookRuntimeProjection::default(),
                    source_state: Default::default(),
                    availability: NotebookAvailabilityProjection {
                        phase: NotebookAvailabilityPhase::ProjectionReady,
                        generation: 1,
                        document_heads: vec![],
                        projection_heads: vec![],
                        capabilities: Default::default(),
                        reason: None,
                    },
                    readiness: NotebookReadiness {
                        projection: true,
                        document: false,
                        runtime: false,
                    },
                    projection_complete: true,
                    projection_heads: vec![],
                    notebook_heads: handle.current_heads_hex().unwrap(),
                    runtime_state_heads: vec![],
                    captured_at: chrono::Utc::now(),
                };
                NotebookSession::local_with_projection(
                    handle.clone(),
                    "test".into(),
                    Some("test.ipynb".into()),
                    0,
                    CanonicalNotebookTarget::new("local:path:test.ipynb"),
                    projection,
                    None,
                )
            } else {
                NotebookSession::local(handle.clone(), "test".into(), None, None)
            };
            // NteractMcp::new does not dial or launch a daemon.
            let server = NteractMcp::new("unused.sock".into(), None, None);
            let notebook_handle = session.notebook_handle.clone();
            server
                .attachments
                .insert(session.clone(), server.attachments.reserve().unwrap());
            *server.session().write().await = Some(session);
            Self {
                server,
                handle,
                notebook_handle,
                peer,
            }
        }
        async fn interactive(&self) {
            let status = SessionControlMessage::SyncStatus(SessionSyncStatusWire {
                notebook_doc: NotebookDocPhaseWire::Interactive,
                runtime_state: RuntimeStatePhaseWire::Ready,
                initial_load: InitialLoadPhaseWire::NotNeeded,
            });
            self.peer
                .lock()
                .unwrap()
                .tx
                .send(TypedNotebookFrame {
                    frame_type: NotebookFrameType::SessionControl,
                    payload: serde_json::to_vec(&status).unwrap(),
                })
                .unwrap();
            self.handle
                .await_session_ready_timeout(Duration::from_secs(1))
                .await
                .unwrap();
        }
        async fn lifecycle(&self, lifecycle: RuntimeLifecycle) {
            let mut updates = self.handle.subscribe_runtime_state();
            {
                let mut peer = self.peer.lock().unwrap();
                peer.doc.set_lifecycle(&lifecycle).unwrap();
                peer.send();
            }
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    if self.handle.get_runtime_state().unwrap().kernel.lifecycle == lifecycle {
                        break;
                    }
                    updates.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
        }
    }

    fn request(name: &str, args: serde_json::Value) -> CallToolRequestParams {
        let mut request = CallToolRequestParams::new(name.to_owned());
        request.arguments = args.as_object().cloned();
        request
    }

    #[tokio::test]
    async fn path_read_waits_past_stale_projection_for_current_document() {
        let fixture = Fixture::new(true).await;
        let request = request(
            "get_all_cells",
            serde_json::json!({"format":"summary", "notebook_handle":fixture.notebook_handle}),
        );
        let progressive = crate::targets::dispatch(&fixture.server, &request)
            .await
            .unwrap();
        assert_eq!(
            progressive.structured_content.unwrap()["cells"],
            serde_json::json!([])
        );
        let mut call = Box::pin(dispatch(&fixture.server, &request));
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut call)
            .await
            .is_err());
        fixture.interactive().await;
        let result = tokio::time::timeout(Duration::from_secs(1), call)
            .await
            .unwrap()
            .unwrap();
        assert!(!result.is_error.unwrap_or(false));
        assert!(serde_json::to_string(&result)
            .unwrap()
            .contains("current document"));
    }

    #[tokio::test]
    async fn cold_create_and_run_waits_for_kernel_before_dispatch() {
        let fixture = Fixture::new(false).await;
        fixture.interactive().await;
        fixture.lifecycle(RuntimeLifecycle::PreparingEnv).await;
        let request = request(
            "create_cell",
            serde_json::json!({"source":"print(56)", "and_run":true}),
        );
        let old = crate::tools::dispatch(&fixture.server, &request)
            .await
            .unwrap();
        assert_eq!(
            old.structured_content.unwrap()["error"]["code"],
            "runtime_not_ready"
        );
        let mut ready = Box::pin(wait_until_ready(
            &fixture.server,
            &request,
            Duration::from_secs(1),
        ));
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut ready)
            .await
            .is_err());
        assert_eq!(
            fixture.handle.get_cells().len(),
            1,
            "no cell mutation before readiness"
        );
        fixture
            .lifecycle(RuntimeLifecycle::Running(KernelActivity::Idle))
            .await;
        assert!(ready.await.unwrap().is_none());
    }

    #[tokio::test]
    async fn document_edits_and_restart_do_not_wait_for_kernel() {
        let fixture = Fixture::new(false).await;
        fixture.interactive().await;
        for name in ["set_cell", "restart_kernel", "get_all_cells"] {
            assert!(wait_until_ready(
                &fixture.server,
                &request(name, serde_json::json!({})),
                Duration::ZERO
            )
            .await
            .unwrap()
            .is_none());
        }
        assert!(wait_until_ready(
            &fixture.server,
            &request(
                "create_cell",
                serde_json::json!({"cell_type":"markdown", "and_run":true})
            ),
            Duration::ZERO
        )
        .await
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn blocked_kernel_and_timeout_preserve_structured_errors() {
        let fixture = Fixture::new(false).await;
        fixture.interactive().await;
        let request = request("execute_cell", serde_json::json!({"cell_id":"live-cell"}));
        for lifecycle in [
            RuntimeLifecycle::AwaitingTrust,
            RuntimeLifecycle::AwaitingEnvBuild,
            RuntimeLifecycle::Error,
            RuntimeLifecycle::Shutdown,
        ] {
            fixture.lifecycle(lifecycle.clone()).await;
            let result = wait_until_ready(&fixture.server, &request, Duration::from_secs(1))
                .await
                .unwrap()
                .unwrap();
            let details = result.structured_content.unwrap();
            assert_eq!(details["error"]["code"], "runtime_not_ready");
            assert!(details["error"]["message"]
                .as_str()
                .unwrap()
                .contains(lifecycle.variant_str()));
        }
        fixture.lifecycle(RuntimeLifecycle::Connecting).await;
        let result = wait_until_ready(&fixture.server, &request, Duration::ZERO)
            .await
            .unwrap()
            .unwrap();
        assert!(result.structured_content.unwrap()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Timed out"));
    }

    #[tokio::test]
    async fn failed_source_is_not_retried() {
        let fixture = Fixture::new(false).await;
        fixture
            .peer
            .lock()
            .unwrap()
            .tx
            .send(TypedNotebookFrame {
                frame_type: NotebookFrameType::SessionControl,
                payload: serde_json::to_vec(&SessionControlMessage::SyncStatus(
                    SessionSyncStatusWire {
                        notebook_doc: NotebookDocPhaseWire::Pending,
                        runtime_state: RuntimeStatePhaseWire::Pending,
                        initial_load: InitialLoadPhaseWire::Failed {
                            reason: "missing source".into(),
                        },
                    },
                ))
                .unwrap(),
            })
            .unwrap();
        let mut status = fixture.handle.subscribe_status();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !matches!(
                fixture.handle.status().initial_load,
                notebook_sync::status::InitialLoadPhase::Failed { .. }
            ) {
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        let result = wait_until_ready(
            &fixture.server,
            &request("get_all_cells", serde_json::json!({})),
            Duration::from_secs(1),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            result.structured_content.unwrap()["error"]["code"],
            "source_degraded"
        );
        for name in [
            "get_results",
            "disconnect_notebook",
            "list_notebooks",
            "connect_notebook",
        ] {
            assert!(
                wait_until_ready(
                    &fixture.server,
                    &request(name, serde_json::json!({})),
                    Duration::ZERO
                )
                .await
                .unwrap()
                .is_none(),
                "{name} must retain its own access rules"
            );
        }
    }
}
