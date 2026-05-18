//! `Session` — the user-facing handle for a notebook + kernel.
//!
//! Phase 1: minimal surface duplicated from `runtimed-py/src/session_core.rs`.
//! Phase 2 will extract the shared logic into a `runtimed-session` crate
//! and collapse both `-py` and `-node` onto it.

use std::path::PathBuf;
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
use runtime_doc::{diff_executions, ProjectContext, ProjectFileKind};

/// Valid cell types accepted by `runCell`.
const VALID_CELL_TYPES: &[&str] = &["code", "markdown", "raw"];

type CommMap = std::collections::HashMap<String, runtime_doc::CommDocEntry>;
type JsonCallback = ThreadsafeFunction<String, (), (String,), napi::Status, false, false, 0>;

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

/// Notebook dependency metadata and trust/runtime status.
#[napi(object)]
pub struct DependencyStatus {
    pub uv: Option<UvDependencyStatus>,
    pub conda: Option<CondaDependencyStatus>,
    pub pixi: Option<PixiDependencyStatus>,
    pub fingerprint: Option<String>,
    pub trust: DependencyTrustStatus,
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
    pub env_source: String,
    pub runtime_agent_id: String,
    pub error_reason: Option<String>,
    pub error_details: Option<String>,
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

// ── Internal state ─────────────────────────────────────────────────────

struct SessionState {
    handle: Option<DocHandle>,
    /// Kept alive so the daemon doesn't close the broadcast channel.
    /// Dropped on `close()` to allow clean teardown.
    _broadcast_rx: Option<BroadcastReceiver>,
    kernel_started: bool,
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
    state: Arc<Mutex<SessionState>>,
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
    fn new(task: tokio::task::JoinHandle<()>) -> Self {
        Self {
            task: Arc::new(std::sync::Mutex::new(Some(task))),
        }
    }
}

/// Spawns subscription watchers on the napi-managed Tokio runtime.
///
/// The `Session.on*` methods are synchronous N-API entry points, so they cannot
/// rely on an ambient Tokio task context being present on the calling thread.
fn spawn_event_task<F>(future: F) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    napi::bindgen_prelude::spawn(future)
}

