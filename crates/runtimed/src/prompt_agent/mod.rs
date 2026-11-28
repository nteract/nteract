//! The prompt agent: a runtime agent process that offers the `prompt`
//! capability.
//!
//! `runtimed prompt-agent` connects to the daemon socket with
//! `Handshake::RuntimeAgent { capabilities: ["prompt"] }`, syncs the
//! RuntimeStateDoc with the coordinator and runs dispatched prompt executions
//! one at a time through a [`ModelBackend`]. Each run is streamed into one
//! markdown output that is rewritten in place as text arrives. The
//! coordinator sends no requests: Stop arrives as the execution's
//! `stop_requested` count.
//!
//! The loop has the shape of the kernel runtime agent's (`runtime_agent.rs`)
//! without a kernel: no NotebookDoc, CommsDoc or keyed documents, only the
//! RuntimeStateDoc. The agent never writes kernel state, the kernel queue, or
//! creates executions.

mod backend;
mod claude;
#[cfg(test)]
mod fake;
mod projector;
mod runner;

use std::path::PathBuf;
use std::sync::Arc;

use notebook_protocol::connection::{
    FrameSink, FrameSource, FrameTransport, NotebookFrameType, UdsFrameTransport,
};
use runtime_doc::{RuntimeStateDoc, RuntimeStateHandle};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, error, info, warn};

use crate::blob_store::BlobStore;
use crate::runtime_agent::install_runtime_agent_shutdown_signal_handlers;

use backend::ModelBackend;
use claude::ClaudeCliBackend;
use runner::PromptWorker;

/// Run the prompt agent against the daemon socket until the daemon goes away
/// or the process is signalled. `agent_command` is the CLI to run (for
/// example `claude`).
pub async fn run_prompt_agent(
    socket_path: PathBuf,
    notebook_id: String,
    runtime_agent_id: String,
    blob_root: PathBuf,
    agent_command: String,
) -> anyhow::Result<()> {
    info!(
        "[prompt-agent] Starting runtime_agent_id={} notebook_id={} socket={} command={}",
        runtime_agent_id,
        notebook_id,
        socket_path.display(),
        agent_command
    );
    let transport =
        UdsFrameTransport::new(&socket_path, &notebook_id, &runtime_agent_id, &blob_root)
            .with_capabilities(vec![runtime_doc::CAPABILITY_PROMPT.to_string()]);
    run_prompt_agent_on_transport(
        transport,
        runtime_agent_id,
        blob_root,
        Arc::new(ClaudeCliBackend::new(agent_command)),
    )
    .await
}

