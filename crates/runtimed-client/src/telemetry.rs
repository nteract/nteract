//! Connection-owned host telemetry. Loss of this connection never regrants permission.

use crate::{
    client::ClientError,
    protocol::{Request, Response},
};
use notebook_protocol::connection::{self, Handshake};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, oneshot},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostTelemetrySource {
    App,
    Mcp,
}

impl HostTelemetrySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Mcp => "mcp",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostTelemetryOptions {
    pub host_id: String,
    pub source: HostTelemetrySource,
    #[serde(default)]
    pub allowed: bool,
}

impl HostTelemetryOptions {
    pub fn new(host_id: impl Into<String>, source: HostTelemetrySource) -> Self {
        Self {
            host_id: host_id.into(),
            source,
            allowed: false,
        }
    }
}

pub fn valid_host_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != "unknown"
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

type Reply = oneshot::Sender<Result<(), ClientError>>;
struct Command {
    request: Request,
    reply: Reply,
}

/// An app-lifetime permission owner. Aggregate windows before opening this handle.
pub struct TelemetryRegistration {
    commands: mpsc::Sender<Command>,
    task: tokio::task::JoinHandle<()>,
    closed: AtomicBool,
    closing: Arc<AtomicBool>,
    emission_enabled: bool,
}

const TIMEOUT: Duration = Duration::from_secs(3);

impl TelemetryRegistration {
    /// Returns `None` when host telemetry is unsupported or its capability probe is unavailable.
    pub async fn open(
        socket_path: impl AsRef<Path>,
        options: HostTelemetryOptions,
    ) -> Result<Option<Self>, ClientError> {
        if !valid_host_id(&options.host_id) {
            return Err(ClientError::ProtocolError("invalid host_id".into()));
        }
        #[cfg(unix)]
        let stream = tokio::time::timeout(
            TIMEOUT,
            tokio::net::UnixStream::connect(socket_path.as_ref()),
        )
        .await
        .map_err(|_| ClientError::Timeout)?
        .map_err(ClientError::ConnectionFailed)?;
        #[cfg(windows)]
        let stream = connection::connect_named_pipe_client(socket_path.as_ref(), TIMEOUT)
            .await
            .map_err(ClientError::ConnectionFailed)?;
        Self::on_stream(stream, options).await
    }

    async fn on_stream<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        mut stream: S,
        options: HostTelemetryOptions,
    ) -> Result<Option<Self>, ClientError> {
        tokio::time::timeout(TIMEOUT, async {
            connection::send_preamble(&mut stream)
                .await
                .map_err(protocol_error)?;
            connection::send_json_frame(&mut stream, &Handshake::Pool)
                .await
                .map_err(protocol_error)
        })
        .await
        .map_err(|_| ClientError::Timeout)??;
        let emission_enabled = match rpc(&mut stream, Request::GetDaemonInfo).await {
            Ok(Response::DaemonInfo {
                host_telemetry: true,
                host_telemetry_enabled,
                ..
            }) => host_telemetry_enabled,
            _ => return Ok(None),
        };
        ack(rpc(
            &mut stream,
            Request::RegisterHostTelemetry {
                host_id: options.host_id,
                source: options.source,
                allowed: options.allowed,
            },
        )
        .await?)?;
        let (commands, mut rx) = mpsc::channel::<Command>(16);
        let closing = Arc::new(AtomicBool::new(false));
        let task_closing = closing.clone();
        let task = tokio::spawn(async move {
            let mut renewal = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            renewal.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    command = rx.recv() => {
                        let Some(command) = command else { break; };
                        if matches!(command.request, Request::UpdateHostTelemetryPermission { allowed: true })
                            && (task_closing.load(Ordering::Acquire) || command.reply.is_closed()) {
                            let _ = command.reply.send(Err(disconnected()));
                            continue;
                        }
                        let closing = matches!(command.request, Request::CloseHostTelemetry);
                        let result = rpc(&mut stream, command.request).await.and_then(ack);
                        let failed = result.is_err();
                        let _ = command.reply.send(result);
                        if closing || failed { break; }
                    }
                    _ = renewal.tick() => {
                        if rpc(&mut stream, Request::RenewHostTelemetry).await.and_then(ack).is_err() { break; }
                    }
                }
            }
        });
        Ok(Some(Self {
            commands,
            task,
            closed: AtomicBool::new(false),
            closing,
            emission_enabled,
        }))
    }

    pub fn emission_enabled(&self) -> bool {
        self.emission_enabled
    }

    pub async fn update_permission(&self, allowed: bool) -> Result<(), ClientError> {
        self.command(Request::UpdateHostTelemetryPermission { allowed })
            .await
    }

    /// Fence queued grants before scheduling asynchronous revocation.
    pub fn begin_close(&self) {
        self.closing.store(true, Ordering::Release);
    }

    /// Success means server revocation was acknowledged, not just written to a socket.
    pub async fn close(&self) -> Result<(), ClientError> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        self.begin_close();
        self.command(Request::CloseHostTelemetry).await?;
        self.closed.store(true, Ordering::Release);
        Ok(())
    }

    async fn command(&self, request: Request) -> Result<(), ClientError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command { request, reply })
            .await
            .map_err(|_| disconnected())?;
        result.await.map_err(|_| disconnected())?
    }
}

