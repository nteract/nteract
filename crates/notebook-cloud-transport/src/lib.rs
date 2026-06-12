#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
//! Cloud-WebSocket [`FrameTransport`] for the runtime agent.
//!
//! The daemon's `runtime_agent` syncs its RuntimeStateDoc/NotebookDoc over a
//! [`FrameTransport`] (see `notebook-protocol::connection`). Its default
//! transport is the local Unix socket. This crate provides the *other* impl: an
//! outbound WebSocket client that dials a hosted notebook room
//! (`wss://<host>/n/<id>/sync`), authenticates on the upgrade, and carries the
//! same typed frames the daemon socket carries — one typed frame per WS binary
//! message, with no length preamble.
//!
//! It lives in its own crate (not `notebook-protocol`) so the protocol crate
//! stays `tokio-tungstenite`-free and wasm-safe, and the daemon never depends on
//! a binary. The reusable WS-sync wire here was first proven by the
//! `runt-cloud-peer` binary (#3397); this crate lifts that wire into the
//! transport trait so the daemon's real `runtime_agent` — not a reimplemented
//! kernel drive — can write to a cloud room. See
//! `docs/adr/remote-workstation-doc-agents.md`.
//!
//! ## What differs from the UDS transport
//!
//! - **Auth, not a `Handshake` frame.** Credentials ride the upgrade request
//!   headers (`Authorization: Bearer` + `X-Scope`; dev token uses
//!   `X-Notebook-Cloud-Dev-Token`). No `Sec-WebSocket-Protocol` — offering a
//!   subprotocol the room won't echo trips tungstenite.
//! - **`cloud_room_ready`, not a preamble.** After the upgrade the room sends a
//!   `SESSION_CONTROL` frame announcing the room is ready and the authenticated
//!   actor label. The agent must author its docs under that principal or the
//!   room's actor-authorization check silently drops every change. [`connect`]
//!   reads up to that frame and surfaces the principal.
//! - **No length framing.** Each WS binary message is exactly one typed frame:
//!   `[1 byte type][payload]`.
//!
//! ## Consumer-side receive (carried by the agent, not this crate)
//!
//! A cloud peer is a *consumer* of the room's authoritative RuntimeStateDoc, so
//! it must apply incoming changes with `receive_sync_message_with_changes`, not
//! the daemon-authoritative `receive_sync_message` (which strips them). That is
//! an agent-loop policy decision, recorded in the #16 decision log; this crate
//! only moves bytes.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use notebook_protocol::connection::{FrameSink, FrameSource, FrameTransport};
use notebook_wire::{NotebookFrameType, TypedNotebookFrame};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderMap, HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};

/// First-byte constant for the session-control channel (`cloud_room_ready`
/// arrives here). Re-export of the wire constant for local readability.
const SESSION_CONTROL: u8 = notebook_wire::frame_types::SESSION_CONTROL;

/// How long [`CloudWsFrameTransport::connect`] waits for the room to reach the
/// `cloud_room_ready` / `cloud_frame_rejected` state after a successful WS
/// upgrade, before giving up with a `TimedOut` connect error.
///
/// Without this bound a room that completes the upgrade but never sends a
/// terminal control frame and never closes the socket would hang `connect`
/// forever. Because every reconnect attempt calls `connect` with no per-attempt
/// timeout of its own, that hang would also wedge the whole
/// `reconnect_with_backoff` recovery path. Returning a connect error instead
/// lets the agent's backoff loop retry (or, after its bounded attempts, exit
/// cleanly) rather than block indefinitely on one wedged room.
const READY_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How the runtime peer authenticates on the WebSocket upgrade.
#[derive(Debug, Clone)]
pub enum CloudAuth {
    /// OIDC / dev-validated bearer token (plain `Authorization: Bearer`).
    OidcBearer { token: String },
    /// Anaconda API key. Also a bearer, but the cloud identity router only
    /// treats a bearer as an API key when the provider-selector header is
    /// present; without it the key is parsed as OIDC and rejected.
    AnacondaApiKey { token: String },
    /// Workstation credential minted by the pairing flow (`nwc_`-prefixed
    /// token; see `docs/adr/hosted-credential-transport.md` Decision 9). Plain
    /// `Authorization: Bearer` on the wire — the same shape as
    /// [`CloudAuth::OidcBearer`], but honestly labeled: the cloud identity
    /// router recognizes the credential by its token prefix, not a header.
    WorkstationCredential { token: String },
    /// Dev token (`X-Notebook-Cloud-Dev-Token`) plus a user label.
    Dev { token: String, user: String },
}

/// Non-secret workstation facts the runtime peer can present on connect.
///
/// The hosted room remains the authority that writes RuntimeStateDoc
/// attachment state; this metadata is only a bounded self-description of the
/// process that is attaching as a runtime peer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudWorkstationMetadata {
    pub workstation_id: Option<String>,
    pub display_name: Option<String>,
    pub default_environment_label: Option<String>,
    pub environment_policy: Option<String>,
    pub working_directory: Option<String>,
}