/// The agent loop, generic over the wire (tests use in-memory channels) and
/// the backend.
pub(crate) async fn run_prompt_agent_on_transport<T: FrameTransport>(
    transport: T,
    runtime_agent_id: String,
    blob_root: PathBuf,
    backend: Arc<dyn ModelBackend>,
) -> anyhow::Result<()> {
    let (mut frame_source, mut frame_sink) = transport.connect().await?;
    info!("[prompt-agent] Connected");

    let state_doc = RuntimeStateDoc::try_new_with_actor(&runtime_agent_id)
        .map_err(|e| anyhow::anyhow!("create prompt-agent state doc: {e}"))?;
    let (state_changed_tx, mut state_changed_rx) = broadcast::channel::<()>(64);
    let state = RuntimeStateHandle::new(state_doc, state_changed_tx);
    let mut coordinator_sync = automerge::sync::State::new();

    let blob_store = Arc::new(BlobStore::new(blob_root));
    let (mut worker, mut done_rx) = PromptWorker::new(state.clone(), blob_store, backend);

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<&'static str>();
    install_runtime_agent_shutdown_signal_handlers(shutdown_tx);

    let mut terminal_error: Option<anyhow::Error> = None;
    info!("[prompt-agent] Infrastructure ready, entering main loop");

    loop {
        tokio::select! {
            biased;

            maybe_frame = frame_source.recv_frame() => match maybe_frame {
                Some(Ok(frame)) => match frame.frame_type {
                    NotebookFrameType::RuntimeStateSync => {
                        let Ok(message) = automerge::sync::Message::decode(&frame.payload) else {
                            warn!("[prompt-agent] Ignoring undecodable RuntimeStateSync frame");
                            continue;
                        };
                        let applied = state.receive_sync_message_with_changes_recovering(
                            &mut coordinator_sync,
                            message,
                            "prompt-agent-state-receive",
                        );
                        match applied {
                            Ok(changed) => {
                                if changed {
                                    worker.maybe_start();
                                }
                            }
                            Err(e) => {
                                warn!("[prompt-agent] Closing after RuntimeStateSync failure: {e}");
                                break;
                            }
                        }
                        // The coordinator treats the agent as ready once it has
                        // acknowledged the initial sync.
                        let reply = match state.generate_sync_message_recovering(
                            &mut coordinator_sync,
                            "prompt-agent-state-reply",
                        ) {
                            Ok(reply) => reply.map(|m| m.encode()),
                            Err(e) => {
                                warn!("[prompt-agent] Closing after RuntimeStateSync reply failure: {e}");
                                break;
                            }
                        };
                        if let Some(encoded) = reply {
                            if let Err(e) = frame_sink
                                .send_frame(NotebookFrameType::RuntimeStateSync, &encoded)
                                .await
                            {
                                warn!("[prompt-agent] Closing after RuntimeStateSync reply send failure: {e}");
                                break;
                            }
                        }
                    }

                    // Requests, SessionControl (keyed-doc kinds) and any
                    // other frame types are for kernel agents.
                    other => {
                        debug!("[prompt-agent] Ignoring frame type {other:?}");
                    }
                },
                // No reconnect: the daemon fails this agent's runs and drops
                // its provenance whenever the connection ends, so a new
                // connection would be rejected anyway.
                Some(Err(e)) => {
                    let closed = transport.stream_error_is_recoverable(&e)
                        || transport.stream_error_is_graceful_shutdown(&e);
                    if !closed {
                        error!("[prompt-agent] Non-recoverable sync stream error: {e}");
                        terminal_error = Some(anyhow::anyhow!(
                            "prompt agent sync stream rejected by the coordinator: {e}"
                        ));
                    } else {
                        info!("[prompt-agent] Sync stream closed ({e}); shutting down");
                    }
                    break;
                }
                None => {
                    info!("[prompt-agent] Daemon disconnected (EOF)");
                    break;
                }
            },

            Some(execution_id) = done_rx.recv() => {
                worker.run_finished(&execution_id);
            }

            // Sync our RuntimeStateDoc changes (status, outputs) out.
            _ = state_changed_rx.recv() => {
                while state_changed_rx.try_recv().is_ok() {}
                let encoded = match state.generate_sync_message_recovering(
                    &mut coordinator_sync,
                    "prompt-agent-state-outbound",
                ) {
                    Ok(message) => message.map(|m| m.encode()),
                    Err(e) => {
                        warn!("[prompt-agent] Closing after outbound RuntimeStateSync failure: {e}");
                        break;
                    }
                };
                if let Some(encoded) = encoded {
                    debug!("[prompt-agent] Sending RuntimeStateSync ({} bytes)", encoded.len());
                    if let Err(e) = frame_sink
                        .send_frame(NotebookFrameType::RuntimeStateSync, &encoded)
                        .await
                    {
                        warn!("[prompt-agent] Closing after RuntimeStateSync send failure: {e}");
                        break;
                    }
                }
            }

            Some(signal) = shutdown_rx.recv() => {
                info!("[prompt-agent] Received {signal}, shutting down");
                break;
            }
        }
    }

    info!("[prompt-agent] Shutting down");
    worker.shutdown();
    match terminal_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests;
