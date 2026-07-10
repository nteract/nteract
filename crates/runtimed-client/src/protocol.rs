//! IPC protocol types for daemon communication.
//!
//! Notebook protocol types (NotebookRequest, NotebookResponse,
//! NotebookBroadcast, etc.) are defined in the `notebook-protocol` crate
//! and re-exported here for backward compatibility.
//!
//! Daemon-internal types (Request, Response) are defined here.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use notebook_doc::pool_state::PoolState;

use crate::{EnvType, PooledEnv};

// Re-export all notebook protocol types from the shared crate.
pub use notebook_protocol::connection::{EnvSource, LaunchSpec};
pub use notebook_protocol::protocol::{
    CompletionItem, DenoLaunchedConfig, DependencyGuard, EnvSyncDiff, ExecutionIdRejectionReason,
    GuardedNotebookProvenance, HistoryEntry, LaunchedEnvConfig, NotebookBroadcast, NotebookRequest,
    NotebookResponse, QueueEntry,
};

/// Requests that clients can send to the daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Request an environment from the pool.
    /// If available, the daemon will claim it and return the path.
    Take { env_type: EnvType },

    /// Return an environment to the pool (optional - daemon reclaims on death).
    Return { env: PooledEnv },

    /// Get current pool statistics.
    Status,

    /// Ping to check if daemon is alive.
    Ping,

    /// Request daemon shutdown (for clean termination).
    Shutdown,

    /// Flush all pooled environments and rebuild with current settings.
    FlushPool,

    /// Inspect the Automerge state for a notebook.
    InspectNotebook {
        /// The notebook ID (file path used as identifier).
        notebook_id: String,
    },

    /// Read a coherent, room-owned projection after initial materialization.
    ///
    /// Unlike `InspectNotebook`, this request never falls back to a persisted
    /// document. The notebook must have a resident room, and the daemon waits
    /// for that room's initial materialization source to settle before
    /// returning the projection.
    GetNotebookProjection {
        /// UUID of the resident notebook room.
        notebook_id: String,
    },

    /// List all active notebook rooms.
    ListRooms,

    /// Shutdown a notebook's kernel and evict its room.
    ShutdownNotebook {
        /// The notebook ID (file path used as identifier).
        notebook_id: String,
    },

    /// Get environment paths currently in use by running kernels.
    /// Used by `runt env clean` to avoid evicting active environments.
    ActiveEnvPaths,

    /// Get rich daemon metadata (pid, version, start time, blob server
    /// port, dev-mode worktree). This is the canonical discovery path for
    /// clients that need more than liveness; use `Ping` if only the daemon
    /// version is needed.
    GetDaemonInfo,

    /// Read a terminal execution result by durable execution ID.
    GetExecutionResult { execution_id: String },

    /// Get tokio runtime metrics (worker utilization, task counts, queue
    /// depths). Used by `runt daemon status --json` and diagnostic tools
    /// to measure whether the daemon's async runtime is spreading work
    /// across cores under load.
    GetRuntimeMetrics,
}

