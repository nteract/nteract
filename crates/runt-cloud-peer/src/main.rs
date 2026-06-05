//! Dial a hosted nteract notebook room over WebSocket and sync as a peer.
//!
//! The outbound peer the daemon lacks: the local sync paths (`notebook-sync`,
//! `runtime_agent`) only speak the Unix-socket handshake, and `runt-publish`
//! only talks HTTP. Here we dial `wss://<host>/n/<id>/sync`, authenticate on the
//! upgrade (OIDC bearer / Anaconda API key / dev token), and run Automerge sync
//! for BOTH the NotebookDoc and the RuntimeStateDoc over the typed-frame v4
//! stream, reusing `notebook-doc` / `runtime-doc` directly.
//!
//! Two load-bearing rules:
//! - CRDT init (notebook-doc invariant #2): `bootstrap()` seeds only the frozen
//!   genesis + `schema_version`. The room owns the `cells`/`metadata` maps; we
//!   receive them via sync before editing.
//! - Change attribution: the room's `validate_room_notebook_change_actors`
//!   rejects any change whose actor principal differs from the authenticated
//!   principal. So we bootstrap the docs with `<principal>/<operator>` taken
//!   from the room's `cloud_room_ready` frame, not an arbitrary actor.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use automerge::sync;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use jupyter_protocol::{JupyterMessage, JupyterMessageContent};
use notebook_doc::{NotebookDoc, TextEncoding};
use notebook_wire::frame_types;
use runtime_doc::{KernelActivity, RuntimeLifecycle, RuntimeStateDoc};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderName, HeaderValue},
        Message as WsMessage,
    },
};
use tracing::{info, warn};

mod kernel_host;

#[derive(Parser, Debug)]
#[command(
    name = "runt-cloud-peer",
    about = "Dial a hosted nteract room over WebSocket and sync both documents"
)]
struct Cli {
    /// Base URL of the notebook cloud (https/http; scheme is swapped to wss/ws).
    #[arg(long, default_value = "https://preview.runt.run")]
    cloud_url: String,

    /// Notebook id to attach to (room is `/n/<id>/sync`).
    #[arg(long)]
    notebook_id: String,

    /// Connection scope: viewer | editor | runtime_peer | owner.
    #[arg(long, default_value = "owner")]
    scope: String,

    /// Auth mode: oidc-bearer | anaconda-api-key | dev.
    #[arg(long, default_value = "oidc-bearer")]
    auth_mode: String,

    /// Token value (or use --token-file).
    #[arg(long)]
    token: Option<String>,

    /// File containing the token (trimmed).
    #[arg(long)]
    token_file: Option<PathBuf>,

    /// Dev user label (dev auth only).
    #[arg(long, default_value = "runt-cloud-peer")]
    user: String,

    /// Operator suffix for our doc actor label (`<principal>/<operator>`).
    #[arg(long, default_value = "agent:runt-cloud-peer")]
    operator: String,

    /// After sync converges, add a code cell with this source and sync it back.
    #[arg(long)]
    add_cell: Option<String>,

    /// After the added cell converges, send an ExecuteCell request for it and
    /// log the executions that appear in the RuntimeStateDoc (verifies the
    /// hosted ExecuteCell dispatch). Requires --add-cell.
    #[arg(long)]
    run_cell: bool,

    /// Auto-close after this many seconds (0 = run until disconnected).
    #[arg(long, default_value_t = 20)]
    seconds: u64,

    /// Standalone self-test of the local kernel-drive layer: launch a python
    /// kernel, run a cell (the --add-cell source, or a default), log IOPub, and
    /// exit. No cloud connection.
    #[arg(long)]
    kernel_self_test: bool,

    /// Host a kernel for the room as a runtime_peer: run queued executions on a
    /// local kernel and stream outputs back. Use with --scope runtime_peer.
    #[arg(long)]
    host_kernel: bool,

    /// Python interpreter for the hosted kernel (must have ipykernel).
    #[arg(long, default_value = "python3")]
    python: String,

    /// Optional VIRTUAL_ENV to export for the hosted kernel.
    #[arg(long)]
    venv: Option<String>,
}

fn load_token(cli: &Cli) -> Result<String> {
    if let Some(t) = &cli.token {
        return Ok(t.trim().to_string());
    }
    if let Some(f) = &cli.token_file {
        let raw = std::fs::read_to_string(f).with_context(|| format!("read {}", f.display()))?;
        return Ok(raw.trim().to_string());
    }
    Err(anyhow!("provide --token or --token-file"))
}

