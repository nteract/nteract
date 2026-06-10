//! Diagnostic cloud peer: dial a hosted notebook room and sync as a peer.
//!
//! This is the smoke/automation peer that used to live in the standalone
//! `runt-cloud-peer` binary (#3397). That spike carried its own copy of the
//! WS dial, auth headers, and `cloud_room_ready` wait; those were since lifted
//! into [`notebook_cloud_transport`], so the peer now rides the same
//! [`CloudWsFrameTransport`] the real `cloud-runtime-agent` uses and the
//! duplicated wire code is gone. Exposed as the hidden `runtimed cloud-peer`
//! subcommand — `runtimed` already depends on the transport and both document
//! crates, so absorbing the binary adds no dependencies.
//!
//! Two load-bearing rules carried over from the spike:
//! - CRDT init (notebook-doc invariant #2): `bootstrap()` seeds only the frozen
//!   genesis + `schema_version`. The room owns the `cells`/`metadata` maps; we
//!   receive them via sync before editing.
//! - Change attribution: the room's actor-authorization check rejects any
//!   change whose actor principal differs from the authenticated principal, so
//!   docs are bootstrapped with `<principal>/<operator>` taken from the
//!   transport's `cloud_room_ready` principal, not an arbitrary actor.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use automerge::sync;
use notebook_cloud_transport::{CloudWsConfig, CloudWsFrameTransport};
use notebook_doc::{NotebookDoc, TextEncoding};
use notebook_protocol::connection::{FrameSink, FrameSource, FrameTransport};
use notebook_wire::NotebookFrameType;
use runtime_doc::RuntimeStateDoc;
use tracing::{info, warn};

/// What the diagnostic peer should do once attached.
#[derive(Debug, Clone, Default)]
pub struct CloudPeerActions {
    /// After sync converges, add a code cell with this source and sync it back.
    pub add_cell: Option<String>,
    /// After the added cell converges, send an ExecuteCell request for it and
    /// log the executions that appear in the RuntimeStateDoc (verifies the
    /// hosted ExecuteCell dispatch). Requires `add_cell`.
    pub run_cell: bool,
    /// Auto-close after this many seconds (0 = run until disconnected).
    pub seconds: u64,
}