/// Responses from the daemon to clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// Successfully took an environment.
    Env { env: PooledEnv },

    /// No environment available right now.
    Empty,

    /// Environment returned successfully.
    Returned,

    /// Pool state (from PoolDoc).
    Stats { state: PoolState },

    /// Pong response to ping.
    ///
    /// Includes version metadata so clients can detect version mismatches
    /// early (before attempting notebook sync or other operations).
    /// All fields are optional for backward compatibility with older daemons.
    Pong {
        /// Numeric protocol version (matches `PROTOCOL_VERSION` in connection.rs).
        /// Bump only on breaking wire-format changes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_version: Option<u32>,
        /// Daemon version string (e.g., "2.0.0+abc123").
        #[serde(default, skip_serializing_if = "Option::is_none")]
        daemon_version: Option<String>,
    },

    /// Rich daemon metadata returned from `Request::GetDaemonInfo`.
    ///
    /// Carries pid, version, start time, blob server port, and the dev-mode
    /// worktree fields. Older daemons that don't know this request respond
    /// with `Response::Error { message: "Unknown request" }`; clients should
    /// treat that as "metadata unavailable".
    DaemonInfo {
        /// Numeric protocol version (matches `PROTOCOL_VERSION`).
        protocol_version: u32,
        /// Daemon version string (e.g., "2.0.0+abc123").
        daemon_version: String,
        /// Daemon process ID.
        pid: u32,
        /// When the daemon started.
        started_at: DateTime<Utc>,
        /// HTTP port for the content-addressed blob server. `None` if the
        /// blob server hasn't finished binding yet.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blob_port: Option<u16>,
        /// Directory for durable execution result records.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_store_dir: Option<String>,
        /// Path to the git worktree this dev daemon is pinned to.
        /// Non-dev daemons return None.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worktree_path: Option<String>,
        /// Human-readable workspace description (dev mode only).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_description: Option<String>,
    },

    /// Shutdown acknowledged.
    ShuttingDown,

    /// Pool flush acknowledged — environments will be rebuilt.
    Flushed,

    /// Generic success acknowledgment.
    Ok,

    /// Durable execution record found by execution ID.
    ExecutionResult {
        record: crate::execution_store::ExecutionRecord,
    },

    /// An error occurred.
    Error { message: String },

    /// Notebook state inspection result.
    NotebookState {
        /// The notebook ID.
        notebook_id: String,
        /// Cell snapshots from the Automerge doc.
        cells: Vec<notebook_doc::CellSnapshot>,
        /// Outputs keyed by cell_id. Outputs live in `RuntimeStateDoc`
        /// keyed by `execution_id`, so they travel here as a parallel map
        /// rather than on `CellSnapshot`. Only cells with non-empty outputs
        /// appear.
        #[serde(default)]
        outputs_by_cell: std::collections::HashMap<String, Vec<serde_json::Value>>,
        /// Whether this was loaded from a live room or from disk.
        source: String,
        /// Kernel info if a kernel is running.
        kernel_info: Option<NotebookKernelInfo>,
    },

    /// A coherent room-owned notebook projection.
    NotebookProjection { projection: NotebookProjection },

    /// Projection could not be produced from the authoritative room.
    NotebookProjectionUnavailable {
        notebook_id: String,
        failure: NotebookProjectionFailure,
    },

    /// List of active notebook rooms.
    RoomsList { rooms: Vec<RoomInfo> },

    /// Notebook shutdown result.
    NotebookShutdown {
        /// Whether the notebook was found and shut down.
        found: bool,
    },

    /// Environment paths currently in use by running kernels.
    ActiveEnvPaths { paths: Vec<PathBuf> },

    /// Tokio runtime metrics snapshot.
    ///
    /// Returned from `Request::GetRuntimeMetrics`. Carries per-worker
    /// busy durations, task counts, and queue depths so tooling can
    /// compute utilization without `tokio_unstable`.
    RuntimeMetrics {
        /// Number of tokio worker threads.
        num_workers: usize,
        /// Number of currently alive (spawned but not yet completed) tasks.
        num_alive_tasks: usize,
        /// Tasks waiting in the global (injection) queue.
        global_queue_depth: usize,
        /// Per-worker cumulative busy duration in microseconds.
        /// Index corresponds to worker index 0..num_workers.
        worker_busy_us: Vec<u64>,
        /// Per-worker park (idle) count. High park counts relative to
        /// poll counts indicate an underloaded worker.
        worker_park_count: Vec<u64>,
        /// Wall-clock microseconds since daemon start — divide
        /// `worker_busy_us[i]` by this to get per-worker utilization.
        uptime_us: u64,
    },
}

/// Kernel info for a notebook room.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookKernelInfo {
    pub kernel_type: String,
    pub env_source: String,
    pub status: String,
}

/// Version of the room-owned notebook projection wire shape.
pub const NOTEBOOK_PROJECTION_SCHEMA_VERSION: u32 = 1;

/// Typed terminal failures for room-owned projection requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotebookProjectionFailure {
    /// The UUID does not name a resident room.
    RoomNotFound,
    /// The room's initial file materialization reached a terminal failure.
    InitialLoadFailed { generation: u64, reason: String },
}

impl std::fmt::Display for NotebookProjectionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RoomNotFound => write!(f, "room not found"),
            Self::InitialLoadFailed { generation, reason } => {
                write!(f, "initial load generation {generation} failed: {reason}")
            }
        }
    }
}

/// Lightweight, ordered cell information returned during notebook connect.
///
/// The daemon deliberately bounds `source_preview`: initial discovery needs
/// stable cell IDs and enough source to orient an agent, not an unbounded copy
/// of every cell. Full source remains available through the notebook document
/// once the caller's replica contains `NotebookProjection::notebook_heads`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotebookCellProjection {
    pub id: String,
    pub cell_type: String,
    pub source_preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_count: Option<i64>,
}

/// Compact runtime facts needed by notebook connect responses.
///
/// Execution records and output payloads are intentionally omitted; they can
/// be large and have dedicated query surfaces. The returned runtime-state
/// heads identify the exact causal snapshot these facts came from.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NotebookRuntimeProjection {
    pub kernel: runtime_doc::KernelState,
    pub env: runtime_doc::EnvState,
    pub trust: runtime_doc::TrustRuntimeState,
    pub project_context: runtime_doc::ProjectContext,
}

