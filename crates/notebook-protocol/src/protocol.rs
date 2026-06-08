//! Notebook-specific protocol types extracted from runtimed.
//!
//! Pure data definitions (structs and enums) for the notebook sync protocol.
//! No `impl` blocks — just shapes + serde derives.

use std::path::PathBuf;

use crate::connection::{EnvSource, LaunchSpec};
pub use notebook_wire::{
    InitialLoadPhaseWire, NotebookDocPhaseWire, RuntimeStatePhaseWire, SessionControlMessage,
    SessionSyncStatusWire,
};
use serde::{Deserialize, Serialize};

// ── Data structs referenced by protocol enums ───────────────────────────────

/// Optional runtime behaviors captured for a kernel launch.
///
/// The daemon derives these from settings before launch and stores the
/// materialized values in `LaunchedEnvConfig` so restart and drift checks know
/// which runtime behavior produced the active kernel.
///
/// Serialized flat via `#[serde(flatten)]` in parent structs, so the
/// on-wire JSON and Automerge keys stay at the top level (`bootstrap_dx`)
/// for backward compatibility.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureFlags {
    /// Launch via `nteract_kernel_launcher` so rich display formatters are
    /// registered before the first user cell.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bootstrap_dx: bool,
}

/// Environment configuration captured at kernel launch time.
/// Used to detect when notebook metadata has drifted from the running kernel.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LaunchedEnvConfig {
    /// UV inline deps (if env_source is "uv:inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uv_deps: Option<Vec<String>>,

    /// Conda inline deps (if env_source is "conda:inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conda_deps: Option<Vec<String>>,

    /// Conda channels (if env_source is "conda:inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conda_channels: Option<Vec<String>>,

    /// Pixi inline deps — conda matchspecs (if env_source is "pixi:inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixi_deps: Option<Vec<String>>,

    /// Pixi project deps snapshot for drift detection (pixi:toml only).
    /// Combined sorted list of conda + pypi dependency names from pixi.toml.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixi_toml_deps: Option<Vec<String>>,

    /// Path to the pixi.toml or pyproject.toml with [tool.pixi] (pixi:toml only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixi_toml_path: Option<PathBuf>,

    /// Path to pyproject.toml (uv:pyproject only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pyproject_path: Option<PathBuf>,

    /// Path to environment.yml (conda:env_yml only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_yml_path: Option<PathBuf>,

    /// Conda deps snapshot from environment.yml for drift detection (conda:env_yml only).
    /// Combined sorted list of conda dependency names from environment.yml.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_yml_deps: Option<Vec<String>>,

    /// Deno config (if kernel_type is "deno")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deno_config: Option<DenoLaunchedConfig>,

    /// Path to the venv used by the kernel (for hot-sync into running env)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venv_path: Option<PathBuf>,

    /// Path to python executable (for hot-sync, avoids hardcoding bin/python vs Scripts/python.exe)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_path: Option<PathBuf>,

    /// Unique identifier for this kernel launch session.
    /// Used to detect if kernel was swapped during async operations (e.g., hot-sync).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,

    /// Snapshot of the user's feature-flag settings at launch time.
    /// Flattened on the wire so each flag sits at the top level (e.g.
    /// `bootstrap_dx`) for backward compatibility.
    #[serde(default, flatten)]
    pub feature_flags: FeatureFlags,

    /// Packages pre-installed in the prewarmed environment (empty for inline envs).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prewarmed_packages: Vec<String>,
}

/// Deno configuration captured at kernel launch time.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct DenoLaunchedConfig {
    /// Deno permission flags
    #[serde(default)]
    pub permissions: Vec<String>,

    /// Path to import_map.json
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_map: Option<String>,

    /// Path to deno.json config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,

    /// Whether npm: imports auto-install packages
    #[serde(default = "default_flexible_npm")]
    pub flexible_npm_imports: bool,
}

fn default_flexible_npm() -> bool {
    true
}

fn default_redact_env_values_in_outputs() -> bool {
    true
}

/// An entry in the execution queue, pairing a cell with its execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueueEntry {
    pub cell_id: String,
    pub execution_id: String,
}

/// Frontend-observed notebook state used to guard trust-approved follow-up actions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuardedNotebookProvenance {
    pub observed_heads: Vec<String>,
}

/// Dependency state used to guard trust-approved sync.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DependencyGuard {
    pub observed_heads: Vec<String>,
}

/// Typed environment kind for sync operations.
///
/// Replaces string-based env_type ("uv", "conda") with a discriminated union
/// that carries environment-specific data. Makes illegal states unrepresentable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "env_kind", rename_all = "snake_case")]
pub enum EnvKind {
    /// UV environment (inline or prewarmed).
    Uv { packages: Vec<String> },
    /// Conda environment (inline or prewarmed).
    Conda {
        packages: Vec<String>,
        channels: Vec<String>,
    },
}

impl EnvKind {
    /// The packages to install, regardless of environment type.
    pub fn packages(&self) -> &[String] {
        match self {
            EnvKind::Uv { packages } | EnvKind::Conda { packages, .. } => packages,
        }
    }
}

// ── Helper structs ──────────────────────────────────────────────────────────

/// A single entry from kernel input history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    /// Session number (0 for current session)
    pub session: i32,
    /// Line number within the session
    pub line: i32,
    /// The source code that was executed
    pub source: String,
}

/// A single completion item (LSP-ready structure).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionItem {
    /// The completion text
    pub label: String,
    /// Kind: "function", "variable", "class", "module", etc.
    /// Populated by LSP later; kernel completions leave this as None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Short type annotation (e.g. "def read_csv(filepath_or_buffer, ...)")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Source: "kernel" now, "ruff"/"basedpyright" later.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Difference between launched environment config and current metadata.
/// Used to show the user what packages would be added/removed on restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvSyncDiff {
    /// Packages to add (in current metadata but not in launched config).
    #[serde(default)]
    pub added: Vec<String>,
    /// Packages to remove (in launched config but not in current metadata).
    #[serde(default)]
    pub removed: Vec<String>,
    /// Conda channels changed (requires restart to use new channels).
    #[serde(default)]
    pub channels_changed: bool,
    /// Deno config changed (permissions, import_map, etc.)
    #[serde(default)]
    pub deno_changed: bool,
}

// ── Notebook protocol enums ─────────────────────────────────────────────────

/// Structured error kinds returned in `NotebookResponse::SaveError`.
///
/// Note: `path` fields carry the serialized path string. Callers that build
/// `PathAlreadyOpen` from a `PathBuf` should use `p.to_string_lossy().into_owned()`
/// so non-UTF-8 paths degrade gracefully on the wire (Task 6.2 concern).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SaveErrorKind {
    /// Another room is currently serving this path. The agent must close
    /// the conflicting session (by UUID) before saving here.
    PathAlreadyOpen {
        /// UUID of the room that currently holds this path.
        uuid: String,
        /// The conflicting path (lossy-UTF-8 serialized from `PathBuf`).
        path: String,
    },
    /// I/O or serialization failure. Message is human-readable.
    Io { message: String },
}

