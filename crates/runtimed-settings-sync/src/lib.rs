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
    CondaDefaults, EditorSettings, PixiDefaults, SyncedSettings, ThemeMode, UvDefaults,
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
    stream: Option<S>,
    confirm_writes: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InitialSyncMode {
    /// Return a live subscriber once the daemon's advertised heads are present.
    Watch { deadline: tokio::time::Instant },
    /// Return a snapshot once the daemon's advertised heads are present.
    Snapshot { deadline: tokio::time::Instant },
}

#[cfg(unix)]
impl SyncClient<tokio::net::UnixStream> {
    /// Connect to the daemon's unified socket and perform initial sync.
    pub async fn connect(socket_path: PathBuf) -> Result<Self, SyncClientError> {
        Self::connect_with_timeout(socket_path, Duration::from_secs(2)).await
    }

    /// Connect with a deadline covering socket connection and initial sync.
    pub async fn connect_with_timeout(
        socket_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, SyncClientError> {
        let deadline = sync_deadline(timeout);
        let stream =
            tokio::time::timeout_at(deadline, tokio::net::UnixStream::connect(&socket_path))
                .await
                .map_err(|_| SyncClientError::Timeout)?
                .map_err(SyncClientError::ConnectionFailed)?;

        info!("[sync-client] Connected to {:?}", socket_path);

        Self::init(stream, InitialSyncMode::Watch { deadline }).await
    }

    /// Connect to the daemon and read the current settings snapshot.
    ///
    /// Both snapshot and watch connections wait for the daemon's advertised
    /// heads. Use this for one-shot reads/writes and `connect` for subscribers.
    /// Snapshot writes wait up to two seconds for the daemon to confirm their
    /// document heads. On error or cancellation the connection is discarded.
    pub async fn connect_snapshot(socket_path: PathBuf) -> Result<Self, SyncClientError> {
        Self::connect_snapshot_with_timeout(socket_path, Duration::from_secs(2)).await
    }

    /// Connect to the daemon and read the current settings snapshot with a
    /// custom socket-connect and snapshot-sync timeout. This timeout applies
    /// only to initialization; each write has its own two-second deadline.
    pub async fn connect_snapshot_with_timeout(
        socket_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, SyncClientError> {
        let deadline = sync_deadline(timeout);
        let stream = tokio::time::timeout(
            remaining_sync_timeout(deadline)?,
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
        let deadline = sync_deadline(timeout);
        let pipe_name = socket_path.to_string_lossy().to_string();
        let client =
            connection::connect_named_pipe_client(&socket_path, remaining_sync_timeout(deadline)?)
                .await
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::TimedOut => SyncClientError::Timeout,
                    _ => SyncClientError::ConnectionFailed(error),
                })?;

        info!("[sync-client] Connected to {}", pipe_name);

        Self::init(client, InitialSyncMode::Watch { deadline }).await
    }

    /// Connect to the daemon and read the current settings snapshot.
    ///
    /// Both snapshot and watch connections wait for the daemon's advertised
    /// heads. Use this for one-shot reads/writes and `connect` for subscribers.
    /// Snapshot writes wait up to two seconds for the daemon to confirm their
    /// document heads. On error or cancellation the connection is discarded.
    pub async fn connect_snapshot(socket_path: PathBuf) -> Result<Self, SyncClientError> {
        Self::connect_snapshot_with_timeout(socket_path, Duration::from_secs(2)).await
    }

    /// Connect to the daemon and read the current settings snapshot with a
    /// custom socket-connect and snapshot-sync timeout. This timeout applies
    /// only to initialization; each write has its own two-second deadline.
    pub async fn connect_snapshot_with_timeout(
        socket_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, SyncClientError> {
        let deadline = sync_deadline(timeout);
        let pipe_name = socket_path.to_string_lossy().to_string();
        let client =
            connection::connect_named_pipe_client(&socket_path, remaining_sync_timeout(deadline)?)
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
        let deadline = match mode {
            InitialSyncMode::Watch { deadline } | InitialSyncMode::Snapshot { deadline } => {
                deadline
            }
        };
        // A timeout is terminal: this future owns the stream, so any partially
        // read/written frame is discarded with the connection, never reused.
        tokio::time::timeout_at(deadline, async move {
            connection::send_preamble(&mut stream)
                .await
                .map_err(|e| SyncClientError::SyncError(format!("preamble: {}", e)))?;
            connection::send_json_frame(&mut stream, &Handshake::SettingsSync)
                .await
                .map_err(|e| SyncClientError::SyncError(format!("handshake: {}", e)))?;

            let mut doc = AutoCommit::new();
            let mut peer_state = sync::State::new();
            loop {
                let server_heads =
                    Self::receive_sync_frame(&mut stream, &mut doc, &mut peer_state).await?;
                if has_heads(&mut doc, &server_heads) {
                    break;
                }
            }
            // Do not probe for quiescence with a timed read: a quiet peer may
            // still owe changes, and cancelling read_exact loses frame bytes.
            info!(
                "[sync-client] Initial sync complete ({:?}): {:?}",
                mode,
                get_all_from_doc(&doc)
            );
            Ok(Self {
                doc,
                peer_state,
                stream: Some(stream),
                confirm_writes: matches!(mode, InitialSyncMode::Snapshot { .. }),
            })
        })
        .await
        .map_err(|_| SyncClientError::Timeout)?
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
    ///
    /// Snapshot clients wait for daemon confirmation (up to two seconds).
    /// Watch clients send immediately and must keep driving `recv_changes`.
    /// For either mode, a failed or cancelled write closes the connection;
    /// discard this client and reconnect before retrying.
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
    /// Snapshot clients wait for daemon confirmation (up to two seconds).
    /// Watch clients send immediately and must keep driving `recv_changes`.
    /// For either mode, a failed or cancelled write closes the connection;
    /// discard this client and reconnect before retrying.
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

    /// Send pending changes; snapshot writers also wait for daemon confirmation.
    async fn sync_to_daemon(&mut self) -> Result<(), SyncClientError> {
        // Own the stream while writing. An error, timeout, or cancellation must
        // close it rather than let a later call reuse a partial frame.
        let mut stream = self.stream.take().ok_or(SyncClientError::Disconnected)?;
        let confirm_writes = self.confirm_writes;
        let exchange = async {
            let Some(msg) = self.doc.sync().generate_sync_message(&mut self.peer_state) else {
                return Ok(());
            };
            connection::send_frame(&mut stream, &msg.encode()).await?;
            if confirm_writes {
                loop {
                    let server_heads =
                        Self::receive_sync_frame(&mut stream, &mut self.doc, &mut self.peer_state)
                            .await?;
                    // A Bloom false positive may require a heads/need round
                    // before the daemon receives our change. Merely sending a
                    // frame is not confirmation, even after initial convergence.
                    if has_heads(&mut self.doc, &server_heads)
                        && self.doc.get_changes(&server_heads).is_empty()
                    {
                        break;
                    }
                }
            }
            Ok(())
        };
        let result = if confirm_writes {
            tokio::time::timeout(Duration::from_secs(2), exchange)
                .await
                .map_err(|_| SyncClientError::Timeout)?
        } else {
            exchange.await
        };
        if result.is_ok() {
            self.stream = Some(stream);
        }
        result
    }

    /// Wait for the next settings change from the daemon.
    ///
    /// Exchanges protocol frames until the document heads change. ACK-only
    /// frames are processed without emitting duplicate settings snapshots.
    /// A new document change is reported even if its resolved values are equal.
    ///
    /// If this future is cancelled, discard the client and reconnect: a frame
    /// read or ACK write may be partial. Initialization timeouts already do this.
    pub async fn recv_changes(&mut self) -> Result<SyncedSettings, SyncClientError> {
        let previous_heads = self.doc.get_heads();
        loop {
            Self::receive_sync_frame(
                self.stream.as_mut().ok_or(SyncClientError::Disconnected)?,
                &mut self.doc,
                &mut self.peer_state,
            )
            .await?;
            if self.doc.get_heads() != previous_heads {
                return Ok(self.get_all());
            }
        }
    }
}

fn has_heads(doc: &mut AutoCommit, heads: &[ChangeHash]) -> bool {
    // SettingsDoc is seeded with defaults; an empty advertisement is not a
    // usable initial settings snapshot for either kind of client.
    if heads.is_empty() {
        return false;
    }
    heads
        .iter()
        .all(|head| doc.get_change_by_hash(head).is_some())
}

fn sync_deadline(timeout: Duration) -> tokio::time::Instant {
    tokio::time::Instant::now() + timeout
}

fn remaining_sync_timeout(deadline: tokio::time::Instant) -> Result<Duration, SyncClientError> {
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

    let get_nested_str = |map_key: &str, sub_key: &str| -> Option<String> {
        let map_id = match doc.get(automerge::ROOT, map_key).ok().flatten() {
            Some((automerge::Value::Object(ObjType::Map), id)) => id,
            _ => return None,
        };
        doc.get(&map_id, sub_key)
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

    let get_nested_bool = |map_key: &str, sub_key: &str| -> Option<bool> {
        let map_id = match doc.get(automerge::ROOT, map_key).ok().flatten() {
            Some((automerge::Value::Object(ObjType::Map), id)) => id,
            _ => return None,
        };
        match doc.get(&map_id, sub_key).ok().flatten() {
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
        editor: EditorSettings {
            code_font_family: get_nested_str("editor", "code_font_family")
                .unwrap_or_else(|| defaults.editor.code_font_family.clone()),
            markdown_font_family: get_nested_str("editor", "markdown_font_family")
                .unwrap_or_else(|| defaults.editor.markdown_font_family.clone()),
            line_numbers: get_nested_bool("editor", "line_numbers")
                .unwrap_or(defaults.editor.line_numbers),
        },
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
        enable_comments: get_bool("enable_comments").unwrap_or(defaults.enable_comments),
        disable_auto_format: get_bool("disable_auto_format")
            .unwrap_or(defaults.disable_auto_format),
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

        // Keep the stream open without sending more frames. Both kinds of
        // client should return as soon as the advertised heads are present.
        tokio::time::sleep(keep_open_for).await;
    }

    async fn serve_stalled_settings_connection(mut stream: tokio::io::DuplexStream) {
        accept_settings_handshake(&mut stream).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    fn test_mode(watch: bool, timeout: Duration) -> InitialSyncMode {
        if watch {
            InitialSyncMode::Watch {
                deadline: sync_deadline(timeout),
            }
        } else {
            InitialSyncMode::Snapshot {
                deadline: sync_deadline(timeout),
            }
        }
    }

    // Exercise both APIs at the same protocol boundary, with no bytes, half a
    // prefix, or a partial body delivered before the old quiescence timeout.
    async fn delayed_initial_sync(watch: bool, split_at: usize) {
        use tokio::io::AsyncWriteExt;
        let (client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
        let expected = SyncedSettings {
            theme: ThemeMode::Light,
            ..SyncedSettings::default()
        };
        let server_settings = expected.clone();
        let mut server = tokio::spawn(async move {
            accept_settings_handshake(&mut server_stream).await;
            let mut doc = SettingsDoc::from_synced_settings(&server_settings);
            let mut peer = sync::State::new();
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
            let msg = doc.generate_sync_message(&mut peer).unwrap().encode();
            let mut frame = (msg.len() as u32).to_be_bytes().to_vec();
            frame.extend_from_slice(&msg);
            server_stream.write_all(&frame[..split_at]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
            server_stream.write_all(&frame[split_at..]).await.unwrap();
            // Protocol rounds can include ACK-only frames. Assert convergence,
            // not a particular number of frames before the client's edit.
            while doc.get_all().theme != ThemeMode::Dark {
                apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
                if let Some(reply) = doc.generate_sync_message(&mut peer) {
                    connection::send_frame(&mut server_stream, &reply.encode())
                        .await
                        .unwrap();
                }
            }
            // Keep the stream alive until the convergence result is observed.
            server_stream
        });
        let mut client = SyncClient::init(client_stream, test_mode(watch, Duration::from_secs(1)))
            .await
            .unwrap();
        assert_eq!(
            client.get_all(),
            expected,
            "initialization must receive the advertised document"
        );
        assert!(!client.doc.get_heads().is_empty());
        client
            .put_value("theme", &serde_json::json!("dark"))
            .await
            .unwrap();
        // put_value sends a sync frame; Automerge may request another round
        // (e.g. a Bloom false positive). Drive the client until the server sees
        // the edit, just as a live peer must. No frame count is assumed.
        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::select! {
                result = &mut server => { result.unwrap(); }
                result = client.recv_changes() => panic!("unexpected server value change: {result:?}"),
            }
        }).await.unwrap();
        // recv_changes was cancelled above; discard this client, never reuse it.
    }

    #[tokio::test(start_paused = true)]
    async fn watch_waits_for_delayed_heads_before_writing() {
        delayed_initial_sync(true, 0).await;
    }

    #[tokio::test(start_paused = true)]
    async fn watch_preserves_fragmented_initial_prefix() {
        delayed_initial_sync(true, 2).await;
    }

    #[tokio::test(start_paused = true)]
    async fn watch_preserves_fragmented_initial_body() {
        delayed_initial_sync(true, 9).await;
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_accepts_slow_and_fragmented_initial_frames() {
        for split_at in [0, 2, 9] {
            delayed_initial_sync(false, split_at).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn initialization_timeout_discards_partial_connection_and_can_reconnect() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for watch in [false, true] {
            for split_at in [0, 2, 9] {
                let (client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
                let server = tokio::spawn(async move {
                    accept_settings_handshake(&mut server_stream).await;
                    let mut doc = SettingsDoc::from_synced_settings(&SyncedSettings::default());
                    let mut peer = sync::State::new();
                    send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
                    apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
                    let msg = doc.generate_sync_message(&mut peer).unwrap().encode();
                    let mut frame = (msg.len() as u32).to_be_bytes().to_vec();
                    frame.extend_from_slice(&msg);
                    server_stream.write_all(&frame[..split_at]).await.unwrap();
                    let mut byte = [0];
                    assert_eq!(
                        server_stream.read(&mut byte).await.unwrap(),
                        0,
                        "timed-out connection must close"
                    );
                });
                let result =
                    SyncClient::init(client_stream, test_mode(watch, Duration::from_millis(50)))
                        .await;
                assert!(matches!(result, Err(SyncClientError::Timeout)));
                tokio::time::timeout(Duration::from_secs(1), server)
                    .await
                    .unwrap()
                    .unwrap();
                // A reconnect gets a fresh stream and peer state.
                delayed_initial_sync(watch, 2).await;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn initialization_deadline_includes_handshake_write() {
        for watch in [false, true] {
            let (client_stream, _server_stream) = tokio::io::duplex(1);
            let result = tokio::time::timeout(
                Duration::from_millis(100),
                SyncClient::init(client_stream, test_mode(watch, Duration::from_millis(50))),
            )
            .await;
            assert!(matches!(result, Ok(Err(SyncClientError::Timeout))));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_initialization_closes_connection_and_can_reconnect() {
        use tokio::io::AsyncReadExt;
        let (client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(async move {
            accept_settings_handshake(&mut server_stream).await;
            let mut byte = [0];
            assert_eq!(server_stream.read(&mut byte).await.unwrap(), 0);
        });
        assert!(tokio::time::timeout(
            Duration::from_millis(25),
            SyncClient::init(client_stream, test_mode(true, Duration::from_secs(1)))
        )
        .await
        .is_err());
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
        delayed_initial_sync(true, 2).await;
    }

    async fn receive_after_ack(theme: ThemeMode) {
        let (client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            accept_settings_handshake(&mut server_stream).await;
            let mut doc = SettingsDoc::from_synced_settings(&SyncedSettings::default());
            let mut peer = sync::State::new();
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
            ready_rx.await.unwrap();
            // An ACK-only frame can arrive after initialization completes.
            let ack = sync::Message {
                heads: doc.heads(),
                need: vec![],
                have: vec![],
                changes: Vec::<Vec<u8>>::new().into(),
                flags: None,
                version: sync::MessageVersion::V1,
            };
            connection::send_frame(&mut server_stream, &ack.encode())
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
            if theme == ThemeMode::System {
                doc.put("test_same_snapshot", "new document change");
            } else {
                doc.put("theme", &theme.to_string());
            }
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
        });
        let mut client = SyncClient::init(client_stream, test_mode(true, Duration::from_secs(1)))
            .await
            .unwrap();
        ready_tx.send(()).unwrap();
        let settings = tokio::time::timeout(Duration::from_secs(1), client.recv_changes())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settings.theme, theme);
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn recv_changes_skips_ack_and_returns_next_value_change() {
        receive_after_ack(ThemeMode::Dark).await;
    }

    #[tokio::test(start_paused = true)]
    async fn recv_changes_reports_new_heads_even_when_values_match() {
        receive_after_ack(ThemeMode::System).await;
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_write_answers_need_after_bloom_false_positive() {
        let (client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(async move {
            accept_settings_handshake(&mut server_stream).await;
            let mut doc = SettingsDoc::from_synced_settings(&SyncedSettings::default());
            let mut peer = sync::State::new();
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            let mut requested_change = false;
            while doc.get_all().theme != ThemeMode::Dark {
                apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
                if let Some(reply) = doc.generate_sync_message(&mut peer) {
                    requested_change |= !reply.need.is_empty();
                    connection::send_frame(&mut server_stream, &reply.encode())
                        .await
                        .unwrap();
                }
            }
            assert!(
                requested_change,
                "server must request the falsely advertised change"
            );
            server_stream
        });
        let mut client = SyncClient::init(client_stream, test_mode(false, Duration::from_secs(1)))
            .await
            .unwrap();
        client.doc.put(automerge::ROOT, "theme", "dark").unwrap();
        let hashes: Vec<_> = client
            .doc
            .get_changes(&[])
            .iter()
            .map(|change| change.hash())
            .collect();
        // Model a Bloom false positive deterministically. The daemon has not
        // seen this edit, but its advertised filter appears to contain it.
        client.peer_state.their_have.as_mut().unwrap()[0].bloom =
            sync::BloomFilter::from_hashes(hashes.iter());
        client.sync_to_daemon().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("snapshot writer returned without delivering the change")
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_confirms_sequential_writes_with_concurrent_server_change() {
        let (client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(async move {
            accept_settings_handshake(&mut server_stream).await;
            let mut doc = SettingsDoc::from_synced_settings(&SyncedSettings::default());
            let mut peer = sync::State::new();
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            for theme in [ThemeMode::Dark, ThemeMode::Light, ThemeMode::System] {
                while doc.get_all().theme != theme {
                    apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
                    if doc.get_all().theme == ThemeMode::Dark {
                        doc.put("default_python_env", "conda");
                    }
                    if let Some(reply) = doc.generate_sync_message(&mut peer) {
                        connection::send_frame(&mut server_stream, &reply.encode())
                            .await
                            .unwrap();
                    }
                }
            }
            server_stream
        });
        let mut client = SyncClient::init(client_stream, test_mode(false, Duration::from_secs(1)))
            .await
            .unwrap();
        for theme in ["dark", "light", "system"] {
            client.put("theme", theme).await.unwrap();
            assert_eq!(client.get_all().default_python_env, PythonEnvType::Conda);
        }
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn failed_watch_write_closes_connection() {
        let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(serve_initial_settings_snapshot(
            server_stream,
            SyncedSettings::default(),
            Duration::from_millis(200),
        ));
        let mut client = SyncClient::init(client_stream, test_mode(true, Duration::from_secs(1)))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            client.put("theme", "dark").await,
            Err(SyncClientError::ConnectionFailed(_))
        ));
        assert!(matches!(
            client.put("theme", "light").await,
            Err(SyncClientError::Disconnected)
        ));
        assert!(matches!(
            client.recv_changes().await,
            Err(SyncClientError::Disconnected)
        ));
    }

    async fn unacknowledged_snapshot_write(cancel: bool) {
        let (client_stream, mut server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(async move {
            accept_settings_handshake(&mut server_stream).await;
            let mut doc = SettingsDoc::from_synced_settings(&SyncedSettings::default());
            let mut peer = sync::State::new();
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            apply_next_client_frame(&mut server_stream, &mut doc, &mut peer).await;
            send_next_server_frame(&mut server_stream, &mut doc, &mut peer).await;
            // Consume frames, but never confirm the write. The client must
            // close on timeout/cancellation, not reuse an uncertain stream.
            while connection::recv_frame(&mut server_stream)
                .await
                .unwrap()
                .is_some()
            {}
        });
        let mut client = SyncClient::init(client_stream, test_mode(false, Duration::from_secs(1)))
            .await
            .unwrap();
        if cancel {
            assert!(
                tokio::time::timeout(Duration::from_millis(25), client.put("theme", "dark"))
                    .await
                    .is_err()
            );
        } else {
            assert!(matches!(
                client.put("theme", "dark").await,
                Err(SyncClientError::Timeout)
            ));
        }
        assert!(matches!(
            client.put("theme", "light").await,
            Err(SyncClientError::Disconnected)
        ));
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
        delayed_initial_sync(false, 2).await;
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_write_timeout_closes_connection() {
        unacknowledged_snapshot_write(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_snapshot_write_closes_connection() {
        unacknowledged_snapshot_write(true).await;
    }

    #[tokio::test(start_paused = true)]
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
                    deadline: sync_deadline(Duration::from_secs(1)),
                },
            ),
        )
        .await
        .expect("snapshot sync should not wait for receive quiescence")
        .expect("snapshot sync should succeed");

        assert_eq!(client.get_all().theme, expected.theme);
        server.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_initial_sync_times_out_when_server_stalls() {
        let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(serve_stalled_settings_connection(server_stream));

        let error = SyncClient::init(
            client_stream,
            InitialSyncMode::Snapshot {
                deadline: sync_deadline(Duration::from_millis(25)),
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

    #[tokio::test(start_paused = true)]
    async fn watch_initial_sync_returns_without_quiescence_wait() {
        let (client_stream, server_stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(serve_initial_settings_snapshot(
            server_stream,
            SyncedSettings::default(),
            Duration::from_millis(200),
        ));

        let result = tokio::time::timeout(
            Duration::from_millis(50),
            SyncClient::init(client_stream, test_mode(true, Duration::from_secs(1))),
        )
        .await;

        let client = result
            .expect("watch readiness must not depend on silence")
            .unwrap();
        assert_eq!(client.get_all(), SyncedSettings::default());
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
    fn test_get_all_reads_enable_comments() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "enable_comments", true).unwrap();

        let settings = get_all_from_doc(&doc);
        assert!(settings.enable_comments);
    }

    #[test]
    fn test_get_all_reads_disable_auto_format() {
        let mut doc = AutoCommit::new();
        doc.put(automerge::ROOT, "disable_auto_format", true)
            .unwrap();

        let settings = get_all_from_doc(&doc);
        assert!(settings.disable_auto_format);
    }

    #[test]
    fn test_get_all_reads_editor_settings() {
        let mut doc = AutoCommit::new();
        let editor_id = doc
            .put_object(automerge::ROOT, "editor", ObjType::Map)
            .unwrap();
        doc.put(&editor_id, "code_font_family", "\"Hack\", monospace")
            .unwrap();
        doc.put(&editor_id, "markdown_font_family", "Georgia, serif")
            .unwrap();
        doc.put(&editor_id, "line_numbers", true).unwrap();

        let settings = get_all_from_doc(&doc);
        assert_eq!(settings.editor.code_font_family, "\"Hack\", monospace");
        assert_eq!(settings.editor.markdown_font_family, "Georgia, serif");
        assert!(settings.editor.line_numbers);
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
