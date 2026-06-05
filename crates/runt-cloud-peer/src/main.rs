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

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use automerge::sync;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use notebook_doc::{NotebookDoc, TextEncoding};
use notebook_wire::frame_types;
use runtime_doc::RuntimeStateDoc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderName, HeaderValue},
        Message as WsMessage,
    },
};
use tracing::{info, warn};

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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
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
            // oidc-bearer and anaconda-api-key both present as a bearer.
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
    let deadline =
        (cli.seconds > 0).then(|| tokio::time::Instant::now() + Duration::from_secs(cli.seconds));
    loop {
        let msg = match deadline {
            Some(d) => match tokio::time::timeout_at(d, ws.next()).await {
                Ok(Some(m)) => m,
                Ok(None) => break,
                Err(_) => {
                    info!("duration elapsed ({}s), closing", cli.seconds);
                    break;
                }
            },
            None => match ws.next().await {
                Some(m) => m,
                None => break,
            },
        };
        let msg = msg.context("websocket read")?;
        if !msg.is_binary() {
            if msg.is_close() {
                warn!("server closed the connection: {msg:?}");
                break;
            }
            continue;
        }
        let data = msg.into_data();
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
                            let _ = nb_doc.update_source(&cell_id, source);
                            edited = true;
                            added_cell_id = Some(cell_id.clone());
                            info!("added code cell {cell_id} ({} chars)", source.len());
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
                rt_doc
                    .receive_sync_message(&mut rt_peer, incoming)
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
                            "execution {id}: status={} seq={:?} source={src:?}",
                            ex.status, ex.seq
                        );
                    }
                }
            }
            other => info!("frame 0x{other:02x} ({} bytes)", payload.len()),
        }
    }

    Ok(())
}