impl CloudAuth {
    /// Return a copy of this auth with its credential replaced by `token`,
    /// preserving the variant (and the `Dev` user label). Used by the
    /// token-refresher path so a reconnect re-auths with a freshly-minted token
    /// without changing the auth *kind* the room expects.
    fn with_token(&self, token: String) -> Self {
        match self {
            CloudAuth::OidcBearer { .. } => CloudAuth::OidcBearer { token },
            CloudAuth::AnacondaApiKey { .. } => CloudAuth::AnacondaApiKey { token },
            CloudAuth::WorkstationCredential { .. } => CloudAuth::WorkstationCredential { token },
            CloudAuth::Dev { user, .. } => CloudAuth::Dev {
                token,
                user: user.clone(),
            },
        }
    }
}

/// A closure the transport calls *before each connect* to obtain a fresh
/// credential, replacing the static token in [`CloudWsConfig::auth`].
///
/// The cloud auth token is static for a single short session today, but a
/// long-lived runtime peer outlives its OIDC token's expiry: every reconnect
/// (idle eviction, blip) must re-auth, and a reconnect that re-presents an
/// expired token is rejected at the upgrade, so `reconnect_with_backoff` would
/// burn all its attempts and give up. A refresher lets the agent mint a fresh
/// token per connect. `None` (the default) keeps the static-token behavior. The
/// closure is `async` (refresh is typically a network round-trip) and its error
/// surfaces as a connect error so the backoff loop retries.
pub type TokenRefresher = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<String>> + Send>>
        + Send
        + Sync,
>;

fn insert_workstation_header(
    headers: &mut HeaderMap,
    name: &'static str,
    value: Option<&str>,
    max_len: usize,
) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let value = truncate_header_value(value, max_len);
    let Ok(header_value) = HeaderValue::from_str(&value) else {
        warn!(
            "[cloud-transport] skipping non-HTTP-safe workstation metadata header {}",
            name
        );
        return;
    };
    headers.insert(HeaderName::from_static(name), header_value);
}

fn truncate_header_value(value: &str, max_len: usize) -> String {
    value.chars().take(max_len).collect()
}

/// Connection parameters for a cloud room. Immutable for the life of the
/// transport, so [`CloudWsFrameTransport::connect`] can be called repeatedly on
/// reconnect.
#[derive(Debug, Clone)]
pub struct CloudWsConfig {
    /// Base URL of the notebook cloud (https/http; scheme is swapped to wss/ws).
    pub cloud_url: String,
    /// Notebook id; the room is `/n/<id>/sync`.
    pub notebook_id: String,
    /// Connection scope: `viewer` | `editor` | `runtime_peer` | `owner`.
    pub scope: String,
    /// How to authenticate the upgrade.
    pub auth: CloudAuth,
    /// Optional non-secret workstation metadata presented on the upgrade.
    pub workstation: Option<CloudWorkstationMetadata>,
}

/// Build the `wss://.../n/<id>/sync` URL from a base cloud URL.
///
/// `https` → `wss`, `http` → `ws`; any other scheme is passed through. A
/// trailing slash on the base is trimmed.
pub fn build_ws_url(cloud_url: &str, notebook_id: &str) -> String {
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

/// Encode one typed frame as a WS binary message body: `[1 byte type][payload]`.
fn encode_frame(frame_type: NotebookFrameType, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + payload.len());
    buf.push(frame_type as u8);
    buf.extend_from_slice(payload);
    buf
}

/// Decode one WS binary message body into a typed frame.
///
/// Returns `Ok(None)` for an empty body or an unknown frame type (skipped for
/// forward compatibility, matching the UDS `FramedReader`), `Ok(Some(_))` for a
/// known frame.
fn decode_frame(data: &[u8]) -> Option<TypedNotebookFrame> {
    let (&type_byte, payload) = data.split_first()?;
    match NotebookFrameType::try_from(type_byte) {
        Ok(frame_type) => Some(TypedNotebookFrame {
            frame_type,
            payload: payload.to_vec(),
        }),
        Err(_) => {
            warn!(
                "[cloud-transport] skipping unknown frame type 0x{:02x} ({} bytes)",
                type_byte,
                payload.len()
            );
            None
        }
    }
}

/// Classification of a `SESSION_CONTROL` frame seen while waiting for the room
/// to become ready.
enum ReadyControl {
    /// `cloud_room_ready` carrying the room principal.
    Ready(String),
    /// `cloud_frame_rejected` carrying the room's stated reason.
    Rejected(String),
    /// Any other control frame (e.g. `cloud_frame_accepted`, presence) — not
    /// terminal for the ready handshake.
    Other,
}

/// Classify a `SESSION_CONTROL` payload during the connect-time ready wait.
///
/// The room announces the authenticated `actor_label`
/// (`<principal>/<operator>`) in `cloud_room_ready`; the principal is the part
/// before the first `/`. A `cloud_frame_rejected` carries a `reason` the room
/// wants surfaced (e.g. an authorization failure that arrives as a control
/// frame rather than an HTTP upgrade status). Anything else is non-terminal.
fn classify_ready_control(payload: &[u8]) -> ReadyControl {
    let Ok(control) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return ReadyControl::Other;
    };
    match control.get("type").and_then(|t| t.as_str()) {
        Some("cloud_room_ready") => {
            let Some(actor_label) = control.get("actor_label").and_then(|v| v.as_str()) else {
                return ReadyControl::Other;
            };
            let principal = actor_label.split('/').next().unwrap_or(actor_label);
            if principal.is_empty() {
                ReadyControl::Other
            } else {
                ReadyControl::Ready(principal.to_string())
            }
        }
        Some("cloud_frame_rejected") => {
            let reason = control
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("(no reason given)")
                .to_string();
            ReadyControl::Rejected(reason)
        }
        _ => ReadyControl::Other,
    }
}