/// Why a caller-provided execution id was rejected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionIdRejectionReason {
    /// The provided id was not a valid UUID string.
    Malformed,
    /// The id already exists in RuntimeStateDoc.
    AlreadyExists,
    /// The same id appeared more than once in a single batch request.
    DuplicateInRequest,
}

/// Structured blob-upload error reasons.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlobUploadErrorKind {
    SizeMismatch,
    HashMismatch,
    OverCap,
    TooManyInFlight,
    InvalidHeader,
    UnknownUpload,
    PartSizeMismatch,
    PartHashMismatch,
    DuplicatePartConflict,
    ManifestMismatch,
    FinalHashMismatch,
    OverPeerBudget,
    SessionExpired,
    Io { message: String },
}

/// One manifest entry supplied when completing a multipart blob upload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobUploadPart {
    pub part_number: u32,
    pub sha256: String,
    pub size: u64,
}

/// Successful one-shot PutBlob upload result returned to callers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PutBlobResult {
    /// Content-addressed blob hash.
    pub blob: String,
    /// Stored byte length.
    pub size: u64,
    /// Stored media type.
    pub media_type: String,
}

/// Durability hint for a one-shot PutBlob upload.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlobDurability {
    Durable,
    Ephemeral,
}

/// Header carried at the start of a binary PutBlob frame.
///
/// The frame payload is `u32 header_len_be | JSON header | raw blob bytes`.
/// Phase 1 supports one-shot uploads only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PutBlobHeader {
    Put {
        id: String,
        media_type: String,
        size: u64,
        sha256: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        durability: Option<BlobDurability>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        purpose: Option<String>,
    },
    Part {
        id: String,
        upload_id: String,
        part_number: u32,
        size: u64,
        sha256: String,
    },
}

/// Structured parse failure for a PutBlob frame payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutBlobPayloadError {
    pub id: Option<String>,
    pub reason: BlobUploadErrorKind,
}

impl PutBlobHeader {
    pub fn encode_frame(&self, body: &[u8]) -> Result<Vec<u8>, serde_json::Error> {
        let header = serde_json::to_vec(self)?;
        let mut frame = Vec::with_capacity(4 + header.len() + body.len());
        frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(body);
        Ok(frame)
    }

    pub fn try_parse(payload: &[u8]) -> Result<(Self, &[u8]), PutBlobPayloadError> {
        if payload.len() < 4 {
            return Err(PutBlobPayloadError {
                id: None,
                reason: BlobUploadErrorKind::InvalidHeader,
            });
        }

        let header_len =
            u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
        let Some(header_end) = 4usize.checked_add(header_len) else {
            return Err(PutBlobPayloadError {
                id: None,
                reason: BlobUploadErrorKind::InvalidHeader,
            });
        };

        if header_end > payload.len() {
            return Err(PutBlobPayloadError {
                id: None,
                reason: BlobUploadErrorKind::InvalidHeader,
            });
        }

        let header_value: serde_json::Value = serde_json::from_slice(&payload[4..header_end])
            .map_err(|_| PutBlobPayloadError {
                id: None,
                reason: BlobUploadErrorKind::InvalidHeader,
            })?;
        let id = header_value
            .get("id")
            .and_then(|id| id.as_str())
            .map(str::to_owned);
        let header = serde_json::from_value(header_value).map_err(|_| PutBlobPayloadError {
            id,
            reason: BlobUploadErrorKind::InvalidHeader,
        })?;

        Ok((header, &payload[header_end..]))
    }

    pub fn id(&self) -> &str {
        match self {
            PutBlobHeader::Put { id, .. } => id,
            PutBlobHeader::Part { id, .. } => id,
        }
    }
}

/// Envelope around a `NotebookRequest` carrying a correlation id.
///
/// The id is echoed on the matching `NotebookResponseEnvelope` so the relay
/// (or any future direct JS sender) can match responses to in-flight
/// requests. Absent id == notification / fire-and-forget — not currently
/// used but kept as a free escape hatch.
///
/// Wire shape is flattened: `{"id":"...","action":"execute_cell","cell_id":"..."}`.
/// Formalized in protocol v3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookRequestEnvelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Causal precondition for handling this request.
    ///
    /// When present, the daemon must not evaluate the request until its
    /// notebook document has incorporated every listed Automerge change hash.
    /// The document may have advanced beyond these heads; this is a
    /// containment check, not an equality check.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_heads: Vec<String>,
    #[serde(flatten)]
    pub request: NotebookRequest,
}