fn build_ws_url(cloud_url: &str, notebook_id: &str) -> String {
    let base = cloud_url.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{ws}/n/{notebook_id}/sync")
}

/// One typed frame = one WS binary message: `[1 byte type][payload]`.
fn frame(frame_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + payload.len());
    buf.push(frame_type);
    buf.extend_from_slice(payload);
    buf
}

/// Read the next IOPub message from an optional kernel. Pends forever when no
/// kernel is present, so it's an inert `select!` arm until a kernel launches.
async fn next_iopub(kernel: &mut Option<kernel_host::Kernel>) -> Option<JupyterMessage> {
    match kernel.as_mut() {
        Some(k) => k.iopub.read().await.ok(),
        None => std::future::pending().await,
    }
}

/// Mint an output_id (required by `append_output`) and append an nbformat output.
fn append_kernel_output(
    rt_doc: &mut RuntimeStateDoc,
    execution_id: &str,
    mut nbformat: serde_json::Value,
) -> Result<()> {
    nbformat["output_id"] = serde_json::Value::String(uuid::Uuid::new_v4().to_string());
    rt_doc
        .append_output(execution_id, &nbformat)
        .map_err(|e| anyhow!("append_output: {e}"))?;
    Ok(())
}

/// Apply one IOPub message to the local RuntimeStateDoc, routing by
/// `parent_header.msg_id == execution_id`. Returns the encoded
/// RUNTIME_STATE_SYNC frame to push to the room when the doc changed.
fn apply_iopub(
    msg: &JupyterMessage,
    rt_doc: &mut RuntimeStateDoc,
    rt_peer: &mut sync::State,
    errored: &mut HashSet<String>,
) -> Result<Option<Vec<u8>>> {
    let Some(eid) = msg.parent_header.as_ref().map(|h| h.msg_id.clone()) else {
        return Ok(None);
    };
    let mut changed = false;
    match &msg.content {
        JupyterMessageContent::ExecuteInput(input) => {
            rt_doc
                .set_execution_count(&eid, input.execution_count.0 as i64)
                .map_err(|e| anyhow!("set_execution_count: {e}"))?;
            changed = true;
        }
        JupyterMessageContent::Status(status) => match status.execution_state {
            jupyter_protocol::ExecutionState::Busy => {
                rt_doc
                    .set_activity(KernelActivity::Busy)
                    .map_err(|e| anyhow!("set_activity: {e}"))?;
                changed = true;
            }
            jupyter_protocol::ExecutionState::Idle => {
                rt_doc
                    .set_activity(KernelActivity::Idle)
                    .map_err(|e| anyhow!("set_activity: {e}"))?;
                // No-op if eid is a non-execution parent (e.g. kernel_info).
                let success = !errored.remove(&eid);
                rt_doc
                    .set_execution_done(&eid, success)
                    .map_err(|e| anyhow!("set_execution_done: {e}"))?;
                changed = true;
            }
            _ => {}
        },
        JupyterMessageContent::ErrorOutput(_) => {
            errored.insert(eid.clone());
            if let Some(nb) = kernel_host::content_to_nbformat(&msg.content) {
                append_kernel_output(rt_doc, &eid, nb)?;
                changed = true;
            }
        }
        other => {
            if let Some(nb) = kernel_host::content_to_nbformat(other) {
                append_kernel_output(rt_doc, &eid, nb)?;
                changed = true;
            }
        }
    }
    if changed {
        Ok(rt_doc
            .generate_sync_message(rt_peer)
            .map(|m| frame(frame_types::RUNTIME_STATE_SYNC, &m.encode())))
    } else {
        Ok(None)
    }
}

