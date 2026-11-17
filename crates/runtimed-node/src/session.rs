//! `Session` — the user-facing handle for a notebook + kernel.
//!
//! Phase 1: minimal surface duplicated from `runtimed-py/src/session_core.rs`.
//! Phase 2 will extract the shared logic into a `runtimed-session` crate
//! and collapse both `-py` and `-node` onto it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde::Serialize;
use tokio::sync::Mutex;

use notebook_protocol::protocol::{NotebookRequest, NotebookResponse};
use notebook_sync::{BroadcastReceiver, DocHandle};
use runtimed_client::client::PoolClient;
use runtimed_outputs::output_resolver as shared_resolver;
use runtimed_outputs::resolved_output::DataValue as SharedDataValue;

use crate::error::to_napi_err;
use crate::kernel_restart::{
    step, KernelObservation, LaunchReply, RestartEvent, RestartPhase, RestartVerdict, TimeoutStage,
};
use runtime_doc::{diff_executions, ExecutionViewProjector, ProjectContext, ProjectFileKind};

/// Valid cell types accepted by `runCell`.
const VALID_CELL_TYPES: &[&str] = &["code", "markdown", "raw"];

type CommMap = std::collections::HashMap<String, runtime_doc::CommDocEntry>;
type JsonCallback =
    ThreadsafeFunction<String, (), FnArgs<(String,)>, napi::Status, false, false, 0>;

// ── Options ────────────────────────────────────────────────────────────

/// Package manager for Python notebook dependencies.
///
/// This mirrors `notebook_protocol::connection::PackageManager` at the N-API
/// boundary. We cannot attach `#[napi]` to the protocol crate's external enum,
/// and that enum intentionally includes an `Unknown(String)` wire-compatibility
/// variant that should not be exposed as a typed JavaScript option.
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageManager {
    Uv,
    Conda,
    Pixi,
}

impl From<PackageManager> for notebook_protocol::connection::PackageManager {
    fn from(value: PackageManager) -> Self {
        match value {
            PackageManager::Uv => Self::Uv,
            PackageManager::Conda => Self::Conda,
            PackageManager::Pixi => Self::Pixi,
        }
    }
}

/// Environment source mode for `createNotebook()`.
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateNotebookEnvironmentMode {
    Auto,
    Project,
    Notebook,
}

impl From<CreateNotebookEnvironmentMode>
    for notebook_protocol::connection::CreateNotebookEnvironmentMode
{
    fn from(value: CreateNotebookEnvironmentMode) -> Self {
        match value {
            CreateNotebookEnvironmentMode::Auto => Self::Auto,
            CreateNotebookEnvironmentMode::Project => Self::Project,
            CreateNotebookEnvironmentMode::Notebook => Self::Notebook,
        }
    }
}

/// Existing Python environment bound to a new notebook room.
///
/// The prefix must be an absolute Conda environment directory with Python and
/// ipykernel. It replaces only the prewarmed fallback: inline dependencies,
/// PEP 723 blocks, a captured environment, and a trusted project file still
/// win. The daemon borrows the prefix and never deletes it.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct LocalEnvironmentOptions {
    pub prefix: String,
}

impl From<LocalEnvironmentOptions> for notebook_protocol::connection::LocalEnvironmentBinding {
    fn from(value: LocalEnvironmentOptions) -> Self {
        Self {
            prefix: PathBuf::from(value.prefix),
        }
    }
}

/// Daemon verdict on a requested `localEnvironment`.
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalEnvironmentBindingState {
    /// The prefix validated and is bound to the room.
    Bound,
    /// The prefix failed validation; the room uses normal auto selection.
    Rejected,
}

/// Verdict on `localEnvironment`, reported by the daemon at creation.
/// Absent when none was requested or the daemon predates the option.
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalEnvironmentStatus {
    pub status: LocalEnvironmentBindingState,
    /// Canonical prefix when bound; the requested prefix when rejected.
    pub prefix: String,
    pub error: Option<String>,
}

impl From<notebook_protocol::connection::LocalEnvironmentBindingStatus> for LocalEnvironmentStatus {
    fn from(value: notebook_protocol::connection::LocalEnvironmentBindingStatus) -> Self {
        use notebook_protocol::connection::LocalEnvironmentBindingStatus as Wire;
        match value {
            Wire::Bound { prefix } => Self {
                status: LocalEnvironmentBindingState::Bound,
                prefix: prefix.to_string_lossy().into_owned(),
                error: None,
            },
            Wire::Rejected { prefix, error } => Self {
                status: LocalEnvironmentBindingState::Rejected,
                prefix: prefix.to_string_lossy().into_owned(),
                error: Some(error),
            },
        }
    }
}

/// Kind of local environment selection target.
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvironmentSelectionTargetKind {
    /// Use the daemon's automatic environment policy.
    Automatic,
    /// Borrow an existing Conda prefix.
    Conda,
    Kernelspec,
}

/// Target for `Session.setEnvironmentSelection()`. `prefix` is required for
/// `"conda"` and ignored for `"automatic"`.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct EnvironmentSelectionTarget {
    pub kind: EnvironmentSelectionTargetKind,
    pub prefix: Option<String>,
    pub name: Option<String>,
}

impl TryFrom<EnvironmentSelectionTarget> for notebook_protocol::protocol::LocalEnvironmentTarget {
    type Error = Error;

    fn try_from(value: EnvironmentSelectionTarget) -> Result<Self> {
        match value.kind {
            EnvironmentSelectionTargetKind::Automatic => Ok(Self::Automatic),
            EnvironmentSelectionTargetKind::Kernelspec => Ok(Self::Kernelspec {
                name: value
                    .name
                    .ok_or_else(|| Error::from_reason("A kernelspec target requires a name"))?,
            }),
            EnvironmentSelectionTargetKind::Conda => value
                .prefix
                .map(|prefix| Self::Conda {
                    prefix: PathBuf::from(prefix),
                })
                .ok_or_else(|| Error::from_reason("A conda target requires a prefix")),
        }
    }
}

/// A validated local Conda environment.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct LocalCondaEnvironmentInfo {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub python_path: String,
    pub python_version: Option<String>,
}

impl From<notebook_protocol::protocol::LocalCondaEnvironment> for LocalCondaEnvironmentInfo {
    fn from(value: notebook_protocol::protocol::LocalCondaEnvironment) -> Self {
        Self {
            id: value.id,
            name: value.name,
            prefix: value.prefix.to_string_lossy().into_owned(),
            python_path: value.python_path.to_string_lossy().into_owned(),
            python_version: value.python_version,
        }
    }
}

/// Daemon-session environment intent, separate from the running kernel.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct EnvironmentSelection {
    pub selected_kernelspec: Option<InstalledKernelspec>,
    pub applied_kernelspec: Option<InstalledKernelspec>,
    /// Pass back as `expectedRevision` to set or apply.
    pub revision: i64,
    /// Staged target. Null means Automatic.
    pub selected: Option<LocalCondaEnvironmentInfo>,
    /// Target the running kernel was applied with. Null means Automatic.
    pub applied: Option<LocalCondaEnvironmentInfo>,
    pub applying: bool,
}

impl From<notebook_protocol::protocol::EnvironmentSelectionSnapshot> for EnvironmentSelection {
    fn from(value: notebook_protocol::protocol::EnvironmentSelectionSnapshot) -> Self {
        Self {
            revision: i64::try_from(value.revision).unwrap_or(i64::MAX),
            selected_kernelspec: value.selected_kernelspec.map(Into::into),
            applied_kernelspec: value.applied_kernelspec.map(Into::into),
            selected: value.selected.map(Into::into),
            applied: value.applied.map(Into::into),
            applying: value.applying,
        }
    }
}