/// Envelope around a `NotebookResponse` echoing the originating request id.
///
/// `id == None` is valid for out-of-band server-pushed responses that
/// don't correspond to a specific client request (not currently emitted;
/// reserved for future use).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookResponseEnvelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(flatten)]
    pub response: NotebookResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommBufferRef {
    pub index: usize,
    pub blob: String,
    pub size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommRequestMessage {
    pub header: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_header: Option<serde_json::Value>,
    #[serde(default = "empty_json_object")]
    pub metadata: serde_json::Value,
    pub content: serde_json::Value,
    #[serde(default)]
    pub buffers: Vec<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub buffer_refs: Vec<CommBufferRef>,
    #[serde(default = "default_comm_channel")]
    pub channel: String,
}

fn empty_json_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

fn default_comm_channel() -> String {
    "shell".to_string()
}

/// Requests sent from notebook app to daemon for notebook operations.
///
/// These are sent as JSON over the notebook sync connection alongside
/// Automerge sync messages. The daemon handles kernel lifecycle and
/// execution, becoming the single source of truth for outputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum NotebookRequest {
    /// Launch a kernel for this notebook room.
    /// If a kernel is already running, returns info about the existing kernel.
    LaunchKernel {
        /// Kernel type: "python" or "deno"
        kernel_type: String,
        /// Request-time launch source: "auto", "auto:uv", "uv:inline", etc.
        env_source: LaunchSpec,
        /// Path to the notebook file (for working directory)
        notebook_path: Option<String>,
    },

    /// Execute a cell by reading its source from the automerge doc.
    ExecuteCell {
        cell_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_id: Option<String>,
    },

    /// Execute a cell only if it still matches the frontend-observed state
    /// captured when a trust gate opened.
    ExecuteCellGuarded {
        cell_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_id: Option<String>,
        observed_heads: Vec<String>,
    },

    /// Interrupt the currently executing cell.
    InterruptExecution {},

    /// Shutdown the kernel for this room.
    ShutdownKernel {},

    /// Run all code cells from the synced document.
    /// Daemon reads cell sources from the Automerge doc and queues them.
    RunAllCells {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cell_execution_ids: Option<std::collections::HashMap<String, String>>,
    },

    /// Run all code cells only if the current code-cell list still matches
    /// the frontend-observed state captured when a trust gate opened.
    RunAllCellsGuarded {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cell_execution_ids: Option<std::collections::HashMap<String, String>>,
        observed_heads: Vec<String>,
    },

    /// Send a comm message to the kernel (widget interactions).
    /// Accepts the full Jupyter message envelope to preserve header/session.
    SendComm {
        /// The full Jupyter message (header, content, buffers, etc.)
        /// Preserves frontend session/msg_id for proper widget protocol.
        message: Box<CommRequestMessage>,
    },

    /// Search the kernel's input history.
    /// Returns matching history entries via HistoryResult response.
    GetHistory {
        /// Pattern to search for (glob-style, optional)
        pattern: Option<String>,
        /// Maximum number of entries to return
        n: i32,
        /// Only return unique entries (deduplicate)
        unique: bool,
    },

    /// Request code completions from the kernel.
    /// Returns matching completions via CompletionResult response.
    Complete {
        /// The code to complete
        code: String,
        /// Cursor position in the code
        cursor_pos: usize,
    },

    /// Save the notebook to disk.
    /// The daemon reads cells and metadata from the Automerge doc, merges
    /// with any existing .ipynb on disk (to preserve unknown metadata keys),
    /// and writes the result.
    ///
    /// If `path` is provided, saves to that path (with .ipynb appended if needed).
    /// If `path` is None, saves to the room's current path; untitled rooms
    /// (no path) return an error.
    SaveNotebook {
        /// If true, format code cells before saving (e.g., with ruff).
        format_cells: bool,
        /// Optional target path. If None, uses the room's current path.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },

    /// Fork the current notebook into a new ephemeral (in-memory only) room.
    ///
    /// Creates a new UUID, copies cells + metadata from the source room,
    /// resets env_id, clears outputs and trust. The new room exists only
    /// on the daemon until a peer connects to it via `Handshake::NotebookSync`
    /// and optionally promotes it to file-backed via Save-As.
    ///
    /// Outputs and execution counts are NOT copied — forking widget state
    /// into a kernel-less room would render disconnected live comms.
    CloneAsEphemeral {
        /// Source notebook UUID. Must refer to a room currently loaded in
        /// the daemon (file-backed, untitled, or ephemeral).
        source_notebook_id: String,
    },

    /// Sync environment with current metadata (hot-install new packages).
    ///
    /// The daemon always enforces trust before installing. `guard` is supplied
    /// when the request follows a trust dialog and must still match the
    /// dependency metadata the user approved.
    SyncEnvironment {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        guard: Option<DependencyGuard>,
    },

    /// Approve the current dependency metadata for this notebook.
    ///
    /// The daemon signs the current runt metadata and writes the trust fields
    /// into the Automerge document. `observed_heads` is supplied when approval
    /// is tied to an already-open trust dialog; the daemon reconstructs the
    /// dependency metadata at those heads and refuses to sign if the current
    /// dependency metadata no longer matches what the user reviewed.
    ApproveTrust {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observed_heads: Option<Vec<String>>,
    },

    /// Approve creating/syncing a project-file environment for the current
    /// project file snapshot. This is intentionally separate from
    /// `ApproveTrust`: it records local project setup approval and does not
    /// sign notebook dependency metadata.
    ApproveProjectEnvironment {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_file_path: Option<String>,
    },

    /// Get the full Automerge document bytes from the daemon's canonical doc.
    /// Used by the frontend to bootstrap its WASM Automerge peer.
    GetDocBytes {},

    /// Begin a peer-scoped multipart blob upload.
    CreateBlobUpload {
        media_type: String,
        size: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part_size: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        purpose: Option<String>,
    },

    /// Publish a completed multipart upload into the content-addressed store.
    CompleteBlobUpload {
        upload_id: String,
        parts: Vec<BlobUploadPart>,
    },

    /// Abort a peer-scoped multipart upload and discard staged parts.
    AbortBlobUpload { upload_id: String },

    /// Get the sandbox state for the current notebook's running kernel.
    ///
    /// Returns the live `SandboxState` from the kernel session. When no kernel
    /// is running (or the notebook has no sandbox profile), the state is
    /// `Disabled`. This is a read-only query — it does not modify any state.
    GetSandboxState {},
}

/// Responses from daemon to notebook app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum NotebookResponse {
    /// Kernel launched successfully.
    KernelLaunched {
        kernel_type: String,
        env_source: EnvSource,
        /// Environment config used at launch (for sync detection).
        launched_config: LaunchedEnvConfig,
    },

    /// Kernel was already running (returned existing info).
    KernelAlreadyRunning {
        kernel_type: String,
        env_source: EnvSource,
        /// Environment config used at launch (for sync detection).
        launched_config: LaunchedEnvConfig,
    },

    /// Cell queued for execution.
    CellQueued {
        cell_id: String,
        execution_id: String,
    },

    /// Caller-provided execution id was rejected before queueing.
    ExecutionIdRejected {
        execution_id: String,
        reason: ExecutionIdRejectionReason,
    },

    /// Interrupt sent to kernel.
    InterruptSent {},

    /// Kernel shutdown initiated.
    KernelShuttingDown {},

    /// No kernel is running.
    NoKernel {},

    /// A guarded action was not queued because current notebook state no
    /// longer matches the state the user approved.
    GuardRejected { reason: String },

    /// All cells queued for execution.
    AllCellsQueued { queued: Vec<QueueEntry> },

    /// Notebook saved successfully to disk.
    NotebookSaved {
        /// The absolute path where the notebook was written.
        path: String,
    },

    /// Save failed with a structured error.
    SaveError { error: SaveErrorKind },

    /// Notebook forked into a new ephemeral room.
    NotebookCloned {
        /// UUID of the newly-created ephemeral room.
        notebook_id: String,
        /// Effective working directory the cloned room inherits from its
        /// source: the source's .ipynb parent if file-backed, or the
        /// source room's explicit working_dir for untitled sources.
        /// Passed through to new-window creation for project-file resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        working_dir: Option<String>,
    },

    /// Generic success.
    Ok {},

    /// Error response.
    Error { error: String },

    /// History search result.
    HistoryResult { entries: Vec<HistoryEntry> },

    /// Code completion result.
    CompletionResult {
        items: Vec<CompletionItem>,
        cursor_start: usize,
        cursor_end: usize,
    },

    /// Environment sync completed successfully.
    SyncEnvironmentComplete {
        /// Packages that were installed
        synced_packages: Vec<String>,
    },

    /// Environment sync failed (fall back to restart).
    SyncEnvironmentFailed {
        /// Error message explaining why sync failed
        error: String,
        /// Whether the user should restart instead
        needs_restart: bool,
    },

    /// Full Automerge document bytes from the daemon's canonical doc.
    DocBytes {
        /// Raw Automerge document bytes, encoded as a Vec for JSON transport.
        bytes: Vec<u8>,
    },

    /// Blob bytes were stored in the content-addressed blob store.
    BlobStored {
        hash: String,
        size: u64,
        media_type: String,
    },

    /// Multipart blob upload was created.
    BlobUploadCreated {
        upload_id: String,
        part_size: u64,
        expires_at: String,
    },

    /// Multipart blob part bytes were staged.
    BlobPartStored {
        upload_id: String,
        part_number: u32,
        sha256: String,
    },

    /// Multipart blob upload was aborted.
    BlobUploadAborted { upload_id: String },

    /// Blob upload failed before publishing bytes.
    BlobUploadError { reason: BlobUploadErrorKind },

    /// Sandbox state for the current notebook's running kernel.
    SandboxState {
        /// Current sandbox state, serialized as a tagged union.
        ///
        /// Variants: `{ "type": "Disabled" }`,
        /// `{ "type": "Active", "nono_pid": u32, "kernel_pid": u32, "session_id": Option<String> }`,
        /// `{ "type": "StartupFailed", "reason": String, "stderr_tail": Vec<String> }`,
        /// `{ "type": "Degraded", "reason": String }`.
        state: SandboxStateInfo,
    },
}