fn cloud_frame_rejection_error(payload: &[u8]) -> Option<std::io::Error> {
    let Ok(control) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return None;
    };
    if control.get("type").and_then(|t| t.as_str()) != Some("cloud_frame_rejected") {
        return None;
    }
    let frame_type = match control.get("frame_type") {
        Some(value) => value
            .as_u64()
            .map(|number| number.to_string())
            .or_else(|| value.as_str().map(str::to_string))
            .unwrap_or_else(|| value.to_string()),
        None => "unknown".to_string(),
    };
    let reason = control
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("(no reason given)");
    Some(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!("cloud room rejected frame: frame_type={frame_type} reason={reason}"),
    ))
}

/// Read frames from `source` until the room reaches a terminal ready state,
/// returning the authenticated principal from `cloud_room_ready`.
///
/// Data frames that arrive before the room is ready are pushed onto `buffered`
/// so the caller can replay them to the agent after the handshake — the
/// connect-time wait never drops a frame. A `cloud_frame_rejected` is surfaced
/// as a `PermissionDenied` error (the room refusing the attach over a control
/// frame rather than an HTTP status); a clean close before ready is an
/// `UnexpectedEof`.
///
/// This helper has no deadline of its own — [`CloudWsFrameTransport::connect`]
/// wraps it in [`READY_WAIT_TIMEOUT`] so a room that upgrades the WS but never
/// sends a terminal control frame can't hang the connect forever. It is generic
/// over [`FrameSource`] so the timeout and rejection paths are unit-testable
/// against a mock source.
async fn wait_for_ready<S: FrameSource>(
    source: &mut S,
    buffered: &mut VecDeque<TypedNotebookFrame>,
) -> std::io::Result<String> {
    loop {
        match source.recv_frame().await {
            Some(Ok(frame)) if frame.frame_type as u8 == SESSION_CONTROL => {
                match classify_ready_control(&frame.payload) {
                    ReadyControl::Ready(principal) => return Ok(principal),
                    ReadyControl::Rejected(reason) => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            format!("room rejected attach before ready: {reason}"),
                        ));
                    }
                    ReadyControl::Other => {
                        debug!(
                            "[cloud-transport] control frame before ready ({} bytes): {}",
                            frame.payload.len(),
                            String::from_utf8_lossy(&frame.payload)
                        );
                    }
                }
            }
            Some(Ok(frame)) => buffered.push_back(frame),
            Some(Err(e)) => return Err(e),
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "connection closed before cloud_room_ready",
                ));
            }
        }
    }
}

/// Extract the room principal from a `cloud_room_ready` control payload.
/// Thin wrapper over [`classify_ready_control`]; used by the ready-wait tests.
#[cfg(test)]
fn principal_from_cloud_room_ready(payload: &[u8]) -> Option<String> {
    match classify_ready_control(payload) {
        ReadyControl::Ready(principal) => Some(principal),
        _ => None,
    }
}

/// [`FrameSource`] over the read half of a cloud WebSocket.
///
/// Holds any frames buffered during [`CloudWsFrameTransport::connect`] (data
/// frames that arrived before `cloud_room_ready`) and drains them before
/// reading live messages, so the connect-time `cloud_room_ready` wait never
/// loses a frame. Non-binary messages (ping/pong/text) are skipped; a close or
/// stream end yields `None`.
pub struct CloudWsSource {
    stream: SplitStream<WsStream>,
    pending: VecDeque<TypedNotebookFrame>,
}

impl FrameSource for CloudWsSource {
    async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
        if let Some(frame) = self.pending.pop_front() {
            return Some(Ok(frame));
        }
        loop {
            match self.stream.next().await {
                Some(Ok(msg)) if msg.is_binary() => match decode_frame(&msg.into_data()) {
                    Some(frame) => {
                        if frame.frame_type == NotebookFrameType::SessionControl {
                            if let Some(error) = cloud_frame_rejection_error(&frame.payload) {
                                return Some(Err(error));
                            }
                        }
                        return Some(Ok(frame));
                    }
                    // Empty / unknown frame: skip, keep reading.
                    None => continue,
                },
                Some(Ok(msg)) if msg.is_close() => {
                    info!("[cloud-transport] room closed the connection");
                    return None;
                }
                // Ping/pong/text/frame: ignore and keep reading.
                Some(Ok(_)) => continue,
                Some(Err(e)) => {
                    return Some(Err(std::io::Error::other(e.to_string())));
                }
                None => return None,
            }
        }
    }
}

/// [`FrameSink`] over the write half of a cloud WebSocket. Each `send_frame`
/// writes one WS binary message and flushes it, matching the daemon socket's
/// flush-per-frame behavior.
pub struct CloudWsSink {
    sink: SplitSink<WsStream, WsMessage>,
}

impl CloudWsSink {
    /// Send a WebSocket close frame so the room records a normal disconnect
    /// rather than a dropped connection. Best-effort: the server may have
    /// closed first.
    pub async fn close(mut self) {
        let _ = self.sink.send(WsMessage::Close(None)).await;
        let _ = self.sink.flush().await;
    }
}

