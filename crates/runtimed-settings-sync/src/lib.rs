//! Client for the Automerge settings sync service.
//!
//! Each notebook window creates a `SyncClient` that maintains a local
//! Automerge document replica. Changes made locally are sent to the daemon,
//! and changes from other peers arrive as sync messages.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::path::PathBuf;
use std::time::Duration;

use automerge::sync::{self, SyncDoc};
use automerge::transaction::Transactable;
use automerge::{AutoCommit, ChangeHash, ObjType, ReadDoc};
use log::info;
use tokio::io::{AsyncRead, AsyncWrite};

use notebook_protocol::connection::{self, Handshake};
use runtimed_client::settings_doc::{
    default_pool_sizes_for_python_env, read_nested_list, split_comma_list, ColorTheme,
    CondaDefaults, PixiDefaults, SyncedSettings, ThemeMode, UvDefaults,
};

/// Error type for sync client operations.
#[derive(Debug, thiserror::Error)]
pub enum SyncClientError {
    #[error("Failed to connect: {0}")]
    ConnectionFailed(#[from] std::io::Error),

    #[error("Sync protocol error: {0}")]
    SyncError(String),

    #[error("Connection timeout")]
    Timeout,

    #[error("Disconnected")]
    Disconnected,
}

/// Client for the Automerge settings sync service.
///
/// Holds a local Automerge document replica that stays in sync with the
/// daemon's live copy via the Automerge sync protocol.
pub struct SyncClient<S> {
    doc: AutoCommit,
    peer_state: sync::State,
    stream: S,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InitialSyncMode {
    /// Drain all immediately available sync rounds before returning.
    ///
    /// This is the right mode for long-lived subscribers because the client is
    /// about to wait for future changes on the same connection.
    Watch,
    /// Return once the client has the daemon's advertised settings heads.
    ///
    /// This is the right mode for one-shot command paths. Automerge may need a
    /// short heads/need exchange before sending changes, but once the advertised
    /// heads are present locally, waiting for receive quiescence only adds a
    /// fixed latency tax.
    Snapshot { deadline: tokio::time::Instant },
}

enum TimedSyncFrame {
    Received(Vec<ChangeHash>),
    TimedOut,
}

#[cfg(unix)]
impl SyncClient<tokio::net::UnixStream> {
    /// Connect to the daemon's unified socket and perform initial sync.
    pub async fn connect(socket_path: PathBuf) -> Result<Self, SyncClientError> {
        Self::connect_with_timeout(socket_path, Duration::from_secs(2)).await
    }

