//! Connection handshake data structures.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

use super::env::{CreateNotebookEnvironmentMode, PackageManager};
use super::framing::{self, NotebookFrameType};

/// Channel handshake — the first frame on every connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "channel", rename_all = "snake_case")]
pub enum Handshake {
    /// Pool IPC: environment take/return/status/ping.
    Pool,
    /// Automerge settings sync.
    SettingsSync,
    /// Automerge notebook sync (per-notebook room).
    ///
    /// The optional `protocol` field is accepted for version negotiation.
    /// v4 clients receive SessionControl frames. After handshake, the server
    /// sends a `ProtocolCapabilities` response before starting sync.
    NotebookSync {
        notebook_id: String,
        /// Protocol version requested by client (`v4`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol: Option<String>,
        /// When true, the daemon sends the connection bootstrap as a typed
        /// SessionControl frame instead of a standalone untyped JSON frame.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        typed_bootstrap: Option<bool>,
        /// Working directory for untitled notebooks (used for project file detection).
        /// When a notebook_id is a UUID (untitled), this provides the directory context
        /// for finding pyproject.toml, pixi.toml, or environment.yaml.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        working_dir: Option<String>,
        /// Serialized NotebookMetadataSnapshot JSON, sent with the initial handshake
        /// so the daemon can read kernelspec before auto-launching a kernel.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_metadata: Option<String>,
        /// Self-declared operator suffix for the authenticated actor label.
        /// The room host owns the principal prefix and returns the assembled
        /// `<principal>/<operator>` label in `ProtocolCapabilities`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operator: Option<String>,
    },
    /// Open an existing notebook file. Daemon loads from disk, derives notebook_id.
    ///
    /// The daemon returns `NotebookConnectionInfo` before starting sync.
    /// After that, the connection becomes a normal notebook sync connection.
    OpenNotebook {
        /// Path to the .ipynb file.
        path: String,
        /// When true, the daemon sends `NotebookConnectionInfo` as a typed
        /// SessionControl frame instead of a standalone untyped JSON frame.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        typed_bootstrap: Option<bool>,
        /// Self-declared operator suffix for the authenticated actor label.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operator: Option<String>,
    },

    /// Runtime agent handshake. Sent by the coordinator to a spawned runtime
    /// agent subprocess on its stdin. The runtime agent reads this, bootstraps
    /// its RuntimeStateDoc, and begins processing kernel requests.
    RuntimeAgent {
        /// Notebook room to attach to.
        notebook_id: String,
        /// Unique runtime agent identifier (e.g., "runtime-agent:a1b2c3d4").
        runtime_agent_id: String,
        /// Filesystem path to the shared blob store root
        /// (e.g., "~/.cache/runt/blobs/").
        blob_root: String,
    },

    /// Create a new untitled notebook. Daemon creates empty room, generates env_id.
    ///
    /// The daemon returns `NotebookConnectionInfo` before starting sync.
    /// After that, the connection becomes a normal notebook sync connection.
    CreateNotebook {
        /// Runtime type: "python" or "deno".
        runtime: String,
        /// Working directory for project file detection (pyproject.toml, pixi.toml, environment.yml).
        /// Used since untitled notebooks have no path to derive working_dir from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        working_dir: Option<String>,
        /// Optional notebook_id hint for restoring an untitled notebook from a previous session.
        /// If provided and the daemon has a persisted Automerge doc for this ID, the room is
        /// reused instead of creating a fresh empty notebook. If the persisted doc doesn't exist,
        /// a new notebook is created and this ID is used as the notebook_id/env_id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notebook_id: Option<String>,
        /// When true, the notebook exists only in memory — no .automerge persisted to disk.
        /// Defaults to false (backward compat). MCP agents use true for scratch compute.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ephemeral: Option<bool>,
        /// Package manager preference: uv, conda, or pixi.
        /// When set, the daemon creates only this manager's metadata section.
        /// When None, the daemon uses its default_python_env setting.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        package_manager: Option<PackageManager>,
        /// Environment inheritance mode: auto, project, or notebook.
        /// Defaults to auto.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        environment_mode: Option<CreateNotebookEnvironmentMode>,
        /// Dependencies to seed into notebook metadata before auto-launch.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dependencies: Vec<String>,
        /// When true, the daemon sends `NotebookConnectionInfo` as a typed
        /// SessionControl frame instead of a standalone untyped JSON frame.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        typed_bootstrap: Option<bool>,
        /// Self-declared operator suffix for the authenticated actor label.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operator: Option<String>,
    },
}

pub const PROTOCOL_V4: &str = "v4";

/// Numeric protocol version for version negotiation.
/// Increment this when making breaking protocol changes.
///
/// Protocol v4 removes legacy environment-sync request/response variants and
/// is not wire-compatible with v3 clients.
pub const PROTOCOL_VERSION: u32 = 4;