impl FrameSink for CloudWsSink {
    async fn send_frame(
        &mut self,
        frame_type: NotebookFrameType,
        payload: &[u8],
    ) -> std::io::Result<()> {
        let body = encode_frame(frame_type, payload);
        self.sink
            .send(WsMessage::Binary(body.into()))
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        self.sink
            .flush()
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
}

/// Cloud-WebSocket transport: dials a hosted room and syncs as a runtime peer.
///
/// `connect` (the [`FrameTransport`] method) performs the upgrade, auth, and the
/// `cloud_room_ready` wait, then hands back the split source/sink. The room
/// principal observed during the wait is cached and exposed via
/// [`CloudWsFrameTransport::principal`] so the agent can author its docs under
/// the authenticated actor.
pub struct CloudWsFrameTransport {
    config: CloudWsConfig,
    ws_url: String,
    /// Principal from the most recent `cloud_room_ready`. Set on first connect;
    /// reconnects to the same room re-observe the same principal.
    principal: Arc<std::sync::OnceLock<String>>,
    /// Optional per-connect token refresher. `None` keeps the static token from
    /// `config.auth`. When set, `connect` calls it before each dial and re-auths
    /// with the returned token so a long-lived peer survives token expiry across
    /// reconnects.
    refresher: Option<TokenRefresher>,
}

impl CloudWsFrameTransport {
    /// Build a transport for `config` with the static token in `config.auth`.
    pub fn new(config: CloudWsConfig) -> Self {
        let ws_url = build_ws_url(&config.cloud_url, &config.notebook_id);
        Self {
            config,
            ws_url,
            principal: Arc::new(std::sync::OnceLock::new()),
            refresher: None,
        }
    }

    /// Build a transport that mints a fresh credential before every connect via
    /// `refresher`, replacing the token in `config.auth` (the variant and any
    /// `Dev` user label are preserved). Use for long-lived runtime peers whose
    /// OIDC token would otherwise expire mid-session and fail every reconnect.
    pub fn with_token_refresher(config: CloudWsConfig, refresher: TokenRefresher) -> Self {
        let ws_url = build_ws_url(&config.cloud_url, &config.notebook_id);
        Self {
            config,
            ws_url,
            principal: Arc::new(std::sync::OnceLock::new()),
            refresher: Some(refresher),
        }
    }

    /// The `wss://` URL this transport dials.
    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// The room principal observed from `cloud_room_ready`, if a connection has
    /// completed its ready handshake. The agent authors its NotebookDoc /
    /// RuntimeStateDoc under `<principal>/<operator>`.
    pub fn principal(&self) -> Option<&str> {
        self.principal.get().map(String::as_str)
    }

    /// Resolve the credential to present on the next connect: the refresher's
    /// fresh token (re-wrapped in `config.auth`'s variant) if one is configured,
    /// else the static `config.auth` unchanged.
    async fn effective_auth(&self) -> std::io::Result<CloudAuth> {
        match &self.refresher {
            Some(refresh) => {
                let token = refresh().await.map_err(|e| {
                    std::io::Error::new(e.kind(), format!("token refresh failed: {e}"))
                })?;
                Ok(self.config.auth.with_token(token))
            }
            None => Ok(self.config.auth.clone()),
        }
    }

    /// Apply the auth headers for `auth` to the upgrade request.
    fn apply_auth_headers(
        &self,
        request: &mut tokio_tungstenite::tungstenite::handshake::client::Request,
        auth: &CloudAuth,
    ) -> anyhow::Result<()> {
        let h = request.headers_mut();
        // No Sec-WebSocket-Protocol: the credential rides Authorization /
        // dev-token headers, not a subprotocol.
        h.insert(
            HeaderName::from_static("x-scope"),
            HeaderValue::from_str(&self.config.scope)?,
        );
        match auth {
            CloudAuth::Dev { token, user } => {
                h.insert(
                    HeaderName::from_static("x-notebook-cloud-dev-token"),
                    HeaderValue::from_str(token)?,
                );
                h.insert(
                    HeaderName::from_static("x-user"),
                    HeaderValue::from_str(user)?,
                );
            }
            CloudAuth::AnacondaApiKey { token } => {
                h.insert(
                    HeaderName::from_static("authorization"),
                    HeaderValue::from_str(&format!("Bearer {token}"))?,
                );
                h.insert(
                    HeaderName::from_static("x-notebook-cloud-auth-provider"),
                    HeaderValue::from_static("anaconda-api-key"),
                );
            }
            // Workstation credentials share OIDC's wire shape (plain bearer);
            // the cloud side dispatches on the `nwc_` token prefix.
            CloudAuth::OidcBearer { token } | CloudAuth::WorkstationCredential { token } => {
                h.insert(
                    HeaderName::from_static("authorization"),
                    HeaderValue::from_str(&format!("Bearer {token}"))?,
                );
            }
        }
        self.apply_workstation_headers(request);
        Ok(())
    }