    /// Connect with a custom timeout.
    pub async fn connect_with_timeout(
        socket_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, SyncClientError> {
        let stream = tokio::time::timeout(timeout, tokio::net::UnixStream::connect(&socket_path))
            .await
            .map_err(|_| SyncClientError::Timeout)?
            .map_err(SyncClientError::ConnectionFailed)?;

        info!("[sync-client] Connected to {:?}", socket_path);

        Self::init(stream, InitialSyncMode::Watch).await
    }

    /// Connect to the daemon and read the current settings snapshot.
    ///
    /// Unlike [`connect`](Self::connect), this does not wait for an initial
    /// receive timeout to infer that the live sync stream is quiet. Use it for
    /// one-shot reads/writes; use `connect` for long-lived watchers.
    pub async fn connect_snapshot(socket_path: PathBuf) -> Result<Self, SyncClientError> {
        Self::connect_snapshot_with_timeout(socket_path, Duration::from_secs(2)).await
    }

    /// Connect to the daemon and read the current settings snapshot with a
    /// custom socket-connect and snapshot-sync timeout.
    pub async fn connect_snapshot_with_timeout(
        socket_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, SyncClientError> {
        let deadline = snapshot_deadline(timeout);
        let stream = tokio::time::timeout(
            remaining_snapshot_timeout(deadline)?,
            tokio::net::UnixStream::connect(&socket_path),
        )
        .await
        .map_err(|_| SyncClientError::Timeout)?
        .map_err(SyncClientError::ConnectionFailed)?;

        info!("[sync-client] Connected to {:?}", socket_path);

        Self::init(stream, InitialSyncMode::Snapshot { deadline }).await
    }
}

#[cfg(windows)]
impl SyncClient<tokio::net::windows::named_pipe::NamedPipeClient> {
    /// Connect to the daemon's unified socket and perform initial sync.
    pub async fn connect(socket_path: PathBuf) -> Result<Self, SyncClientError> {
        Self::connect_with_timeout(socket_path, Duration::from_secs(2)).await
    }

    /// Connect with a custom timeout, retrying on transient pipe-busy errors.
    pub async fn connect_with_timeout(
        socket_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, SyncClientError> {
        let pipe_name = socket_path.to_string_lossy().to_string();
        let client = connection::connect_named_pipe_client(&socket_path, timeout)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::TimedOut => SyncClientError::Timeout,
                _ => SyncClientError::ConnectionFailed(error),
            })?;

        info!("[sync-client] Connected to {}", pipe_name);

        Self::init(client, InitialSyncMode::Watch).await
    }

    /// Connect to the daemon and read the current settings snapshot.
    ///
    /// Unlike [`connect`](Self::connect), this does not wait for an initial
    /// receive timeout to infer that the live sync stream is quiet. Use it for
    /// one-shot reads/writes; use `connect` for long-lived watchers.
    pub async fn connect_snapshot(socket_path: PathBuf) -> Result<Self, SyncClientError> {
        Self::connect_snapshot_with_timeout(socket_path, Duration::from_secs(2)).await
    }

    /// Connect to the daemon and read the current settings snapshot with a
    /// custom socket-connect and snapshot-sync timeout.
    pub async fn connect_snapshot_with_timeout(
        socket_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, SyncClientError> {
        let deadline = snapshot_deadline(timeout);
        let pipe_name = socket_path.to_string_lossy().to_string();
        let client = connection::connect_named_pipe_client(
            &socket_path,
            remaining_snapshot_timeout(deadline)?,
        )
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::TimedOut => SyncClientError::Timeout,
            _ => SyncClientError::ConnectionFailed(error),
        })?;

        info!("[sync-client] Connected to {}", pipe_name);

        Self::init(client, InitialSyncMode::Snapshot { deadline }).await
    }
}

impl<S> SyncClient<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// Initialize the client by sending the handshake and performing
    /// the initial sync exchange.
    async fn init(mut stream: S, mode: InitialSyncMode) -> Result<Self, SyncClientError> {
        // Send preamble (magic bytes + protocol version)
        connection::send_preamble(&mut stream)
            .await
            .map_err(|e| SyncClientError::SyncError(format!("preamble: {}", e)))?;

        // Send the channel handshake so the daemon routes us to settings sync
        connection::send_json_frame(&mut stream, &Handshake::SettingsSync)
            .await
            .map_err(|e| SyncClientError::SyncError(format!("handshake: {}", e)))?;

        let mut doc = AutoCommit::new();
        let mut peer_state = sync::State::new();

        match mode {
            InitialSyncMode::Snapshot { deadline } => {
                let mut server_heads = Self::receive_sync_frame_before(
                    &mut stream,
                    &mut doc,
                    &mut peer_state,
                    remaining_snapshot_timeout(deadline)?,
                )
                .await?
                .ok_or_timeout()?;

                while !has_heads(&mut doc, &server_heads) {
                    server_heads = Self::receive_sync_frame_before(
                        &mut stream,
                        &mut doc,
                        &mut peer_state,
                        remaining_snapshot_timeout(deadline)?,
                    )
                    .await?
                    .ok_or_timeout()?;
                }
            }
            InitialSyncMode::Watch => {
                // The server sends first -- receive and apply.
                Self::receive_sync_frame(&mut stream, &mut doc, &mut peer_state).await?;

                // There might be more rounds needed -- keep going until no more messages.
                // Try to receive with a short timeout (the server may not have more to say).
                while let TimedSyncFrame::Received(_) = Self::receive_sync_frame_before(
                    &mut stream,
                    &mut doc,
                    &mut peer_state,
                    Duration::from_millis(100),
                )
                .await?
                {
                    // Drain initial sync frames until the short receive timeout
                    // indicates quiescence. Protocol errors still return above.
                }
            }
        }

        let settings = get_all_from_doc(&doc);
        info!(
            "[sync-client] Initial sync complete ({:?}): {:?}",
            mode, settings
        );

        Ok(Self {
            doc,
            peer_state,
            stream,
        })
    }