fn json_callback(callback: Function<'_, (String,), ()>) -> Result<JsonCallback> {
    callback
        .build_threadsafe_function::<String>()
        .callee_handled::<false>()
        .build_callback(|ctx| Ok((ctx.value,)))
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

    /// Subscribe to resolved progress snapshots for one execution.
    ///
    /// Callback receives the same JSON shape as `CellResult`, emitted whenever
    /// the RuntimeStateDoc entry for the execution changes. The subscription
    /// ends after an authoritative terminal snapshot, including kernel
    /// failure/close.
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
            NotebookResponse::NotebookSaved { .. } => Ok(()),
            NotebookResponse::Error { error } => Err(Error::from_reason(error)),
            other => Err(Error::from_reason(format!(
                "Unexpected response: {other:?}"
            ))),
        }
    }

    /// Close the session and release the underlying connection.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        let mut st = self.state.lock().await;
        st.handle = None;
        st._broadcast_rx = None;
        st.kernel_started = false;
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
        approve_current_trust(&handle, None).await
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
            approve_current_trust(&handle, None).await?;
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
        approve_current_trust(&handle, observed_heads).await
    }

    /// Ask the daemon to hot-install any pending dependency changes into
    /// the running kernel's env. Starts the kernel first if needed.
    /// Returns once the install finishes.
    #[napi]
    pub async fn sync_environment(&self) -> Result<()> {
        ensure_kernel_started(&self.state).await?;
        let handle = {
            let st = self.state.lock().await;
            st.handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not connected"))?
                .clone()
        };
        handle.confirm_sync().await.map_err(to_napi_err)?;
        let response = handle
            .send_request(NotebookRequest::SyncEnvironment { guard: None })
            .await
            .map_err(to_napi_err)?;
        match response {
            NotebookResponse::SyncEnvironmentComplete { .. } => Ok(()),
            NotebookResponse::SyncEnvironmentFailed { error, .. } => Err(Error::from_reason(error)),
            NotebookResponse::GuardRejected { reason } => Err(Error::from_reason(reason)),
            NotebookResponse::Error { error } => Err(Error::from_reason(error)),
            other => Err(Error::from_reason(format!(
                "Unexpected response: {other:?}"
            ))),
        }
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
            NotebookResponse::KernelShuttingDown {} => {
                let mut st = self.state.lock().await;
                st.kernel_started = false;
                Ok(true)
            }
            NotebookResponse::NoKernel {} => {
                let mut st = self.state.lock().await;
                st.kernel_started = false;
                Ok(false)
            }
            NotebookResponse::Error { error } => Err(Error::from_reason(error)),
            other => Err(Error::from_reason(format!(
                "Unexpected response to shutdownKernel: {other:?}"
            ))),
        }
    }

    /// Restart the kernel, clearing in-memory state while preserving notebook dependencies.
    #[napi]
    pub async fn restart_kernel(&self) -> Result<bool> {
        let handle = session_handle(&self.state).await?;
        let had_kernel = self.shutdown_kernel().await?;
        if had_kernel {
            wait_for_kernel_not_running(&handle, Duration::from_secs(30)).await?;
        }
        {
            let mut st = self.state.lock().await;
            st.kernel_started = false;
        }
        ensure_kernel_started(&self.state).await?;
        Ok(true)
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
            st.handle = None;
            st._broadcast_rx = None;
            st.kernel_started = false;
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

    let result = notebook_sync::connect::connect_create_with_environment_mode(
        socket_path.clone(),
        &runtime,
        working_dir.clone(),
        &actor_label,
        /* ephemeral */ false,
        package_manager,
        dependencies,
        environment_mode,
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

    let state = SessionState {
        handle: Some(result.handle),
        _broadcast_rx: Some(result.broadcast_rx),
        kernel_started: false,
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
        state: Arc::new(Mutex::new(state)),
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
    let (kernel_started, runtime) = kernel_state_from_handle(&result.handle);

    let state = SessionState {
        handle: Some(result.handle),
        _broadcast_rx: Some(result.broadcast_rx),
        kernel_started,
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
        state: Arc::new(Mutex::new(state)),
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
    let (kernel_started, runtime) = kernel_state_from_handle(&result.handle);

    let state = SessionState {
        handle: Some(result.handle),
        _broadcast_rx: Some(result.broadcast_rx),
        kernel_started,
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
        state: Arc::new(Mutex::new(state)),
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

async fn resolve_blob_paths(socket_path: &std::path::Path) -> (Option<String>, Option<PathBuf>) {
    if let Some(parent) = socket_path.parent() {
        let daemon_json = parent.join("daemon.json");
        let base_url = if daemon_json.exists() {
            tokio::fs::read_to_string(&daemon_json)
                .await
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("blob_port").and_then(|p| p.as_u64()))
                .map(|port| format!("http://localhost:{port}"))
        } else {
            None
        };
        let store_path = parent.join("blobs");
        let store_path = if store_path.exists() {
            Some(store_path)
        } else {
            None
        };
        (base_url, store_path)
    } else {
        (None, None)
    }
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

fn kernel_state_from_handle(handle: &DocHandle) -> (bool, String) {
    let rs = handle.get_runtime_state().ok();
    let started = rs
        .as_ref()
        .map(|r| {
            matches!(
                r.kernel.lifecycle,
                runtime_doc::RuntimeLifecycle::Running(_)
            )
        })
        .unwrap_or(false);
    let runtime = rs
        .as_ref()
        .map(|r| r.kernel.name.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "python".to_string());
    (started, runtime)
}

async fn wait_for_kernel_not_running(handle: &DocHandle, timeout: Duration) -> Result<()> {
    let start = std::time::Instant::now();
    loop {
        match handle.get_runtime_state() {
            Ok(state)
                if !matches!(
                    state.kernel.lifecycle,
                    runtime_doc::RuntimeLifecycle::Running(_)
                ) =>
            {
                return Ok(());
            }
            Ok(_) | Err(_) if start.elapsed() < timeout => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Ok(state) => {
                return Err(Error::from_reason(format!(
                    "Timed out waiting for kernel shutdown; lifecycle is {}",
                    state.kernel.lifecycle.variant_str()
                )));
            }
            Err(e) => {
                return Err(Error::from_reason(format!(
                    "Timed out waiting for kernel shutdown; runtime state unavailable: {e}"
                )));
            }
        }
    }
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
    handle
        .get_notebook_metadata()
        .map(|snapshot| snapshot.dependency_fingerprint())
}

fn runtime_status_for_handle(handle: &DocHandle) -> RuntimeStatus {
    let kernel = handle
        .get_runtime_state()
        .ok()
        .map(|state| state.kernel)
        .unwrap_or_default();
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
        error_reason: kernel.error_reason.filter(|s| !s.is_empty()),
        error_details: kernel.error_details.filter(|s| !s.is_empty()),
    }
}

fn dependency_status_for_handle(handle: &DocHandle) -> DependencyStatus {
    let metadata = handle.get_notebook_metadata().unwrap_or_default();
    let uv = metadata.runt.uv.as_ref();
    let conda = metadata.runt.conda.as_ref();
    let pixi = metadata.runt.pixi.as_ref();
    let trust = handle.get_runtime_state().ok().map(|state| state.trust);

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
        fingerprint: Some(metadata.dependency_fingerprint()),
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
    }
}

async fn approve_current_trust(
    handle: &DocHandle,
    observed_heads: Option<Vec<String>>,
) -> Result<()> {
    handle.confirm_sync().await.map_err(to_napi_err)?;
    let response = handle
        .send_request(NotebookRequest::ApproveTrust { observed_heads })
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

async fn ensure_kernel_started(state: &Arc<Mutex<SessionState>>) -> Result<()> {
    let (started, runtime, notebook_path) = {
        let st = state.lock().await;
        (
            st.kernel_started,
            st.runtime.clone(),
            st.working_dir.clone(),
        )
    };
    if started {
        return Ok(());
    }
    let handle = {
        let st = state.lock().await;
        st.handle
            .as_ref()
            .ok_or_else(|| Error::from_reason("Not connected"))?
            .clone()
    };
    handle.confirm_sync().await.map_err(to_napi_err)?;
    let response = handle
        .send_request(NotebookRequest::LaunchKernel {
            kernel_type: runtime.clone(),
            env_source: notebook_protocol::connection::LaunchSpec::Auto,
            notebook_path,
        })
        .await
        .map_err(to_napi_err)?;

    match response {
        NotebookResponse::KernelLaunched { .. } | NotebookResponse::KernelAlreadyRunning { .. } => {
            let mut st = state.lock().await;
            st.kernel_started = true;
            Ok(())
        }
        NotebookResponse::GuardRejected { reason } => Err(Error::from_reason(reason)),
        NotebookResponse::Error { error } => Err(Error::from_reason(error)),
        other => Err(Error::from_reason(format!(
            "Unexpected response: {other:?}"
        ))),
    }
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
    let response = handle
        .send_request_after_heads(
            NotebookRequest::ExecuteCell {
                cell_id: cell_id.to_string(),
            },
            required_heads,
        )
        .await
        .map_err(to_napi_err)?;
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
    let exec = runtime_doc::ExecutionState {
        cell_id: record.cell_id.unwrap_or_default(),
        status: record.status,
        execution_count: record.execution_count,
        success: record.success,
        outputs: record.outputs,
        source: record.source,
        seq: record.seq,
    };
    cell_result_from_execution_state(
        &execution_id,
        None,
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
    let cell_id = if state.cell_id.is_empty() {
        fallback_cell_id.unwrap_or_default()
    } else {
        state.cell_id.as_str()
    };
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
    fn resolve_socket_path_prefers_explicit_override() {
        let path = resolve_socket_path(Some("/tmp/runtimed-node-test.sock".to_string()));
        assert_eq!(path, PathBuf::from("/tmp/runtimed-node-test.sock"));
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
            cell_id: "cell-1".to_string(),
            status: "done".to_string(),
            execution_count: Some(3),
            success: Some(true),
            outputs: vec![],
            source: Some("1 + 1".to_string()),
            seq: Some(9),
        };

        let result = cell_result_from_execution_state("exec-1", None, &state, None, &None, &None)
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
            cell_id: "cell-from-record".to_string(),
            status: "done".to_string(),
            execution_count: Some(5),
            success: Some(true),
            outputs: vec![],
            source: Some("print('ok')".to_string()),
            seq: Some(11),
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

        assert_eq!(result.cell_id, "cell-from-record");
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