fn environment_selection_response(response: NotebookResponse) -> Result<EnvironmentSelection> {
    match response {
        NotebookResponse::EnvironmentSelection { selection } => Ok(selection.into()),
        NotebookResponse::EnvironmentSelectionRejected { error } => Err(Error::from_reason(error)),
        NotebookResponse::GuardRejected { reason } => Err(Error::from_reason(reason)),
        NotebookResponse::Error { error } => Err(Error::from_reason(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct InstalledKernelspec {
    pub name: String,
    pub display_name: String,
    pub language: String,
}
impl From<notebook_protocol::protocol::InstalledKernelspec> for InstalledKernelspec {
    fn from(s: notebook_protocol::protocol::InstalledKernelspec) -> Self {
        Self {
            name: s.name,
            display_name: s.display_name,
            language: s.language,
        }
    }
}
#[napi(object)]
pub struct KernelspecInventory {
    pub kernelspecs: Vec<InstalledKernelspec>,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

fn expected_revision(revision: i64) -> Result<u64> {
    u64::try_from(revision).map_err(|_| Error::from_reason("expectedRevision must be >= 0"))
}

/// Options for `createNotebook()`.
#[napi(object)]
#[derive(Default)]
pub struct CreateNotebookOptions {
    /// Runtime type: `"python"` or `"deno"`. Defaults to `"python"`.
    pub runtime: Option<String>,
    /// Working directory for the kernel.
    pub working_dir: Option<String>,
    /// Override daemon socket path (otherwise uses `default_socket_path()`).
    pub socket_path: Option<String>,
    /// Actor label for presence / Automerge provenance.
    pub peer_label: Option<String>,
    /// Human-readable session description. Used as the peer label when `peerLabel` is omitted.
    pub description: Option<String>,
    /// Packages to record before the kernel starts (for example `["numpy", "matplotlib"]`).
    /// Python notebooks use the selected package manager; Deno notebooks treat these as
    /// runtime-native import dependencies.
    pub dependencies: Option<Vec<String>>,
    /// Package manager for Python dependencies. Defaults to the daemon/user setting.
    pub package_manager: Option<PackageManager>,
    /// Environment source mode. Defaults to auto.
    pub environment_mode: Option<CreateNotebookEnvironmentMode>,
    /// Existing environment prefix to use instead of the prewarmed fallback.
    pub local_environment: Option<LocalEnvironmentOptions>,
}

/// Options for `openNotebook()` and `openNotebookPath()`.
#[napi(object)]
#[derive(Default)]
pub struct OpenNotebookOptions {
    pub socket_path: Option<String>,
    pub peer_label: Option<String>,
    /// Human-readable session description. Used as the peer label when `peerLabel` is omitted.
    pub description: Option<String>,
}

/// Options for dependency edit methods.
#[napi(object)]
#[derive(Default)]
pub struct DependencyEditOptions {
    /// Dependency manager to edit. Defaults to the running/configured manager,
    /// falling back to UV for fresh Python notebooks.
    pub package_manager: Option<PackageManager>,
}

/// UV dependency metadata.
#[napi(object)]
pub struct UvDependencyStatus {
    pub dependencies: Vec<String>,
    pub requires_python: Option<String>,
}

/// Conda dependency metadata.
#[napi(object)]
pub struct CondaDependencyStatus {
    pub dependencies: Vec<String>,
    pub channels: Vec<String>,
    pub python: Option<String>,
}

/// Pixi dependency metadata.
#[napi(object)]
pub struct PixiDependencyStatus {
    pub dependencies: Vec<String>,
    pub pypi_dependencies: Vec<String>,
    pub channels: Vec<String>,
    pub python: Option<String>,
}

/// Notebook trust state for dependency metadata.
#[napi(object)]
pub struct DependencyTrustStatus {
    pub status: Option<String>,
    pub needs_approval: Option<bool>,
    pub approved_uv_dependencies: Vec<String>,
    pub approved_conda_dependencies: Vec<String>,
    pub approved_pixi_dependencies: Vec<String>,
    pub approved_pixi_pypi_dependencies: Vec<String>,
}

/// What trusting a project folder lets uv, pixi, or conda do. Parsed from
/// the manifest only; no tool runs to produce it.
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTrustSummaryStatus {
    pub dependencies: Vec<String>,
    pub non_registry_sources: Vec<String>,
    pub indexes_and_channels: Vec<String>,
    pub build_backend: Option<String>,
    pub activation_scripts: Vec<String>,
    pub outside_directory: Vec<String>,
    pub environment_to_build: Option<String>,
}

/// Project-folder trust for the project file that would drive the
/// environment. When `lifecycle` is `"AwaitingProjectTrust"`, pass
/// `projectDir` (or an ancestor such as `repoRoot`) to
/// `approveProjectTrust()` or `declineProjectTrust()`.
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTrustStatus {
    /// `"no_project"`, `"trusted"`, `"untrusted"`, or `"notebook_env"`.
    /// Absent until the daemon evaluates the room.
    pub status: Option<String>,
    pub needs_approval: bool,
    pub manifest_path: Option<String>,
    /// `"pyproject_toml"`, `"pixi_toml"`, or `"environment_yml"`.
    pub kind: Option<String>,
    pub project_dir: Option<String>,
    pub repo_root: Option<String>,
    pub trusted_dir: Option<String>,
    pub summary: ProjectTrustSummaryStatus,
}

impl From<runtime_doc::ProjectTrustRuntimeState> for ProjectTrustStatus {
    fn from(state: runtime_doc::ProjectTrustRuntimeState) -> Self {
        let non_empty = |value: String| (!value.is_empty()).then_some(value);
        Self {
            status: non_empty(state.status),
            needs_approval: state.needs_approval,
            manifest_path: non_empty(state.manifest_path),
            kind: non_empty(state.kind),
            project_dir: non_empty(state.project_dir),
            repo_root: state.repo_root,
            trusted_dir: state.trusted_dir,
            summary: ProjectTrustSummaryStatus {
                dependencies: state.summary.dependencies,
                non_registry_sources: state.summary.non_registry_sources,
                indexes_and_channels: state.summary.indexes_and_channels,
                build_backend: state.summary.build_backend,
                activation_scripts: state.summary.activation_scripts,
                outside_directory: state.summary.outside_directory,
                environment_to_build: state.summary.environment_to_build,
            },
        }
    }
}

/// Notebook dependency metadata and trust/runtime status.
#[napi(object)]
pub struct DependencyStatus {
    pub uv: Option<UvDependencyStatus>,
    pub conda: Option<CondaDependencyStatus>,
    pub pixi: Option<PixiDependencyStatus>,
    pub pep723_dependencies: Vec<String>,
    pub fingerprint: Option<String>,
    pub trust: DependencyTrustStatus,
    pub project_trust: ProjectTrustStatus,
}

/// Runtime/kernel status from RuntimeStateDoc.
#[napi(object)]
pub struct RuntimeStatus {
    pub status: String,
    pub lifecycle: String,
    pub activity: Option<String>,
    pub starting_phase: String,
    pub name: String,
    pub language: String,
    /// Active identity fields are empty unless lifecycle is Running.
    pub env_source: String,
    pub runtime_agent_id: String,
    pub environment_id: String,
    pub environment_name: String,
    pub python_version: String,
    pub error_reason: Option<String>,
    pub error_details: Option<String>,
    pub project_trust: ProjectTrustStatus,
}

/// Daemon verdict for `Session.syncEnvironmentResult()`.
///
/// `status` is `"applied"`, `"restart_required"`, or `"failed"`.
/// `nextAction` is `"none"`, `"restart"`, or `"inspect"` respectively.
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvironmentSyncResult {
    pub status: String,
    /// Packages the daemon installed into the running kernel.
    pub synced_packages: Vec<String>,
    pub needs_restart: bool,
    pub error: Option<String>,
    pub next_action: String,
}

impl EnvironmentSyncResult {
    fn applied(synced_packages: Vec<String>) -> Self {
        Self {
            status: "applied".into(),
            synced_packages,
            needs_restart: false,
            error: None,
            next_action: "none".into(),
        }
    }

    fn restart_required(error: String) -> Self {
        Self {
            status: "restart_required".into(),
            synced_packages: Vec::new(),
            needs_restart: true,
            error: Some(error),
            next_action: "restart".into(),
        }
    }

    fn failed(error: String) -> Self {
        Self {
            status: "failed".into(),
            synced_packages: Vec::new(),
            needs_restart: false,
            error: Some(error),
            next_action: "inspect".into(),
        }
    }
}

/// Options for `Session.restartKernel()` and `Session.restartKernelResult()`.
#[napi(object)]
#[derive(Default)]
pub struct RestartKernelOptions {
    /// Bound in milliseconds for each confirmation wait: the old kernel
    /// observed stopped, then a matching kernel observed running. Default 30_000.
    /// The daemon's LaunchKernel request keeps its own deadline.
    pub timeout_ms: Option<u32>,
}

/// Result of `Session.restartKernelResult()`.
///
/// `outcome` is one of `"running"`, `"trust_required"`, `"launch_rejected"`,
/// `"failed"`, `"stopped"`, or `"timed_out"`. `"trust_required"` comes only
/// from the daemon's typed `GuardRejected` launch reply: notebook dependencies
/// or the project folder need approval.
#[napi(object)]
pub struct KernelRestartResult {
    pub outcome: String,
    pub error: Option<String>,
    /// envSource the daemon reported for the accepted launch.
    pub launched_env_source: Option<String>,
    /// This client's RuntimeStateDoc view when the restart finished. It is
    /// an observed matching running kernel only when `outcome` is `"running"`.
    /// A rejection returns as soon as the reply arrives, so this view may not
    /// yet show the daemon's matching state, such as `AwaitingProjectTrust`.
    /// No launch generation exists; a peer restart of the same environment
    /// cannot be distinguished from this call's launch.
    pub status: RuntimeStatus,
}

/// Options for `Session.runCell()`.
#[napi(object)]
#[derive(Default)]
pub struct RunCellOptions {
    /// Max milliseconds to wait for execution. Default 120_000 (2 min).
    pub timeout_ms: Option<u32>,
    /// Cell source type: `"code"` (default), `"markdown"`, or `"raw"`.
    pub cell_type: Option<String>,
}

/// Options for `Session.createCell()`.
#[napi(object)]
#[derive(Default)]
pub struct CreateCellOptions {
    /// Cell source type: `"code"` (default), `"markdown"`, or `"raw"`.
    pub cell_type: Option<String>,
    /// Insert after this cell, or omit to append at the end.
    pub after_cell_id: Option<String>,
    /// Position to insert at. Omit to append; 0 prepends; out-of-range appends.
    /// Cannot be combined with `afterCellId`.
    pub index: Option<i64>,
}

/// Options for `Session.setCell()`.
#[napi(object)]
#[derive(Default)]
pub struct SetCellOptions {
    /// New source text. Omit to leave unchanged.
    pub source: Option<String>,
    /// New cell source type. Omit to leave unchanged.
    pub cell_type: Option<String>,
}

/// Options for `Session.moveCell()`.
#[napi(object)]
#[derive(Default)]
pub struct MoveCellOptions {
    /// Move after this cell, or omit/null to move to the beginning.
    pub after_cell_id: Option<String>,
}

/// Options for `Session.executeCell()`.
#[napi(object)]
#[derive(Default)]
pub struct ExecuteCellOptions {
    /// Max milliseconds to wait for execution. Default 120_000 (2 min).
    pub timeout_ms: Option<u32>,
}

/// Options for `Session.queueCell()`.
#[napi(object)]
#[derive(Default)]
pub struct QueueCellOptions {
    /// Cell source type: `"code"` (default), `"markdown"`, or `"raw"`.
    pub cell_type: Option<String>,
}

/// Options for `Session.waitForExecution()`.
#[napi(object)]
#[derive(Default)]
pub struct WaitExecutionOptions {
    /// Cell ID to use when reporting kernel failures before terminal state syncs.
    pub cell_id: Option<String>,
    /// Max milliseconds to wait for execution. Default 120_000 (2 min).
    pub timeout_ms: Option<u32>,
}

/// Options for top-level `getExecutionResult()`.
#[napi(object)]
#[derive(Default)]
pub struct GetExecutionResultOptions {
    /// Override daemon socket path (otherwise uses `defaultSocketPath()`).
    pub socket_path: Option<String>,
}

/// Options for top-level `listActiveNotebooks()`.
#[napi(object)]
#[derive(Default)]
pub struct ListActiveNotebooksOptions {
    /// Override daemon socket path (otherwise uses `defaultSocketPath()`).
    pub socket_path: Option<String>,
}

/// Options for top-level `shutdownNotebook()`.
#[napi(object)]
#[derive(Default)]
pub struct ShutdownNotebookOptions {
    /// Override daemon socket path (otherwise uses `defaultSocketPath()`).
    pub socket_path: Option<String>,
}

/// Options for top-level `showNotebook()`.
#[napi(object)]
#[derive(Default)]
pub struct ShowNotebookOptions {
    /// Override daemon socket path (otherwise uses `defaultSocketPath()`).
    pub socket_path: Option<String>,
    /// Active notebook UUID to open in the app.
    pub notebook_id: Option<String>,
    /// File path to open in the app. If both path and notebookId are provided, path wins.
    pub path: Option<String>,
}

/// A queued execution handle.
#[napi(object)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedExecution {
    pub cell_id: String,
    pub execution_id: String,
}

/// An active notebook room reported by the daemon.
#[napi(object)]
pub struct ActiveNotebook {
    pub notebook_id: String,
    pub active_peers: u32,
    pub had_peers: bool,
    pub has_kernel: bool,
    pub kernel_type: Option<String>,
    pub env_source: Option<String>,
    pub kernel_status: Option<String>,
    pub ephemeral: bool,
    pub notebook_path: Option<String>,
}

/// Result of asking nteract Desktop to show a notebook.
#[napi(object)]
pub struct ShowNotebookResult {
    pub notebook_id: Option<String>,
    pub path: Option<String>,
    pub opened: bool,
    pub reason: Option<String>,
    pub warning: Option<String>,
}

/// A notebook cell snapshot.
#[napi(object)]
pub struct JsCellSnapshot {
    pub id: String,
    pub cell_type: String,
    pub position: String,
    pub source: String,
    /// JSON-encoded metadata object.
    pub metadata_json: String,
    /// Legacy execution count as stored in the notebook doc.
    pub execution_count: Option<String>,
}

// ── Outputs (serialized to JS via serde_json) ──────────────────────────

/// One output from a cell. `data` values are: `{ type: "text"|"binary"|"json", value: ... }`.
#[napi(object)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsOutput {
    pub output_type: String,
    pub name: Option<String>,
    pub text: Option<String>,
    /// MIME-keyed map, serialized via JSON. Binary values become base64 strings.
    pub data_json: Option<String>,
    pub ename: Option<String>,
    pub evalue: Option<String>,
    pub traceback: Option<Vec<String>>,
    pub execution_count: Option<i64>,
    pub blob_urls_json: Option<String>,
    pub blob_paths_json: Option<String>,
}

/// Result of running a cell.
#[napi(object)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellResult {
    pub cell_id: String,
    pub execution_id: String,
    pub execution_count: Option<i64>,
    /// One of: `"done"`, `"error"`, `"timeout"`, `"kernel_error"`.
    pub status: String,
    pub success: bool,
    pub outputs: Vec<JsOutput>,
}

/// Serialized notebook + runtime-state + comms snapshots for hosted publishing.
#[napi(object)]
pub struct SnapshotPair {
    pub notebook_id: String,
    pub notebook_bytes: Buffer,
    pub runtime_state_bytes: Buffer,
    pub comms_doc_bytes: Buffer,
    pub notebook_heads: Vec<String>,
    pub runtime_state_heads: Vec<String>,
    pub comms_doc_heads: Vec<String>,
    pub blob_base_url: Option<String>,
    pub blob_store_path: Option<String>,
}

// ── Internal state ─────────────────────────────────────────────────────

struct SessionState {
    handle: Option<DocHandle>,
    /// Kept alive so the daemon doesn't close the broadcast channel.
    /// Dropped on `close()` to allow clean teardown.
    _broadcast_rx: Option<BroadcastReceiver>,
    runtime: String,
    blob_base_url: Option<String>,
    blob_store_path: Option<PathBuf>,
    #[allow(dead_code)]
    socket_path: PathBuf,
    working_dir: Option<String>,
    peer_label: String,
}

struct OutputResolutionContext<'a> {
    comms: Option<&'a CommMap>,
    blob_base_url: &'a Option<String>,
    blob_store_path: &'a Option<PathBuf>,
}

struct ExecutionResultParts<'a> {
    execution_id: &'a str,
    cell_id: &'a str,
    status: &'a str,
    success: bool,
    execution_count: Option<i64>,
    output_manifests: &'a [serde_json::Value],
}

// ── Session ────────────────────────────────────────────────────────────

/// A connected notebook session.
#[napi]
pub struct Session {
    notebook_id: String,
    local_environment: Option<LocalEnvironmentStatus>,
    state: Arc<Mutex<SessionState>>,
    closed_tx: tokio::sync::watch::Sender<bool>,
}