    async fn receive_sync_frame(
        stream: &mut S,
        doc: &mut AutoCommit,
        peer_state: &mut sync::State,
    ) -> Result<Vec<ChangeHash>, SyncClientError> {
        match connection::recv_frame(stream).await? {
            Some(data) => {
                let message = sync::Message::decode(&data)
                    .map_err(|e| SyncClientError::SyncError(format!("decode: {}", e)))?;
                let server_heads = message.heads.clone();
                doc.sync()
                    .receive_sync_message(peer_state, message)
                    .map_err(|e| SyncClientError::SyncError(format!("receive: {}", e)))?;

                if let Some(msg) = doc.sync().generate_sync_message(peer_state) {
                    connection::send_frame(stream, &msg.encode()).await?;
                }

                Ok(server_heads)
            }
            None => Err(SyncClientError::Disconnected),
        }
    }

    async fn receive_sync_frame_before(
        stream: &mut S,
        doc: &mut AutoCommit,
        peer_state: &mut sync::State,
        timeout: Duration,
    ) -> Result<TimedSyncFrame, SyncClientError> {
        match tokio::time::timeout(timeout, Self::receive_sync_frame(stream, doc, peer_state)).await
        {
            Ok(frame) => frame.map(TimedSyncFrame::Received),
            Err(_) => Ok(TimedSyncFrame::TimedOut),
        }
    }

    /// Get a snapshot of all settings from the local replica.
    pub fn get_all(&self) -> SyncedSettings {
        get_all_from_doc(&self.doc)
    }

    /// Consume the client and return the local Automerge document.
    ///
    /// This is useful when you want to keep the synced settings doc
    /// without maintaining the network connection.
    pub fn into_doc(self) -> AutoCommit {
        self.doc
    }

    /// Get a single scalar setting value.
    pub fn get(&self, key: &str) -> Option<String> {
        self.doc
            .get(automerge::ROOT, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                automerge::Value::Scalar(s) => match s.as_ref() {
                    automerge::ScalarValue::Str(s) => Some(s.to_string()),
                    _ => None,
                },
                _ => None,
            })
    }

    /// Update a scalar setting and sync the change to the daemon.
    pub async fn put(&mut self, key: &str, value: &str) -> Result<(), SyncClientError> {
        if let Some((map_key, sub_key)) = key.split_once('.') {
            let map_id = self.ensure_map(map_key)?;
            self.doc
                .put(&map_id, sub_key, value)
                .map_err(|e| SyncClientError::SyncError(format!("put nested: {}", e)))?;
        } else {
            self.doc
                .put(automerge::ROOT, key, value)
                .map_err(|e| SyncClientError::SyncError(format!("put: {}", e)))?;
        }

        self.sync_to_daemon().await
    }

    /// Update a setting from a `serde_json::Value` and sync the change.
    ///
    /// Dispatches to scalar `put` for strings or list replacement for arrays.
    pub async fn put_value(
        &mut self,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), SyncClientError> {
        match value {
            serde_json::Value::String(s) => {
                // Scalar write -- delegate to put which handles dotted paths
                if let Some((map_key, sub_key)) = key.split_once('.') {
                    let map_id = self.ensure_map(map_key)?;
                    self.doc
                        .put(&map_id, sub_key, s.as_str())
                        .map_err(|e| SyncClientError::SyncError(format!("put nested: {}", e)))?;
                } else {
                    self.doc
                        .put(automerge::ROOT, key, s.as_str())
                        .map_err(|e| SyncClientError::SyncError(format!("put: {}", e)))?;
                }
            }
            serde_json::Value::Array(arr) => {
                let items: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                self.put_list(key, &items)?;
            }
            serde_json::Value::Number(n) => {
                if let Some(u) = n.as_u64() {
                    // Store as i64 since Automerge's Int is more widely supported
                    self.doc
                        .put(automerge::ROOT, key, u as i64)
                        .map_err(|e| SyncClientError::SyncError(format!("put u64: {}", e)))?;
                }
            }
            serde_json::Value::Bool(b) => {
                if let Some((map_key, sub_key)) = key.split_once('.') {
                    let map_id = self.ensure_map(map_key)?;
                    self.doc.put(&map_id, sub_key, *b).map_err(|e| {
                        SyncClientError::SyncError(format!("put nested bool: {}", e))
                    })?;
                } else {
                    self.doc
                        .put(automerge::ROOT, key, *b)
                        .map_err(|e| SyncClientError::SyncError(format!("put bool: {}", e)))?;
                }
            }
            _ => {}
        }

        self.sync_to_daemon().await
    }