/// Sandbox state DTO for the `GetSandboxState` response.
///
/// A transport-safe representation of the daemon-side `SandboxState` enum.
/// Maps one-to-one with the `SandboxStateDto` described in task 09.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SandboxStateInfo {
    /// No sandbox profile configured or `enabled = false`.
    Disabled,

    /// Sandbox launched and the nono proxy is healthy.
    Active {
        nono_pid: u32,
        kernel_pid: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },

    /// Sandbox failed to start.
    StartupFailed {
        reason: String,
        stderr_tail: Vec<String>,
    },

    /// Sandbox started but the nono proxy died mid-session.
    Degraded { reason: String },
}

/// Broadcast messages from daemon to all peers in a room.
///
/// Ephemeral, room-wide events. Custom comm messages (ipywidgets model
/// updates, button clicks) are the only traffic that still flows here.
/// Kernel state, execution lifecycle, queue, outputs, the notebook's
/// `path`, `last_saved` timestamp, and environment-preparation progress
/// all live in `RuntimeStateDoc` (frame type `0x05`) — they used to flow
/// as broadcasts and the dead variants were removed once the doc became
/// authoritative.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum NotebookBroadcast {
    /// Comm message from kernel (ipywidgets protocol).
    /// Broadcast to all connected peers so all windows can display widgets.
    Comm {
        /// Message type: "comm_open", "comm_msg", "comm_close"
        msg_type: String,
        /// Message content (comm_id, data, target_name, etc.)
        content: serde_json::Value,
        /// Binary buffers (base64-encoded when serialized to JSON)
        #[serde(default)]
        buffers: Vec<Vec<u8>>,
    },
}

// ── Runtime agent protocol types ──────────────────────────────────────────
//
// These types define the coordinator↔runtime-agent wire contract for
// process-isolated runtime agents (#1333). The runtime agent subprocess
// communicates over stdin/stdout using the same framed protocol (frame
// types 0x01/0x02/0x03 for JSON, 0x05 for RuntimeStateDoc sync).

/// Requests from coordinator to runtime agent (frame type 0x01).
///
/// The coordinator mediates between frontend requests and the runtime agent.
/// Environment preparation happens in the coordinator; the runtime agent
/// receives a ready-to-launch configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelPorts {
    pub stdin: u16,
    pub control: u16,
    pub hb: u16,
    pub shell: u16,
    pub iopub: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum RuntimeAgentRequest {
    /// Launch a kernel with the given configuration.
    /// Environment is already prepared by the coordinator.
    LaunchKernel {
        kernel_type: String,
        env_source: EnvSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notebook_path: Option<String>,
        launched_config: LaunchedEnvConfig,
        kernel_ports: KernelPorts,
        /// Environment variables to set for the kernel process.
        #[serde(default)]
        env_vars: std::collections::HashMap<String, String>,
        /// Redact eligible environment variable values from textual kernel outputs.
        #[serde(default = "default_redact_env_values_in_outputs")]
        redact_env_values_in_outputs: bool,
        /// Sandbox profile for this kernel session.
        ///
        /// When `Some` and `profile.enabled == true`, the kernel is launched under
        /// nono via the sandbox supervisor. When `None` or `profile.enabled == false`,
        /// the existing direct-spawn path is used (D-3 opt-in semantics).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sandbox_profile: Option<notebook_doc::sandbox::SandboxProfile>,
    },

    /// Interrupt the currently executing cell.
    InterruptExecution,

    /// Shutdown the kernel. The runtime agent process stays alive for potential restart.
    ShutdownKernel,

    /// Restart the kernel: shut down the current kernel, create a new one,
    /// re-launch. Same runtime agent process, same socket connection. The
    /// coordinator sends this instead of spawning a new runtime agent when
    /// one is already connected.
    RestartKernel {
        kernel_type: String,
        env_source: EnvSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notebook_path: Option<String>,
        launched_config: LaunchedEnvConfig,
        kernel_ports: KernelPorts,
        #[serde(default)]
        env_vars: std::collections::HashMap<String, String>,
        #[serde(default = "default_redact_env_values_in_outputs")]
        redact_env_values_in_outputs: bool,
        /// Sandbox profile for this kernel session (same semantics as `LaunchKernel`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sandbox_profile: Option<notebook_doc::sandbox::SandboxProfile>,
    },

    /// Send a comm message to the kernel (widget interactions).
    SendComm { message: Box<CommRequestMessage> },

    /// Request code completions from the kernel.
    Complete { code: String, cursor_pos: usize },

    /// Search the kernel's input history.
    GetHistory {
        pattern: Option<String>,
        n: i32,
        unique: bool,
    },

    /// Hot-install packages into the running kernel's environment.
    /// Supported for UV and Conda inline dependencies (additions only).
    SyncEnvironment(EnvKind),
}

/// Responses from runtime agent to coordinator (frame type 0x02).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum RuntimeAgentResponse {
    /// Kernel launched successfully.
    KernelLaunched {
        env_source: EnvSource,
        /// Sandbox state after launch. `None` when sandbox is not active
        /// (the common case). The coordinator stores this in
        /// `NotebookRoom::sandbox_state_cache` so `GetSandboxState {}` can
        /// return it without a round-trip to the runtime agent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sandbox_state: Option<SandboxStateInfo>,
    },

    /// Kernel restarted successfully (same runtime agent, new kernel).
    KernelRestarted {
        env_source: EnvSource,
        /// Sandbox state after restart. Same semantics as `KernelLaunched`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sandbox_state: Option<SandboxStateInfo>,
    },

    /// Code completion result.
    CompletionResult {
        items: Vec<CompletionItem>,
        cursor_start: usize,
        cursor_end: usize,
    },

    /// History search result.
    HistoryResult { entries: Vec<HistoryEntry> },

    /// Interrupt acknowledged. Contains the list of cleared queue entries.
    InterruptAcknowledged { cleared: Vec<QueueEntry> },

    /// Generic success.
    Ok,

    /// Packages installed successfully into the running env.
    EnvironmentSynced { synced_packages: Vec<String> },

    /// Error response.
    Error { error: String },
}

/// Envelope around a `RuntimeAgentRequest` carrying a correlation ID.
///
/// Every request gets a unique ID. For query RPCs (Complete, GetHistory),
/// the agent echoes the ID on the response envelope. For command RPCs
/// (fire-and-forget), the agent processes the request but sends no response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeAgentRequestEnvelope {
    pub id: String,
    #[serde(flatten)]
    pub request: RuntimeAgentRequest,
}

/// Envelope around a `RuntimeAgentResponse` echoing the correlation ID.
///
/// Only used for query RPCs (Complete, GetHistory) that need sync responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeAgentResponseEnvelope {
    pub id: String,
    #[serde(flatten)]
    pub response: RuntimeAgentResponse,
}