    fn apply_workstation_headers(
        &self,
        request: &mut tokio_tungstenite::tungstenite::handshake::client::Request,
    ) {
        let Some(workstation) = self.config.workstation.as_ref() else {
            return;
        };

        let h = request.headers_mut();
        insert_workstation_header(
            h,
            "x-nteract-workstation-id",
            workstation.workstation_id.as_deref(),
            128,
        );
        insert_workstation_header(
            h,
            "x-nteract-workstation-display-name",
            workstation.display_name.as_deref(),
            160,
        );
        insert_workstation_header(
            h,
            "x-nteract-workstation-default-environment",
            workstation.default_environment_label.as_deref(),
            160,
        );
        insert_workstation_header(
            h,
            "x-nteract-workstation-environment-policy",
            workstation.environment_policy.as_deref(),
            80,
        );
        insert_workstation_header(
            h,
            "x-nteract-workstation-working-directory",
            workstation.working_directory.as_deref(),
            512,
        );
    }

    /// Dial + auth + split + wait for `cloud_room_ready`, returning the halves
    /// and the room principal. The [`FrameTransport::connect`] impl delegates
    /// here and caches the principal.
    async fn connect_cloud(&self) -> std::io::Result<(CloudWsSource, CloudWsSink, String)> {
        let auth = self.effective_auth().await?;
        let mut request = self
            .ws_url
            .as_str()
            .into_client_request()
            .map_err(|e| std::io::Error::other(format!("build upgrade request: {e}")))?;
        self.apply_auth_headers(&mut request, &auth)
            .map_err(|e| std::io::Error::other(format!("apply auth headers: {e}")))?;

        info!(
            "[cloud-transport] dialing {} (scope={})",
            self.ws_url, self.config.scope
        );

        let (ws, resp) = match connect_async(request).await {
            Ok(ok) => ok,
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
                let status = resp.status();
                let body = resp
                    .into_body()
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default();
                return Err(std::io::Error::other(format!(
                    "upgrade rejected: HTTP {status}: {body}"
                )));
            }
            Err(e) => return Err(std::io::Error::other(format!("websocket connect: {e}"))),
        };
        debug!("[cloud-transport] connected: HTTP {}", resp.status());

        let (sink, stream) = ws.split();
        let mut source = CloudWsSource {
            stream,
            pending: VecDeque::new(),
        };

        // Read up to `cloud_room_ready`, surfacing the principal — but bound the
        // wait. A room that upgrades the WS yet never sends a terminal control
        // frame and never closes would otherwise hang `connect` (and, through
        // `reconnect_with_backoff`, the whole recovery path) forever. On timeout
        // return a `TimedOut` connect error so the agent retries rather than
        // blocks. Data frames that arrive before ready are buffered in
        // `source.pending` and replayed to the agent after the handshake.
        let mut buffered = VecDeque::new();
        let principal = match tokio::time::timeout(
            READY_WAIT_TIMEOUT,
            wait_for_ready(&mut source, &mut buffered),
        )
        .await
        {
            Ok(result) => result?,
            Err(_elapsed) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!(
                        "room did not send cloud_room_ready within {}s",
                        READY_WAIT_TIMEOUT.as_secs()
                    ),
                ));
            }
        };
        source.pending = buffered;

        info!("[cloud-transport] room ready; principal={principal}");
        let sink = CloudWsSink { sink };
        Ok((source, sink, principal))
    }
}

impl FrameTransport for CloudWsFrameTransport {
    type Source = CloudWsSource;
    type Sink = CloudWsSink;

    /// A clean WS close must not tear the kernel down: the daemon still owns a
    /// healthy kernel, and the close is an idle timeout / eviction / blip the
    /// agent should recover from by reconnecting. See lifecycle requirement #1.
    fn clean_eof_is_recoverable(&self) -> bool {
        true
    }

    fn stream_error_is_recoverable(&self, error: &std::io::Error) -> bool {
        error.kind() != std::io::ErrorKind::PermissionDenied
    }