    /// Replace a list at a dotted path in the local Automerge doc.
    fn put_list(&mut self, key: &str, values: &[String]) -> Result<(), SyncClientError> {
        let (map_key, sub_key) = key
            .split_once('.')
            .ok_or_else(|| SyncClientError::SyncError("list key must be dotted".into()))?;

        let map_id = self.ensure_map(map_key)?;

        // Delete existing value
        let _ = self.doc.delete(&map_id, sub_key);

        // Create new list
        let list_id = self
            .doc
            .put_object(&map_id, sub_key, ObjType::List)
            .map_err(|e| SyncClientError::SyncError(format!("put_object list: {}", e)))?;

        for (i, item) in values.iter().enumerate() {
            self.doc
                .insert(&list_id, i, item.as_str())
                .map_err(|e| SyncClientError::SyncError(format!("insert: {}", e)))?;
        }

        Ok(())
    }

    /// Get or create a nested Map at ROOT.
    fn ensure_map(&mut self, map_key: &str) -> Result<automerge::ObjId, SyncClientError> {
        // Check if map already exists
        if let Some((automerge::Value::Object(ObjType::Map), id)) =
            self.doc.get(automerge::ROOT, map_key).ok().flatten()
        {
            return Ok(id);
        }

        // Create it
        self.doc
            .put_object(automerge::ROOT, map_key, ObjType::Map)
            .map_err(|e| SyncClientError::SyncError(format!("put_object map: {}", e)))
    }

    /// Generate and send sync message to daemon.
    async fn sync_to_daemon(&mut self) -> Result<(), SyncClientError> {
        if let Some(msg) = self.doc.sync().generate_sync_message(&mut self.peer_state) {
            connection::send_frame(&mut self.stream, &msg.encode()).await?;
        }
        Ok(())
    }

    /// Wait for the next settings change from the daemon.
    ///
    /// Blocks until a sync message arrives, applies it, and returns the
    /// updated settings snapshot.
    pub async fn recv_changes(&mut self) -> Result<SyncedSettings, SyncClientError> {
        match connection::recv_frame(&mut self.stream).await? {
            Some(data) => {
                let message = sync::Message::decode(&data)
                    .map_err(|e| SyncClientError::SyncError(format!("decode: {}", e)))?;
                self.doc
                    .sync()
                    .receive_sync_message(&mut self.peer_state, message)
                    .map_err(|e| SyncClientError::SyncError(format!("receive: {}", e)))?;

                // Send ack if needed
                if let Some(msg) = self.doc.sync().generate_sync_message(&mut self.peer_state) {
                    connection::send_frame(&mut self.stream, &msg.encode()).await?;
                }

                Ok(self.get_all())
            }
            None => Err(SyncClientError::Disconnected),
        }
    }
}

impl TimedSyncFrame {
    fn ok_or_timeout(self) -> Result<Vec<ChangeHash>, SyncClientError> {
        match self {
            TimedSyncFrame::Received(heads) => Ok(heads),
            TimedSyncFrame::TimedOut => Err(SyncClientError::Timeout),
        }
    }
}

fn has_heads(doc: &mut AutoCommit, heads: &[ChangeHash]) -> bool {
    if heads.is_empty() {
        return false;
    }
    heads
        .iter()
        .all(|head| doc.get_change_by_hash(head).is_some())
}

fn snapshot_deadline(timeout: Duration) -> tokio::time::Instant {
    tokio::time::Instant::now() + timeout
}