impl RuntimeAgentRequest {
    /// Returns true if this request is a command (fire-and-forget).
    /// Commands don't get a response — state flows back via CRDT.
    ///
    /// Currently: Interrupt, SendComm. Shutdown is a sync query because
    /// the daemon must confirm the kernel is dead before LaunchKernel
    /// sends RestartKernel — otherwise CRDT-queued cells can race onto
    /// the dying kernel.
    pub fn is_command(&self) -> bool {
        matches!(
            self,
            RuntimeAgentRequest::InterruptExecution | RuntimeAgentRequest::SendComm { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn env_kind_uv_round_trip() {
        let kind = EnvKind::Uv {
            packages: vec!["numpy".into(), "pandas".into()],
        };
        let json = serde_json::to_string(&kind).expect("failed to serialize EnvKind::Uv");
        let parsed: EnvKind = serde_json::from_str(&json).expect("failed to parse EnvKind::Uv");
        assert_eq!(kind, parsed);
    }

    #[test]
    fn env_kind_conda_round_trip() {
        let kind = EnvKind::Conda {
            packages: vec!["scipy".into()],
            channels: vec!["conda-forge".into()],
        };
        let json = serde_json::to_string(&kind).expect("failed to serialize EnvKind::Conda");
        assert!(json.contains("\"env_kind\":\"conda\""));
        let parsed: EnvKind = serde_json::from_str(&json).expect("failed to parse EnvKind::Conda");
        assert_eq!(kind, parsed);
    }

    #[test]
    fn sync_environment_request_round_trip() {
        let req = RuntimeAgentRequest::SyncEnvironment(EnvKind::Conda {
            packages: vec!["numpy".into()],
            channels: vec!["conda-forge".into(), "bioconda".into()],
        });
        let json = serde_json::to_string(&req).expect("failed to serialize SyncEnvironment");
        let parsed: RuntimeAgentRequest =
            serde_json::from_str(&json).expect("failed to parse SyncEnvironment");
        match &parsed {
            RuntimeAgentRequest::SyncEnvironment(kind) => {
                assert_eq!(kind.packages(), &["numpy".to_string()]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn env_kind_packages_returns_inner_uv_slice() {
        // Both variants share a packages() accessor — make sure each one
        // returns its own packages, not e.g. an empty slice or the wrong
        // variant's data.
        let uv = EnvKind::Uv {
            packages: vec!["pandas".into(), "polars".into()],
        };
        assert_eq!(uv.packages(), &["pandas".to_string(), "polars".to_string()]);
    }

    #[test]
    fn env_kind_packages_returns_inner_conda_slice() {
        let conda = EnvKind::Conda {
            packages: vec!["scipy".into(), "numpy".into()],
            channels: vec!["conda-forge".into()],
        };
        assert_eq!(
            conda.packages(),
            &["scipy".to_string(), "numpy".to_string()]
        );
    }

    #[test]
    fn env_kind_uv_packages_can_be_empty() {
        // Empty package list is a real case (e.g. a prewarmed env that
        // is later reused with no extra installs). packages() must
        // return an empty slice without panicking.
        let uv = EnvKind::Uv { packages: vec![] };
        assert!(uv.packages().is_empty());
    }

    #[test]
    fn deno_launched_config_serde_default_keeps_flexible_npm_imports_on() {
        // The real guarantee: a JSON object missing `flexible_npm_imports`
        // must deserialize to true. If a future refactor accidentally flips
        // the serde default to false, every legacy notebook that doesn't
        // carry the field would silently lose `npm:` autoinstall on kernel
        // restore. (Note: `derive(Default)` gives false because bool's
        // Default is false; the serde default is what fires during
        // deserialization, and that's the load-bearing path.)
        let parsed: DenoLaunchedConfig =
            serde_json::from_str("{}").expect("DenoLaunchedConfig deserializes from {{}}");
        assert!(parsed.flexible_npm_imports);
    }

    #[test]
    fn deno_launched_config_round_trip_preserves_all_fields() {
        let cfg = DenoLaunchedConfig {
            permissions: vec!["--allow-net".into(), "--allow-read=./data".into()],
            import_map: Some("./import_map.json".into()),
            config: Some("./deno.json".into()),
            flexible_npm_imports: false,
        };
        let json = serde_json::to_string(&cfg).expect("serialize");
        let parsed: DenoLaunchedConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(cfg, parsed);
    }

    #[test]
    fn queue_entry_round_trip_preserves_ids() {
        let entry = QueueEntry {
            cell_id: "cell-abc".to_string(),
            execution_id: "exec-123-uuid".to_string(),
        };
        let json = serde_json::to_string(&entry).expect("serialize");
        let parsed: QueueEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(entry, parsed);
    }

    #[test]
    fn request_envelope_flattens_and_round_trips() {
        let env = NotebookRequestEnvelope {
            id: Some("req-1".into()),
            required_heads: vec!["a".repeat(64)],
            request: NotebookRequest::ExecuteCell {
                cell_id: "cell-42".into(),
                execution_id: None,
            },
        };
        let json = serde_json::to_value(&env).expect("serialize");
        assert_eq!(json["id"], "req-1");
        assert_eq!(json["required_heads"][0], "a".repeat(64));
        assert_eq!(json["action"], "execute_cell");
        assert_eq!(json["cell_id"], "cell-42");
        let parsed: NotebookRequestEnvelope = serde_json::from_value(json).expect("deserialize");
        assert_eq!(parsed.id.as_deref(), Some("req-1"));
        assert_eq!(parsed.required_heads, vec!["a".repeat(64)]);
        assert!(matches!(
            parsed.request,
            NotebookRequest::ExecuteCell { cell_id, execution_id } if cell_id == "cell-42" && execution_id.is_none()
        ));
    }

    #[test]
    fn response_envelope_flattens_and_round_trips() {
        let env = NotebookResponseEnvelope {
            id: Some("req-1".into()),
            response: NotebookResponse::CellQueued {
                cell_id: "cell-42".into(),
                execution_id: "exec-abc".into(),
            },
        };
        let json = serde_json::to_value(&env).expect("serialize");
        assert_eq!(json["id"], "req-1");
        assert_eq!(json["result"], "cell_queued");
        assert_eq!(json["cell_id"], "cell-42");
        let parsed: NotebookResponseEnvelope = serde_json::from_value(json).expect("deserialize");
        assert_eq!(parsed.id.as_deref(), Some("req-1"));
    }

    #[test]
    fn guarded_requests_round_trip() {
        let observed_heads = vec!["0123456789abcdef".to_string()];
        let cases = vec![
            NotebookRequest::ExecuteCellGuarded {
                cell_id: "cell-1".to_string(),
                execution_id: None,
                observed_heads: observed_heads.clone(),
            },
            NotebookRequest::RunAllCellsGuarded {
                cell_execution_ids: None,
                observed_heads: observed_heads.clone(),
            },
            NotebookRequest::SyncEnvironment {
                guard: Some(DependencyGuard {
                    observed_heads: observed_heads.clone(),
                }),
            },
            NotebookRequest::ApproveTrust {
                observed_heads: Some(observed_heads),
            },
            NotebookRequest::ApproveProjectEnvironment {
                project_file_path: Some("/tmp/project/environment.yml".into()),
            },
        ];

        for request in cases {
            let json = serde_json::to_string(&request).expect("serialize guarded request");
            let parsed: NotebookRequest =
                serde_json::from_str(&json).expect("deserialize guarded request");
            assert_eq!(
                serde_json::to_value(parsed).expect("reserialize guarded request"),
                serde_json::to_value(request).expect("serialize original guarded request")
            );
        }
    }

    #[test]
    fn guard_rejected_response_round_trip() {
        let response = NotebookResponse::GuardRejected {
            reason: "Notebook changed before the action could run.".to_string(),
        };
        let json = serde_json::to_value(&response).expect("serialize GuardRejected");
        assert_eq!(json["result"], "guard_rejected");
        assert_eq!(
            json["reason"],
            "Notebook changed before the action could run."
        );
        let parsed: NotebookResponse =
            serde_json::from_value(json).expect("deserialize GuardRejected");
        assert_eq!(
            serde_json::to_value(parsed).expect("reserialize GuardRejected"),
            serde_json::to_value(response).expect("serialize original GuardRejected")
        );
    }

    #[test]
    fn blob_upload_responses_round_trip() {
        let cases = vec![
            serde_json::json!({
                "result": "blob_stored",
                "hash": "c".repeat(64),
                "size": 1024,
                "media_type": "image/png"
            }),
            serde_json::json!({
                "result": "blob_upload_error",
                "reason": {
                    "kind": "hash_mismatch"
                }
            }),
            serde_json::json!({
                "result": "blob_upload_error",
                "reason": {
                    "kind": "io",
                    "message": "disk full"
                }
            }),
            serde_json::json!({
                "result": "blob_upload_error",
                "reason": {
                    "kind": "too_many_in_flight"
                }
            }),
        ];

        for json in cases {
            let parsed: NotebookResponse =
                serde_json::from_value(json.clone()).expect("deserialize blob upload response");
            assert_eq!(
                serde_json::to_value(parsed).expect("serialize blob upload response"),
                json
            );
        }
    }

    #[test]
    fn put_blob_header_parses_length_prefixed_payload() {
        let header = serde_json::json!({
            "op": "put",
            "id": "blob-request-1",
            "media_type": "application/octet-stream",
            "size": 3,
            "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "purpose": "widget-state",
        });
        let header_bytes = serde_json::to_vec(&header).unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
        payload.extend_from_slice(&header_bytes);
        payload.extend_from_slice(b"abc");

        let (parsed, body) = PutBlobHeader::try_parse(&payload).unwrap();

        assert_eq!(body, b"abc");
        assert_eq!(
            parsed,
            PutBlobHeader::Put {
                id: "blob-request-1".to_string(),
                media_type: "application/octet-stream".to_string(),
                size: 3,
                sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                    .to_string(),
                durability: None,
                purpose: Some("widget-state".to_string()),
            }
        );
    }

    #[test]
    fn put_blob_header_encode_frame_roundtrips_via_try_parse() {
        let header = PutBlobHeader::Put {
            id: "blob-request-encode".to_string(),
            media_type: "application/octet-stream".to_string(),
            size: 3,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_string(),
            durability: Some(BlobDurability::Ephemeral),
            purpose: Some("widget-state".to_string()),
        };

        let frame = header.encode_frame(b"abc").expect("encode PutBlob frame");
        let header_len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        let header_bytes = &frame[4..4 + header_len];
        let header_json: serde_json::Value =
            serde_json::from_slice(header_bytes).expect("parse encoded PutBlob header");

        assert_eq!(header_json["op"], "put");
        assert_eq!(header_json["id"], "blob-request-encode");
        assert_eq!(header_json["media_type"], "application/octet-stream");
        assert_eq!(header_json["size"], 3);
        assert_eq!(header_json["durability"], "ephemeral");
        assert_eq!(header_json["purpose"], "widget-state");

        let (parsed, body) = PutBlobHeader::try_parse(&frame).unwrap();
        assert_eq!(parsed, header);
        assert_eq!(body, b"abc");
    }

    #[test]
    fn put_blob_header_reports_invalid_payloads() {
        let too_short = PutBlobHeader::try_parse(&[0, 0, 0]).unwrap_err();
        assert_eq!(too_short.id, None);
        assert_eq!(too_short.reason, BlobUploadErrorKind::InvalidHeader);

        let mut truncated_header = Vec::new();
        truncated_header.extend_from_slice(&64_u32.to_be_bytes());
        truncated_header.extend_from_slice(b"{\"op\":\"put\"");

        let truncated = PutBlobHeader::try_parse(&truncated_header).unwrap_err();
        assert_eq!(truncated.id, None);
        assert_eq!(truncated.reason, BlobUploadErrorKind::InvalidHeader);

        let missing_op = serde_json::json!({
            "id": "blob-request-2",
            "media_type": "application/octet-stream",
            "size": 3,
            "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        });
        let missing_op_bytes = serde_json::to_vec(&missing_op).unwrap();
        let mut missing_op_payload = Vec::new();
        missing_op_payload.extend_from_slice(&(missing_op_bytes.len() as u32).to_be_bytes());
        missing_op_payload.extend_from_slice(&missing_op_bytes);
        missing_op_payload.extend_from_slice(b"abc");

        let missing_op = PutBlobHeader::try_parse(&missing_op_payload).unwrap_err();
        assert_eq!(missing_op.id.as_deref(), Some("blob-request-2"));
        assert_eq!(missing_op.reason, BlobUploadErrorKind::InvalidHeader);
    }

    /// Locks in the exact JSON wire shape that the TypeScript frontend
    /// emits for each `NotebookRequest` variant. The TS `NotebookRequest`
    /// union's discriminator field names must match the Rust variant's
    /// snake_cased name — the frame-based `TauriTransport.sendRequest`
    /// translates TS's `type:` into the envelope's `action:` key verbatim,
    /// so a mismatched name produces an unparseable request on the
    /// daemon side (silent wire error + failed interrupt / execute / etc.).
    ///
    /// Adding a new variant on the Rust side? Extend this test with the
    /// JSON shape the TS caller sends. Renaming a Rust variant? This
    /// test will flag the mismatch.
    #[test]
    fn wire_action_names_match_ts_discriminators() {
        let cases: Vec<(&str, serde_json::Value)> = vec![
            (
                "launch_kernel",
                serde_json::json!({
                    "action": "launch_kernel",
                    "kernel_type": "python",
                    "env_source": "uv:inline",
                }),
            ),
            (
                "execute_cell",
                serde_json::json!({ "action": "execute_cell", "cell_id": "c1" }),
            ),
            (
                "execute_cell_guarded",
                serde_json::json!({
                    "action": "execute_cell_guarded",
                    "cell_id": "c1",
                    "observed_heads": ["abc"],
                }),
            ),
            (
                "interrupt_execution",
                serde_json::json!({ "action": "interrupt_execution" }),
            ),
            (
                "shutdown_kernel",
                serde_json::json!({ "action": "shutdown_kernel" }),
            ),
            (
                "sync_environment",
                serde_json::json!({ "action": "sync_environment" }),
            ),
            (
                "sync_environment_with_guard",
                serde_json::json!({
                    "action": "sync_environment",
                    "guard": {
                        "observed_heads": ["abc"],
                    },
                }),
            ),
            (
                "approve_trust",
                serde_json::json!({
                    "action": "approve_trust",
                    "observed_heads": ["abc"],
                }),
            ),
            (
                "approve_project_environment",
                serde_json::json!({
                    "action": "approve_project_environment",
                    "project_file_path": "/tmp/project/environment.yml",
                }),
            ),
            (
                "run_all_cells",
                serde_json::json!({ "action": "run_all_cells" }),
            ),
            (
                "run_all_cells_guarded",
                serde_json::json!({
                    "action": "run_all_cells_guarded",
                    "observed_heads": ["abc"],
                }),
            ),
            (
                "get_history",
                serde_json::json!({
                    "action": "get_history",
                    "pattern": null,
                    "n": 100,
                    "unique": false,
                }),
            ),
            (
                "complete",
                serde_json::json!({
                    "action": "complete",
                    "code": "import os\nos.",
                    "cursor_pos": 13,
                }),
            ),
            (
                "save_notebook",
                serde_json::json!({
                    "action": "save_notebook",
                    "format_cells": true,
                    "path": "/tmp/example.ipynb",
                }),
            ),
            (
                "clone_as_ephemeral",
                serde_json::json!({
                    "action": "clone_as_ephemeral",
                    "source_notebook_id": "source-room",
                }),
            ),
            (
                "get_doc_bytes",
                serde_json::json!({ "action": "get_doc_bytes" }),
            ),
            (
                "create_blob_upload",
                serde_json::json!({
                    "action": "create_blob_upload",
                    "media_type": "application/octet-stream",
                    "size": 12,
                    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
                    "part_size": 8,
                    "purpose": "comm-buffer",
                }),
            ),
            (
                "complete_blob_upload",
                serde_json::json!({
                    "action": "complete_blob_upload",
                    "upload_id": "upload-1",
                    "parts": [
                        { "part_number": 1, "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "size": 12 }
                    ],
                }),
            ),
            (
                "abort_blob_upload",
                serde_json::json!({
                    "action": "abort_blob_upload",
                    "upload_id": "upload-1",
                }),
            ),
            (
                "send_comm",
                serde_json::json!({
                    "action": "send_comm",
                    "message": {
                        "header": {},
                        "content": {},
                        "buffers": [],
                        "channel": "shell",
                    },
                }),
            ),
        ];

        let request_actions = cases
            .iter()
            .map(|(_, json)| {
                json.get("action")
                    .and_then(serde_json::Value::as_str)
                    .expect("case has action")
                    .to_owned()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            request_actions,
            expected_values(crate::typescript::NOTEBOOK_REQUEST_TYPES),
            "TypeScript request discriminator list must match the serde request shapes covered here"
        );

        for (name, json) in cases {
            // Also validate the envelope form (with an id), which is what
            // the frame-based path actually sends.
            let mut with_id = json.clone();
            if let serde_json::Value::Object(ref mut map) = with_id {
                map.insert("id".into(), serde_json::Value::String("req-1".into()));
            }
            let _: NotebookRequestEnvelope = serde_json::from_value(with_id.clone())
                .unwrap_or_else(|e| {
                    panic!("envelope with action {:?} failed to deserialize: {e}", name)
                });
            let _: NotebookRequest = serde_json::from_value(json).unwrap_or_else(|e| {
                panic!(
                    "bare request with action {:?} failed to deserialize: {e}",
                    name
                )
            });
        }
    }

    fn extract_string_array(source: &str, const_name: &str) -> BTreeSet<String> {
        let needle = format!("export const {const_name} = [");
        let start = source
            .find(&needle)
            .unwrap_or_else(|| panic!("missing TS const {const_name}"))
            + needle.len();
        let rest = &source[start..];
        let end = rest
            .find("] as const")
            .unwrap_or_else(|| panic!("missing end of TS const {const_name}"));

        rest[..end]
            .split(',')
            .filter_map(|part| {
                let value = part.trim().trim_matches('\n').trim();
                value
                    .strip_prefix('"')
                    .and_then(|s| s.strip_suffix('"'))
                    .map(ToOwned::to_owned)
            })
            .collect()
    }

    fn expected_values(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn typescript_protocol_contract_matches_rust_discriminants() {
        let ts_contract = include_str!("../../../packages/runtimed/src/protocol-contract.ts");

        assert_eq!(
            extract_string_array(ts_contract, "NOTEBOOK_REQUEST_TYPES"),
            expected_values(crate::typescript::NOTEBOOK_REQUEST_TYPES)
        );
        assert_eq!(
            extract_string_array(ts_contract, "NOTEBOOK_RESPONSE_RESULTS"),
            expected_values(crate::typescript::NOTEBOOK_RESPONSE_RESULTS)
        );
        assert_eq!(
            extract_string_array(ts_contract, "SESSION_CONTROL_TYPES"),
            expected_values(crate::typescript::SESSION_CONTROL_TYPES)
        );
        assert_eq!(
            extract_string_array(ts_contract, "NOTEBOOK_DOC_PHASES"),
            expected_values(crate::typescript::NOTEBOOK_DOC_PHASES)
        );
        assert_eq!(
            extract_string_array(ts_contract, "RUNTIME_STATE_PHASES"),
            expected_values(crate::typescript::RUNTIME_STATE_PHASES)
        );
        assert_eq!(
            extract_string_array(ts_contract, "INITIAL_LOAD_PHASES"),
            expected_values(crate::typescript::INITIAL_LOAD_PHASES)
        );
    }

    #[test]
    fn runtime_agent_request_envelope_round_trip() {
        let envelope = RuntimeAgentRequestEnvelope {
            id: "req-42".to_string(),
            request: RuntimeAgentRequest::InterruptExecution,
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["id"], "req-42");
        assert_eq!(json["action"], "interrupt_execution");

        let parsed: RuntimeAgentRequestEnvelope = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.id, "req-42");
        assert!(matches!(
            parsed.request,
            RuntimeAgentRequest::InterruptExecution
        ));
    }

    #[test]
    fn runtime_agent_response_envelope_round_trip() {
        let envelope = RuntimeAgentResponseEnvelope {
            id: "req-42".to_string(),
            response: RuntimeAgentResponse::CompletionResult {
                items: vec![],
                cursor_start: 0,
                cursor_end: 5,
            },
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["id"], "req-42");
        assert_eq!(json["result"], "completion_result");

        let parsed: RuntimeAgentResponseEnvelope = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.id, "req-42");
    }

    #[test]
    fn runtime_agent_launch_and_restart_include_kernel_ports() {
        let ports = KernelPorts {
            stdin: 9000,
            control: 9001,
            hb: 9002,
            shell: 9003,
            iopub: 9004,
        };
        let launch = RuntimeAgentRequest::LaunchKernel {
            kernel_type: "python".into(),
            env_source: EnvSource::Prewarmed(crate::connection::PackageManager::Uv),
            notebook_path: None,
            launched_config: Default::default(),
            kernel_ports: ports,
            env_vars: Default::default(),
            redact_env_values_in_outputs: true,
            sandbox_profile: None,
        };
        let json = serde_json::to_value(&launch).unwrap();
        assert_eq!(json["kernel_ports"]["stdin"], 9000);
        assert_eq!(json["kernel_ports"]["control"], 9001);
        assert_eq!(json["kernel_ports"]["hb"], 9002);
        assert_eq!(json["kernel_ports"]["shell"], 9003);
        assert_eq!(json["kernel_ports"]["iopub"], 9004);

        let parsed: RuntimeAgentRequest = serde_json::from_value(json).unwrap();
        assert!(matches!(
            parsed,
            RuntimeAgentRequest::LaunchKernel {
                kernel_ports,
                ..
            } if kernel_ports == ports
        ));
        let parsed_legacy: RuntimeAgentRequest = serde_json::from_value(serde_json::json!({
            "action": "launch_kernel",
            "kernel_type": "python",
            "env_source": "uv:prewarmed",
            "launched_config": {},
            "kernel_ports": ports,
        }))
        .unwrap();
        assert!(matches!(
            parsed_legacy,
            RuntimeAgentRequest::LaunchKernel {
                redact_env_values_in_outputs: true,
                ..
            }
        ));

        let restart = RuntimeAgentRequest::RestartKernel {
            kernel_type: "python".into(),
            env_source: EnvSource::Inline(crate::connection::PackageManager::Conda),
            notebook_path: None,
            launched_config: Default::default(),
            kernel_ports: ports,
            env_vars: Default::default(),
            redact_env_values_in_outputs: true,
            sandbox_profile: None,
        };
        let json = serde_json::to_value(&restart).unwrap();
        let parsed: RuntimeAgentRequest = serde_json::from_value(json).unwrap();
        assert!(matches!(
            parsed,
            RuntimeAgentRequest::RestartKernel {
                kernel_ports,
                ..
            } if kernel_ports == ports
        ));
    }

    #[test]
    fn runtime_agent_is_command() {
        assert!(RuntimeAgentRequest::InterruptExecution.is_command());
        assert!(!RuntimeAgentRequest::ShutdownKernel.is_command());
        assert!(!RuntimeAgentRequest::Complete {
            code: String::new(),
            cursor_pos: 0,
        }
        .is_command());
        assert!(!RuntimeAgentRequest::GetHistory {
            pattern: None,
            n: 10,
            unique: false,
        }
        .is_command());
    }

    #[test]
    fn is_command_exhaustive_classification() {
        // Fire-and-forget commands (no response needed)
        assert!(RuntimeAgentRequest::InterruptExecution.is_command());
        assert!(RuntimeAgentRequest::SendComm {
            message: Box::new(CommRequestMessage {
                header: serde_json::json!({"msg_type": "comm_msg"}),
                parent_header: None,
                metadata: serde_json::json!({}),
                content: serde_json::json!({}),
                buffers: vec![vec![1, 2, 3]],
                buffer_refs: vec![],
                channel: "shell".to_string(),
            }),
        }
        .is_command());

        // Sync queries (response required)
        assert!(!RuntimeAgentRequest::ShutdownKernel.is_command());
        assert!(!RuntimeAgentRequest::LaunchKernel {
            kernel_type: "python".into(),
            env_source: EnvSource::Prewarmed(crate::connection::PackageManager::Uv),
            notebook_path: None,
            launched_config: Default::default(),
            kernel_ports: KernelPorts {
                stdin: 9000,
                control: 9001,
                hb: 9002,
                shell: 9003,
                iopub: 9004,
            },
            env_vars: Default::default(),
            redact_env_values_in_outputs: true,
            sandbox_profile: None,
        }
        .is_command());
        assert!(!RuntimeAgentRequest::RestartKernel {
            kernel_type: "python".into(),
            env_source: EnvSource::Inline(crate::connection::PackageManager::Conda),
            notebook_path: None,
            launched_config: Default::default(),
            kernel_ports: KernelPorts {
                stdin: 9005,
                control: 9006,
                hb: 9007,
                shell: 9008,
                iopub: 9009,
            },
            env_vars: Default::default(),
            redact_env_values_in_outputs: true,
            sandbox_profile: None,
        }
        .is_command());
        assert!(!RuntimeAgentRequest::SyncEnvironment(EnvKind::Uv {
            packages: vec!["numpy".into()]
        })
        .is_command());
    }

    #[test]
    fn comm_request_message_defaults_optional_legacy_fields() {
        let request: NotebookRequest = serde_json::from_value(serde_json::json!({
            "action": "send_comm",
            "message": {
                "header": { "msg_type": "comm_msg" },
                "content": { "comm_id": "comm-a", "data": {} }
            }
        }))
        .expect("legacy SendComm without optional fields should deserialize");

        let NotebookRequest::SendComm { message } = request else {
            panic!("expected SendComm request");
        };
        assert_eq!(message.parent_header, None);
        assert_eq!(message.metadata, serde_json::json!({}));
        assert!(message.buffers.is_empty());
        assert!(message.buffer_refs.is_empty());
        assert_eq!(message.channel, "shell");
    }

    #[test]
    fn comm_request_message_accepts_ordered_buffer_refs() {
        let request: NotebookRequest = serde_json::from_value(serde_json::json!({
            "action": "send_comm",
            "message": {
                "header": { "msg_type": "comm_msg" },
                "content": { "comm_id": "comm-a", "data": {} },
                "buffer_refs": [
                    {
                        "index": 0,
                        "blob": "abc123",
                        "size": 3,
                        "media_type": "application/octet-stream"
                    }
                ]
            }
        }))
        .expect("SendComm buffer refs should deserialize");

        let NotebookRequest::SendComm { message } = request else {
            panic!("expected SendComm request");
        };
        assert_eq!(
            message.buffer_refs,
            vec![CommBufferRef {
                index: 0,
                blob: "abc123".to_string(),
                size: 3,
                media_type: Some("application/octet-stream".to_string()),
            }]
        );
    }

    #[test]
    fn shutdown_is_sync_prevents_crdt_race() {
        // ShutdownKernel MUST be a sync query. If it were fire-and-forget,
        // the daemon would return immediately and LaunchKernel could set
        // kernel_status="starting" before the agent processes shutdown.
        // Cells queued during env prep would then execute on the dying kernel.
        assert!(
            !RuntimeAgentRequest::ShutdownKernel.is_command(),
            "ShutdownKernel must be sync to prevent CRDT race with LaunchKernel"
        );
    }

    #[test]
    fn correlation_id_preserved_in_envelope_roundtrip() {
        let id = "corr-abc-123";
        let envelope = RuntimeAgentRequestEnvelope {
            id: id.to_string(),
            request: RuntimeAgentRequest::Complete {
                code: "import pa".into(),
                cursor_pos: 9,
            },
        };
        let json = serde_json::to_value(&envelope).unwrap();
        let parsed: RuntimeAgentRequestEnvelope = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.id, id);

        let resp_envelope = RuntimeAgentResponseEnvelope {
            id: id.to_string(),
            response: RuntimeAgentResponse::CompletionResult {
                items: vec![],
                cursor_start: 7,
                cursor_end: 9,
            },
        };
        let resp_json = serde_json::to_value(&resp_envelope).unwrap();
        let parsed_resp: RuntimeAgentResponseEnvelope = serde_json::from_value(resp_json).unwrap();
        assert_eq!(parsed_resp.id, id);
    }
}