    async fn connect(&self) -> std::io::Result<(Self::Source, Self::Sink)> {
        let (source, sink, principal) = self.connect_cloud().await?;
        // Cache the principal for `Self::principal`. Reconnects to the same room
        // with the same credential re-observe the same principal, so a failed
        // set (already-initialised) is normally expected. If a reconnect sees a
        // *different* principal, the agent is still authoring under the original
        // one and the room's actor-authz check would silently drop its changes —
        // warn loudly so that mismatch is diagnosable rather than silent.
        if let Err(existing) = self.principal.set(principal.clone()) {
            if existing != principal {
                warn!(
                    "[cloud-transport] reconnect observed principal {principal:?} but agent is \
                     authoring under {existing:?}; room will drop changes from the stale actor"
                );
            }
        }
        Ok((source, sink))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time proof that the cloud transport satisfies the same
    /// `FrameTransport` bound the daemon's `runtime_agent` is generic over, so
    /// the agent can spawn against it without a wrapper. Purely a type check.
    #[allow(dead_code)]
    fn assert_satisfies_frame_transport<T: FrameTransport>() {}
    #[allow(dead_code)]
    fn cloud_transport_is_a_frame_transport() {
        assert_satisfies_frame_transport::<CloudWsFrameTransport>();
    }

    #[test]
    fn build_ws_url_swaps_https_to_wss() {
        assert_eq!(
            build_ws_url("https://preview.runt.run", "abc"),
            "wss://preview.runt.run/n/abc/sync"
        );
    }

    #[test]
    fn build_ws_url_swaps_http_to_ws() {
        assert_eq!(
            build_ws_url("http://localhost:8787", "id1"),
            "ws://localhost:8787/n/id1/sync"
        );
    }

    #[test]
    fn build_ws_url_trims_trailing_slash_and_passes_other_schemes() {
        assert_eq!(
            build_ws_url("https://preview.runt.run/", "n"),
            "wss://preview.runt.run/n/n/sync"
        );
        assert_eq!(
            build_ws_url("wss://already.ws", "n"),
            "wss://already.ws/n/n/sync"
        );
    }

    #[test]
    fn encode_decode_frame_roundtrips() {
        let payload = b"\x00binary automerge sync bytes";
        let encoded = encode_frame(NotebookFrameType::AutomergeSync, payload);
        assert_eq!(encoded[0], NotebookFrameType::AutomergeSync as u8);
        let decoded = decode_frame(&encoded).expect("known frame decodes");
        assert_eq!(decoded.frame_type, NotebookFrameType::AutomergeSync);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn decode_frame_skips_empty_and_unknown() {
        assert!(decode_frame(&[]).is_none(), "empty body -> None");
        // 0xFF is not a known NotebookFrameType.
        assert!(
            decode_frame(&[0xFF, 0x01, 0x02]).is_none(),
            "unknown type -> None"
        );
    }

    #[test]
    fn decode_frame_accepts_empty_payload_for_known_type() {
        // A known type with a zero-length payload is a valid frame.
        let decoded = decode_frame(&[NotebookFrameType::RuntimeStateSync as u8])
            .expect("known type, empty payload");
        assert_eq!(decoded.frame_type, NotebookFrameType::RuntimeStateSync);
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn principal_parsed_from_cloud_room_ready() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_room_ready",
            "actor_label": "anaconda:alice/agent:runt:7f3a",
            "connection_scope": "runtime_peer",
        }))
        .unwrap();
        assert_eq!(
            principal_from_cloud_room_ready(&payload).as_deref(),
            Some("anaconda:alice")
        );
    }

    #[test]
    fn classify_surfaces_rejection_reason() {
        let rejected = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_frame_rejected",
            "reason": "principal lacks runtime_peer ACL row",
        }))
        .unwrap();
        match classify_ready_control(&rejected) {
            ReadyControl::Rejected(reason) => {
                assert_eq!(reason, "principal lacks runtime_peer ACL row");
            }
            _ => panic!("expected Rejected"),
        }

        // Rejection with no reason still classifies as Rejected (with a
        // placeholder) so the connect path surfaces it rather than hanging.
        let no_reason = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_frame_rejected",
        }))
        .unwrap();
        assert!(matches!(
            classify_ready_control(&no_reason),
            ReadyControl::Rejected(_)
        ));
    }

    #[test]
    fn cloud_frame_rejection_error_is_non_recoverable_shape() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_frame_rejected",
            "frame_type": 5,
            "reason": "actor label must be '<principal>/<operator>'",
        }))
        .unwrap();
        let error = cloud_frame_rejection_error(&payload).expect("rejection becomes an error");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(error
            .to_string()
            .contains("actor label must be '<principal>/<operator>'"));

        let accepted = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_frame_accepted",
        }))
        .unwrap();
        assert!(cloud_frame_rejection_error(&accepted).is_none());
    }

    #[test]
    fn cloud_frame_rejection_error_formats_string_frame_type_without_json_quotes() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_frame_rejected",
            "frame_type": "runtime_state_sync",
            "reason": "rejected",
        }))
        .unwrap();
        let error = cloud_frame_rejection_error(&payload).expect("rejection becomes an error");
        assert!(error
            .to_string()
            .contains("frame_type=runtime_state_sync reason=rejected"));
    }

    #[test]
    fn classify_treats_accepted_and_garbage_as_other() {
        let accepted = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_frame_accepted",
        }))
        .unwrap();
        assert!(matches!(
            classify_ready_control(&accepted),
            ReadyControl::Other
        ));
        assert!(matches!(
            classify_ready_control(b"not json"),
            ReadyControl::Other
        ));
    }

    #[test]
    fn principal_none_for_other_control_and_missing_label() {
        let accepted = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_frame_accepted",
        }))
        .unwrap();
        assert!(principal_from_cloud_room_ready(&accepted).is_none());

        let no_label = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_room_ready",
        }))
        .unwrap();
        assert!(principal_from_cloud_room_ready(&no_label).is_none());

        let empty_principal = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_room_ready",
            "actor_label": "/operator-only",
        }))
        .unwrap();
        assert!(principal_from_cloud_room_ready(&empty_principal).is_none());
    }

    /// The transport caches the principal across the trait's `connect`; before
    /// any connect it is `None`.
    #[test]
    fn principal_is_none_before_connect() {
        let t = CloudWsFrameTransport::new(CloudWsConfig {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "abc".into(),
            scope: "runtime_peer".into(),
            auth: CloudAuth::OidcBearer {
                token: "tok".into(),
            },
            workstation: None,
        });
        assert_eq!(t.ws_url(), "wss://preview.runt.run/n/abc/sync");
        assert!(t.principal().is_none());
    }

    /// A clean WS close must be recoverable (reconnect, keep the kernel alive),
    /// the opposite of the UDS default — lifecycle requirement #1.
    #[test]
    fn cloud_clean_eof_is_recoverable() {
        let t = CloudWsFrameTransport::new(CloudWsConfig {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "abc".into(),
            scope: "runtime_peer".into(),
            auth: CloudAuth::OidcBearer {
                token: "tok".into(),
            },
            workstation: None,
        });
        assert!(t.clean_eof_is_recoverable());
    }

    #[test]
    fn cloud_permission_denied_stream_error_is_terminal() {
        let t = CloudWsFrameTransport::new(CloudWsConfig {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "abc".into(),
            scope: "runtime_peer".into(),
            auth: CloudAuth::OidcBearer {
                token: "tok".into(),
            },
            workstation: None,
        });
        let fatal = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "room rejected");
        let transient = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset");
        assert!(!t.stream_error_is_recoverable(&fatal));
        assert!(t.stream_error_is_recoverable(&transient));
    }

    // -- token-refresher tests --------------------------------------------

    #[test]
    fn with_token_preserves_variant_and_dev_user() {
        assert!(matches!(
            CloudAuth::OidcBearer { token: "old".into() }.with_token("new".into()),
            CloudAuth::OidcBearer { token } if token == "new"
        ));
        assert!(matches!(
            CloudAuth::AnacondaApiKey { token: "old".into() }.with_token("new".into()),
            CloudAuth::AnacondaApiKey { token } if token == "new"
        ));
        assert!(matches!(
            CloudAuth::WorkstationCredential { token: "old".into() }.with_token("new".into()),
            CloudAuth::WorkstationCredential { token } if token == "new"
        ));
        // Dev keeps its user label, swaps only the token.
        match (CloudAuth::Dev {
            token: "old".into(),
            user: "alice".into(),
        })
        .with_token("new".into())
        {
            CloudAuth::Dev { token, user } => {
                assert_eq!(token, "new");
                assert_eq!(user, "alice");
            }
            _ => panic!("expected Dev"),
        }
    }

    fn test_config() -> CloudWsConfig {
        CloudWsConfig {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "abc".into(),
            scope: "runtime_peer".into(),
            auth: CloudAuth::OidcBearer {
                token: "static-tok".into(),
            },
            workstation: None,
        }
    }

    #[test]
    fn apply_auth_headers_includes_bounded_workstation_metadata() {
        let t = CloudWsFrameTransport::new(CloudWsConfig {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "abc".into(),
            scope: "runtime_peer".into(),
            auth: CloudAuth::OidcBearer {
                token: "tok".into(),
            },
            workstation: Some(CloudWorkstationMetadata {
                workstation_id: Some("ws-lab2".into()),
                display_name: Some("Lab2 workstation".into()),
                default_environment_label: Some("Current Python".into()),
                environment_policy: Some("current_python".into()),
                working_directory: Some("/home/ubuntu/codex/nteract".into()),
            }),
        });
        let mut request = t.ws_url().into_client_request().unwrap();

        t.apply_auth_headers(
            &mut request,
            &CloudAuth::OidcBearer {
                token: "tok".into(),
            },
        )
        .unwrap();

        let headers = request.headers();
        assert_eq!(
            headers
                .get("x-nteract-workstation-id")
                .and_then(|value| value.to_str().ok()),
            Some("ws-lab2")
        );
        assert_eq!(
            headers
                .get("x-nteract-workstation-working-directory")
                .and_then(|value| value.to_str().ok()),
            Some("/home/ubuntu/codex/nteract")
        );
        assert_eq!(
            headers
                .get("x-nteract-workstation-environment-policy")
                .and_then(|value| value.to_str().ok()),
            Some("current_python")
        );
    }

    /// The workstation credential rides as a plain bearer — same wire shape as
    /// OIDC, no provider-selector or dev-token headers.
    #[test]
    fn apply_auth_headers_workstation_credential_is_plain_bearer() {
        let t = CloudWsFrameTransport::new(CloudWsConfig {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "abc".into(),
            scope: "runtime_peer".into(),
            auth: CloudAuth::WorkstationCredential {
                token: "nwc_secret".into(),
            },
            workstation: None,
        });
        let mut request = t.ws_url().into_client_request().unwrap();

        t.apply_auth_headers(
            &mut request,
            &CloudAuth::WorkstationCredential {
                token: "nwc_secret".into(),
            },
        )
        .unwrap();

        let headers = request.headers();
        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer nwc_secret")
        );
        assert!(headers.get("x-notebook-cloud-auth-provider").is_none());
        assert!(headers.get("x-notebook-cloud-dev-token").is_none());
    }

    #[tokio::test]
    async fn effective_auth_uses_static_token_without_refresher() {
        let t = CloudWsFrameTransport::new(test_config());
        match t.effective_auth().await.unwrap() {
            CloudAuth::OidcBearer { token } => assert_eq!(token, "static-tok"),
            _ => panic!("expected OidcBearer"),
        }
    }

    #[tokio::test]
    async fn effective_auth_uses_refreshed_token_when_set() {
        let refresher: TokenRefresher =
            Arc::new(|| Box::pin(async { Ok("fresh-tok".to_string()) }));
        let t = CloudWsFrameTransport::with_token_refresher(test_config(), refresher);
        match t.effective_auth().await.unwrap() {
            // Variant preserved (still OIDC), token replaced with the fresh one.
            CloudAuth::OidcBearer { token } => assert_eq!(token, "fresh-tok"),
            _ => panic!("expected OidcBearer"),
        }
    }

    #[tokio::test]
    async fn effective_auth_surfaces_refresher_error() {
        let refresher: TokenRefresher = Arc::new(|| {
            Box::pin(async {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "token endpoint said no",
                ))
            })
        });
        let t = CloudWsFrameTransport::with_token_refresher(test_config(), refresher);
        let err = t
            .effective_auth()
            .await
            .expect_err("refresher error surfaces");
        // Kind is preserved so the agent can distinguish auth failures; the
        // backoff loop treats any connect error as retryable.
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    // -- ready-wait helper tests ------------------------------------------
    //
    // `wait_for_ready` is the inner loop `connect` wraps in `READY_WAIT_TIMEOUT`.
    // Testing it (and the timeout) against a mock `FrameSource` exercises the
    // hang/rejection/buffering paths without a live room.

    /// A scripted [`FrameSource`]: yields a queue of frames, then either ends
    /// the stream (`None`) or, if `hang` is set, blocks forever — modelling a
    /// room that upgraded the WS but never sends a terminal control frame.
    struct ScriptedSource {
        frames: VecDeque<std::io::Result<TypedNotebookFrame>>,
        hang: bool,
    }

    impl ScriptedSource {
        fn yielding(frames: Vec<std::io::Result<TypedNotebookFrame>>) -> Self {
            Self {
                frames: frames.into(),
                hang: false,
            }
        }

        /// Yields `frames`, then hangs forever instead of ending the stream.
        fn then_hang(frames: Vec<std::io::Result<TypedNotebookFrame>>) -> Self {
            Self {
                frames: frames.into(),
                hang: true,
            }
        }
    }

    impl FrameSource for ScriptedSource {
        async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
            if let Some(frame) = self.frames.pop_front() {
                return Some(frame);
            }
            if self.hang {
                std::future::pending::<()>().await;
            }
            None
        }
    }

    fn control_frame(json: serde_json::Value) -> TypedNotebookFrame {
        TypedNotebookFrame {
            frame_type: NotebookFrameType::SessionControl,
            payload: serde_json::to_vec(&json).unwrap(),
        }
    }

    fn data_frame(payload: &[u8]) -> TypedNotebookFrame {
        TypedNotebookFrame {
            frame_type: NotebookFrameType::AutomergeSync,
            payload: payload.to_vec(),
        }
    }

    #[tokio::test]
    async fn wait_for_ready_returns_principal_and_buffers_pre_ready_data() {
        // A data frame arrives before `cloud_room_ready`; it must be buffered
        // (replayed to the agent later), not dropped, and the principal parsed.
        let mut source = ScriptedSource::yielding(vec![
            Ok(data_frame(b"early sync bytes")),
            Ok(control_frame(serde_json::json!({
                "type": "cloud_room_ready",
                "actor_label": "anaconda:alice/agent:runt:7f3a",
            }))),
        ]);
        let mut buffered = VecDeque::new();
        let principal = wait_for_ready(&mut source, &mut buffered).await.unwrap();
        assert_eq!(principal, "anaconda:alice");
        assert_eq!(buffered.len(), 1, "pre-ready data frame is buffered");
        assert_eq!(buffered[0].payload, b"early sync bytes");
    }

    #[tokio::test]
    async fn wait_for_ready_surfaces_rejection() {
        let mut source = ScriptedSource::yielding(vec![Ok(control_frame(serde_json::json!({
            "type": "cloud_frame_rejected",
            "reason": "principal lacks runtime_peer ACL row",
        })))]);
        let mut buffered = VecDeque::new();
        let err = wait_for_ready(&mut source, &mut buffered)
            .await
            .expect_err("rejection is an error");
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[tokio::test]
    async fn wait_for_ready_clean_eof_before_ready_is_unexpected_eof() {
        let mut source = ScriptedSource::yielding(vec![]);
        let mut buffered = VecDeque::new();
        let err = wait_for_ready(&mut source, &mut buffered)
            .await
            .expect_err("EOF before ready is an error");
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    /// The keystone gap-1 test: a room that upgrades the WS but never sends a
    /// terminal control frame and never closes must NOT hang `connect`. The
    /// `READY_WAIT_TIMEOUT` wrapper turns the hang into a `TimedOut` error so
    /// `reconnect_with_backoff` can retry. Uses paused time so the test is
    /// instant and deterministic.
    #[tokio::test(start_paused = true)]
    async fn ready_wait_times_out_on_a_silent_room() {
        // Sends one non-terminal control frame, then hangs forever.
        let mut source = ScriptedSource::then_hang(vec![Ok(control_frame(serde_json::json!({
            "type": "cloud_frame_accepted",
        })))]);
        let mut buffered = VecDeque::new();

        let result = tokio::time::timeout(
            READY_WAIT_TIMEOUT,
            wait_for_ready(&mut source, &mut buffered),
        )
        .await;
        assert!(
            result.is_err(),
            "a room that never sends cloud_room_ready must time out, not hang"
        );

        // And the connect-time mapping turns that elapsed into a TimedOut io
        // error (the shape `reconnect_with_backoff` treats as a failed connect).
        let mapped: std::io::Result<String> = match result {
            Ok(inner) => inner,
            Err(_elapsed) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "room did not send cloud_room_ready",
            )),
        };
        assert_eq!(
            mapped.expect_err("timed out").kind(),
            std::io::ErrorKind::TimedOut
        );
    }
}