/// Coherent initial notebook view captured from the authoritative room.
///
/// NotebookDoc and RuntimeStateDoc are separate Automerge documents, so the
/// two head sets describe their respective snapshots rather than pretending
/// the pair is transactionally atomic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotebookProjection {
    pub schema_version: u32,
    pub load_generation: u64,
    pub notebook_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notebook_path: Option<String>,
    pub cells: Vec<NotebookCellProjection>,
    /// Preserves the existing MCP connect behavior: this is the UV dependency
    /// list from `metadata.runt.uv.dependencies`.
    #[serde(default)]
    pub dependencies: Vec<String>,
    pub runtime: NotebookRuntimeProjection,
    pub notebook_heads: Vec<String>,
    pub runtime_state_heads: Vec<String>,
    pub captured_at: DateTime<Utc>,
}

/// High-level lifecycle position of a notebook room.
///
/// - `Active`: at least one peer is connected.
/// - `Idle`: no peers, but the kernel is still running (within the
///   no-peers grace before kernel teardown).
/// - `Inactive`: no peers and no kernel — resumable. Open by path or
///   `notebook_id` to bring the room back to life. After the ghost
///   reaper's TTL the room is removed entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomState {
    Active,
    Idle,
    Inactive,
}

impl Default for RoomState {
    /// Backwards-compat default for clients deserializing from older
    /// daemons that don't emit a `state` field. Treat absence as
    /// `Active` because that was the universal behaviour before the
    /// state field existed (rooms only appeared in `list_rooms` while a
    /// peer was connected).
    fn default() -> Self {
        RoomState::Active
    }
}

impl RoomState {
    /// Wire-stable string form for CLI and logs.
    pub fn as_str(self) -> &'static str {
        match self {
            RoomState::Active => "active",
            RoomState::Idle => "idle",
            RoomState::Inactive => "inactive",
        }
    }
}