/// A live event subscription returned by `Session.on*` methods.
#[napi]
pub struct EventSubscription {
    task: Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

#[napi]
impl EventSubscription {
    /// Stop delivering events to the callback.
    #[napi]
    pub fn dispose(&self) {
        if let Ok(mut task) = self.task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

impl Drop for EventSubscription {
    fn drop(&mut self) {
        if let Ok(mut task) = self.task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

impl EventSubscription {
    pub(crate) fn new(task: tokio::task::JoinHandle<()>) -> Self {
        Self {
            task: Arc::new(std::sync::Mutex::new(Some(task))),
        }
    }
}

/// Spawns subscription watchers on the napi-managed Tokio runtime.
///
/// The `Session.on*` methods are synchronous N-API entry points, so they cannot
/// rely on an ambient Tokio task context being present on the calling thread.
pub(crate) fn spawn_event_task<F>(future: F) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    napi::bindgen_prelude::spawn(future)
}

fn json_callback(callback: Function<'_, (String,), ()>) -> Result<JsonCallback> {
    callback
        .build_threadsafe_function::<String>()
        .callee_handled::<false>()
        .build_callback(|ctx| Ok(FnArgs::from((ctx.value,))))
}

fn emit_json<T: Serialize>(callback: &JsonCallback, value: &T) {
    if let Ok(json) = serde_json::to_string(value) {
        let _ = callback.call(json, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

#[napi]
impl Session {
    /// The notebook ID (always a UUID).
    #[napi(getter)]
    pub fn notebook_id(&self) -> String {
        self.notebook_id.clone()
    }

    /// Daemon verdict on `createNotebook({ localEnvironment })`. Null for
    /// opened sessions, when none was requested, or on older daemons.
    #[napi(getter)]
    pub fn local_environment(&self) -> Option<LocalEnvironmentStatus> {
        self.local_environment.clone()
    }

    /// Subscribe to RuntimeStateDoc snapshots. Callback receives a JSON string.
    #[napi]
    pub fn on_runtime_state(
        &self,
        callback: Function<'_, (String,), ()>,
    ) -> Result<EventSubscription> {
        let handle = {
            let st = self
                .state
                .try_lock()
                .map_err(|_| Error::from_reason("Session state busy"))?;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        let mut rx = handle.subscribe_runtime_state();
        let tsfn = json_callback(callback)?;
        let task = spawn_event_task(async move {
            emit_json(&tsfn, &*rx.borrow_and_update());
            while rx.changed().await.is_ok() {
                emit_json(&tsfn, &*rx.borrow_and_update());
            }
        });
        Ok(EventSubscription::new(task))
    }

    /// Subscribe to execution lifecycle transitions. Callback receives a JSON string.
    #[napi]
    pub fn on_execution_transition(
        &self,
        callback: Function<'_, (String,), ()>,
    ) -> Result<EventSubscription> {
        let handle = {
            let st = self
                .state
                .try_lock()
                .map_err(|_| Error::from_reason("Session state busy"))?;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        let mut rx = handle.subscribe_runtime_state();
        let tsfn = json_callback(callback)?;
        let task = spawn_event_task(async move {
            let mut prev = rx.borrow_and_update().executions.clone();
            while rx.changed().await.is_ok() {
                let curr = rx.borrow_and_update().executions.clone();
                for transition in diff_executions(&prev, &curr) {
                    emit_json(&tsfn, &transition);
                }
                prev = curr;
            }
        });
        Ok(EventSubscription::new(task))
    }

    /// Subscribe to shared execution-view changes. Callback receives a JSON string.
    #[napi]
    pub fn on_execution_view_change(
        &self,
        callback: Function<'_, (String,), ()>,
    ) -> Result<EventSubscription> {
        let handle = {
            let st = self
                .state
                .try_lock()
                .map_err(|_| Error::from_reason("Session state busy"))?;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        let mut notebook_rx = handle.subscribe();
        let mut runtime_rx = handle.subscribe_runtime_state();
        let tsfn = json_callback(callback)?;
        let task = spawn_event_task(async move {
            let mut projector = ExecutionViewProjector::default();
            let state = runtime_rx.borrow().clone();
            let changeset = match handle.get_cell_execution_pointers() {
                Ok(cell_pointers) => projector.project_all(cell_pointers, &state),
                Err(_) => projector.project_runtime(&state),
            };
            if !changeset.is_empty() {
                emit_json(&tsfn, &changeset);
            }

            loop {
                tokio::select! {
                    changed = notebook_rx.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        let state = runtime_rx.borrow_and_update().clone();
                        let changeset = match handle.get_cell_execution_pointers() {
                            Ok(cell_pointers) => projector.project_all(cell_pointers, &state),
                            Err(_) => {
                                projector.reset();
                                projector.project_runtime(&state)
                            }
                        };
                        if !changeset.is_empty() {
                            emit_json(&tsfn, &changeset);
                        }
                    }
                    changed = runtime_rx.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        let state = runtime_rx.borrow_and_update().clone();
                        let changeset = projector.project_runtime(&state);
                        if !changeset.is_empty() {
                            emit_json(&tsfn, &changeset);
                        }
                    }
                }
            }
        });
        Ok(EventSubscription::new(task))
    }

    /// Subscribe to resolved progress snapshots for one execution.
    ///
    /// Callback receives the same JSON shape as `CellResult`, emitted whenever
    /// the RuntimeStateDoc entry for the execution changes. The subscription
    /// ends after a terminal execution snapshot, kernel failure after the
    /// execution has been observed, or connection close. An execution that
    /// never appears stays pending until the subscription is disposed or the
    /// connection closes.
    #[napi]
    pub fn on_execution_progress(
        &self,
        execution_id: String,
        cell_id: Option<String>,
        callback: Function<'_, (String,), ()>,
    ) -> Result<EventSubscription> {
        let (handle, blob_base_url, blob_store_path) = {
            let st = self
                .state
                .try_lock()
                .map_err(|_| Error::from_reason("Session state busy"))?;
            (
                st.handle
                    .as_ref()
                    .ok_or_else(|| Error::from_reason("Not connected"))?
                    .clone(),
                st.blob_base_url.clone(),
                st.blob_store_path.clone(),
            )
        };
        let tsfn = json_callback(callback)?;
        let task = spawn_event_task(async move {
            let fallback_cell_id = cell_id.unwrap_or_default();
            let mut watcher =
                notebook_sync::ExecutionWatcher::new(&handle, fallback_cell_id, execution_id);
            while let Some(progress) = watcher.next().await {
                let comms = handle.get_runtime_state().ok().map(|rs| rs.comms);
                if let Ok(result) = cell_result_from_execution_progress(
                    &progress,
                    comms.as_ref(),
                    &blob_base_url,
                    &blob_store_path,
                )
                .await
                {
                    emit_json(&tsfn, &result);
                }
                if progress.terminal {
                    break;
                }
            }
        });
        Ok(EventSubscription::new(task))
    }

    /// Subscribe to notebook document changes. Callback receives a JSON string.
    ///
    /// The native handle currently reports `null` as a full-materialization
    /// marker, matching the browser SyncEngine's no-changeset fallback.
    #[napi]
    pub fn on_cell_change(
        &self,
        callback: Function<'_, (String,), ()>,
    ) -> Result<EventSubscription> {
        let handle = {
            let st = self
                .state
                .try_lock()
                .map_err(|_| Error::from_reason("Session state busy"))?;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        let mut rx = handle.subscribe();
        let tsfn = json_callback(callback)?;
        let task = spawn_event_task(async move {
            while rx.changed().await.is_ok() {
                let _ = tsfn.call("null".to_string(), ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
        Ok(EventSubscription::new(task))
    }

    /// Subscribe to comm broadcasts. Callback receives a JSON string.
    #[napi]
    pub fn on_broadcast(&self, callback: Function<'_, (String,), ()>) -> Result<EventSubscription> {
        let mut rx = {
            let st = self
                .state
                .try_lock()
                .map_err(|_| Error::from_reason("Session state busy"))?;
            st._broadcast_rx
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .resubscribe()
        };
        let tsfn = json_callback(callback)?;
        let task = spawn_event_task(async move {
            while let Some(broadcast) = rx.recv().await {
                emit_json(&tsfn, &broadcast);
            }
        });
        Ok(EventSubscription::new(task))
    }

    /// Subscribe to handshake/readiness status updates. Callback receives a JSON string.
    #[napi]
    pub fn on_session_status(
        &self,
        callback: Function<'_, (String,), ()>,
    ) -> Result<EventSubscription> {
        let handle = {
            let st = self
                .state
                .try_lock()
                .map_err(|_| Error::from_reason("Session state busy"))?;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        let mut rx = handle.subscribe_status();
        let tsfn = json_callback(callback)?;
        let task = spawn_event_task(async move {
            emit_json(&tsfn, &*rx.borrow_and_update());
            while rx.changed().await.is_ok() {
                emit_json(&tsfn, &*rx.borrow_and_update());
            }
        });
        Ok(EventSubscription::new(task))
    }

    /// Save the notebook to disk. If a path is given, saves to that path
    /// (creating the file if needed). Otherwise saves to the original location.
    #[napi]
    pub async fn save_notebook(&self, path: Option<String>) -> Result<()> {
        let handle = {
            let st = self.state.lock().await;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        handle.confirm_sync().await.map_err(to_napi_err)?;
        let response = handle
            .send_request(NotebookRequest::SaveNotebook {
                format_cells: false,
                path,
            })
            .await
            .map_err(to_napi_err)?;
        match response {
            NotebookResponse::NotebookSaved { .. }
            | NotebookResponse::NotebookAlreadyCurrent { .. } => Ok(()),
            NotebookResponse::NotebookSaveBlocked { reason, .. } => {
                Err(Error::from_reason(format!("Save blocked: {reason:?}")))
            }
            NotebookResponse::Error { error } => Err(Error::from_reason(error)),
            other => Err(Error::from_reason(format!(
                "Unexpected response: {other:?}"
            ))),
        }
    }

    /// Export the live synced notebook, runtime-state, and comms documents.
    ///
    /// This waits for all document channels to converge with the daemon
    /// before serializing, so hosted publish clients can upload a coherent
    /// `NotebookDoc` + `RuntimeStateDoc` + `CommsDoc` snapshot triplet.
    #[napi]
    pub async fn export_snapshot_pair(&self) -> Result<SnapshotPair> {
        let (handle, blob_base_url, blob_store_path) = {
            let st = self.state.lock().await;
            (
                st.handle
                    .as_ref()
                    .ok_or_else(|| Error::from_reason("Not connected"))?
                    .clone(),
                st.blob_base_url.clone(),
                st.blob_store_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
            )
        };
        handle.confirm_sync().await.map_err(to_napi_err)?;
        handle.confirm_state_sync().await.map_err(to_napi_err)?;
        let snapshot = handle.save_snapshot_pair().map_err(to_napi_err)?;
        Ok(SnapshotPair {
            notebook_id: self.notebook_id.clone(),
            notebook_bytes: snapshot.notebook_bytes.into(),
            runtime_state_bytes: snapshot.runtime_state_bytes.into(),
            comms_doc_bytes: snapshot.comms_doc_bytes.into(),
            notebook_heads: snapshot.notebook_heads,
            runtime_state_heads: snapshot.runtime_state_heads,
            comms_doc_heads: snapshot.comms_doc_heads,
            blob_base_url,
            blob_store_path,
        })
    }

    /// Acknowledge the current NotebookDoc frontier at the connected daemon.
    /// Returns the captured heads; later edits are not covered. Rejects on
    /// timeout, close, disconnect, unsupported peers, or daemon rejection.
    /// This does not save an .ipynb or acknowledge other document streams.
    #[napi]
    pub async fn confirm_notebook_sync(&self) -> Result<Vec<String>> {
        let mut closed_rx = self.closed_tx.subscribe();
        let handle = session_handle(&self.state).await?;
        tokio::select! {
            biased;
            _ = closed_rx.wait_for(|closed| *closed) => {
                Err(Error::from_reason("Session closed before notebook sync acknowledgement"))
            }
            result = handle.confirm_notebook_sync() => result.map_err(to_napi_err),
        }
    }

    /// Close the session and release the underlying connection.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        let mut st = self.state.lock().await;
        self.closed_tx.send_replace(true);
        st.handle = None;
        st._broadcast_rx = None;
        Ok(())
    }

    /// Add dependencies to the selected package manager in one CRDT transaction.
    /// When no manager is provided, the running/configured notebook manager is used.
    /// Call `syncEnvironment()` or restart the kernel to install them.
    #[napi]
    pub async fn add_dependencies(
        &self,
        packages: Vec<String>,
        options: Option<DependencyEditOptions>,
    ) -> Result<()> {
        let handle = session_handle(&self.state).await?;
        let runtime_state = handle.get_runtime_state().ok();
        handle
            .with_metadata(|snapshot| {
                let package_manager =
                    dependency_package_manager(options, runtime_state.as_ref(), snapshot);
                for pkg in &packages {
                    match package_manager {
                        PackageManager::Uv => snapshot.add_uv_dependency(pkg),
                        PackageManager::Conda => snapshot.add_conda_dependency(pkg),
                        PackageManager::Pixi => snapshot.add_pixi_dependency(pkg),
                    }
                }
            })
            .map_err(to_napi_err)?;
        approve_current_trust(&handle, None, false).await
    }

    /// Add a dependency to the selected package manager.
    /// When no manager is provided, the running/configured notebook manager is used.
    /// Call `syncEnvironment()` or restart the kernel to install it.
    #[napi]
    pub async fn add_dependency(
        &self,
        pkg: String,
        options: Option<DependencyEditOptions>,
    ) -> Result<()> {
        self.add_dependencies(vec![pkg], options).await
    }

    /// Remove dependencies from the selected package manager in one CRDT transaction.
    /// When no manager is provided, the running/configured notebook manager is used.
    /// Returns the number of dependencies removed.
    #[napi]
    pub async fn remove_dependencies(
        &self,
        packages: Vec<String>,
        options: Option<DependencyEditOptions>,
    ) -> Result<u32> {
        let handle = session_handle(&self.state).await?;
        let runtime_state = handle.get_runtime_state().ok();
        let removed = handle
            .with_metadata(|snapshot| {
                let package_manager =
                    dependency_package_manager(options, runtime_state.as_ref(), snapshot);
                packages
                    .iter()
                    .filter(|pkg| match package_manager {
                        PackageManager::Uv => snapshot.remove_uv_dependency(pkg),
                        PackageManager::Conda => snapshot.remove_conda_dependency(pkg),
                        PackageManager::Pixi => snapshot.remove_pixi_dependency(pkg),
                    })
                    .count()
            })
            .map_err(to_napi_err)?;
        if removed > 0 {
            approve_current_trust(&handle, None, false).await?;
        }
        Ok(removed.try_into().unwrap_or(u32::MAX))
    }

    /// Remove a dependency from the selected package manager.
    /// When no manager is provided, the running/configured notebook manager is used.
    /// Returns true if a dependency was removed.
    #[napi]
    pub async fn remove_dependency(
        &self,
        pkg: String,
        options: Option<DependencyEditOptions>,
    ) -> Result<bool> {
        Ok(self.remove_dependencies(vec![pkg], options).await? > 0)
    }

    /// Add a UV dependency to the notebook (e.g. `"matplotlib>=3.8"`).
    /// Call `syncEnvironment()` or restart the kernel to install it.
    #[napi]
    pub async fn add_uv_dependency(&self, pkg: String) -> Result<()> {
        self.add_dependency(
            pkg,
            Some(DependencyEditOptions {
                package_manager: Some(PackageManager::Uv),
            }),
        )
        .await
    }

    /// Get runtime/kernel state, including lifecycle error details.
    #[napi]
    pub async fn get_runtime_status(&self) -> Result<RuntimeStatus> {
        let handle = session_handle(&self.state).await?;
        Ok(runtime_status_for_handle(&handle))
    }

    /// Get dependency metadata, fingerprint, and current trust state.
    #[napi]
    pub async fn get_dependency_status(&self) -> Result<DependencyStatus> {
        let handle = session_handle(&self.state).await?;
        Ok(dependency_status_for_handle(&handle))
    }

    /// Get the current dependency fingerprint for diagnostics.
    #[napi]
    pub async fn dependency_fingerprint(&self) -> Result<Option<String>> {
        let handle = session_handle(&self.state).await?;
        Ok(dependency_fingerprint_for_handle(&handle))
    }

    /// Approve and sign the current dependency metadata.
    #[napi]
    pub async fn approve_trust(&self, observed_heads: Option<Vec<String>>) -> Result<()> {
        let handle = {
            let st = self.state.lock().await;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        approve_current_trust(&handle, observed_heads, true).await
    }

    /// Trust a folder so project files at or below it may drive uv, pixi,
    /// or conda on this machine. `directory` must be the project file's
    /// folder or an ancestor of it. The daemon releases a room parked at
    /// `AwaitingProjectTrust`; launch the kernel afterwards.
    #[napi]
    pub async fn approve_project_trust(&self, directory: String) -> Result<()> {
        let handle = session_handle(&self.state).await?;
        send_project_trust_decision(&handle, NotebookRequest::ApproveProjectTrust { directory })
            .await
    }

    /// Use the notebook's own environment instead of the project file in
    /// `directory`. With `remember`, the choice persists for that folder on
    /// this machine; otherwise it lasts for this room. Launch afterwards.
    #[napi]
    pub async fn decline_project_trust(
        &self,
        directory: String,
        remember: Option<bool>,
    ) -> Result<()> {
        let handle = session_handle(&self.state).await?;
        send_project_trust_decision(
            &handle,
            NotebookRequest::DeclineProjectTrust {
                directory,
                remember: remember.unwrap_or(false),
            },
        )
        .await
    }

    #[napi]
    pub async fn list_installed_kernelspecs(&self) -> Result<KernelspecInventory> {
        let handle = session_handle(&self.state).await?;
        if !handle.supports_installed_kernelspecs() {
            return Err(Error::from_reason(
                "Daemon does not support installed kernelspecs",
            ));
        }
        match handle
            .send_request(NotebookRequest::ListInstalledKernelspecs {})
            .await
            .map_err(to_napi_err)?
        {
            NotebookResponse::InstalledKernelspecs { inventory } => Ok(KernelspecInventory {
                kernelspecs: inventory.kernelspecs.into_iter().map(Into::into).collect(),
                warnings: inventory.warnings,
                truncated: inventory.truncated,
            }),
            NotebookResponse::Error { error }
            | NotebookResponse::EnvironmentSelectionRejected { error } => {
                Err(Error::from_reason(error))
            }
            other => Err(Error::from_reason(format!(
                "Unexpected response: {other:?}"
            ))),
        }
    }

    /// Read the staged and applied local environment selection.
    #[napi]
    pub async fn get_environment_selection(&self) -> Result<EnvironmentSelection> {
        let handle = session_handle(&self.state).await?;
        environment_selection_response(
            handle
                .send_request(NotebookRequest::GetEnvironmentSelection {})
                .await
                .map_err(to_napi_err)?,
        )
    }

    /// Stage a local environment target. Does not touch the running kernel;
    /// call `applyEnvironmentSelection()` to launch with it.
    #[napi]
    pub async fn set_environment_selection(
        &self,
        target: EnvironmentSelectionTarget,
        expected_revision: i64,
    ) -> Result<EnvironmentSelection> {
        let target = target.try_into()?;
        let expected_revision = self::expected_revision(expected_revision)?;
        let handle = session_handle(&self.state).await?;
        if matches!(
            &target,
            notebook_protocol::protocol::LocalEnvironmentTarget::Kernelspec { .. }
        ) && !handle.supports_installed_kernelspecs()
        {
            return Err(Error::from_reason(
                "Daemon does not support installed kernelspecs",
            ));
        }
        environment_selection_response(
            handle
                .send_request(NotebookRequest::SetEnvironmentSelection {
                    target,
                    expected_revision,
                })
                .await
                .map_err(to_napi_err)?,
        )
    }

    /// Start or restart the kernel with the staged selection after trust
    /// checks. `observedHeads` defaults to this session's current heads.
    #[napi]
    pub async fn apply_environment_selection(
        &self,
        expected_revision: i64,
        observed_heads: Option<Vec<String>>,
    ) -> Result<EnvironmentSelection> {
        let expected_revision = self::expected_revision(expected_revision)?;
        let handle = session_handle(&self.state).await?;
        handle.confirm_sync().await.map_err(to_napi_err)?;
        let observed_heads = match observed_heads {
            Some(heads) => heads,
            None => handle.current_heads_hex().map_err(to_napi_err)?,
        };
        environment_selection_response(
            handle
                .send_request_after_heads(
                    NotebookRequest::ApplyEnvironmentSelection {
                        expected_revision,
                        observed_heads: observed_heads.clone(),
                    },
                    observed_heads,
                )
                .await
                .map_err(to_napi_err)?,
        )
    }

    /// Ask the daemon to hot-install any pending dependency changes into
    /// the running kernel's env. Starts the kernel first if needed.
    /// Resolves once the install finishes; rejects with the daemon's error
    /// for every other verdict. Use `syncEnvironmentResult()` to tell a
    /// required restart apart from a failure.
    #[napi]
    pub async fn sync_environment(&self) -> Result<()> {
        let result = self.sync_environment_result().await?;
        match result.error {
            Some(error) if result.status != "applied" => Err(Error::from_reason(error)),
            _ => Ok(()),
        }
    }

    /// Ask the daemon to hot-install pending dependency changes and return
    /// its verdict as a value. Never restarts a running kernel: when the
    /// daemon cannot hot-apply (removals, channel or manager changes, project
    /// file updates), the result is `restart_required`. Joins or starts a
    /// launch first only when no kernel is running. Rejects when the session
    /// is not connected, the connection drops, or the daemon replies with an
    /// unexpected response; the daemon-side effect is then unknown.
    #[napi]
    pub async fn sync_environment_result(&self) -> Result<EnvironmentSyncResult> {
        // Environment sync cannot queue during launch like code execution can.
        // Join the daemon's launch request so the kernel is ready first.
        if let Some(failed) = sync_launch_failure(send_launch_kernel(&self.state).await?)? {
            return Ok(failed);
        }
        let handle = session_handle(&self.state).await?;
        handle.confirm_sync().await.map_err(to_napi_err)?;
        let response = handle
            .send_request(NotebookRequest::SyncEnvironment { guard: None })
            .await
            .map_err(to_napi_err)?;
        environment_sync_result_from_response(response)
    }

    /// Return all cells in notebook order.
    #[napi]
    pub async fn list_cells(&self) -> Result<Vec<JsCellSnapshot>> {
        let handle = session_handle(&self.state).await?;
        Ok(handle
            .get_cells()
            .into_iter()
            .map(js_cell_from_snapshot)
            .collect())
    }

    /// Return one cell by ID, or null if it does not exist.
    #[napi]
    pub async fn get_cell(&self, cell_id: String) -> Result<Option<JsCellSnapshot>> {
        let handle = session_handle(&self.state).await?;
        Ok(handle.get_cell(&cell_id).map(js_cell_from_snapshot))
    }

    /// Create a cell without executing it. Returns the new cell ID.
    #[napi]
    pub async fn create_cell(
        &self,
        source: String,
        options: Option<CreateCellOptions>,
    ) -> Result<String> {
        let opts = options.unwrap_or_default();
        let cell_type = normalize_cell_type(opts.cell_type)?;
        let (handle, peer_label) = session_handle_and_label(&self.state).await?;
        let after_cell_id = insertion_anchor(&handle, opts.after_cell_id.as_deref(), opts.index)?;
        let cell_id = format!("cell-{}", uuid::Uuid::new_v4());
        handle
            .add_cell_with_source(&cell_id, &cell_type, after_cell_id.as_deref(), &source)
            .map_err(to_napi_err)?;
        notebook_sync::presence::emit_cursor_at_end(&handle, &cell_id, &source, Some(&peer_label))
            .await;
        Ok(cell_id)
    }

    /// Replace a cell's source and/or type. Returns true if the cell existed.
    #[napi]
    pub async fn set_cell(&self, cell_id: String, options: SetCellOptions) -> Result<bool> {
        let cell_type = options
            .cell_type
            .map(|cell_type| normalize_cell_type(Some(cell_type)))
            .transpose()?;
        let (handle, peer_label) = session_handle_and_label(&self.state).await?;
        let mut found = false;
        if let Some(source) = options.source {
            found |= handle
                .update_source(&cell_id, &source)
                .map_err(to_napi_err)?;
            if found {
                notebook_sync::presence::emit_cursor_at_end(
                    &handle,
                    &cell_id,
                    &source,
                    Some(&peer_label),
                )
                .await;
            }
        }
        if let Some(cell_type) = cell_type {
            found |= handle
                .set_cell_type(&cell_id, &cell_type)
                .map_err(to_napi_err)?;
        }
        Ok(found)
    }

    /// Delete a cell. Returns true if the cell existed.
    #[napi]
    pub async fn delete_cell(&self, cell_id: String) -> Result<bool> {
        let (handle, peer_label) = session_handle_and_label(&self.state).await?;
        let deleted = handle.delete_cell(&cell_id).map_err(to_napi_err)?;
        if deleted {
            notebook_sync::presence::announce(&handle, Some(&peer_label)).await;
        }
        Ok(deleted)
    }

    /// Move a cell after another cell, or to the beginning when omitted/null.
    /// Returns the new position string.
    #[napi]
    pub async fn move_cell(
        &self,
        cell_id: String,
        options: Option<MoveCellOptions>,
    ) -> Result<String> {
        let handle = session_handle(&self.state).await?;
        let after_cell_id = options.and_then(|opts| opts.after_cell_id);
        let position = handle
            .move_cell(&cell_id, after_cell_id.as_deref())
            .map_err(to_napi_err)?;
        let peer_label = session_peer_label(&self.state).await;
        notebook_sync::presence::emit_focus(&handle, &cell_id, Some(&peer_label)).await;
        Ok(position)
    }

    /// Execute an existing code cell and wait for terminal outputs.
    #[napi]
    pub async fn execute_cell(
        &self,
        cell_id: String,
        options: Option<ExecuteCellOptions>,
    ) -> Result<CellResult> {
        let opts = options.unwrap_or_default();
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(120_000) as u64);
        ensure_kernel_started(&self.state).await?;
        let execution_id = queue_existing_cell(&self.state, &cell_id).await?;
        if let Ok((handle, peer_label)) = session_handle_and_label(&self.state).await {
            notebook_sync::presence::emit_focus(&handle, &cell_id, Some(&peer_label)).await;
        }

        collect_outputs_with_timeout(&self.state, cell_id, execution_id, timeout).await
    }

    /// Execute a source string as a new cell. Starts the kernel on demand.
    /// Returns the cell's outputs once execution is terminal.
    #[napi]
    pub async fn run_cell(
        &self,
        source: String,
        options: Option<RunCellOptions>,
    ) -> Result<CellResult> {
        let opts = options.unwrap_or_default();
        let cell_type = normalize_cell_type(opts.cell_type)?;
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(120_000) as u64);

        // 1. Ensure kernel started (lazy).
        ensure_kernel_started(&self.state).await?;

        // 2. Add a new cell with source (single atomic mutation).
        let cell_id = add_source_cell(&self.state, &source, &cell_type).await?;

        // 3. Queue the cell. Do this before the timeout wrapper so timeout
        // results still carry an execution ID that can be recovered later.
        let execution_id = queue_existing_cell(&self.state, &cell_id).await?;

        collect_outputs_with_timeout(&self.state, cell_id, execution_id, timeout).await
    }

    /// Queue a source string as a new cell without waiting for execution.
    #[napi]
    pub async fn queue_cell(
        &self,
        source: String,
        options: Option<QueueCellOptions>,
    ) -> Result<QueuedExecution> {
        let opts = options.unwrap_or_default();
        let cell_type = normalize_cell_type(opts.cell_type)?;

        ensure_kernel_started(&self.state).await?;
        let cell_id = add_source_cell(&self.state, &source, &cell_type).await?;
        let execution_id = queue_existing_cell(&self.state, &cell_id).await?;

        Ok(QueuedExecution {
            cell_id,
            execution_id,
        })
    }

    /// Interrupt the currently executing cell.
    #[napi]
    pub async fn interrupt_kernel(&self) -> Result<bool> {
        let handle = session_handle(&self.state).await?;
        let response = handle
            .send_request(NotebookRequest::InterruptExecution {})
            .await
            .map_err(to_napi_err)?;
        match response {
            NotebookResponse::InterruptSent {} => Ok(true),
            NotebookResponse::NoKernel {} => Ok(false),
            NotebookResponse::Error { error } => Err(Error::from_reason(error)),
            other => Err(Error::from_reason(format!(
                "Unexpected response to interruptKernel: {other:?}"
            ))),
        }
    }

    /// Shutdown the running kernel. Returns false when no kernel is running.
    #[napi]
    pub async fn shutdown_kernel(&self) -> Result<bool> {
        let handle = session_handle(&self.state).await?;
        let response = handle
            .send_request(NotebookRequest::ShutdownKernel {})
            .await
            .map_err(to_napi_err)?;
        match response {
            NotebookResponse::KernelShuttingDown {} => Ok(true),
            NotebookResponse::NoKernel {} => Ok(false),
            NotebookResponse::Error { error } => Err(Error::from_reason(error)),
            other => Err(Error::from_reason(format!(
                "Unexpected response to shutdownKernel: {other:?}"
            ))),
        }
    }

    /// Restart the kernel, clearing in-memory state while preserving notebook
    /// dependencies. Resolves `true` only after this client's RuntimeStateDoc
    /// shows Running after a stopped state, matching the accepted envSource and
    /// local environment identity when supplied. A peer restart of the same
    /// environment cannot be distinguished without a launch generation.
    /// Rejects for every other outcome; see `restartKernelResult()`.
    #[napi]
    pub async fn restart_kernel(&self, options: Option<RestartKernelOptions>) -> Result<bool> {
        let result = self.restart_kernel_result(options).await?;
        if result.outcome == "running" {
            Ok(true)
        } else {
            Err(Error::from_reason(result.error.unwrap_or_else(|| {
                format!("Kernel restart ended as {}", result.outcome)
            })))
        }
    }

    /// Restart the kernel and report how it ended. Shuts the kernel down,
    /// waits for the stop to reach this client, launches, then waits until
    /// the replica shows Running with the launched envSource. Rejects when
    /// the session closes, the connection drops, or the daemon replies with
    /// an unexpected response.
    #[napi]
    pub async fn restart_kernel_result(
        &self,
        options: Option<RestartKernelOptions>,
    ) -> Result<KernelRestartResult> {
        let timeout_ms = options.and_then(|o| o.timeout_ms).unwrap_or(30_000);
        if timeout_ms == 0 {
            return Err(Error::from_reason("timeoutMs must be greater than 0"));
        }
        let closed_rx = self.closed_tx.subscribe();
        restart_kernel_flow(
            &self.state,
            closed_rx,
            Duration::from_millis(u64::from(timeout_ms)),
        )
        .await
    }

    /// Shutdown this notebook's kernel and evict its daemon room.
    #[napi]
    pub async fn shutdown_notebook(&self) -> Result<bool> {
        let (socket_path, notebook_id) = {
            let st = self.state.lock().await;
            (st.socket_path.clone(), self.notebook_id.clone())
        };
        let removed = PoolClient::new(socket_path)
            .shutdown_notebook(&notebook_id)
            .await
            .map_err(to_napi_err)?;
        if removed {
            let mut st = self.state.lock().await;
            self.closed_tx.send_replace(true);
            st.handle = None;
            st._broadcast_rx = None;
        }
        Ok(removed)
    }

    /// Open this notebook in nteract Desktop. In headless environments, returns
    /// `opened: false` with a reason instead of failing.
    #[napi]
    pub async fn show_notebook(&self) -> Result<ShowNotebookResult> {
        let (socket_path, notebook_id) = {
            let st = self.state.lock().await;
            (st.socket_path.clone(), self.notebook_id.clone())
        };
        show_notebook_inner(socket_path, Some(notebook_id), None).await
    }

    /// Wait for an already-queued execution in this live session.
    #[napi]
    pub async fn wait_for_execution(
        &self,
        execution_id: String,
        options: Option<WaitExecutionOptions>,
    ) -> Result<CellResult> {
        let opts = options.unwrap_or_default();
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(120_000) as u64);
        let fallback_cell_id = opts.cell_id.unwrap_or_default();

        collect_outputs_with_timeout(&self.state, fallback_cell_id, execution_id, timeout).await
    }
}

// ── Standalone constructors ────────────────────────────────────────────

/// Create a new (ephemeral) notebook against the daemon.
#[napi]
pub async fn create_notebook(options: Option<CreateNotebookOptions>) -> Result<Session> {
    let opts = options.unwrap_or_default();
    let runtime = opts.runtime.unwrap_or_else(|| "python".to_string());
    let socket_path = resolve_socket_path(opts.socket_path);
    let working_dir: Option<PathBuf> = opts.working_dir.map(PathBuf::from);
    let actor_label = peer_label_or_description(opts.peer_label, opts.description);
    let dependencies = opts.dependencies.unwrap_or_default();
    let package_manager = opts.package_manager.map(Into::into);
    let environment_mode = opts.environment_mode.map(Into::into);
    let local_environment = opts.local_environment.map(Into::into);

    let result = notebook_sync::connect::connect_create(
        socket_path.clone(),
        notebook_sync::connect::CreateNotebookSpec {
            working_dir: working_dir.clone(),
            actor_label: actor_label.clone(),
            package_manager,
            dependencies,
            environment_mode,
            local_environment,
            ..notebook_sync::connect::CreateNotebookSpec::new(runtime.as_str())
        },
    )
    .await
    .map_err(to_napi_err)?;
    let local_environment = result
        .info
        .capabilities
        .local_environment
        .clone()
        .map(LocalEnvironmentStatus::from);

    result
        .handle
        .await_session_ready()
        .await
        .map_err(to_napi_err)?;

    let notebook_id = result.info.notebook_id.clone();
    let (blob_base_url, blob_store_path) = resolve_blob_paths(&socket_path).await;

    let state = SessionState {
        handle: Some(result.handle),
        _broadcast_rx: Some(result.broadcast_rx),
        runtime,
        blob_base_url,
        blob_store_path,
        socket_path,
        working_dir: working_dir.map(|p| p.to_string_lossy().to_string()),
        peer_label: actor_label.clone(),
    };

    notebook_sync::presence::announce(
        state.handle.as_ref().expect("handle set"),
        Some(&actor_label),
    )
    .await;

    Ok(Session {
        notebook_id,
        local_environment,
        state: Arc::new(Mutex::new(state)),
        closed_tx: tokio::sync::watch::channel(false).0,
    })
}

/// List active notebook rooms from the daemon.
#[napi]
pub async fn list_active_notebooks(
    options: Option<ListActiveNotebooksOptions>,
) -> Result<Vec<ActiveNotebook>> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    let rooms = PoolClient::new(socket_path)
        .list_rooms()
        .await
        .map_err(to_napi_err)?;
    Ok(rooms.into_iter().map(active_notebook_from_room).collect())
}

/// Shutdown a notebook's kernel and evict its daemon room by notebook ID.
#[napi]
pub async fn shutdown_notebook(
    notebook_id: String,
    options: Option<ShutdownNotebookOptions>,
) -> Result<bool> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    PoolClient::new(socket_path)
        .shutdown_notebook(&notebook_id)
        .await
        .map_err(to_napi_err)
}

/// Open a notebook in nteract Desktop by active notebook ID or file path.
/// In headless environments, returns `opened: false` with a reason instead of failing.
#[napi]
pub async fn show_notebook(options: Option<ShowNotebookOptions>) -> Result<ShowNotebookResult> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    show_notebook_inner(socket_path, opts.notebook_id, opts.path).await
}

/// Open an existing notebook file by path.
#[napi]
pub async fn open_notebook_path(
    path: String,
    options: Option<OpenNotebookOptions>,
) -> Result<Session> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    let actor_label = peer_label_or_description(opts.peer_label, opts.description);
    let result = notebook_sync::connect::connect_open(
        socket_path.clone(),
        PathBuf::from(path),
        &actor_label,
    )
    .await
    .map_err(to_napi_err)?;

    result
        .handle
        .await_session_ready()
        .await
        .map_err(to_napi_err)?;

    let notebook_id = result.info.notebook_id.clone();
    let (blob_base_url, blob_store_path) = resolve_blob_paths(&socket_path).await;
    let runtime = runtime_from_handle(&result.handle);

    let state = SessionState {
        handle: Some(result.handle),
        _broadcast_rx: Some(result.broadcast_rx),
        runtime,
        blob_base_url,
        blob_store_path,
        socket_path,
        working_dir: None,
        peer_label: actor_label.clone(),
    };

    notebook_sync::presence::announce(
        state.handle.as_ref().expect("handle set"),
        Some(&actor_label),
    )
    .await;

    Ok(Session {
        notebook_id,
        local_environment: None,
        state: Arc::new(Mutex::new(state)),
        closed_tx: tokio::sync::watch::channel(false).0,
    })
}

/// Open an existing notebook by ID.
#[napi]
pub async fn open_notebook(
    notebook_id: String,
    options: Option<OpenNotebookOptions>,
) -> Result<Session> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    let actor_label = peer_label_or_description(opts.peer_label, opts.description);

    let result =
        notebook_sync::connect::connect(socket_path.clone(), notebook_id.clone(), &actor_label)
            .await
            .map_err(to_napi_err)?;

    result
        .handle
        .await_session_ready()
        .await
        .map_err(to_napi_err)?;

    let (blob_base_url, blob_store_path) = resolve_blob_paths(&socket_path).await;

    // Try to hydrate kernel state from the RuntimeStateDoc.
    let runtime = runtime_from_handle(&result.handle);

    let state = SessionState {
        handle: Some(result.handle),
        _broadcast_rx: Some(result.broadcast_rx),
        runtime,
        blob_base_url,
        blob_store_path,
        socket_path,
        working_dir: None,
        peer_label: actor_label.clone(),
    };

    notebook_sync::presence::announce(
        state.handle.as_ref().expect("handle set"),
        Some(&actor_label),
    )
    .await;

    Ok(Session {
        notebook_id,
        local_environment: None,
        state: Arc::new(Mutex::new(state)),
        closed_tx: tokio::sync::watch::channel(false).0,
    })
}

/// Read a terminal execution result from the daemon's durable execution store.
#[napi]
pub async fn get_execution_result(
    execution_id: String,
    options: Option<GetExecutionResultOptions>,
) -> Result<CellResult> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    let record = PoolClient::new(socket_path.clone())
        .get_execution_record(&execution_id)
        .await
        .map_err(to_napi_err)?;

    cell_result_from_record(&socket_path, record).await
}

// ── Internals ──────────────────────────────────────────────────────────

fn resolve_socket_path(override_path: Option<String>) -> PathBuf {
    override_path
        .map(PathBuf::from)
        .unwrap_or_else(runt_workspace::default_socket_path)
}

/// Resolve a blob hash to the local on-disk blob path for the selected daemon.
#[napi]
pub fn resolve_blob_path(hash: String, socket_path: Option<String>) -> Option<String> {
    let socket_path = resolve_socket_path(socket_path);
    let store_path = blob_store_path_for_socket_path(&socket_path)?;
    let blob_path = blob_file_path_for_hash(&store_path, &hash)?;
    blob_path
        .exists()
        .then(|| blob_path.to_string_lossy().to_string())
}

/// Return the local blob store root for the selected daemon, when present.
#[napi]
pub fn blob_store_path(socket_path: Option<String>) -> Option<String> {
    blob_store_path_for_socket_path(&resolve_socket_path(socket_path))
        .map(|path| path.to_string_lossy().to_string())
}

async fn resolve_blob_paths(socket_path: &std::path::Path) -> (Option<String>, Option<PathBuf>) {
    runtimed_client::daemon_paths::get_blob_paths_async(socket_path).await
}

fn blob_store_path_for_socket_path(socket_path: &Path) -> Option<PathBuf> {
    let store_path = socket_path.parent()?.join("blobs");
    store_path.exists().then_some(store_path)
}

fn blob_file_path_for_hash(store_path: &Path, hash: &str) -> Option<PathBuf> {
    if hash.len() < 2 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(store_path.join(&hash[..2]).join(&hash[2..]))
}

async fn session_handle(state: &Arc<Mutex<SessionState>>) -> Result<DocHandle> {
    let st = state.lock().await;
    st.handle
        .as_ref()
        .ok_or_else(|| Error::from_reason("Not connected"))
        .cloned()
}

async fn session_handle_and_label(state: &Arc<Mutex<SessionState>>) -> Result<(DocHandle, String)> {
    let st = state.lock().await;
    let handle = st
        .handle
        .as_ref()
        .ok_or_else(|| Error::from_reason("Not connected"))?
        .clone();
    Ok((handle, st.peer_label.clone()))
}

async fn session_peer_label(state: &Arc<Mutex<SessionState>>) -> String {
    let st = state.lock().await;
    st.peer_label.clone()
}

fn peer_label_or_description(peer_label: Option<String>, description: Option<String>) -> String {
    peer_label
        .or_else(|| description.map(|desc| format!("runtimed-node:{desc}")))
        .unwrap_or_else(|| "runtimed-node".to_string())
}

fn runtime_from_handle(handle: &DocHandle) -> String {
    let rs = handle.get_runtime_state().ok();
    rs.as_ref()
        .map(|r| r.kernel.name.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "python".to_string())
}

fn active_notebook_from_room(room: runtimed_client::protocol::RoomInfo) -> ActiveNotebook {
    ActiveNotebook {
        notebook_id: room.notebook_id,
        active_peers: room.active_peers.try_into().unwrap_or(u32::MAX),
        had_peers: room.had_peers,
        has_kernel: room.has_kernel,
        kernel_type: room.kernel_type,
        env_source: room.env_source,
        kernel_status: room.kernel_status,
        ephemeral: room.ephemeral,
        notebook_path: room.notebook_path,
    }
}

fn has_display() -> bool {
    if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
        return true;
    }
    std::env::var("DISPLAY").is_ok() || std::env::var("WAYLAND_DISPLAY").is_ok()
}

async fn show_notebook_inner(
    socket_path: PathBuf,
    notebook_id: Option<String>,
    path: Option<String>,
) -> Result<ShowNotebookResult> {
    if let Some(path) = path {
        if !has_display() {
            return Ok(ShowNotebookResult {
                notebook_id,
                path: Some(path),
                opened: false,
                reason: Some(
                    "No display available (headless environment). The notebook can still be used through @runtimed/node."
                        .to_string(),
                ),
                warning: None,
            });
        }
        runt_workspace::open_notebook_app(Some(std::path::Path::new(&path)), &[])
            .map_err(|e| Error::from_reason(format!("Failed to open app: {e}")))?;
        return Ok(ShowNotebookResult {
            notebook_id,
            path: Some(path),
            opened: true,
            reason: None,
            warning: None,
        });
    }

    let notebook_id = notebook_id.ok_or_else(|| {
        Error::from_reason("showNotebook requires notebookId or path when not called on a Session")
    })?;
    let rooms = PoolClient::new(socket_path)
        .list_rooms()
        .await
        .map_err(to_napi_err)?;
    let room = rooms
        .iter()
        .find(|room| room.notebook_id == notebook_id)
        .ok_or_else(|| Error::from_reason(format!("Notebook {notebook_id} is not active")))?;
    let resolved_path = room
        .notebook_path
        .as_deref()
        .filter(|p| std::path::Path::new(p).is_absolute());

    if !has_display() {
        return Ok(ShowNotebookResult {
            notebook_id: Some(notebook_id),
            path: resolved_path.map(str::to_string),
            opened: false,
            reason: Some(
                "No display available (headless environment). The notebook is running in the daemon and accessible through @runtimed/node."
                    .to_string(),
            ),
            warning: room.ephemeral.then(|| {
                "This notebook is ephemeral. Save it to a path to persist it.".to_string()
            }),
        });
    }

    if let Some(path) = resolved_path {
        runt_workspace::open_notebook_app(Some(std::path::Path::new(path)), &[])
            .map_err(|e| Error::from_reason(format!("Failed to open app: {e}")))?;
    } else {
        runt_workspace::open_notebook_app(None, &["--notebook-id", &notebook_id])
            .map_err(|e| Error::from_reason(format!("Failed to open app: {e}")))?;
    }

    Ok(ShowNotebookResult {
        notebook_id: Some(notebook_id),
        path: resolved_path.map(str::to_string),
        opened: true,
        reason: None,
        warning: room
            .ephemeral
            .then(|| "This notebook is ephemeral. Save it from the app to keep it.".to_string()),
    })
}

fn dependency_package_manager(
    options: Option<DependencyEditOptions>,
    runtime_state: Option<&runtime_doc::RuntimeState>,
    metadata: &notebook_doc::metadata::NotebookMetadataSnapshot,
) -> PackageManager {
    options
        .and_then(|opts| opts.package_manager)
        .or_else(|| infer_dependency_package_manager(runtime_state, metadata))
        .unwrap_or(PackageManager::Uv)
}

fn infer_dependency_package_manager(
    runtime_state: Option<&runtime_doc::RuntimeState>,
    metadata: &notebook_doc::metadata::NotebookMetadataSnapshot,
) -> Option<PackageManager> {
    if let Some(state) = runtime_state {
        let env_source = state.kernel.env_source.as_str();
        if env_source.starts_with("pixi:") {
            return Some(PackageManager::Pixi);
        }
        if env_source.starts_with("conda:") {
            return Some(PackageManager::Conda);
        }
        if env_source.starts_with("uv:") {
            return Some(PackageManager::Uv);
        }
    }

    if metadata.runt.uv.is_some() {
        return Some(PackageManager::Uv);
    }
    if metadata.runt.conda.is_some() {
        return Some(PackageManager::Conda);
    }
    if metadata.runt.pixi.is_some() {
        return Some(PackageManager::Pixi);
    }

    match runtime_state.map(|state| &state.project_context) {
        Some(ProjectContext::Detected { project_file, .. }) => match project_file.kind {
            ProjectFileKind::PixiToml => Some(PackageManager::Pixi),
            ProjectFileKind::EnvironmentYml => Some(PackageManager::Conda),
            ProjectFileKind::PyprojectToml => Some(PackageManager::Uv),
        },
        _ => None,
    }
}

fn js_cell_from_snapshot(cell: notebook_doc::CellSnapshot) -> JsCellSnapshot {
    JsCellSnapshot {
        id: cell.id,
        cell_type: cell.cell_type,
        position: cell.position,
        source: cell.source,
        metadata_json: serde_json::to_string(&cell.metadata).unwrap_or_else(|_| "{}".to_string()),
        execution_count: if cell.execution_count == "null" {
            None
        } else {
            Some(cell.execution_count)
        },
    }
}

fn normalize_cell_type(cell_type: Option<String>) -> Result<String> {
    let cell_type = cell_type.unwrap_or_else(|| "code".to_string());
    if !VALID_CELL_TYPES.contains(&cell_type.as_str()) {
        return Err(Error::from_reason(format!(
            "Invalid cell_type {cell_type:?}. Must be one of: {}",
            VALID_CELL_TYPES.join(", ")
        )));
    }
    Ok(cell_type)
}

async fn add_source_cell(
    state: &Arc<Mutex<SessionState>>,
    source: &str,
    cell_type: &str,
) -> Result<String> {
    let cell_id = format!("cell-{}", uuid::Uuid::new_v4());
    let (handle, peer_label) = session_handle_and_label(state).await?;
    let after_cell_id = insertion_anchor(&handle, None, None)?;
    handle
        .add_cell_with_source(&cell_id, cell_type, after_cell_id.as_deref(), source)
        .map_err(to_napi_err)?;
    notebook_sync::presence::emit_cursor_at_end(&handle, &cell_id, source, Some(&peer_label)).await;
    Ok(cell_id)
}

fn insertion_anchor(
    handle: &DocHandle,
    after_cell_id: Option<&str>,
    index: Option<i64>,
) -> Result<Option<String>> {
    if after_cell_id.is_some() && index.is_some() {
        return Err(Error::from_reason(
            "index and afterCellId cannot both be set",
        ));
    }

    if let Some(after_cell_id) = after_cell_id {
        return Ok(Some(after_cell_id.to_string()));
    }

    if index.is_some() {
        return insertion_anchor_from_order(&handle.get_cell_ids(), None, index);
    }

    Ok(handle.last_cell_id())
}

fn insertion_anchor_from_order(
    cell_ids: &[String],
    after_cell_id: Option<&str>,
    index: Option<i64>,
) -> Result<Option<String>> {
    if after_cell_id.is_some() && index.is_some() {
        return Err(Error::from_reason(
            "index and afterCellId cannot both be set",
        ));
    }

    if let Some(after_cell_id) = after_cell_id {
        return Ok(Some(after_cell_id.to_string()));
    }

    if let Some(index) = index {
        if index <= 0 {
            return Ok(None);
        }
        let clamped = (index as usize).min(cell_ids.len());
        return Ok(cell_ids.get(clamped.saturating_sub(1)).cloned());
    }

    Ok(cell_ids.last().cloned())
}

fn dependency_fingerprint_for_handle(handle: &DocHandle) -> Option<String> {
    let metadata = handle
        .get_notebook_metadata()
        .map(|snapshot| snapshot.dependency_fingerprint());
    let pep723 = notebook_doc::pep723::find_pep723_in_cells(&handle.get_cells())
        .map(|pep| {
            pep.map(|metadata| metadata.dependencies)
                .unwrap_or_default()
        })
        .map_err(|error| error.to_string());
    serde_json::to_string(&(metadata, pep723)).ok()
}

fn runtime_status_for_handle(handle: &DocHandle) -> RuntimeStatus {
    runtime_status_from_state(handle.get_runtime_state().ok().unwrap_or_default())
}

fn runtime_status_from_state(state: runtime_doc::RuntimeState) -> RuntimeStatus {
    let mut kernel = state.kernel;
    // RuntimeStateDoc retains the previous kernel's identity while preparing
    // its replacement. Those historical fields do not identify an active
    // environment until the daemon publishes Running for the new kernel.
    if !matches!(kernel.lifecycle, runtime_doc::RuntimeLifecycle::Running(_)) {
        kernel.name.clear();
        kernel.language.clear();
        kernel.env_source.clear();
        kernel.runtime_agent_id.clear();
        kernel.environment_id.clear();
        kernel.environment_name.clear();
        kernel.python_version.clear();
    }
    let (lifecycle, activity) = match &kernel.lifecycle {
        runtime_doc::RuntimeLifecycle::Running(activity) => (
            kernel.lifecycle.variant_str().to_string(),
            Some(activity.as_str().to_string()),
        ),
        lifecycle => (lifecycle.variant_str().to_string(), None),
    };
    RuntimeStatus {
        status: kernel.status,
        lifecycle,
        activity,
        starting_phase: kernel.starting_phase,
        name: kernel.name,
        language: kernel.language,
        env_source: kernel.env_source,
        runtime_agent_id: kernel.runtime_agent_id,
        environment_id: kernel.environment_id,
        environment_name: kernel.environment_name,
        python_version: kernel.python_version,
        error_reason: kernel.error_reason.filter(|s| !s.is_empty()),
        error_details: kernel.error_details.filter(|s| !s.is_empty()),
        project_trust: state.project_trust.into(),
    }
}

fn dependency_status_for_handle(handle: &DocHandle) -> DependencyStatus {
    let metadata = handle.get_notebook_metadata().unwrap_or_default();
    let uv = metadata.runt.uv.as_ref();
    let conda = metadata.runt.conda.as_ref();
    let pixi = metadata.runt.pixi.as_ref();
    let runtime_state = handle.get_runtime_state().ok();
    let project_trust = runtime_state
        .as_ref()
        .map(|state| state.project_trust.clone())
        .unwrap_or_default()
        .into();
    let trust = runtime_state.map(|state| state.trust);
    let pep723_dependencies = notebook_doc::pep723::find_pep723_in_cells(&handle.get_cells())
        .ok()
        .flatten()
        .map(|pep| pep.dependencies)
        .unwrap_or_default();

    DependencyStatus {
        uv: uv.map(|uv| UvDependencyStatus {
            dependencies: uv.dependencies.clone(),
            requires_python: uv.requires_python.clone(),
        }),
        conda: conda.map(|conda| CondaDependencyStatus {
            dependencies: conda.dependencies.clone(),
            channels: conda.channels.clone(),
            python: conda.python.clone(),
        }),
        pixi: pixi.map(|pixi| PixiDependencyStatus {
            dependencies: pixi.dependencies.clone(),
            pypi_dependencies: pixi.pypi_dependencies.clone(),
            channels: pixi.channels.clone(),
            python: pixi.python.clone(),
        }),
        pep723_dependencies,
        fingerprint: dependency_fingerprint_for_handle(handle),
        trust: DependencyTrustStatus {
            status: trust.as_ref().map(|trust| trust.status.clone()),
            needs_approval: trust.as_ref().map(|trust| trust.needs_approval),
            approved_uv_dependencies: trust
                .as_ref()
                .map(|trust| trust.approved_uv_dependencies.clone())
                .unwrap_or_default(),
            approved_conda_dependencies: trust
                .as_ref()
                .map(|trust| trust.approved_conda_dependencies.clone())
                .unwrap_or_default(),
            approved_pixi_dependencies: trust
                .as_ref()
                .map(|trust| trust.approved_pixi_dependencies.clone())
                .unwrap_or_default(),
            approved_pixi_pypi_dependencies: trust
                .map(|trust| trust.approved_pixi_pypi_dependencies)
                .unwrap_or_default(),
        },
        project_trust,
    }
}

async fn approve_current_trust(
    handle: &DocHandle,
    observed_heads: Option<Vec<String>>,
    include_pep723: bool,
) -> Result<()> {
    handle.confirm_sync().await.map_err(to_napi_err)?;
    let response = handle
        .send_request(NotebookRequest::ApproveTrust {
            observed_heads,
            include_pep723,
            reviewed_pep723_dependencies: None,
        })
        .await
        .map_err(to_napi_err)?;

    match response {
        NotebookResponse::Ok {} => Ok(()),
        NotebookResponse::GuardRejected { reason } => Err(Error::from_reason(reason)),
        NotebookResponse::Error { error } => Err(Error::from_reason(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
}

async fn send_project_trust_decision(handle: &DocHandle, request: NotebookRequest) -> Result<()> {
    match handle.send_request(request).await.map_err(to_napi_err)? {
        NotebookResponse::Ok {} => Ok(()),
        NotebookResponse::Error { error } => Err(Error::from_reason(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
}

async fn ensure_kernel_started(state: &Arc<Mutex<SessionState>>) -> Result<()> {
    let handle = session_handle(state).await?;
    if handle
        .get_runtime_state()
        .map_err(to_napi_err)?
        .kernel
        .lifecycle
        .is_starting_or_running()
    {
        return Ok(());
    }
    launch_kernel(state).await
}

async fn launch_kernel(state: &Arc<Mutex<SessionState>>) -> Result<()> {
    match send_launch_kernel(state).await? {
        NotebookResponse::KernelLaunched { .. } | NotebookResponse::KernelAlreadyRunning { .. } => {
            Ok(())
        }
        NotebookResponse::GuardRejected { reason } => Err(Error::from_reason(reason)),
        NotebookResponse::Error { error } => Err(Error::from_reason(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
}

/// Map the on-demand launch before an environment sync. `None` means a kernel
/// is running and the sync request may follow.
fn sync_launch_failure(response: NotebookResponse) -> Result<Option<EnvironmentSyncResult>> {
    match response {
        NotebookResponse::KernelLaunched { .. } | NotebookResponse::KernelAlreadyRunning { .. } => {
            Ok(None)
        }
        NotebookResponse::GuardRejected { reason } => {
            Ok(Some(EnvironmentSyncResult::failed(reason)))
        }
        NotebookResponse::Error { error }
        | NotebookResponse::EnvironmentSelectionRejected { error } => {
            Ok(Some(EnvironmentSyncResult::failed(error)))
        }
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
}

/// Map the daemon's `SyncEnvironment` reply. The daemon decides whether a
/// restart is needed; metadata is never consulted here.
fn environment_sync_result_from_response(
    response: NotebookResponse,
) -> Result<EnvironmentSyncResult> {
    match response {
        NotebookResponse::SyncEnvironmentComplete { synced_packages } => {
            Ok(EnvironmentSyncResult::applied(synced_packages))
        }
        NotebookResponse::SyncEnvironmentFailed {
            error,
            needs_restart: true,
        } => Ok(EnvironmentSyncResult::restart_required(error)),
        NotebookResponse::SyncEnvironmentFailed {
            error,
            needs_restart: false,
        } => Ok(EnvironmentSyncResult::failed(error)),
        NotebookResponse::GuardRejected { reason } => Ok(EnvironmentSyncResult::failed(reason)),
        NotebookResponse::Error { error } => Ok(EnvironmentSyncResult::failed(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
}

fn launch_reply_for_restart(response: NotebookResponse) -> Result<LaunchReply> {
    match response {
        NotebookResponse::KernelLaunched {
            env_source,
            launched_config,
            ..
        }
        | NotebookResponse::KernelAlreadyRunning {
            env_source,
            launched_config,
            ..
        } => Ok(LaunchReply::Accepted {
            env_source: env_source.as_str().to_string(),
            environment_id: launched_config.local_environment.map(|env| env.id),
        }),
        // The reply type alone decides trust. Error text is never parsed.
        NotebookResponse::GuardRejected { reason } => Ok(LaunchReply::TrustRejected { reason }),
        NotebookResponse::Error { error }
        | NotebookResponse::EnvironmentSelectionRejected { error } => {
            Ok(LaunchReply::Rejected { error })
        }
        other => Err(Error::from_reason(format!(
            "Unexpected response to restartKernel launch: {other:?}"
        ))),
    }
}

fn shutdown_reply_for_restart(response: NotebookResponse) -> Result<()> {
    match response {
        NotebookResponse::KernelShuttingDown {} | NotebookResponse::NoKernel {} => Ok(()),
        NotebookResponse::Error { error } => Err(Error::from_reason(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response to restartKernel shutdown: {other:?}"
        ))),
    }
}

/// What woke a restart wait.
enum RestartWake {
    Changed,
    TimedOut,
}

/// Wait for the next RuntimeStateDoc change or the deadline. Session close and
/// a dropped sync task are rejections: they say nothing about the kernel.
async fn next_restart_wake(
    runtime_rx: &mut tokio::sync::watch::Receiver<runtime_doc::RuntimeState>,
    closed_rx: &mut tokio::sync::watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<RestartWake> {
    tokio::select! {
        biased;
        _ = closed_rx.wait_for(|closed| *closed) => {
            Err(Error::from_reason("Session closed during kernel restart"))
        }
        changed = runtime_rx.changed() => match changed {
            Ok(()) => Ok(RestartWake::Changed),
            Err(_) => Err(Error::from_reason("Connection lost during kernel restart")),
        },
        _ = tokio::time::sleep_until(deadline) => Ok(RestartWake::TimedOut),
    }
}

/// The replica's current kernel. The document can be ahead of the watch value.
fn current_runtime_state(
    handle: &DocHandle,
    runtime_rx: &mut tokio::sync::watch::Receiver<runtime_doc::RuntimeState>,
) -> runtime_doc::RuntimeState {
    let watched = runtime_rx.borrow_and_update().clone();
    handle.get_runtime_state().unwrap_or(watched)
}

/// Feed observations into `phase` until it leaves the waiting phase or the
/// deadline passes. Returns the new phase and the last runtime state read.
async fn observe_until_transition(
    handle: &DocHandle,
    mut phase: RestartPhase,
    runtime_rx: &mut tokio::sync::watch::Receiver<runtime_doc::RuntimeState>,
    closed_rx: &mut tokio::sync::watch::Receiver<bool>,
    timeout: Duration,
) -> Result<(RestartPhase, runtime_doc::RuntimeState)> {
    let deadline = tokio::time::Instant::now() + timeout;
    let waiting = std::mem::discriminant(&phase);
    loop {
        // A replica retains its last Running snapshot after disconnect. Never
        // turn that retained value into successful restart confirmation.
        if *closed_rx.borrow() {
            return Err(Error::from_reason("Session closed during kernel restart"));
        }
        if handle.status().connection == notebook_sync::status::ConnectionState::Disconnected {
            return Err(Error::from_reason("Connection lost during kernel restart"));
        }
        let state = current_runtime_state(handle, runtime_rx);
        phase = step(
            phase,
            RestartEvent::Observed(KernelObservation::from(&state.kernel)),
        );
        if std::mem::discriminant(&phase) != waiting {
            return Ok((phase, state));
        }
        if let RestartWake::TimedOut = next_restart_wake(runtime_rx, closed_rx, deadline).await? {
            return Ok((step(phase, RestartEvent::TimedOut), state));
        }
    }
}

async fn restart_kernel_flow(
    session_state: &Arc<Mutex<SessionState>>,
    mut closed_rx: tokio::sync::watch::Receiver<bool>,
    timeout: Duration,
) -> Result<KernelRestartResult> {
    let handle = session_handle(session_state).await?;
    let mut runtime_rx = handle.subscribe_runtime_state();

    let shutdown = handle.send_request(NotebookRequest::ShutdownKernel {});
    let response = tokio::select! {
        biased;
        _ = closed_rx.wait_for(|closed| *closed) => {
            return Err(Error::from_reason("Session closed during kernel restart"));
        }
        response = shutdown => response.map_err(to_napi_err)?,
    };
    shutdown_reply_for_restart(response)?;
    let phase = step(RestartPhase::initial(), RestartEvent::ShutdownAcknowledged);

    // Fence: the replica shows the old kernel stopped.
    let (mut phase, mut last_state) =
        observe_until_transition(&handle, phase, &mut runtime_rx, &mut closed_rx, timeout).await?;

    if matches!(phase, RestartPhase::Launching { .. }) {
        let launch = send_launch_kernel(session_state);
        tokio::pin!(launch);
        let response = loop {
            tokio::select! {
                biased;
                _ = closed_rx.wait_for(|closed| *closed) => {
                    return Err(Error::from_reason("Session closed during kernel restart"));
                }
                response = &mut launch => break response?,
                changed = runtime_rx.changed() => {
                    if changed.is_err() {
                        return Err(Error::from_reason("Connection lost during kernel restart"));
                    }
                    last_state = current_runtime_state(&handle, &mut runtime_rx);
                    phase = step(
                        phase,
                        RestartEvent::Observed(KernelObservation::from(&last_state.kernel)),
                    );
                }
            }
        };
        phase = step(
            phase,
            RestartEvent::LaunchReplied(launch_reply_for_restart(response)?),
        );
    }

    if matches!(phase, RestartPhase::Confirming { .. }) {
        (phase, last_state) =
            observe_until_transition(&handle, phase, &mut runtime_rx, &mut closed_rx, timeout)
                .await?;
    }

    match phase {
        RestartPhase::Done(verdict) => Ok(restart_result(verdict, last_state, timeout)),
        other => Err(Error::from_reason(format!(
            "Kernel restart stopped in an unexpected phase: {other:?}"
        ))),
    }
}

fn restart_result(
    verdict: RestartVerdict,
    state: runtime_doc::RuntimeState,
    timeout: Duration,
) -> KernelRestartResult {
    let status = runtime_status_from_state(state);
    let (outcome, error, launched_env_source) = match verdict {
        RestartVerdict::Running { env_source } => ("running", None, Some(env_source)),
        RestartVerdict::TrustRequired { reason } => ("trust_required", Some(reason), None),
        RestartVerdict::LaunchRejected { error } => ("launch_rejected", Some(error), None),
        RestartVerdict::Failed {
            env_source,
            observation,
        } => {
            let detail = observation
                .error_details
                .or(observation.error_reason)
                .unwrap_or_else(|| "no error details".to_string());
            (
                "failed",
                Some(format!(
                    "Kernel ({env_source}) failed after the daemon accepted the launch: {detail}"
                )),
                Some(env_source),
            )
        }
        RestartVerdict::Stopped {
            env_source,
            observation,
        } => (
            "stopped",
            Some(format!(
                "Kernel ({env_source}) is {} after the daemon accepted the launch",
                observation.lifecycle.variant_str()
            )),
            Some(env_source),
        ),
        RestartVerdict::TimedOut {
            stage,
            env_source,
            last,
        } => {
            let last = last
                .map(|o| format!("{} {}", o.lifecycle.variant_str(), o.env_source))
                .unwrap_or_else(|| "unknown".to_string());
            let waiting_for = match (stage, &env_source) {
                (TimeoutStage::AwaitingStopped, _) => "the old kernel to stop".to_string(),
                (TimeoutStage::Confirming, Some(env)) => {
                    format!("the new kernel ({env}) to report Running")
                }
                (TimeoutStage::Confirming, None) => "the new kernel to report Running".to_string(),
            };
            (
                "timed_out",
                Some(format!(
                    "Timed out after {} ms waiting for {waiting_for}; last observed: {}",
                    timeout.as_millis(),
                    last.trim_end()
                )),
                env_source,
            )
        }
    };
    KernelRestartResult {
        outcome: outcome.to_string(),
        error,
        launched_env_source,
        status,
    }
}

/// Send `LaunchKernel` (auto source) after confirming notebook sync and
/// return the raw daemon reply. Transport errors reject.
async fn send_launch_kernel(state: &Arc<Mutex<SessionState>>) -> Result<NotebookResponse> {
    let (handle, runtime, notebook_path) = {
        let st = state.lock().await;
        let handle = st
            .handle
            .as_ref()
            .ok_or_else(|| Error::from_reason("Not connected"))?
            .clone();
        (handle, st.runtime.clone(), st.working_dir.clone())
    };
    handle.confirm_sync().await.map_err(to_napi_err)?;
    handle
        .send_request(NotebookRequest::LaunchKernel {
            kernel_type: runtime,
            env_source: notebook_protocol::connection::LaunchSpec::Auto,
            notebook_path,
        })
        .await
        .map_err(to_napi_err)
}

async fn queue_existing_cell(state: &Arc<Mutex<SessionState>>, cell_id: &str) -> Result<String> {
    let handle = {
        let st = state.lock().await;
        st.handle
            .as_ref()
            .ok_or_else(|| Error::from_reason("Not connected"))?
            .clone()
    };
    let required_heads = handle.current_heads_hex().map_err(to_napi_err)?;
    let request = NotebookRequest::ExecuteCell {
        cell_id: cell_id.to_string(),
        execution_id: None,
    };
    let mut response = handle
        .send_request_after_heads(request.clone(), required_heads.clone())
        .await
        .map_err(to_napi_err)?;
    if matches!(response, NotebookResponse::NoKernel {}) {
        // The daemon rejected the work before queueing it. A synced Running
        // snapshot may lag a peer's shutdown, so force one launch and retry
        // only this rejection, never an accepted or ambiguous execution.
        launch_kernel(state).await?;
        response = handle
            .send_request_after_heads(request, required_heads)
            .await
            .map_err(to_napi_err)?;
    }
    match response {
        NotebookResponse::CellQueued { execution_id, .. } => Ok(execution_id),
        NotebookResponse::Error { error } => Err(Error::from_reason(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
}

async fn collect_outputs(
    state: &Arc<Mutex<SessionState>>,
    cell_id: &str,
    execution_id: &str,
) -> Result<CellResult> {
    let (handle, blob_base_url, blob_store_path) = {
        let st = state.lock().await;
        (
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone(),
            st.blob_base_url.clone(),
            st.blob_store_path.clone(),
        )
    };

    let helper_timeout = Duration::from_secs(60 * 60); // 1 hour ceiling; caller's tokio::time::timeout is the real bound
    let terminal =
        notebook_sync::await_execution_terminal(&handle, execution_id, helper_timeout, None).await;

    match terminal {
        Ok(terminal_state) => {
            let comms = handle.get_runtime_state().ok().map(|rs| rs.comms);
            cell_result_from_output_manifests(
                ExecutionResultParts {
                    execution_id,
                    cell_id,
                    status: &terminal_state.status,
                    success: terminal_state.success,
                    execution_count: terminal_state.execution_count,
                    output_manifests: &terminal_state.output_manifests,
                },
                OutputResolutionContext {
                    comms: comms.as_ref(),
                    blob_base_url: &blob_base_url,
                    blob_store_path: &blob_store_path,
                },
            )
            .await
        }
        Err(notebook_sync::ExecutionTerminalError::KernelFailed { reason }) => Ok(CellResult {
            cell_id: cell_id.to_string(),
            execution_id: execution_id.to_string(),
            execution_count: None,
            status: "kernel_error".to_string(),
            success: false,
            outputs: vec![JsOutput {
                output_type: "error".to_string(),
                name: None,
                text: None,
                data_json: None,
                ename: Some("KernelError".to_string()),
                evalue: Some(reason),
                traceback: None,
                execution_count: None,
                blob_urls_json: None,
                blob_paths_json: None,
            }],
        }),
        Err(notebook_sync::ExecutionTerminalError::Timeout) => {
            Err(Error::from_reason("Execution wait aborted"))
        }
    }
}

async fn collect_outputs_with_timeout(
    state: &Arc<Mutex<SessionState>>,
    cell_id: String,
    execution_id: String,
    timeout: Duration,
) -> Result<CellResult> {
    match tokio::time::timeout(timeout, collect_outputs(state, &cell_id, &execution_id)).await {
        Ok(result) => result,
        Err(_) => Ok(timeout_cell_result(cell_id, execution_id)),
    }
}

fn timeout_cell_result(cell_id: String, execution_id: String) -> CellResult {
    CellResult {
        cell_id,
        execution_id,
        execution_count: None,
        status: "timeout".to_string(),
        success: false,
        outputs: vec![],
    }
}

async fn cell_result_from_record(
    socket_path: &std::path::Path,
    record: runtimed_client::execution_store::ExecutionRecord,
) -> Result<CellResult> {
    let (blob_base_url, blob_store_path) =
        runtimed_client::daemon_paths::get_blob_paths_async(socket_path).await;
    let execution_id = record.execution_id.clone();
    let fallback_cell_id = record.cell_id.clone();
    let exec = runtime_doc::ExecutionState {
        status: record.status,
        execution_count: record.execution_count,
        success: record.success,
        outputs: record.outputs,
        source: record.source,
        cell_id: record.cell_id,
        seq: record.seq,
        submitted_by_actor_label: record.submitted_by_actor_label,
    };
    cell_result_from_execution_state(
        &execution_id,
        fallback_cell_id.as_deref(),
        &exec,
        None,
        &blob_base_url,
        &blob_store_path,
    )
    .await
}

async fn cell_result_from_execution_state(
    execution_id: &str,
    fallback_cell_id: Option<&str>,
    state: &runtime_doc::ExecutionState,
    comms: Option<&CommMap>,
    blob_base_url: &Option<String>,
    blob_store_path: &Option<PathBuf>,
) -> Result<CellResult> {
    let cell_id = fallback_cell_id.unwrap_or_default();
    let success = state.success.unwrap_or(true);
    cell_result_from_output_manifests(
        ExecutionResultParts {
            execution_id,
            cell_id,
            status: &state.status,
            success,
            execution_count: state.execution_count,
            output_manifests: &state.outputs,
        },
        OutputResolutionContext {
            comms,
            blob_base_url,
            blob_store_path,
        },
    )
    .await
}

async fn cell_result_from_execution_progress(
    progress: &notebook_sync::ExecutionProgressState,
    comms: Option<&CommMap>,
    blob_base_url: &Option<String>,
    blob_store_path: &Option<PathBuf>,
) -> Result<CellResult> {
    cell_result_from_output_manifests(
        ExecutionResultParts {
            execution_id: &progress.execution_id,
            cell_id: &progress.cell_id,
            status: &progress.status,
            success: progress.success.unwrap_or(true),
            execution_count: progress.execution_count,
            output_manifests: &progress.output_manifests,
        },
        OutputResolutionContext {
            comms,
            blob_base_url,
            blob_store_path,
        },
    )
    .await
}

async fn cell_result_from_output_manifests(
    parts: ExecutionResultParts<'_>,
    context: OutputResolutionContext<'_>,
) -> Result<CellResult> {
    let resolved = shared_resolver::resolve_cell_outputs(
        parts.output_manifests,
        context.blob_base_url,
        context.blob_store_path,
        context.comms,
    )
    .await;
    let outputs: Vec<JsOutput> = resolved
        .into_iter()
        .map(to_js_output)
        .collect::<napi::Result<Vec<_>>>()?;
    let success = parts.status == "done"
        && parts.success
        && !outputs.iter().any(|o| o.output_type == "error");

    Ok(CellResult {
        cell_id: parts.cell_id.to_string(),
        execution_id: parts.execution_id.to_string(),
        execution_count: parts.execution_count,
        status: parts.status.to_string(),
        success,
        outputs,
    })
}

#[derive(Serialize)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
enum DataValueJson {
    Text(String),
    /// base64-encoded.
    Binary(String),
    Json(serde_json::Value),
}

fn to_js_output(o: runtimed_outputs::resolved_output::Output) -> napi::Result<JsOutput> {
    js_output_from_resolved_output(o)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output data: {e}")))
}

fn js_output_from_resolved_output(
    o: runtimed_outputs::resolved_output::Output,
) -> serde_json::Result<JsOutput> {
    let data_json = match o.data {
        Some(d) => {
            let map: std::collections::HashMap<String, DataValueJson> = d
                .into_iter()
                .map(|(k, v)| {
                    let dv = match v {
                        SharedDataValue::Text(s) => DataValueJson::Text(s),
                        SharedDataValue::Binary(b) => {
                            use base64::{engine::general_purpose::STANDARD, Engine as _};
                            DataValueJson::Binary(STANDARD.encode(&b))
                        }
                        SharedDataValue::Json(j) => DataValueJson::Json(j),
                    };
                    (k, dv)
                })
                .collect();
            Some(serde_json::to_string(&map)?)
        }
        None => None,
    };
    let blob_urls_json = o.blob_urls.map(|m| serde_json::to_string(&m)).transpose()?;
    let blob_paths_json = o
        .blob_paths
        .map(|m| serde_json::to_string(&m))
        .transpose()?;
    Ok(JsOutput {
        output_type: o.output_type,
        name: o.name,
        text: o.text,
        data_json,
        ename: o.ename,
        evalue: o.evalue,
        traceback: o.traceback,
        execution_count: o.execution_count,
        blob_urls_json,
        blob_paths_json,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use runtimed_outputs::resolved_output::{DataValue as SharedDataValue, Output as SharedOutput};
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::Path;

    #[test]
    fn runtime_status_reports_identity_only_for_running_kernel() {
        use runtime_doc::{KernelActivity, RuntimeLifecycle};
        for lifecycle in [
            RuntimeLifecycle::NotStarted,
            RuntimeLifecycle::AwaitingTrust,
            RuntimeLifecycle::AwaitingProjectTrust,
            RuntimeLifecycle::AwaitingEnvBuild,
            RuntimeLifecycle::Resolving,
            RuntimeLifecycle::PreparingEnv,
            RuntimeLifecycle::Launching,
            RuntimeLifecycle::Connecting,
            RuntimeLifecycle::Error,
            RuntimeLifecycle::Shutdown,
            RuntimeLifecycle::Running(KernelActivity::Idle),
            RuntimeLifecycle::Running(KernelActivity::Busy),
        ] {
            let running = matches!(lifecycle, RuntimeLifecycle::Running(_));
            let state = runtime_doc::RuntimeState {
                kernel: runtime_doc::KernelState {
                    lifecycle,
                    name: "python".into(),
                    language: "python".into(),
                    env_source: "conda:existing:local".into(),
                    runtime_agent_id: "runtime-agent:previous".into(),
                    environment_id: "conda:chosen".into(),
                    environment_name: "chosen".into(),
                    python_version: "3.13.2".into(),
                    ..Default::default()
                },
                ..Default::default()
            };
            let status = runtime_status_from_state(state);
            assert_eq!(status.name, if running { "python" } else { "" });
            assert_eq!(status.language, if running { "python" } else { "" });
            let expected = if running {
                [
                    "conda:existing:local",
                    "runtime-agent:previous",
                    "conda:chosen",
                    "chosen",
                    "3.13.2",
                ]
            } else {
                ["", "", "", "", ""]
            };
            assert_eq!(
                [
                    status.env_source.as_str(),
                    status.runtime_agent_id.as_str(),
                    status.environment_id.as_str(),
                    status.environment_name.as_str(),
                    status.python_version.as_str()
                ],
                expected,
                "active identity must follow lifecycle {}",
                status.lifecycle,
            );
        }
    }

    #[test]
    fn runtime_status_projects_parked_project_trust() {
        let state = runtime_doc::RuntimeState {
            kernel: runtime_doc::KernelState {
                lifecycle: runtime_doc::RuntimeLifecycle::AwaitingProjectTrust,
                ..Default::default()
            },
            project_trust: runtime_doc::ProjectTrustRuntimeState {
                status: "untrusted".to_string(),
                needs_approval: true,
                manifest_path: "/work/proj/pixi.toml".to_string(),
                kind: "pixi_toml".to_string(),
                project_dir: "/work/proj".to_string(),
                repo_root: Some("/work".to_string()),
                trusted_dir: None,
                summary: runtime_doc::ProjectTrustSummary {
                    activation_scripts: vec!["scripts/activate.sh".to_string()],
                    ..Default::default()
                },
            },
            ..Default::default()
        };

        let status = runtime_status_from_state(state);
        assert_eq!(status.lifecycle, "AwaitingProjectTrust");
        assert_eq!(
            status.project_trust,
            ProjectTrustStatus {
                status: Some("untrusted".to_string()),
                needs_approval: true,
                manifest_path: Some("/work/proj/pixi.toml".to_string()),
                kind: Some("pixi_toml".to_string()),
                project_dir: Some("/work/proj".to_string()),
                repo_root: Some("/work".to_string()),
                trusted_dir: None,
                summary: ProjectTrustSummaryStatus {
                    dependencies: vec![],
                    non_registry_sources: vec![],
                    indexes_and_channels: vec![],
                    build_backend: None,
                    activation_scripts: vec!["scripts/activate.sh".to_string()],
                    outside_directory: vec![],
                    environment_to_build: None,
                },
            }
        );
    }

    #[test]
    fn project_trust_status_reads_unevaluated_state_as_absent() {
        let status = ProjectTrustStatus::from(runtime_doc::ProjectTrustRuntimeState::default());
        assert_eq!(status.status, None);
        assert!(!status.needs_approval);
        assert_eq!(status.project_dir, None);
    }

    #[test]
    fn resolve_socket_path_prefers_explicit_override() {
        let path = resolve_socket_path(Some("/tmp/runtimed-node-test.sock".to_string()));
        assert_eq!(path, PathBuf::from("/tmp/runtimed-node-test.sock"));
    }

    #[test]
    fn resolve_blob_path_uses_daemon_blob_store_sharding() {
        let root =
            std::env::temp_dir().join(format!("runtimed-node-blob-path-{}", uuid::Uuid::new_v4()));
        let blob_root = root.join("blobs");
        let socket_path = root.join("daemon.sock");
        let hash = "abcdef0123456789";
        let blob_path = blob_root.join("ab").join("cdef0123456789");
        std::fs::create_dir_all(blob_path.parent().unwrap()).unwrap();
        std::fs::write(&blob_path, b"arrow").unwrap();

        assert_eq!(
            blob_store_path(Some(socket_path.to_string_lossy().to_string())),
            Some(blob_root.to_string_lossy().to_string())
        );
        assert_eq!(
            resolve_blob_path(
                hash.to_string(),
                Some(socket_path.to_string_lossy().to_string())
            ),
            Some(blob_path.to_string_lossy().to_string())
        );
        assert_eq!(
            resolve_blob_path(
                "not-a-hex-hash".to_string(),
                Some(socket_path.to_string_lossy().to_string())
            ),
            None
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_cell_type_defaults_and_validates() {
        assert_eq!(normalize_cell_type(None).unwrap(), "code");
        assert_eq!(
            normalize_cell_type(Some("markdown".to_string())).unwrap(),
            "markdown"
        );
        assert_eq!(normalize_cell_type(Some("raw".to_string())).unwrap(), "raw");

        let err = normalize_cell_type(Some("sql".to_string())).unwrap_err();
        assert!(err.reason.contains("Invalid cell_type"));
        assert!(err.reason.contains("code, markdown, raw"));
    }

    #[test]
    fn insertion_anchor_defaults_to_append() {
        let cells = vec!["cell-1".to_string(), "cell-2".to_string()];
        assert_eq!(
            insertion_anchor_from_order(&cells, None, None)
                .unwrap()
                .as_deref(),
            Some("cell-2"),
        );
        assert_eq!(
            insertion_anchor_from_order(&cells, Some("cell-1"), None)
                .unwrap()
                .as_deref(),
            Some("cell-1"),
        );
        assert!(insertion_anchor_from_order(&cells, None, Some(0))
            .unwrap()
            .is_none());
        assert_eq!(
            insertion_anchor_from_order(&cells, None, Some(1))
                .unwrap()
                .as_deref(),
            Some("cell-1"),
        );
        assert_eq!(
            insertion_anchor_from_order(&cells, None, Some(99))
                .unwrap()
                .as_deref(),
            Some("cell-2"),
        );

        let err = insertion_anchor_from_order(&cells, Some("cell-1"), Some(0)).unwrap_err();
        assert!(err.reason.contains("cannot both be set"));
    }

    #[test]
    fn sync_result_maps_every_daemon_verdict() {
        let applied =
            environment_sync_result_from_response(NotebookResponse::SyncEnvironmentComplete {
                synced_packages: vec!["numpy".into()],
            })
            .unwrap();
        assert_eq!(
            applied,
            EnvironmentSyncResult::applied(vec!["numpy".into()])
        );
        assert_eq!(
            (
                applied.status.as_str(),
                applied.needs_restart,
                applied.next_action.as_str()
            ),
            ("applied", false, "none")
        );
        assert_eq!(applied.error, None);

        // The incident: uv -> conda metadata change on a running uv kernel.
        let message =
            "Environment changes include removals or config changes that require a kernel restart";
        let restart =
            environment_sync_result_from_response(NotebookResponse::SyncEnvironmentFailed {
                error: message.into(),
                needs_restart: true,
            })
            .unwrap();
        assert_eq!(
            (
                restart.status.as_str(),
                restart.needs_restart,
                restart.next_action.as_str()
            ),
            ("restart_required", true, "restart")
        );
        assert_eq!(restart.error.as_deref(), Some(message));
        assert!(restart.synced_packages.is_empty());

        let failed =
            environment_sync_result_from_response(NotebookResponse::SyncEnvironmentFailed {
                error: "Package sync is disabled for a borrowed local environment".into(),
                needs_restart: false,
            })
            .unwrap();
        assert_eq!(
            (
                failed.status.as_str(),
                failed.needs_restart,
                failed.next_action.as_str()
            ),
            ("failed", false, "inspect")
        );

        let guard = environment_sync_result_from_response(NotebookResponse::GuardRejected {
            reason: "Trust changed before the action could run.".into(),
        })
        .unwrap();
        assert_eq!(guard.status, "failed");
        assert_eq!(
            guard.error.as_deref(),
            Some("Trust changed before the action could run.")
        );

        let error = environment_sync_result_from_response(NotebookResponse::Error {
            error: "boom".into(),
        })
        .unwrap();
        assert_eq!(error, EnvironmentSyncResult::failed("boom".into()));

        assert!(environment_sync_result_from_response(NotebookResponse::Ok {}).is_err());
    }

    #[test]
    fn sync_launch_step_continues_only_for_running_kernel() {
        let launched_config = notebook_protocol::protocol::LaunchedEnvConfig::default();
        let env_source = notebook_protocol::connection::EnvSource::Prewarmed(
            notebook_protocol::connection::PackageManager::Uv,
        );
        assert_eq!(
            sync_launch_failure(NotebookResponse::KernelAlreadyRunning {
                kernel_type: "python".into(),
                env_source: env_source.clone(),
                launched_config: launched_config.clone(),
            })
            .unwrap(),
            None
        );
        assert_eq!(
            sync_launch_failure(NotebookResponse::KernelLaunched {
                kernel_type: "python".into(),
                env_source,
                launched_config,
            })
            .unwrap(),
            None
        );
        let guard = sync_launch_failure(NotebookResponse::GuardRejected {
            reason: "untrusted".into(),
        })
        .unwrap()
        .unwrap();
        assert_eq!(guard, EnvironmentSyncResult::failed("untrusted".into()));
        let rejected = sync_launch_failure(NotebookResponse::EnvironmentSelectionRejected {
            error: "runtime changed".into(),
        })
        .unwrap()
        .unwrap();
        assert_eq!(rejected.next_action, "inspect");
        assert!(sync_launch_failure(NotebookResponse::NoKernel {}).is_err());
    }

    #[test]
    fn restart_launch_reply_uses_daemon_env_source() {
        let reply = launch_reply_for_restart(NotebookResponse::KernelLaunched {
            kernel_type: "python".into(),
            env_source: notebook_protocol::connection::EnvSource::Inline(
                notebook_protocol::connection::PackageManager::Conda,
            ),
            launched_config: Default::default(),
        })
        .unwrap();
        assert_eq!(
            reply,
            LaunchReply::Accepted {
                env_source: "conda:inline".into(),
                environment_id: None,
            }
        );
        assert_eq!(
            launch_reply_for_restart(NotebookResponse::GuardRejected { reason: "r".into() })
                .unwrap(),
            LaunchReply::TrustRejected { reason: "r".into() }
        );
        assert_eq!(
            launch_reply_for_restart(NotebookResponse::Error { error: "e".into() }).unwrap(),
            LaunchReply::Rejected { error: "e".into() }
        );
        assert!(launch_reply_for_restart(NotebookResponse::Ok {}).is_err());
        assert!(shutdown_reply_for_restart(NotebookResponse::NoKernel {}).is_ok());
        assert!(shutdown_reply_for_restart(NotebookResponse::KernelShuttingDown {}).is_ok());
        assert!(shutdown_reply_for_restart(NotebookResponse::Ok {}).is_err());
    }

    #[test]
    fn restart_launch_reply_retains_local_environment_identity() {
        let reply = launch_reply_for_restart(NotebookResponse::KernelLaunched {
            kernel_type: "python".into(),
            env_source: notebook_protocol::connection::EnvSource::Inline(
                notebook_protocol::connection::PackageManager::Conda,
            ),
            launched_config: notebook_protocol::protocol::LaunchedEnvConfig {
                local_environment: Some(notebook_protocol::protocol::LocalEnvironmentIdentity {
                    id: "selected-prefix".into(),
                    name: "Selected environment".into(),
                    python_version: None,
                }),
                ..Default::default()
            },
        })
        .unwrap();
        assert!(
            matches!(reply, LaunchReply::Accepted { environment_id: Some(id), .. } if id == "selected-prefix")
        );
    }

    #[test]
    fn restart_result_keeps_status_conservative() {
        let mut state = runtime_doc::RuntimeState::default();
        state.kernel.lifecycle = runtime_doc::RuntimeLifecycle::Launching;
        state.kernel.env_source = "uv:prewarmed".into();
        let result = restart_result(
            RestartVerdict::TimedOut {
                stage: TimeoutStage::Confirming,
                env_source: Some("conda:inline".into()),
                last: Some(KernelObservation::from(&state.kernel)),
            },
            state,
            Duration::from_millis(500),
        );
        assert_eq!(result.outcome, "timed_out");
        assert_eq!(result.launched_env_source.as_deref(), Some("conda:inline"));
        // A non-Running status never reports the stale pre-restart identity.
        assert_eq!(result.status.lifecycle, "Launching");
        assert_eq!(result.status.env_source, "");
        let error = result.error.unwrap();
        assert!(error.contains("conda:inline"), "{error}");
        assert!(error.contains("Launching uv:prewarmed"), "{error}");

        let mut state = runtime_doc::RuntimeState::default();
        state.kernel.lifecycle =
            runtime_doc::RuntimeLifecycle::Running(runtime_doc::KernelActivity::Idle);
        state.kernel.env_source = "conda:inline".into();
        let result = restart_result(
            RestartVerdict::Running {
                env_source: "conda:inline".into(),
            },
            state,
            Duration::from_secs(1),
        );
        assert_eq!(result.outcome, "running");
        assert_eq!(result.error, None);
        assert_eq!(result.status.lifecycle, "Running");
    }

    /// Runs the restart transitions the driver feeds for a project trust
    /// refusal, in both arrival orders, and returns the public result.
    fn project_trust_restart_result(
        park_observed_first: bool,
        response: NotebookResponse,
    ) -> KernelRestartResult {
        let mut stopped = runtime_doc::RuntimeState::default();
        stopped.kernel.lifecycle = runtime_doc::RuntimeLifecycle::Shutdown;
        stopped.kernel.env_source = "uv:prewarmed".into();
        let mut parked = runtime_doc::RuntimeState::default();
        parked.kernel.lifecycle = runtime_doc::RuntimeLifecycle::AwaitingProjectTrust;
        parked.project_trust.status = "untrusted".into();
        parked.project_trust.needs_approval = true;
        parked.project_trust.kind = "environment_yml".into();

        let mut phase = step(RestartPhase::initial(), RestartEvent::ShutdownAcknowledged);
        phase = step(
            phase,
            RestartEvent::Observed(KernelObservation::from(&stopped.kernel)),
        );
        assert!(matches!(phase, RestartPhase::Launching { .. }), "{phase:?}");
        let mut last_state = stopped;
        if park_observed_first {
            last_state = parked;
            phase = step(
                phase,
                RestartEvent::Observed(KernelObservation::from(&last_state.kernel)),
            );
        }
        phase = step(
            phase,
            RestartEvent::LaunchReplied(launch_reply_for_restart(response).unwrap()),
        );
        let RestartPhase::Done(verdict) = phase else {
            panic!("a launch refusal must be terminal, got {phase:?}");
        };
        restart_result(verdict, last_state, Duration::from_secs(1))
    }

    #[test]
    fn project_trust_guard_rejection_is_trust_required_in_either_order() {
        let reason = "The project folder is not trusted on this machine. \
                      Trust it or use the notebook environment to launch.";
        for park_observed_first in [true, false] {
            let result = project_trust_restart_result(
                park_observed_first,
                NotebookResponse::GuardRejected {
                    reason: reason.into(),
                },
            );
            assert_eq!(result.outcome, "trust_required", "{park_observed_first}");
            assert_eq!(result.error.as_deref(), Some(reason));
            assert_eq!(result.launched_env_source, None);
            // The result returns on the reply. Its status is whatever the
            // replica held then; it is not awaited or used for the verdict.
            if park_observed_first {
                assert_eq!(result.status.lifecycle, "AwaitingProjectTrust");
                assert!(result.status.project_trust.needs_approval);
            } else {
                assert_eq!(result.status.lifecycle, "Shutdown");
                assert!(!result.status.project_trust.needs_approval);
            }
            assert_eq!(result.status.env_source, "");
        }
    }

    #[test]
    fn generic_launch_error_stays_launch_rejected_even_with_trust_text() {
        // Daemons that predate the typed refusal reply `Error` for a parked
        // project. Without a typed reply this is a generic launch failure.
        for park_observed_first in [true, false] {
            let result = project_trust_restart_result(
                park_observed_first,
                NotebookResponse::Error {
                    error: "The project folder is not trusted on this machine.".into(),
                },
            );
            assert_eq!(result.outcome, "launch_rejected", "{park_observed_first}");
        }
    }

    #[test]
    fn package_manager_converts_to_protocol_enum() {
        let uv: notebook_protocol::connection::PackageManager = PackageManager::Uv.into();
        let conda: notebook_protocol::connection::PackageManager = PackageManager::Conda.into();
        let pixi: notebook_protocol::connection::PackageManager = PackageManager::Pixi.into();

        assert_eq!(uv.as_str(), "uv");
        assert_eq!(conda.as_str(), "conda");
        assert_eq!(pixi.as_str(), "pixi");
    }

    #[test]
    fn dependency_package_manager_prefers_explicit_option() {
        let metadata = notebook_doc::metadata::NotebookMetadataSnapshot::default();

        assert_eq!(
            dependency_package_manager(
                Some(DependencyEditOptions {
                    package_manager: Some(PackageManager::Pixi),
                }),
                None,
                &metadata,
            ),
            PackageManager::Pixi
        );
    }

    #[test]
    fn dependency_package_manager_prefers_running_env_source() {
        let mut metadata = notebook_doc::metadata::NotebookMetadataSnapshot::default();
        metadata.add_uv_dependency("numpy");
        let runtime_state = runtime_doc::RuntimeState {
            kernel: runtime_doc::KernelState {
                env_source: "conda:environment-yml".to_string(),
                ..Default::default()
            },
            ..Default::default()
        };

        assert_eq!(
            dependency_package_manager(None, Some(&runtime_state), &metadata),
            PackageManager::Conda
        );
    }

    #[test]
    fn dependency_package_manager_uses_inline_metadata_before_project_context() {
        let mut metadata = notebook_doc::metadata::NotebookMetadataSnapshot::default();
        metadata.add_pixi_dependency("numpy");
        let runtime_state = runtime_doc::RuntimeState {
            project_context: ProjectContext::Detected {
                project_file: runtime_doc::ProjectFile {
                    kind: ProjectFileKind::PyprojectToml,
                    absolute_path: "/tmp/pyproject.toml".to_string(),
                    relative_to_notebook: "pyproject.toml".to_string(),
                },
                parsed: runtime_doc::ProjectFileParsed::default(),
                observed_at: "2026-05-03T00:00:00Z".to_string(),
            },
            ..Default::default()
        };

        assert_eq!(
            dependency_package_manager(None, Some(&runtime_state), &metadata),
            PackageManager::Pixi
        );
    }

    #[test]
    fn dependency_package_manager_falls_back_to_project_context_then_uv() {
        let metadata = notebook_doc::metadata::NotebookMetadataSnapshot::default();
        let runtime_state = runtime_doc::RuntimeState {
            project_context: ProjectContext::Detected {
                project_file: runtime_doc::ProjectFile {
                    kind: ProjectFileKind::EnvironmentYml,
                    absolute_path: "/tmp/environment.yml".to_string(),
                    relative_to_notebook: "environment.yml".to_string(),
                },
                parsed: runtime_doc::ProjectFileParsed::default(),
                observed_at: "2026-05-03T00:00:00Z".to_string(),
            },
            ..Default::default()
        };

        assert_eq!(
            dependency_package_manager(None, Some(&runtime_state), &metadata),
            PackageManager::Conda
        );
        assert_eq!(
            dependency_package_manager(None, None, &metadata),
            PackageManager::Uv
        );
    }

    #[tokio::test]
    async fn execution_state_result_includes_execution_id_and_terminal_fields() {
        let state = runtime_doc::ExecutionState {
            status: "done".to_string(),
            execution_count: Some(3),
            success: Some(true),
            outputs: vec![],
            source: Some("1 + 1".to_string()),
            cell_id: None,
            seq: Some(9),
            submitted_by_actor_label: None,
        };

        let result =
            cell_result_from_execution_state("exec-1", Some("cell-1"), &state, None, &None, &None)
                .await
                .unwrap();

        assert_eq!(result.cell_id, "cell-1");
        assert_eq!(result.execution_id, "exec-1");
        assert_eq!(result.status, "done");
        assert_eq!(result.execution_count, Some(3));
        assert!(result.success);
        assert!(result.outputs.is_empty());
    }

    #[test]
    fn timeout_cell_result_preserves_ids_and_terminal_shape() {
        let result = timeout_cell_result("cell-timeout".to_string(), "exec-timeout".to_string());

        assert_eq!(result.cell_id, "cell-timeout");
        assert_eq!(result.execution_id, "exec-timeout");
        assert_eq!(result.execution_count, None);
        assert_eq!(result.status, "timeout");
        assert!(!result.success);
        assert!(result.outputs.is_empty());
    }

    #[tokio::test]
    async fn execution_record_result_recovers_required_execution_id() {
        let state = runtime_doc::ExecutionState {
            status: "done".to_string(),
            execution_count: Some(5),
            success: Some(true),
            outputs: vec![],
            source: Some("print('ok')".to_string()),
            cell_id: None,
            seq: Some(11),
            submitted_by_actor_label: None,
        };
        let record = runtimed_client::execution_store::ExecutionRecord::from_execution_state(
            "exec-from-store",
            "notebook",
            "nb-1",
            None,
            &state,
        );

        let result = cell_result_from_record(Path::new("/tmp/runtimed-node-test.sock"), record)
            .await
            .unwrap();

        assert_eq!(result.cell_id, "");
        assert_eq!(result.execution_id, "exec-from-store");
        assert_eq!(result.execution_count, Some(5));
        assert!(result.success);
    }

    #[test]
    fn to_js_output_preserves_output_fields_and_typed_data_contract() {
        let data = HashMap::from([
            (
                "text/plain".to_string(),
                SharedDataValue::Text("hello".to_string()),
            ),
            (
                "image/png".to_string(),
                SharedDataValue::Binary(vec![0, 1, 2, 255]),
            ),
            (
                "application/json".to_string(),
                SharedDataValue::Json(json!({"ok": true, "n": 3})),
            ),
        ]);
        let mut output = SharedOutput::execute_result(data, 7);
        output.blob_urls = Some(HashMap::from([(
            "image/png".to_string(),
            "http://localhost:9999/blob/abc".to_string(),
        )]));
        output.blob_paths = Some(HashMap::from([(
            "image/png".to_string(),
            "/tmp/blobs/ab/abc".to_string(),
        )]));

        let js_output = js_output_from_resolved_output(output).expect("output serializes");

        assert_eq!(js_output.output_type, "execute_result");
        assert_eq!(js_output.execution_count, Some(7));

        let data_json: serde_json::Value =
            serde_json::from_str(js_output.data_json.as_deref().unwrap()).unwrap();
        assert_eq!(
            data_json["text/plain"],
            json!({"type": "text", "value": "hello"})
        );
        assert_eq!(
            data_json["image/png"],
            json!({"type": "binary", "value": "AAEC/w=="})
        );
        assert_eq!(
            data_json["application/json"],
            json!({"type": "json", "value": {"ok": true, "n": 3}})
        );

        let blob_urls: serde_json::Value =
            serde_json::from_str(js_output.blob_urls_json.as_deref().unwrap()).unwrap();
        assert_eq!(
            blob_urls,
            json!({"image/png": "http://localhost:9999/blob/abc"})
        );

        let blob_paths: serde_json::Value =
            serde_json::from_str(js_output.blob_paths_json.as_deref().unwrap()).unwrap();
        assert_eq!(blob_paths, json!({"image/png": "/tmp/blobs/ab/abc"}));
    }

    #[test]
    fn to_js_output_keeps_kernel_error_shape_stable() {
        let output = SharedOutput::error(
            "ValueError",
            "bad value",
            vec![
                "Traceback line 1".to_string(),
                "Traceback line 2".to_string(),
            ],
        );

        let js_output = js_output_from_resolved_output(output).expect("error output serializes");

        assert_eq!(js_output.output_type, "error");
        assert_eq!(js_output.ename.as_deref(), Some("ValueError"));
        assert_eq!(js_output.evalue.as_deref(), Some("bad value"));
        assert_eq!(
            js_output.traceback,
            Some(vec![
                "Traceback line 1".to_string(),
                "Traceback line 2".to_string()
            ])
        );
        assert!(js_output.data_json.is_none());
        assert!(js_output.blob_urls_json.is_none());
        assert!(js_output.blob_paths_json.is_none());
    }
}