fn remaining_snapshot_timeout(deadline: tokio::time::Instant) -> Result<Duration, SyncClientError> {
    deadline
        .checked_duration_since(tokio::time::Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(SyncClientError::Timeout)
}

/// Extract all settings from an Automerge document.
///
/// Reads nested maps/lists first, falling back to old flat keys for
/// backward compatibility during upgrades.
pub fn get_all_from_doc(doc: &AutoCommit) -> SyncedSettings {
    let defaults = SyncedSettings::default();

    let get_str = |key: &str| -> Option<String> {
        doc.get(automerge::ROOT, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                automerge::Value::Scalar(s) => match s.as_ref() {
                    automerge::ScalarValue::Str(s) => Some(s.to_string()),
                    _ => None,
                },
                _ => None,
            })
    };

    // Get a u64 value from the doc
    let get_u64 = |key: &str| -> Option<u64> {
        match doc.get(automerge::ROOT, key).ok().flatten() {
            Some((automerge::Value::Scalar(s), _)) => match s.as_ref() {
                automerge::ScalarValue::Int(i) => u64::try_from(*i).ok(),
                automerge::ScalarValue::Uint(u) => Some(*u),
                automerge::ScalarValue::Str(s) => s.parse().ok(),
                _ => None,
            },
            _ => None,
        }
    };

    // Get a bool value from the doc
    let get_bool = |key: &str| -> Option<bool> {
        match doc.get(automerge::ROOT, key).ok().flatten() {
            Some((automerge::Value::Scalar(s), _)) => match s.as_ref() {
                automerge::ScalarValue::Boolean(b) => Some(*b),
                _ => None,
            },
            _ => None,
        }
    };

    // Read uv packages: try nested list, fall back to flat comma string
    let uv_packages = {
        let nested = read_nested_list(doc, "uv", "default_packages");
        if !nested.is_empty() {
            nested
        } else if let Some(flat) = get_str("default_uv_packages") {
            split_comma_list(&flat)
        } else {
            defaults.uv.default_packages.clone()
        }
    };

    // Read conda packages: try nested list, fall back to flat comma string
    let conda_packages = {
        let nested = read_nested_list(doc, "conda", "default_packages");
        if !nested.is_empty() {
            nested
        } else if let Some(flat) = get_str("default_conda_packages") {
            split_comma_list(&flat)
        } else {
            defaults.conda.default_packages.clone()
        }
    };

    let default_python_env = get_str("default_python_env")
        .and_then(|s| s.parse().ok())
        .unwrap_or_default();
    let pool_sizes = default_pool_sizes_for_python_env(&default_python_env);

    SyncedSettings {
        theme: get_str("theme")
            .and_then(|s| serde_json::from_str::<ThemeMode>(&format!("\"{s}\"")).ok())
            .unwrap_or(defaults.theme),
        color_theme: get_str("color_theme")
            .and_then(|s| serde_json::from_str::<ColorTheme>(&format!("\"{s}\"")).ok())
            .unwrap_or(defaults.color_theme),
        default_runtime: get_str("default_runtime")
            .and_then(|s| s.parse().ok())
            .unwrap_or_default(),
        default_python_env,
        uv: UvDefaults {
            default_packages: uv_packages,
        },
        conda: CondaDefaults {
            default_packages: conda_packages,
        },
        pixi: PixiDefaults {
            default_packages: read_nested_list(doc, "pixi", "default_packages"),
        },
        keep_alive_secs: get_u64("keep_alive_secs").unwrap_or(defaults.keep_alive_secs),
        // For existing users: if onboarding_completed is missing but other settings exist,
        // assume they're upgrading from before onboarding was added → treat as completed
        onboarding_completed: get_bool("onboarding_completed")
            .unwrap_or_else(|| get_str("theme").is_some() || get_str("default_runtime").is_some()),
        uv_pool_size: get_u64("uv_pool_size").unwrap_or(pool_sizes.uv_pool_size),
        conda_pool_size: get_u64("conda_pool_size").unwrap_or(pool_sizes.conda_pool_size),
        pixi_pool_size: get_u64("pixi_pool_size").unwrap_or(pool_sizes.pixi_pool_size),
        install_default_data_packages: get_bool("install_default_data_packages")
            .unwrap_or(defaults.install_default_data_packages),
        disable_nteract_launcher: get_bool("disable_nteract_launcher")
            .unwrap_or(defaults.disable_nteract_launcher),
        redact_env_values_in_outputs: get_bool("redact_env_values_in_outputs")
            .unwrap_or(defaults.redact_env_values_in_outputs),
        import_shell_environment: get_bool("import_shell_environment")
            .unwrap_or(defaults.import_shell_environment),
        install_id: get_str("install_id").unwrap_or_default(),
        telemetry_enabled: get_bool("telemetry_enabled").unwrap_or(true),
        telemetry_consent_recorded: get_bool("telemetry_consent_recorded").unwrap_or(false),
        telemetry_last_daemon_ping_at: get_u64("telemetry_last_daemon_ping_at"),
        telemetry_last_app_ping_at: get_u64("telemetry_last_app_ping_at"),
        telemetry_last_mcp_ping_at: get_u64("telemetry_last_mcp_ping_at"),
    }
}