/// Info about an active notebook room.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub notebook_id: String,
    pub active_peers: usize,
    pub had_peers: bool,
    pub has_kernel: bool,
    /// Kernel type if running (e.g., "python", "deno")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_type: Option<String>,
    /// Environment source if kernel is running (e.g., "uv:inline", "conda:prewarmed")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_source: Option<String>,
    /// Kernel status if running (e.g., "idle", "busy", "starting")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_status: Option<String>,
    #[serde(default)]
    pub ephemeral: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notebook_path: Option<String>,
    /// Lifecycle position: `active` (peers > 0), `idle` (no peers,
    /// kernel alive), or `inactive` (no peers, no kernel — resumable).
    /// Older daemons that don't emit this field default to `active`.
    #[serde(default)]
    pub state: RoomState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn roundtrip_request(req: &Request) -> Request {
        let bytes = serde_json::to_vec(req).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn roundtrip_response(resp: &Response) -> Response {
        let bytes = serde_json::to_vec(resp).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn test_request_take_uv() {
        let req = Request::Take {
            env_type: EnvType::Uv,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("take"));
        assert!(json.contains("uv"));

        match roundtrip_request(&req) {
            Request::Take { env_type } => assert_eq!(env_type, EnvType::Uv),
            _ => panic!("unexpected request type"),
        }
    }

    #[test]
    fn test_request_take_conda() {
        let req = Request::Take {
            env_type: EnvType::Conda,
        };
        match roundtrip_request(&req) {
            Request::Take { env_type } => assert_eq!(env_type, EnvType::Conda),
            _ => panic!("unexpected request type"),
        }
    }

    #[test]
    fn test_request_return() {
        let env = PooledEnv {
            env_type: EnvType::Uv,
            venv_path: PathBuf::from("/tmp/test-venv"),
            python_path: PathBuf::from("/tmp/test-venv/bin/python"),
            prewarmed_packages: vec![],
        };
        let req = Request::Return { env: env.clone() };
        match roundtrip_request(&req) {
            Request::Return { env: parsed_env } => {
                assert_eq!(parsed_env.venv_path, env.venv_path);
                assert_eq!(parsed_env.python_path, env.python_path);
            }
            _ => panic!("unexpected request type"),
        }
    }

    #[test]
    fn test_request_status() {
        assert!(matches!(
            roundtrip_request(&Request::Status),
            Request::Status
        ));
    }

    #[test]
    fn test_request_ping() {
        assert!(matches!(roundtrip_request(&Request::Ping), Request::Ping));
    }

    #[test]
    fn test_request_shutdown() {
        assert!(matches!(
            roundtrip_request(&Request::Shutdown),
            Request::Shutdown
        ));
    }

    #[test]
    fn test_request_flush_pool() {
        assert!(matches!(
            roundtrip_request(&Request::FlushPool),
            Request::FlushPool
        ));
    }

    #[test]
    fn test_request_get_runtime_metrics() {
        assert!(matches!(
            roundtrip_request(&Request::GetRuntimeMetrics),
            Request::GetRuntimeMetrics
        ));
    }

    #[test]
    fn test_request_get_notebook_projection() {
        let request = Request::GetNotebookProjection {
            notebook_id: "018f0000-0000-7000-8000-000000000001".to_string(),
        };
        match roundtrip_request(&request) {
            Request::GetNotebookProjection { notebook_id } => {
                assert_eq!(notebook_id, "018f0000-0000-7000-8000-000000000001");
            }
            _ => panic!("unexpected request type"),
        }
    }

    #[test]
    fn test_response_runtime_metrics() {
        let resp = Response::RuntimeMetrics {
            num_workers: 4,
            num_alive_tasks: 42,
            global_queue_depth: 3,
            worker_busy_us: vec![100_000, 200_000, 150_000, 50_000],
            worker_park_count: vec![10, 20, 15, 5],
            uptime_us: 1_000_000,
        };
        match roundtrip_response(&resp) {
            Response::RuntimeMetrics {
                num_workers,
                num_alive_tasks,
                global_queue_depth,
                worker_busy_us,
                worker_park_count,
                uptime_us,
            } => {
                assert_eq!(num_workers, 4);
                assert_eq!(num_alive_tasks, 42);
                assert_eq!(global_queue_depth, 3);
                assert_eq!(worker_busy_us, vec![100_000, 200_000, 150_000, 50_000]);
                assert_eq!(worker_park_count, vec![10, 20, 15, 5]);
                assert_eq!(uptime_us, 1_000_000);
            }
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_response_env() {
        let env = PooledEnv {
            env_type: EnvType::Uv,
            venv_path: PathBuf::from("/tmp/test-venv"),
            python_path: PathBuf::from("/tmp/test-venv/bin/python"),
            prewarmed_packages: vec![],
        };
        let resp = Response::Env { env: env.clone() };
        match roundtrip_response(&resp) {
            Response::Env { env: parsed_env } => {
                assert_eq!(parsed_env.venv_path, env.venv_path);
            }
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_response_empty() {
        assert!(matches!(
            roundtrip_response(&Response::Empty),
            Response::Empty
        ));
    }

    #[test]
    fn test_response_returned() {
        assert!(matches!(
            roundtrip_response(&Response::Returned),
            Response::Returned
        ));
    }

    #[test]
    fn test_response_stats() {
        use notebook_doc::pool_state::RuntimePoolState;

        let state = PoolState {
            uv: RuntimePoolState {
                available: 3,
                warming: 1,
                pool_size: 4,
                ..Default::default()
            },
            conda: RuntimePoolState {
                available: 2,
                warming: 0,
                pool_size: 2,
                ..Default::default()
            },
            pixi: RuntimePoolState::default(),
        };
        let resp = Response::Stats {
            state: state.clone(),
        };
        match roundtrip_response(&resp) {
            Response::Stats { state: s } => {
                assert_eq!(s.uv.available, 3);
                assert_eq!(s.uv.warming, 1);
                assert_eq!(s.conda.available, 2);
                assert_eq!(s.conda.warming, 0);
            }
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_response_pong() {
        let resp = Response::Pong {
            protocol_version: Some(2),
            daemon_version: Some("2.0.0+abc123".into()),
        };
        match roundtrip_response(&resp) {
            Response::Pong {
                protocol_version,
                daemon_version,
            } => {
                assert_eq!(protocol_version, Some(2));
                assert_eq!(daemon_version.as_deref(), Some("2.0.0+abc123"));
            }
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_response_pong_without_version() {
        // Old daemons send Pong without version fields — backward compat
        let json = r#"{"type":"pong"}"#;
        let resp: Response = serde_json::from_str(json).unwrap();
        match resp {
            Response::Pong {
                protocol_version,
                daemon_version,
            } => {
                assert_eq!(protocol_version, None);
                assert_eq!(daemon_version, None);
            }
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_response_shutting_down() {
        assert!(matches!(
            roundtrip_response(&Response::ShuttingDown),
            Response::ShuttingDown
        ));
    }

    #[test]
    fn test_response_flushed() {
        assert!(matches!(
            roundtrip_response(&Response::Flushed),
            Response::Flushed
        ));
    }

    #[test]
    fn test_response_error() {
        let resp = Response::Error {
            message: "test error".to_string(),
        };
        match roundtrip_response(&resp) {
            Response::Error { message } => assert_eq!(message, "test error"),
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_response_notebook_projection() {
        let projection = NotebookProjection {
            schema_version: NOTEBOOK_PROJECTION_SCHEMA_VERSION,
            load_generation: 7,
            notebook_id: "018f0000-0000-7000-8000-000000000001".to_string(),
            notebook_path: Some("/tmp/example.ipynb".to_string()),
            cells: vec![NotebookCellProjection {
                id: "cell-1".to_string(),
                cell_type: "code".to_string(),
                source_preview: "print('hello')".to_string(),
                execution_id: Some("exec-1".to_string()),
                execution_status: Some("done".to_string()),
                execution_count: Some(1),
            }],
            dependencies: vec!["numpy".to_string()],
            runtime: NotebookRuntimeProjection::default(),
            notebook_heads: vec!["aa".repeat(32)],
            runtime_state_heads: vec!["bb".repeat(32)],
            captured_at: Utc::now(),
        };

        match roundtrip_response(&Response::NotebookProjection {
            projection: projection.clone(),
        }) {
            Response::NotebookProjection { projection: parsed } => assert_eq!(parsed, projection),
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_response_notebook_projection_failure() {
        let response = Response::NotebookProjectionUnavailable {
            notebook_id: "018f0000-0000-7000-8000-000000000001".to_string(),
            failure: NotebookProjectionFailure::InitialLoadFailed {
                generation: 9,
                reason: "invalid notebook JSON".to_string(),
            },
        };

        match roundtrip_response(&response) {
            Response::NotebookProjectionUnavailable {
                notebook_id,
                failure: NotebookProjectionFailure::InitialLoadFailed { generation, reason },
            } => {
                assert_eq!(notebook_id, "018f0000-0000-7000-8000-000000000001");
                assert_eq!(generation, 9);
                assert_eq!(reason, "invalid notebook JSON");
            }
            _ => panic!("unexpected response type"),
        }
    }

    #[test]
    fn test_invalid_json() {
        let result: Result<Request, _> = serde_json::from_slice(b"not valid json");
        assert!(result.is_err());
    }

    // Notebook protocol tests

    #[test]
    fn test_notebook_request_launch_kernel() {
        let req = NotebookRequest::LaunchKernel {
            kernel_type: "python".into(),
            env_source: LaunchSpec::Concrete(EnvSource::parse("uv:prewarmed")),
            notebook_path: Some("/tmp/test.ipynb".into()),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("launch_kernel"));
        assert!(json.contains("python"));

        let parsed: NotebookRequest = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, NotebookRequest::LaunchKernel { .. }));
    }

    #[test]
    fn test_notebook_request_execute_cell() {
        let req = NotebookRequest::ExecuteCell {
            cell_id: "cell-456".into(),
            execution_id: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("execute_cell"));
        assert!(json.contains("cell-456"));

        let parsed: NotebookRequest = serde_json::from_str(&json).unwrap();
        match parsed {
            NotebookRequest::ExecuteCell {
                cell_id,
                execution_id,
            } => {
                assert_eq!(cell_id, "cell-456");
                assert!(execution_id.is_none());
            }
            _ => panic!("unexpected request type"),
        }
    }

    #[test]
    fn test_notebook_response_kernel_launched() {
        let resp = NotebookResponse::KernelLaunched {
            kernel_type: "python".into(),
            env_source: EnvSource::parse("conda:inline"),
            launched_config: LaunchedEnvConfig {
                conda_deps: Some(vec!["numpy".into(), "pandas".into()]),
                ..Default::default()
            },
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("kernel_launched"));
        assert!(json.contains("launched_config"));

        let parsed: NotebookResponse = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, NotebookResponse::KernelLaunched { .. }));
    }

    #[test]
    fn test_notebook_broadcast_comm() {
        let broadcast = NotebookBroadcast::Comm {
            msg_type: "comm_msg".into(),
            content: serde_json::json!({"comm_id": "abc"}),
            buffers: vec![],
        };
        let json = serde_json::to_string(&broadcast).unwrap();
        assert!(json.contains("comm"));
        assert!(json.contains("comm_id"));

        let parsed: NotebookBroadcast = serde_json::from_str(&json).unwrap();
        let NotebookBroadcast::Comm { msg_type, .. } = parsed else {
            panic!("expected comm broadcast");
        };
        assert_eq!(msg_type, "comm_msg");
    }
}