impl Drop for TelemetryRegistration {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn disconnected() -> ClientError {
    ClientError::ProtocolError("host telemetry connection closed; register again explicitly".into())
}
fn protocol_error(error: impl std::fmt::Display) -> ClientError {
    ClientError::ProtocolError(error.to_string())
}
fn ack(response: Response) -> Result<(), ClientError> {
    match response {
        Response::HostTelemetryAck => Ok(()),
        Response::Error { message } => Err(ClientError::DaemonError(message)),
        _ => Err(protocol_error("unexpected host telemetry response")),
    }
}

async fn rpc<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    request: Request,
) -> Result<Response, ClientError> {
    tokio::time::timeout(TIMEOUT, async {
        connection::send_json_frame(stream, &request)
            .await
            .map_err(protocol_error)?;
        connection::recv_json_frame(stream)
            .await
            .map_err(protocol_error)?
            .ok_or_else(disconnected)
    })
    .await
    .map_err(|_| ClientError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::DuplexStream;

    async fn handshake(server: &mut DuplexStream) {
        connection::recv_preamble(server).await.unwrap();
        let value: Handshake = connection::recv_json_frame(server).await.unwrap().unwrap();
        assert!(matches!(value, Handshake::Pool));
        let request: Request = connection::recv_json_frame(server).await.unwrap().unwrap();
        assert!(matches!(request, Request::GetDaemonInfo));
    }
    async fn info(server: &mut DuplexStream, supported: bool) {
        let mut value = serde_json::json!({ "type":"daemon_info", "protocol_version":4,
            "daemon_version":"test", "pid":1, "started_at":"2026-09-29T00:00:00Z" });
        if supported {
            value["host_telemetry"] = true.into();
            value["host_telemetry_enabled"] = true.into();
        }
        connection::send_json_frame(server, &value).await.unwrap();
    }

    #[tokio::test]
    async fn old_daemon_receives_no_new_rpc() {
        let (client, mut server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            handshake(&mut server).await;
            info(&mut server, false).await;
            assert!(connection::recv_json_frame::<_, Request>(&mut server)
                .await
                .unwrap()
                .is_none());
        });
        assert!(TelemetryRegistration::on_stream(
            client,
            HostTelemetryOptions::new("editor", HostTelemetrySource::App)
        )
        .await
        .unwrap()
        .is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn ancient_daemon_closing_discovery_is_unsupported() {
        let (client, mut server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            handshake(&mut server).await;
        });
        assert!(TelemetryRegistration::on_stream(
            client,
            HostTelemetryOptions::new("editor", HostTelemetrySource::App)
        )
        .await
        .unwrap()
        .is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn persistent_ordered_ack_close_and_default_denial() {
        let (client, mut server) = tokio::io::duplex(4096);
        let (seen, received) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            handshake(&mut server).await;
            info(&mut server, true).await;
            assert!(matches!(
                connection::recv_json_frame::<_, Request>(&mut server)
                    .await
                    .unwrap(),
                Some(Request::RegisterHostTelemetry { allowed: false, .. })
            ));
            connection::send_json_frame(&mut server, &Response::HostTelemetryAck)
                .await
                .unwrap();
            assert!(matches!(
                connection::recv_json_frame::<_, Request>(&mut server)
                    .await
                    .unwrap(),
                Some(Request::UpdateHostTelemetryPermission { allowed: false })
            ));
            seen.send(()).unwrap();
            released.await.unwrap();
            connection::send_json_frame(&mut server, &Response::HostTelemetryAck)
                .await
                .unwrap();
            assert!(matches!(
                connection::recv_json_frame::<_, Request>(&mut server)
                    .await
                    .unwrap(),
                Some(Request::CloseHostTelemetry)
            ));
            connection::send_json_frame(&mut server, &Response::HostTelemetryAck)
                .await
                .unwrap();
        });
        let handle = TelemetryRegistration::on_stream(
            client,
            HostTelemetryOptions::new("editor", HostTelemetrySource::App),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(handle.emission_enabled());
        let update = handle.update_permission(false);
        tokio::pin!(update);
        tokio::select! { _ = &mut update => panic!("returned before ack"), _ = received => {} }
        release.send(()).unwrap();
        update.await.unwrap();
        handle.close().await.unwrap();
        handle.close().await.unwrap();
        assert!(handle.update_permission(true).await.is_err());
        server.await.unwrap();
    }

    #[test]
    fn host_validation_and_wire_defaults() {
        for bad in ["", "unknown", "Uppercase", "x.y", "a/b", "a_b", "a b"] {
            assert!(!valid_host_id(bad));
        }
        assert!(valid_host_id(&"a".repeat(64)));
        assert!(!valid_host_id(&"a".repeat(65)));
        let options: HostTelemetryOptions =
            serde_json::from_value(serde_json::json!({"host_id":"editor", "source":"app"}))
                .unwrap();
        assert!(!options.allowed);
        let request: Request = serde_json::from_value(serde_json::json!({"type":"register_host_telemetry", "host_id":"editor", "source":"mcp"})).unwrap();
        assert!(matches!(
            request,
            Request::RegisterHostTelemetry {
                allowed: false,
                source: HostTelemetrySource::Mcp,
                ..
            }
        ));
        assert!(serde_json::from_value::<Request>(serde_json::json!({"type":"register_host_telemetry", "host_id":"editor", "source":"daemon"})).is_err());
    }

    #[tokio::test]
    async fn close_fences_grant_queued_behind_pending_rpc() {
        let (client, mut server) = tokio::io::duplex(4096);
        let (seen, received) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            handshake(&mut server).await;
            info(&mut server, true).await;
            let _: Request = connection::recv_json_frame(&mut server)
                .await
                .unwrap()
                .unwrap();
            connection::send_json_frame(&mut server, &Response::HostTelemetryAck)
                .await
                .unwrap();
            assert!(matches!(
                connection::recv_json_frame::<_, Request>(&mut server)
                    .await
                    .unwrap(),
                Some(Request::UpdateHostTelemetryPermission { allowed: false })
            ));
            seen.send(()).unwrap();
            released.await.unwrap();
            connection::send_json_frame(&mut server, &Response::HostTelemetryAck)
                .await
                .unwrap();
            assert!(matches!(
                connection::recv_json_frame::<_, Request>(&mut server)
                    .await
                    .unwrap(),
                Some(Request::CloseHostTelemetry)
            ));
            connection::send_json_frame(&mut server, &Response::HostTelemetryAck)
                .await
                .unwrap();
        });
        let handle = TelemetryRegistration::on_stream(
            client,
            HostTelemetryOptions::new("editor", HostTelemetrySource::App),
        )
        .await
        .unwrap()
        .unwrap();
        let first = handle.update_permission(false);
        tokio::pin!(first);
        tokio::select! { _ = &mut first => panic!("premature ack"), _ = received => {} }
        let grant = handle.update_permission(true);
        tokio::pin!(grant);
        tokio::select! { biased; _ = &mut grant => panic!("premature grant"), _ = tokio::task::yield_now() => {} }
        let close = handle.close();
        tokio::pin!(close);
        tokio::select! { biased; _ = &mut close => panic!("premature close"), _ = tokio::task::yield_now() => {} }
        release.send(()).unwrap();
        first.await.unwrap();
        assert!(grant.await.is_err());
        close.await.unwrap();
        server.await.unwrap();
    }
}