/// Dial the room described by `config`, sync both documents, and perform
/// `actions`. The `operator` suffix forms the doc actor label
/// (`<principal>/<operator>:<nonce>`).
pub async fn run_cloud_peer(
    config: CloudWsConfig,
    operator: String,
    actions: CloudPeerActions,
) -> Result<()> {
    if actions.run_cell && actions.add_cell.is_none() {
        anyhow::bail!("run_cell requires add_cell");
    }

    let transport = CloudWsFrameTransport::new(config);
    info!(
        "dialing {} (scope set on transport config)",
        transport.ws_url()
    );
    let (mut source, mut sink) = transport
        .connect()
        .await
        .context("connect to hosted room")?;
    let principal = transport
        .principal()
        .ok_or_else(|| anyhow!("transport connected without observing a principal"))?
        .to_string();

    // Unique actor per run: reusing one actor label across separate doc
    // instances collides at (actor, seq 1) -> automerge DuplicateSeqNumber
    // when the room syncs back the prior change.
    let actor_label = format!(
        "{principal}/{operator}:{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    info!("attached: authoring as {actor_label}");

    let mut nb = NotebookDoc::bootstrap(TextEncoding::UnicodeCodePoint, &actor_label);
    let mut nb_peer = sync::State::new();
    let mut rt = RuntimeStateDoc::try_new_with_actor(&actor_label)
        .map_err(|e| anyhow!("runtime-state doc init: {e}"))?;
    let mut rt_peer = sync::State::new();

    // Kick the initial sync exchange for both documents.
    if let Some(m) = nb.generate_sync_message(&mut nb_peer) {
        sink.send_frame(NotebookFrameType::AutomergeSync, &m.encode())
            .await?;
    }
    if let Some(m) = rt.generate_sync_message(&mut rt_peer) {
        sink.send_frame(NotebookFrameType::RuntimeStateSync, &m.encode())
            .await?;
    }

    let mut edited = false;
    let mut added_cell_id: Option<String> = None;
    let mut requested = false;
    let deadline = (actions.seconds > 0)
        .then(|| tokio::time::Instant::now() + Duration::from_secs(actions.seconds));

    loop {
        let frame = match deadline {
            Some(d) => match tokio::time::timeout_at(d, source.recv_frame()).await {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(_) => {
                    info!("duration elapsed ({}s), closing", actions.seconds);
                    break;
                }
            },
            None => match source.recv_frame().await {
                Some(f) => f,
                None => break,
            },
        };
        let frame = frame.context("read frame")?;

        match frame.frame_type {
            NotebookFrameType::SessionControl => {
                // Surface rejections/errors (skip the per-frame accept flood).
                if let Ok(control) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                    let ctl_type = control.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if ctl_type != "cloud_frame_accepted" && ctl_type != "cloud_room_ready" {
                        info!("control: {}", String::from_utf8_lossy(&frame.payload));
                    }
                }
            }
            NotebookFrameType::AutomergeSync => {
                let incoming = sync::Message::decode(&frame.payload)
                    .map_err(|e| anyhow!("decode notebook sync: {e}"))?;
                nb.receive_sync_message(&mut nb_peer, incoming)
                    .map_err(|e| anyhow!("apply notebook sync: {e}"))?;

                // The cells map arrives with the room's first sync, so an early
                // frame may not have it yet; retry the edit on later frames.
                if !edited {
                    if let Some(source_code) = actions.add_cell.as_deref() {
                        let cell_id =
                            format!("cell-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
                        if nb.add_cell_after(&cell_id, "code", None).is_ok() {
                            // Only consider the cell added once its source is
                            // set. Swallowing this would sync (and potentially
                            // run) an empty cell while logging success.
                            match nb.update_source(&cell_id, source_code) {
                                Ok(_) => {
                                    edited = true;
                                    added_cell_id = Some(cell_id.clone());
                                    info!(
                                        "added code cell {cell_id} ({} chars)",
                                        source_code.len()
                                    );
                                }
                                Err(e) => {
                                    warn!("update_source for {cell_id} failed: {e}; will retry");
                                }
                            }
                        }
                    }
                }

                let reply = nb.generate_sync_message(&mut nb_peer);
                let converged = reply.is_none();
                if let Some(reply) = reply {
                    sink.send_frame(NotebookFrameType::AutomergeSync, &reply.encode())
                        .await?;
                }

                // Once the added cell has converged to the room, ask the room
                // to run it. The room's ExecuteCell dispatch creates the queued
                // execution in RuntimeStateDoc, observed in the
                // RuntimeStateSync arm.
                if converged && edited && actions.run_cell && !requested {
                    if let Some(cell_id) = &added_cell_id {
                        let req =
                            serde_json::json!({ "action": "execute_cell", "cell_id": cell_id });
                        let body =
                            serde_json::to_vec(&req).map_err(|e| anyhow!("encode request: {e}"))?;
                        sink.send_frame(NotebookFrameType::Request, &body).await?;
                        requested = true;
                        info!("sent ExecuteCell request for {cell_id}");
                    }
                }
            }
            NotebookFrameType::RuntimeStateSync => {
                let incoming = sync::Message::decode(&frame.payload)
                    .map_err(|e| anyhow!("decode runtime-state sync: {e}"))?;
                // Use the change-accepting receive: this peer is a *consumer*
                // of the room's authoritative RuntimeStateDoc, like a frontend.
                // The plain receive_sync_message() strips incoming changes
                // (daemon-authoritative semantics), which silently discards the
                // room's queued executions and stalls convergence.
                rt.receive_sync_message_with_changes(&mut rt_peer, incoming)
                    .map_err(|e| anyhow!("apply runtime-state sync: {e}"))?;
                if let Some(m) = rt.generate_sync_message(&mut rt_peer) {
                    sink.send_frame(NotebookFrameType::RuntimeStateSync, &m.encode())
                        .await?;
                }
                // Surface any executions the room created (verifies dispatch).
                let state = rt.read_state();
                if !state.executions.is_empty() {
                    let mut ids: Vec<&String> = state.executions.keys().collect();
                    ids.sort();
                    for id in ids {
                        let ex = &state.executions[id];
                        let src: String = ex
                            .source
                            .as_deref()
                            .unwrap_or("")
                            .chars()
                            .take(40)
                            .collect();
                        info!(
                            "execution {id}: status={} seq={:?} source={src:?}",
                            ex.status, ex.seq
                        );
                    }
                }
            }
            other => info!("frame {other:?} ({} bytes)", frame.payload.len()),
        }
    }

    // Close the socket cleanly so the room records a normal disconnect rather
    // than a dropped connection. Best-effort: the server may have closed first.
    sink.close().await;

    Ok(())
}