/// Dispatch any queued executions the room created to the local kernel:
/// queued -> running, then `execute_request`. Returns the RUNTIME_STATE_SYNC
/// frame carrying the running transitions, if any.
async fn dispatch_queued(
    rt_doc: &mut RuntimeStateDoc,
    rt_peer: &mut sync::State,
    kernel: &mut kernel_host::Kernel,
    dispatched: &mut HashSet<String>,
) -> Result<Option<Vec<u8>>> {
    let mut any = false;
    for (eid, exec) in rt_doc.get_queued_executions() {
        if dispatched.contains(&eid) {
            continue;
        }
        let Some(source) = exec.source.clone() else {
            continue; // the room must populate source on the queued execution
        };
        rt_doc
            .set_execution_running(&eid)
            .map_err(|e| anyhow!("set_execution_running: {e}"))?;
        kernel
            .execute(&eid, exec.cell_id.as_deref(), &source)
            .await?;
        dispatched.insert(eid.clone());
        any = true;
        info!("dispatched queued execution {eid} to kernel");
    }
    if any {
        Ok(rt_doc
            .generate_sync_message(rt_peer)
            .map(|m| frame(frame_types::RUNTIME_STATE_SYNC, &m.encode())))
    } else {
        Ok(None)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    // Standalone kernel-drive self-test: no cloud, no token. Proves the local
    // launch + execute + IOPub layer before wiring it into the room loop.
    if cli.kernel_self_test {
        let source = cli
            .add_cell
            .as_deref()
            .unwrap_or("print('hello from runt-cloud-peer kernel host')");
        return kernel_host::self_test(&cli.python, cli.venv.as_deref(), source).await;
    }

    let token = load_token(&cli)?;
    let ws_url = build_ws_url(&cli.cloud_url, &cli.notebook_id);
    info!(
        "dialing {ws_url} (scope={}, auth_mode={})",
        cli.scope, cli.auth_mode
    );

    let mut request = ws_url
        .as_str()
        .into_client_request()
        .context("build websocket upgrade request")?;
    {
        let h = request.headers_mut();
        // No Sec-WebSocket-Protocol: we carry the credential in the
        // Authorization (or dev-token) header, not a subprotocol; offering one
        // the room won't echo trips tungstenite's "server sent no subprotocol".
        h.insert(
            HeaderName::from_static("x-scope"),
            HeaderValue::from_str(&cli.scope)?,
        );
        match cli.auth_mode.as_str() {
            "dev" => {
                h.insert(
                    HeaderName::from_static("x-notebook-cloud-dev-token"),
                    HeaderValue::from_str(&token)?,
                );
                h.insert(
                    HeaderName::from_static("x-user"),
                    HeaderValue::from_str(&cli.user)?,
                );
            }
            // The Anaconda API-key path is also a bearer, but the cloud identity
            // router only treats a bearer as an API key when the provider
            // selector header is present; without it the key is parsed as OIDC
            // and rejected.
            "anaconda-api-key" => {
                h.insert(
                    HeaderName::from_static("authorization"),
                    HeaderValue::from_str(&format!("Bearer {token}"))?,
                );
                h.insert(
                    HeaderName::from_static("x-notebook-cloud-auth-provider"),
                    HeaderValue::from_static("anaconda-api-key"),
                );
            }
            // oidc-bearer (default): plain bearer.
            _ => {
                h.insert(
                    HeaderName::from_static("authorization"),
                    HeaderValue::from_str(&format!("Bearer {token}"))?,
                );
            }
        }
    }

    let (mut ws, resp) = match connect_async(request).await {
        Ok(ok) => ok,
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            let status = resp.status();
            let body = resp
                .into_body()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            bail!("upgrade rejected: HTTP {status}: {body}");
        }
        Err(e) => return Err(e).context("websocket connect"),
    };
    info!("connected: HTTP {} ", resp.status());

    // Docs are created only after `cloud_room_ready` tells us the principal, so
    // our changes are authored under `<principal>/<operator>` and pass the
    // room's actor-authorization check.
    let mut nb: Option<NotebookDoc> = None;
    let mut nb_peer = sync::State::new();
    let mut rt: Option<RuntimeStateDoc> = None;
    let mut rt_peer = sync::State::new();
    let mut edited = false;
    let mut added_cell_id: Option<String> = None;
    let mut requested = false;
    // Kernel-host (runtime_peer) state: the local kernel, the executions we've
    // already dispatched to it, and which ones produced an error output.
    let mut kernel: Option<kernel_host::Kernel> = None;
    let mut dispatched: HashSet<String> = HashSet::new();
    let mut errored: HashSet<String> = HashSet::new();
    let deadline =
        (cli.seconds > 0).then(|| tokio::time::Instant::now() + Duration::from_secs(cli.seconds));

    enum Ev {
        Frame(Vec<u8>),
        Iopub(JupyterMessage),
        Closed,
        Deadline,
    }
    loop {
        let ev = tokio::select! {
            biased;
            _ = async {
                match deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => Ev::Deadline,
            m = ws.next() => match m {
                Some(Ok(msg)) if msg.is_binary() => Ev::Frame(msg.into_data().to_vec()),
                Some(Ok(msg)) if msg.is_close() => Ev::Closed,
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e).context("websocket read"),
                None => Ev::Closed,
            },
            io = next_iopub(&mut kernel), if kernel.is_some() => match io {
                Some(msg) => Ev::Iopub(msg),
                None => Ev::Closed,
            },
        };
        let data = match ev {
            Ev::Deadline => {
                info!("duration elapsed ({}s), closing", cli.seconds);
                break;
            }
            Ev::Closed => {
                warn!("connection closed");
                break;
            }
            Ev::Iopub(msg) => {
                if let Some(rt_doc) = rt.as_mut() {
                    if let Some(out) = apply_iopub(&msg, rt_doc, &mut rt_peer, &mut errored)? {
                        ws.send(WsMessage::Binary(out.into())).await?;
                    }
                }
                continue;
            }
            Ev::Frame(d) => d,
        };
        let Some((&ftype, payload)) = data.split_first() else {
            warn!("empty frame");
            continue;
        };

        match ftype {
            frame_types::SESSION_CONTROL => {
                let control: serde_json::Value = match serde_json::from_slice(payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let ctl_type = control.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ctl_type != "cloud_room_ready" {
                    // Surface rejections/errors (skip the per-frame accept flood).
                    if ctl_type != "cloud_frame_accepted" {
                        info!("control: {}", String::from_utf8_lossy(payload));
                    }
                    continue;
                }
                if nb.is_some() {
                    continue; // already attached
                }
                let room_actor = control
                    .get("actor_label")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let principal = room_actor.split('/').next().unwrap_or(room_actor);
                if principal.is_empty() {
                    bail!("cloud_room_ready missing actor_label/principal");
                }
                // Unique actor per run: reusing one actor label across separate
                // doc instances collides at (actor, seq 1) -> automerge
                // DuplicateSeqNumber when the room syncs back the prior change.
                let actor_label = format!(
                    "{principal}/{}:{}",
                    cli.operator,
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                );
                let scope = control
                    .get("connection_scope")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                info!("attached: scope={scope}, authoring as {actor_label}");

                let mut nb_doc =
                    NotebookDoc::bootstrap(TextEncoding::UnicodeCodePoint, &actor_label);
                let mut rt_doc = RuntimeStateDoc::try_new_with_actor(&actor_label)
                    .map_err(|e| anyhow!("runtime-state doc init: {e}"))?;
                // Kick the initial sync exchange for both documents.
                if let Some(m) = nb_doc.generate_sync_message(&mut nb_peer) {
                    ws.send(WsMessage::Binary(
                        frame(frame_types::AUTOMERGE_SYNC, &m.encode()).into(),
                    ))
                    .await?;
                }
                if let Some(m) = rt_doc.generate_sync_message(&mut rt_peer) {
                    ws.send(WsMessage::Binary(
                        frame(frame_types::RUNTIME_STATE_SYNC, &m.encode()).into(),
                    ))
                    .await?;
                }
                nb = Some(nb_doc);
                rt = Some(rt_doc);

                // Host a kernel for this room: launch it, mark the runtime
                // Running(Idle), and push that so the viewer sees a live kernel.
                // Queued executions are then dispatched in the RUNTIME_STATE_SYNC
                // arm and their outputs stream back via the IOPub select arm.
                if cli.host_kernel && kernel.is_none() {
                    match kernel_host::Kernel::launch(&cli.python, cli.venv.as_deref()).await {
                        Ok(mut k) => {
                            if let Err(e) = k.wait_until_ready(Duration::from_secs(30)).await {
                                warn!("kernel did not become ready: {e}");
                            }
                            if let Some(rt_doc) = rt.as_mut() {
                                rt_doc
                                    .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
                                    .map_err(|e| anyhow!("set_lifecycle: {e}"))?;
                                if let Some(m) = rt_doc.generate_sync_message(&mut rt_peer) {
                                    ws.send(WsMessage::Binary(
                                        frame(frame_types::RUNTIME_STATE_SYNC, &m.encode()).into(),
                                    ))
                                    .await?;
                                }
                            }
                            kernel = Some(k);
                            info!("hosting kernel as runtime_peer; ready for queued executions");
                        }
                        Err(e) => warn!("kernel launch failed: {e}"),
                    }
                }
            }
            frame_types::AUTOMERGE_SYNC => {
                let Some(nb_doc) = nb.as_mut() else {
                    continue;
                };
                let incoming = sync::Message::decode(payload)
                    .map_err(|e| anyhow!("decode notebook sync: {e}"))?;
                nb_doc
                    .receive_sync_message(&mut nb_peer, incoming)
                    .map_err(|e| anyhow!("apply notebook sync: {e}"))?;

                // The cells map arrives with the room's first sync, so an early
                // frame may not have it yet; retry the edit on later frames.
                if !edited {
                    if let Some(source) = cli.add_cell.as_deref() {
                        let cell_id =
                            format!("cell-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
                        if nb_doc.add_cell_after(&cell_id, "code", None).is_ok() {
                            // Only consider the cell added once its source is set.
                            // Swallowing this would sync (and potentially run) an
                            // empty cell while logging success.
                            match nb_doc.update_source(&cell_id, source) {
                                Ok(_) => {
                                    edited = true;
                                    added_cell_id = Some(cell_id.clone());
                                    info!("added code cell {cell_id} ({} chars)", source.len());
                                }
                                Err(e) => {
                                    warn!("update_source for {cell_id} failed: {e}; will retry");
                                }
                            }
                        }
                    }
                }

                let reply = nb_doc.generate_sync_message(&mut nb_peer);
                let converged = reply.is_none();
                if let Some(reply) = reply {
                    ws.send(WsMessage::Binary(
                        frame(frame_types::AUTOMERGE_SYNC, &reply.encode()).into(),
                    ))
                    .await?;
                }

                // Once the added cell has converged to the room, ask the room to
                // run it. The room's ExecuteCell dispatch creates the queued
                // execution in RuntimeStateDoc, which we observe in the 0x05 arm.
                if converged && edited && cli.run_cell && !requested {
                    if let Some(cell_id) = &added_cell_id {
                        let req =
                            serde_json::json!({ "action": "execute_cell", "cell_id": cell_id });
                        let body =
                            serde_json::to_vec(&req).map_err(|e| anyhow!("encode request: {e}"))?;
                        ws.send(WsMessage::Binary(frame(frame_types::REQUEST, &body).into()))
                            .await?;
                        requested = true;
                        info!("sent ExecuteCell request for {cell_id}");
                    }
                }
            }
            frame_types::RUNTIME_STATE_SYNC => {
                let Some(rt_doc) = rt.as_mut() else {
                    continue;
                };
                let incoming = sync::Message::decode(payload)
                    .map_err(|e| anyhow!("decode runtime-state sync: {e}"))?;
                // Use the change-accepting receive: this peer is a *consumer*
                // of the room's authoritative RuntimeStateDoc, like a frontend.
                // The plain receive_sync_message() strips incoming changes
                // (daemon-authoritative semantics), which silently discards the
                // room's queued executions and stalls convergence.
                rt_doc
                    .receive_sync_message_with_changes(&mut rt_peer, incoming)
                    .map_err(|e| anyhow!("apply runtime-state sync: {e}"))?;
                if let Some(m) = rt_doc.generate_sync_message(&mut rt_peer) {
                    ws.send(WsMessage::Binary(
                        frame(frame_types::RUNTIME_STATE_SYNC, &m.encode()).into(),
                    ))
                    .await?;
                }
                // Surface any executions the room created (verifies dispatch).
                let state = rt_doc.read_state();
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
                            "execution {id}: status={} seq={:?} outputs={} source={src:?}",
                            ex.status,
                            ex.seq,
                            ex.outputs.len()
                        );
                    }
                }

                // Hosted-kernel runtime_peer: run any newly-queued executions.
                if let Some(k) = kernel.as_mut() {
                    if let Some(out) =
                        dispatch_queued(rt_doc, &mut rt_peer, k, &mut dispatched).await?
                    {
                        ws.send(WsMessage::Binary(out.into())).await?;
                    }
                }
            }
            other => info!("frame 0x{other:02x} ({} bytes)", payload.len()),
        }
    }

    // Close the socket cleanly so the room records a normal disconnect rather
    // than a dropped connection. Best-effort: the server may have closed first.
    let _ = ws.close(None).await;

    Ok(())
}
