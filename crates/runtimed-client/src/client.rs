//! Client for communicating with the pool daemon.
//!
//! Notebook windows use this client to request prewarmed environments
//! from the central daemon via IPC (Unix domain sockets on Unix, named pipes
//! on Windows).

use std::path::PathBuf;
use std::time::Duration;

use log::{info, warn};
use tokio::io::{AsyncRead, AsyncWrite};

use serde::Serialize;

use notebook_doc::pool_state::PoolState;
use notebook_protocol::connection::{self, Handshake};
use runt_workspace::default_socket_path;

use crate::protocol::{Request, Response};
use crate::{EnvType, PooledEnv};

/// Progress updates during daemon startup.
///
/// Consumed by the notebook app's first-launch flow to render UI feedback
/// while the daemon installs, upgrades, or starts.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DaemonProgress {
    /// Checking if daemon is already running
    Checking,
    /// Installing daemon service (first launch)
    Installing,
    /// Upgrading daemon to new version
    Upgrading,
    /// Starting daemon service
    Starting,
    /// Waiting for daemon to become ready
    WaitingForReady { attempt: u32, max_attempts: u32 },
    /// Daemon is ready
    Ready { endpoint: String },
    /// Daemon failed to start
    Failed {
        error: String,
        /// Actionable guidance for the user
        guidance: String,
    },
}

#[cfg(unix)]
use tokio::net::UnixStream;

/// Result of inspecting a notebook's state.
#[derive(Debug, Clone)]
pub struct InspectResult {
    pub notebook_id: String,
    pub cells: Vec<notebook_doc::CellSnapshot>,
    /// Outputs keyed by cell_id. Outputs live in `RuntimeStateDoc` keyed
    /// by `execution_id` and travel alongside the cell snapshot rather
    /// than on it. Cells without outputs are absent from the map.
    pub outputs_by_cell: std::collections::HashMap<String, Vec<serde_json::Value>>,
    pub source: String,
    pub kernel_info: Option<crate::protocol::NotebookKernelInfo>,
}

/// Version information returned by a daemon ping.
#[derive(Debug, Clone)]
pub struct PongInfo {
    /// Numeric protocol version (matches `PROTOCOL_VERSION` in connection.rs).
    /// `None` if the daemon is too old to include this field.
    pub protocol_version: Option<u32>,
    /// Daemon version string (e.g., "2.0.0+abc123").
    /// `None` if the daemon is too old to include this field.
    pub daemon_version: Option<String>,
}

/// Rich daemon metadata queried from the daemon via `PoolClient::daemon_info()`.
#[derive(Debug, Clone)]
pub struct DaemonInfo {
    /// Numeric protocol version.
    pub protocol_version: u32,
    /// Daemon version string (e.g., "2.0.0+abc123").
    pub daemon_version: String,
    /// Daemon process ID.
    pub pid: u32,
    /// When the daemon process began.
    pub started_at: chrono::DateTime<chrono::Utc>,
    /// HTTP port for the content-addressed blob server. `None` if the
    /// blob server hasn't finished binding yet.
    pub blob_port: Option<u16>,
    /// Directory for durable execution result records.
    pub execution_store_dir: Option<String>,
    /// Path to the git worktree this dev daemon is pinned to.
    pub worktree_path: Option<String>,
    /// Human-readable workspace description (dev mode only).
    pub workspace_description: Option<String>,
}

impl PongInfo {
    /// Check whether the daemon's protocol version is compatible with this client.
    ///
    /// Returns `Ok(())` if compatible, or an `Err` with an actionable message
    /// explaining the mismatch. If the daemon didn't report a protocol version
    /// (old daemon), this logs a warning but does not error — backward
    /// compatibility is preserved.
    pub fn check_protocol_version(&self) -> Result<(), String> {
        let expected = u32::from(notebook_protocol::connection::PROTOCOL_VERSION);

        match self.protocol_version {
            Some(remote) if remote == expected => Ok(()),
            Some(remote) if remote > expected => Err(format!(
                "Daemon is running protocol version {remote}, but this CLI expects version {expected}. \
                 Please update the CLI (or reinstall the app) to match the daemon."
            )),
            Some(remote) => Err(format!(
                "Daemon is running protocol version {remote}, but this CLI expects version {expected}. \
                 Please update the daemon: runt daemon doctor --fix"
            )),
            None => {
                log::warn!(
                    "[pool-client] Daemon did not report a protocol version — \
                     it may be outdated. Consider updating: runt daemon doctor --fix"
                );
                Ok(())
            }
        }
    }
}