/// Try to connect to the sync daemon and get current settings.
///
/// Returns an error if the daemon is unavailable. Callers should
/// fall back to their own local state (e.g. localStorage) on error
/// rather than silently adopting defaults.
pub async fn try_get_synced_settings() -> Result<SyncedSettings, SyncClientError> {
    #[cfg(unix)]
    {
        let client = SyncClient::connect_snapshot(runt_workspace::default_socket_path()).await?;
        let settings = client.get_all();
        info!("[sync-client] Got settings from daemon: {:?}", settings);
        Ok(settings)
    }

    #[cfg(windows)]
    {
        let client = SyncClient::connect_snapshot(runt_workspace::default_socket_path()).await?;
        let settings = client.get_all();
        info!("[sync-client] Got settings from daemon: {:?}", settings);
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::transaction::Transactable;
    use notebook_protocol::connection::{self, Handshake};
    use runtimed_client::runtime::Runtime;
    use runtimed_client::settings_doc::{PythonEnvType, SettingsDoc, ThemeMode};

    async fn accept_settings_handshake(stream: &mut tokio::io::DuplexStream) {
        connection::recv_preamble(stream)
            .await
            .expect("client preamble");
        let handshake: Handshake = connection::recv_json_frame(stream)
            .await
            .expect("handshake frame")
            .expect("handshake should not eof");
        assert!(matches!(handshake, Handshake::SettingsSync));
    }

    async fn apply_next_client_frame(
        stream: &mut tokio::io::DuplexStream,
        doc: &mut SettingsDoc,
        peer_state: &mut sync::State,
    ) {
        let data = connection::recv_frame(stream)
            .await
            .expect("client response frame")
            .expect("client response should not eof");
        let message = sync::Message::decode(&data).expect("decode client response");
        doc.receive_sync_message(peer_state, message)
            .expect("apply client response");
    }

    async fn send_next_server_frame(
        stream: &mut tokio::io::DuplexStream,
        doc: &mut SettingsDoc,
        peer_state: &mut sync::State,
    ) {
        let msg = doc
            .generate_sync_message(peer_state)
            .expect("server should generate settings sync frame");
        connection::send_frame(stream, &msg.encode())
            .await
            .expect("send settings sync frame");
    }

    async fn serve_initial_settings_snapshot(
        mut stream: tokio::io::DuplexStream,
        settings: SyncedSettings,
        keep_open_for: Duration,
    ) {
        accept_settings_handshake(&mut stream).await;

        let mut doc = SettingsDoc::from_synced_settings(&settings);
        let mut peer_state = sync::State::new();
        send_next_server_frame(&mut stream, &mut doc, &mut peer_state).await;
        apply_next_client_frame(&mut stream, &mut doc, &mut peer_state).await;
        if let Some(reply) = doc.generate_sync_message(&mut peer_state) {
            connection::send_frame(&mut stream, &reply.encode())
                .await
                .expect("send requested settings changes");
        }

        // Keep the stream open without sending more frames. Snapshot clients
        // should return immediately; watch clients infer quiescence by waiting.
        tokio::time::sleep(keep_open_for).await;
    }

    async fn serve_stalled_settings_connection(mut stream: tokio::io::DuplexStream) {
        accept_settings_handshake(&mut stream).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    #[tokio::test]
    async fn snapshot_initial_sync_returns_without_quiescence_wait() {
        let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
        let expected = SyncedSettings {
            theme: ThemeMode::Dark,
            ..SyncedSettings::default()
        };
        let server = tokio::spawn(serve_initial_settings_snapshot(
            server_stream,
            expected.clone(),
            Duration::from_millis(200),
        ));

        let client = tokio::time::timeout(
            Duration::from_millis(50),
            SyncClient::init(
                client_stream,
                InitialSyncMode::Snapshot {
                    deadline: snapshot_deadline(Duration::from_secs(1)),
                },
            ),
        )
        .await
        .expect("snapshot sync should not wait for receive quiescence")
        .expect("snapshot sync should succeed");

        assert_eq!(client.get_all().theme, expected.theme);
        server.abort();
    }

    #[tokio::test]
    async fn snapshot_initial_sync_times_out_when_server_stalls() {
        let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(serve_stalled_settings_connection(server_stream));

        let error = SyncClient::init(
            client_stream,
            InitialSyncMode::Snapshot {
                deadline: snapshot_deadline(Duration::from_millis(25)),
            },
        )
        .await
        .err()
        .expect("stalled snapshot sync should time out");

        assert!(matches!(error, SyncClientError::Timeout));
        server.abort();
    }

    #[test]
    fn empty_advertised_heads_do_not_complete_snapshot_sync() {
        let mut doc = AutoCommit::new();
        assert!(!has_heads(&mut doc, &[]));
    }

    #[tokio::test]
    async fn watch_initial_sync_waits_for_quiescence() {
        let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(serve_initial_settings_snapshot(
            server_stream,
            SyncedSettings::default(),
            Duration::from_millis(200),
        ));

        let result = tokio::time::timeout(
            Duration::from_millis(50),
            SyncClient::init(client_stream, InitialSyncMode::Watch),
        )
        .await;

        assert!(
            result.is_err(),
            "watch sync should keep waiting for possible initial sync frames"
        );
        server.abort();
    }

    #[test]
    fn test_get_all_from_empty_doc() {
        let doc = AutoCommit::new();
        let settings = get_all_from_doc(&doc);
        assert_eq!(settings, SyncedSettings::default());
    }

    #[test]
    fn test_get_all_from_populated_doc() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "theme", "dark").unwrap();
        doc.put(automerge::ROOT, "default_runtime", "deno").unwrap();
        doc.put(automerge::ROOT, "default_python_env", "conda")
            .unwrap();

        let settings = get_all_from_doc(&doc);
        assert_eq!(settings.theme, ThemeMode::Dark);
        assert_eq!(settings.default_runtime, Runtime::Deno);
        assert_eq!(settings.default_python_env, PythonEnvType::Conda);
    }

    #[test]
    fn test_get_all_reads_disable_nteract_launcher() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "disable_nteract_launcher", true)
            .unwrap();

        let settings = get_all_from_doc(&doc);
        assert!(settings.disable_nteract_launcher);
        assert!(!settings.feature_flags().bootstrap_dx);
    }

    #[test]
    fn test_get_all_pool_defaults_follow_selected_python_env() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "default_python_env", "pixi")
            .unwrap();

        let settings = get_all_from_doc(&doc);
        assert_eq!(settings.uv_pool_size, 1);
        assert_eq!(settings.conda_pool_size, 1);
        assert_eq!(settings.pixi_pool_size, 2);
    }

    #[test]
    fn test_get_all_reads_nested_lists() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "theme", "system").unwrap();
        doc.put(automerge::ROOT, "default_runtime", "python")
            .unwrap();
        doc.put(automerge::ROOT, "default_python_env", "uv")
            .unwrap();

        // Create nested uv map with package list
        let uv_id = doc.put_object(automerge::ROOT, "uv", ObjType::Map).unwrap();
        let uv_pkgs_id = doc
            .put_object(&uv_id, "default_packages", ObjType::List)
            .unwrap();
        doc.insert(&uv_pkgs_id, 0, "numpy").unwrap();
        doc.insert(&uv_pkgs_id, 1, "pandas").unwrap();

        let settings = get_all_from_doc(&doc);
        assert_eq!(settings.uv.default_packages, vec!["numpy", "pandas"]);
    }

    #[test]
    fn test_get_all_falls_back_to_flat_comma_string() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "theme", "system").unwrap();
        doc.put(automerge::ROOT, "default_runtime", "python")
            .unwrap();
        doc.put(automerge::ROOT, "default_python_env", "uv")
            .unwrap();
        // Old flat format
        doc.put(automerge::ROOT, "default_uv_packages", "numpy, scipy")
            .unwrap();

        let settings = get_all_from_doc(&doc);
        assert_eq!(settings.uv.default_packages, vec!["numpy", "scipy"]);
    }

    #[test]
    fn test_get_all_reads_onboarding_completed_bool() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "onboarding_completed", true)
            .unwrap();

        let settings = get_all_from_doc(&doc);
        assert!(settings.onboarding_completed);
    }

    #[test]
    fn test_get_all_onboarding_defaults_false_for_fresh_install() {
        // Fresh install: no settings at all
        let doc = AutoCommit::new();
        let settings = get_all_from_doc(&doc);
        // Should be false because no other settings exist
        assert!(!settings.onboarding_completed);
    }

    #[test]
    fn test_get_all_onboarding_defaults_true_for_existing_user() {
        // Existing user: has theme but no onboarding_completed
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "theme", "dark").unwrap();

        let settings = get_all_from_doc(&doc);
        // Should be true because theme exists (migration scenario)
        assert!(settings.onboarding_completed);
    }
}