/// Server response indicating protocol capabilities.
///
/// Sent immediately after handshake, before starting sync.
/// Used by the `NotebookSync` handshake variant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolCapabilities {
    /// Protocol version string (currently always "v4").
    pub protocol: String,
    /// Numeric protocol version for explicit version checking.
    /// Clients can compare this against their expected version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    /// Daemon version string (e.g., "2.0.0+abc123").
    /// Useful for debugging version mismatches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_version: Option<String>,
    /// Blob upload support advertised by the daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub put_blob: Option<PutBlobCapability>,
    /// Authenticated actor label that the client should use for Automerge
    /// changes on this connection, formatted as `<principal>/<operator>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_label: Option<String>,
    /// Server-enforced connection scope. This is informational for clients;
    /// room hosts still enforce scope server-side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_scope: Option<String>,
}

impl ProtocolCapabilities {
    pub fn v4(daemon_version: Option<String>) -> Self {
        let put_blob_limits =
            notebook_wire::frame_size_limits(notebook_wire::frame_types::PUT_BLOB);

        Self {
            protocol: PROTOCOL_V4.to_string(),
            protocol_version: Some(PROTOCOL_VERSION),
            daemon_version,
            put_blob: Some(PutBlobCapability {
                version: 1,
                single_frame_max: put_blob_limits.cap as u64,
                multipart: true,
                ephemeral_supported: true,
            }),
            actor_label: None,
            connection_scope: None,
        }
    }

    /// Attach authenticated identity metadata to this capability response.
    pub fn with_identity(
        mut self,
        actor_label: impl Into<String>,
        connection_scope: impl Into<String>,
    ) -> Self {
        self.actor_label = Some(actor_label.into());
        self.connection_scope = Some(connection_scope.into());
        self
    }
}

/// PutBlob transport capability advertised during notebook connection setup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PutBlobCapability {
    /// Capability schema version.
    pub version: u32,
    /// Maximum body size accepted for a single PutBlob frame.
    pub single_frame_max: u64,
    /// Whether multipart uploads are supported.
    pub multipart: bool,
    /// Whether `PutBlobHeader::Put.durability = "ephemeral"` is supported.
    #[serde(default)]
    pub ephemeral_supported: bool,
}

/// Server response for `OpenNotebook` and `CreateNotebook` handshakes.
///
/// Sent immediately after handshake, before starting sync.
/// Contains notebook_id derived by the daemon (from path or generated env_id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookConnectionInfo {
    /// Shared protocol and capability metadata.
    #[serde(flatten)]
    pub capabilities: ProtocolCapabilities,
    /// Notebook identifier derived by the daemon.
    /// For existing files: canonical path.
    /// For new notebooks: generated UUID (env_id).
    pub notebook_id: String,
    /// Number of cells in the notebook (for progress indication).
    pub cell_count: usize,
    /// True if the notebook has untrusted dependencies requiring user approval.
    pub needs_trust_approval: bool,
    /// Error message if the notebook could not be opened/created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Whether this notebook is ephemeral (in-memory only, no persistence).
    #[serde(default)]
    pub ephemeral: bool,
    /// On-disk path when the room is file-backed. Populated by `CreateNotebook`
    /// when `notebook_id_hint` resolves to a room that already has a path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notebook_path: Option<String>,
}

/// Typed bootstrap payload carried on `NotebookFrameType::SessionControl`.
///
/// Unix streams still need length-prefix framing, but relay-style clients can
/// opt into this envelope so all post-handshake connection metadata rides the
/// same typed-frame channel used by WebSocket transports.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionBootstrap {
    ProtocolCapabilities {
        #[serde(flatten)]
        capabilities: ProtocolCapabilities,
    },
    NotebookConnectionInfo {
        #[serde(flatten)]
        info: NotebookConnectionInfo,
    },
}

impl ConnectionBootstrap {
    pub fn protocol_capabilities(capabilities: ProtocolCapabilities) -> Self {
        Self::ProtocolCapabilities { capabilities }
    }

    pub fn notebook_connection_info(info: NotebookConnectionInfo) -> Self {
        Self::NotebookConnectionInfo { info }
    }
}

/// Send a typed connection bootstrap frame.
pub async fn send_typed_bootstrap_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bootstrap: &ConnectionBootstrap,
) -> anyhow::Result<()> {
    framing::send_typed_json_frame(writer, NotebookFrameType::SessionControl, bootstrap).await
}

/// Receive and parse a typed connection bootstrap frame.
pub async fn recv_typed_bootstrap_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> anyhow::Result<Option<ConnectionBootstrap>> {
    let Some(frame) = framing::recv_typed_frame(reader).await? else {
        return Ok(None);
    };

    if frame.frame_type != NotebookFrameType::SessionControl {
        anyhow::bail!(
            "expected SessionControl bootstrap frame, got {:?}",
            frame.frame_type
        );
    }

    let bootstrap = serde_json::from_slice(&frame.payload)?;
    Ok(Some(bootstrap))
}