/// Error type for client operations.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Failed to connect to daemon: {0}")]
    ConnectionFailed(#[from] std::io::Error),

    #[error("Protocol error: {0}")]
    ProtocolError(String),

    #[error("Daemon returned error: {0}")]
    DaemonError(String),

    #[error("Connection timeout")]
    Timeout,

    #[error("Notebook projection unavailable for {notebook_id}: {failure}")]
    NotebookProjectionUnavailable {
        notebook_id: String,
        failure: crate::protocol::NotebookProjectionFailure,
    },
}

/// Client for the pool daemon.
pub struct PoolClient {
    socket_path: PathBuf,
    connect_timeout: Duration,
}

impl Default for PoolClient {
    fn default() -> Self {
        Self::new(default_socket_path())
    }
}

impl PoolClient {
    /// Create a new client with a custom socket/pipe path.
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            connect_timeout: Duration::from_secs(2),
        }
    }

    /// Set the connection timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// Check if the daemon is running.
    pub async fn is_daemon_running(&self) -> bool {
        self.ping().await.is_ok()
    }

    /// Ping the daemon to check if it's alive.
    pub async fn ping(&self) -> Result<(), ClientError> {
        self.ping_version().await.map(|_| ())
    }

    /// Ping the daemon and return its version info.
    ///
    /// Returns `Ok(PongInfo)` with the daemon's protocol version and
    /// version string. Old daemons that send a bare `Pong` (no fields)
    /// will have `None` for both fields.
    pub async fn ping_version(&self) -> Result<PongInfo, ClientError> {
        let response = self.send_request(Request::Ping).await?;
        match response {
            Response::Pong {
                protocol_version,
                daemon_version,
            } => Ok(PongInfo {
                protocol_version,
                daemon_version,
            }),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Query rich daemon metadata (pid, blob port, worktree info, etc.).
    ///
    /// This is the socket-based daemon metadata path.
    /// Returns `Err` with `DaemonError("Unknown request")` on daemons too
    /// old to know this request; callers should treat that as "metadata
    /// unavailable".
    pub async fn daemon_info(&self) -> Result<DaemonInfo, ClientError> {
        let response = self.send_request(Request::GetDaemonInfo).await?;
        match response {
            Response::DaemonInfo {
                protocol_version,
                daemon_version,
                pid,
                started_at,
                blob_port,
                execution_store_dir,
                worktree_path,
                workspace_description,
            } => Ok(DaemonInfo {
                protocol_version,
                daemon_version,
                pid,
                started_at,
                blob_port,
                execution_store_dir,
                worktree_path,
                workspace_description,
            }),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Read a terminal execution record by execution ID from the daemon.
    pub async fn get_execution_record(
        &self,
        execution_id: &str,
    ) -> Result<crate::execution_store::ExecutionRecord, ClientError> {
        let response = self
            .send_request(Request::GetExecutionResult {
                execution_id: execution_id.to_string(),
            })
            .await?;
        match response {
            Response::ExecutionResult { record } => Ok(record),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Query tokio runtime metrics (worker utilization, task counts).
    ///
    /// Returns the raw metrics snapshot as a JSON value. Daemons that
    /// predate this request return `Err(DaemonError("Unknown request"))`.
    pub async fn runtime_metrics(&self) -> Result<serde_json::Value, ClientError> {
        let response = self.send_request(Request::GetRuntimeMetrics).await?;
        match response {
            Response::RuntimeMetrics {
                num_workers,
                num_alive_tasks,
                global_queue_depth,
                worker_busy_us,
                worker_park_count,
                uptime_us,
            } => {
                let uptime_us_f = uptime_us as f64;
                let workers: Vec<serde_json::Value> = (0..num_workers)
                    .map(|i| {
                        let busy = worker_busy_us.get(i).copied().unwrap_or(0);
                        let parks = worker_park_count.get(i).copied().unwrap_or(0);
                        let utilization = if uptime_us_f > 0.0 {
                            (busy as f64 / uptime_us_f * 100.0).min(100.0)
                        } else {
                            0.0
                        };
                        serde_json::json!({
                            "busy_us": busy,
                            "park_count": parks,
                            "utilization_pct": (utilization * 100.0).round() / 100.0,
                        })
                    })
                    .collect();

                Ok(serde_json::json!({
                    "num_workers": num_workers,
                    "num_alive_tasks": num_alive_tasks,
                    "global_queue_depth": global_queue_depth,
                    "uptime_us": uptime_us,
                    "workers": workers,
                }))
            }
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Request an environment from the pool.
    ///
    /// Returns `Ok(Some(env))` if an environment was available,
    /// `Ok(None)` if the pool was empty.
    pub async fn take(&self, env_type: EnvType) -> Result<Option<PooledEnv>, ClientError> {
        let response = self.send_request(Request::Take { env_type }).await?;
        match response {
            Response::Env { env } => {
                info!(
                    "[pool-client] Got {} env from daemon: {:?}",
                    env_type, env.venv_path
                );
                Ok(Some(env))
            }
            Response::Empty => {
                info!("[pool-client] Daemon pool empty for {}", env_type);
                Ok(None)
            }
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Return an environment to the pool.
    pub async fn return_env(&self, env: PooledEnv) -> Result<(), ClientError> {
        let response = self.send_request(Request::Return { env }).await?;
        match response {
            Response::Returned => Ok(()),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Get pool state (from PoolDoc).
    pub async fn status(&self) -> Result<PoolState, ClientError> {
        let response = self.send_request(Request::Status).await?;
        match response {
            Response::Stats { state } => Ok(state),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Get environment paths currently in use by running kernels.
    pub async fn active_env_paths(&self) -> Result<Vec<std::path::PathBuf>, ClientError> {
        let response = self.send_request(Request::ActiveEnvPaths).await?;
        match response {
            Response::ActiveEnvPaths { paths } => Ok(paths),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Flush all pooled environments and trigger rebuild with current settings.
    pub async fn flush_pool(&self) -> Result<(), ClientError> {
        let response = self.send_request(Request::FlushPool).await?;
        match response {
            Response::Flushed => Ok(()),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Request daemon shutdown.
    pub async fn shutdown(&self) -> Result<(), ClientError> {
        let response = self.send_request(Request::Shutdown).await?;
        match response {
            Response::ShuttingDown => Ok(()),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Inspect a notebook's Automerge state.
    pub async fn inspect_notebook(&self, notebook_id: &str) -> Result<InspectResult, ClientError> {
        let response = self
            .send_request(Request::InspectNotebook {
                notebook_id: notebook_id.to_string(),
            })
            .await?;
        match response {
            Response::NotebookState {
                notebook_id,
                cells,
                outputs_by_cell,
                source,
                kernel_info,
            } => Ok(InspectResult {
                notebook_id,
                cells,
                outputs_by_cell,
                source,
                kernel_info,
            }),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Read the authoritative room projection after initial materialization.
    ///
    /// `response_timeout` bounds the potentially long cold-file load without
    /// widening the socket connect timeout. Canceling this call only drops the
    /// waiter; the daemon-owned materialization continues for other callers.
    pub async fn get_notebook_projection(
        &self,
        notebook_id: &str,
        response_timeout: Duration,
    ) -> Result<crate::protocol::NotebookProjection, ClientError> {
        let response = self
            .send_request_with_response_timeout(
                Request::GetNotebookProjection {
                    notebook_id: notebook_id.to_string(),
                },
                response_timeout,
            )
            .await?;
        match response {
            Response::NotebookProjection { projection } => Ok(projection),
            Response::NotebookProjectionUnavailable {
                notebook_id,
                failure,
            } => Err(ClientError::NotebookProjectionUnavailable {
                notebook_id,
                failure,
            }),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// List all active notebook rooms.
    pub async fn list_rooms(&self) -> Result<Vec<crate::protocol::RoomInfo>, ClientError> {
        let response = self.send_request(Request::ListRooms).await?;
        match response {
            Response::RoomsList { rooms } => Ok(rooms),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Shutdown a notebook's kernel and evict its room.
    ///
    /// Returns `Ok(true)` if the notebook was found and shut down,
    /// `Ok(false)` if no such notebook was open.
    pub async fn shutdown_notebook(&self, notebook_id: &str) -> Result<bool, ClientError> {
        let response = self
            .send_request(Request::ShutdownNotebook {
                notebook_id: notebook_id.to_string(),
            })
            .await?;
        match response {
            Response::NotebookShutdown { found } => Ok(found),
            Response::Error { message } => Err(ClientError::DaemonError(message)),
            _ => Err(ClientError::ProtocolError(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Send a request to the daemon and receive a response.
    ///
    /// The entire request (connect + send + recv) is bounded by a timeout
    /// derived from `connect_timeout` so that a bound-but-not-yet-accepting
    /// socket cannot stall the caller indefinitely.
    async fn send_request(&self, request: Request) -> Result<Response, ClientError> {
        self.send_request_with_response_timeout(request, Duration::from_secs(3))
            .await
    }

    /// Send a request while keeping socket-connect and response budgets
    /// independent. Cold notebook projections can legitimately take much
    /// longer than an ordinary pool request, but a missing daemon socket
    /// should still fail on the short `connect_timeout`.
    async fn send_request_with_response_timeout(
        &self,
        request: Request,
        response_timeout: Duration,
    ) -> Result<Response, ClientError> {
        self.send_request_inner(request, response_timeout).await
    }

    async fn send_request_inner(
        &self,
        request: Request,
        response_timeout: Duration,
    ) -> Result<Response, ClientError> {
        #[cfg(unix)]
        let stream = {
            let connect_result =
                tokio::time::timeout(self.connect_timeout, UnixStream::connect(&self.socket_path))
                    .await;

            match connect_result {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return Err(ClientError::ConnectionFailed(e)),
                Err(_) => return Err(ClientError::Timeout),
            }
        };

        #[cfg(windows)]
        let stream = {
            match notebook_protocol::connection::connect_named_pipe_client(
                &self.socket_path,
                self.connect_timeout,
            )
            .await
            {
                Ok(s) => s,
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    return Err(ClientError::Timeout);
                }
                Err(e) => return Err(ClientError::ConnectionFailed(e)),
            }
        };

        tokio::time::timeout(
            response_timeout,
            self.send_request_on_stream(stream, request),
        )
        .await
        .map_err(|_| ClientError::Timeout)?
    }

    /// Send a request on an established stream.
    async fn send_request_on_stream<S>(
        &self,
        mut stream: S,
        request: Request,
    ) -> Result<Response, ClientError>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        // Send preamble (magic bytes + protocol version)
        connection::send_preamble(&mut stream)
            .await
            .map_err(|e| ClientError::ProtocolError(format!("preamble: {}", e)))?;

        // Send the channel handshake
        connection::send_json_frame(&mut stream, &Handshake::Pool)
            .await
            .map_err(|e| ClientError::ProtocolError(format!("handshake: {}", e)))?;

        // Send the request as a framed JSON message
        connection::send_json_frame(&mut stream, &request)
            .await
            .map_err(|e| ClientError::ProtocolError(format!("send: {}", e)))?;

        // Read the response
        connection::recv_json_frame::<_, Response>(&mut stream)
            .await
            .map_err(|e| ClientError::ProtocolError(format!("recv: {}", e)))?
            .ok_or_else(|| ClientError::ProtocolError("connection closed".to_string()))
    }
}

/// Try to get an environment from the daemon, falling back gracefully.
///
/// This is a convenience function that:
/// 1. Tries to connect to the daemon
/// 2. If successful, requests an environment
/// 3. If daemon is unavailable or pool is empty, returns None
///
/// This allows notebook code to optionally use the daemon without requiring it.
pub async fn try_get_pooled_env(env_type: EnvType) -> Option<PooledEnv> {
    let client = PoolClient::default();

    match client.take(env_type).await {
        Ok(Some(env)) => Some(env),
        Ok(None) => {
            info!(
                "[pool-client] Daemon pool empty for {}, will create locally",
                env_type
            );
            None
        }
        Err(e) => {
            warn!(
                "[pool-client] Could not connect to daemon ({:?}), will create locally",
                e
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_default() {
        let client = PoolClient::default();
        #[cfg(unix)]
        assert!(client
            .socket_path
            .to_string_lossy()
            .contains("runtimed.sock"));
        #[cfg(windows)]
        assert!(client.socket_path.to_string_lossy().contains("runtimed"));
    }

    #[test]
    fn test_client_custom_path() {
        let client = PoolClient::new(PathBuf::from("/tmp/test.sock"));
        assert_eq!(client.socket_path, PathBuf::from("/tmp/test.sock"));
    }
}
