//! RuntimeStateDoc — per-notebook ephemeral Automerge document for runtime state.
//!
//! Runtime-authoritative. One per notebook room. Describes the kernel,
//! execution queue, environment state, outputs, and runtime topology. Regular
//! notebook clients sync it read-only; runtime peers and room/coordinator code
//! use the validated writable path for policy-allowed runtime state.
//!
//! Schema:
//! ```text
//! ROOT/
//!   kernel/
//!     lifecycle: Str       ("NotStarted" | "AwaitingTrust" | "AwaitingEnvBuild" | "Resolving" | "PreparingEnv"
//!                           | "Launching" | "Connecting" | "Running" | "Error" | "Shutdown")
//!     activity: Str        ("" | "Unknown" | "Idle" | "Busy") — only meaningful when lifecycle == "Running"
//!     error_reason: Str    ("" unless lifecycle == "Error")
//!     name: Str            (e.g. "charming-toucan")
//!     language: Str        (e.g. "python", "typescript")
//!     env_source: Str      (e.g. "uv:prewarmed", "pixi:toml", "deno")
//!   queue/
//!     executing_execution_id: Str|null (execution_id currently executing)
//!     queued_execution_ids: List[Str]  (execution_ids waiting)
//!   executions/             Map (keyed by execution_id)
//!     {execution_id}/       Map
//!       status: Str         ("queued" | "running" | "done" | "error" | "cancelled")
//!       execution_count: Int|null
//!       success: Bool|null
//!       outputs: Map  (keyed by output_id)
//!         {output_id}/
//!           seq: Uint       (projection order within this execution)
//!           manifest: Map   (inline output manifest with blob refs)
//!   env/
//!     in_sync: bool
//!     added: List[Str]     (packages in metadata but not in kernel)
//!     removed: List[Str]   (packages in kernel but not in metadata)
//!     channels_changed: bool
//!     deno_changed: bool
//!     progress: Map|null    (latest flattened EnvProgress event, daemon-authored)
//!   trust/
//!     status: Str          ("trusted" | "untrusted" | "no_dependencies")
//!     needs_approval: bool
//!     approved_uv_dependencies: List[Str]
//!     approved_conda_dependencies: List[Str]
//!     approved_conda_channels: List[Str]
//!     approved_pixi_dependencies: List[Str]
//!     approved_pixi_pypi_dependencies: List[Str]
//!     approved_pixi_channels: List[Str]
//!   project_context/         Map (daemon-observed project-file context)
//!     state: Str              ("pending" | "not_found" | "detected" | "unreadable")
//!     observed_at: Str        (ISO timestamp, "" when state == "pending")
//!     kind: Str               ("pyproject_toml" | "pixi_toml" | "environment_yml"; "" unless state == "detected")
//!     absolute_path: Str      ("" unless state == "detected")
//!     relative_to_notebook: Str ("" unless state == "detected")
//!     unreadable_path: Str    ("" unless state == "unreadable")
//!     unreadable_reason: Str  ("" unless state == "unreadable")
//!     parsed/                 Map (present when state == "detected")
//!       dependencies: List[Str]
//!       dev_dependencies: List[Str]
//!       requires_python: Str|null
//!       prerelease: Str|null
//!       extras: Str           (JSON-encoded ProjectFileExtras)
//!   workstation/            Map|null (room-host-owned current compute attachment)
//!     workstation_id: Str
//!     display_name: Str
//!     provider: Str
//!     default_environment_label: Str
//!     environment_policy: Str
//!     status: Str             ("disconnected" | "connecting" | "ready" | "busy" | "idle" | "error")
//!                             "disconnected" means compute was lost and can resume on execution.
//!                             "idle" means attached compute is stopped and can resume on execution.
//!                             "error" means startup or attachment failed and needs attention.
//!     status_message: Str|null
//!     cpu_count: Uint|null
//!     memory_bytes: Uint|null
//!     working_directory: Str|null
//!     updated_at: Str|null
//!     runtime_session_id: Str|null
//!   display_index/          Map (keyed by display_id)
//!     {display_id}/         Map
//!       {execution_id\0output_id}: Bool
//!   comms/                 Map (keyed by comm_id)
//!     {comm_id}/           Map
//!       target_name: Str
//!       model_module: Str
//!       model_name: Str
//!       state: Map         (legacy compatibility slot; widget state lives in CommsDoc)
//!       outputs: List[Map] (inline manifests, OutputModel only)
//!       seq: Int           (insertion order)
//!       capture_msg_id: Str (Output widget capture routing, "" if not capturing)
//!   runtime_state_doc_id: Str|null
//!   last_saved: Str|null   (ISO timestamp of last save)
//! ```

#[cfg(test)]
use automerge::transaction::CommitOptions;
use automerge::{
    sync, sync::SyncDoc, transaction::Transactable, ActorId, AutoCommit, AutomergeError, ObjId,
    ObjType, ReadDoc, ScalarValue, Value, ROOT,
};
use automerge_recovery::{
    catch_automerge_panic, catch_automerge_result, is_recoverable_sync_error,
    recoverable_automerge_operation, AutomergeAttempt, AutomergeOperationError,
    AutomergeRebuildError,
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::cell::Cell;
use std::collections::{HashMap, HashSet};

use crate::{
    KernelActivity, KernelErrorReason, ProjectContext, ProjectFile, ProjectFileExtras,
    ProjectFileKind, ProjectFileParsed, RuntimeLifecycle, StreamOutputState,
};

#[cfg(test)]
thread_local! {
    static PATCH_LOG_MISMATCH_ON_NEXT_RECEIVE_SYNC_CALLS: Cell<usize> = const { Cell::new(0) };
}

// ── Snapshot types for reading/comparing state ──────────────────────

/// Kernel state snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelState {
    /// Flat status bucket string, projected from [`lifecycle`] at
    /// read time for source-compat with pre-migration consumers. New
    /// code should match on [`lifecycle`] directly.
    #[serde(default)]
    pub status: String,
    /// Starting sub-phase string, projected from [`lifecycle`] at
    /// read time for source-compat. Only non-empty when `status ==
    /// "starting"`. New code should match on [`lifecycle`] directly.
    #[serde(default)]
    pub starting_phase: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub env_source: String,
    /// ID of the runtime agent subprocess that owns this kernel (e.g., "runtime-agent:a1b2c3d4").
    /// Used for provenance: identifying which runtime agent is running and detecting stale ones.
    #[serde(default)]
    pub runtime_agent_id: String,
    /// Typed lifecycle, read directly from the CRDT `kernel/lifecycle` +
    /// `kernel/activity` keys.
    #[serde(default)]
    pub lifecycle: RuntimeLifecycle,
    /// Human-readable reason populated when `lifecycle == Error`. `None`
    /// when `kernel/error_reason` is absent (empty string in the CRDT
    /// deserializes as `Some("")`, indicating "scaffolded but unset").
    #[serde(default)]
    pub error_reason: Option<String>,
    /// Free-form details accompanying an error, shown to the user via
    /// the frontend banner and exposed to MCP tools. Carries specifics
    /// that don't fit in the typed [`error_reason`] enum — e.g., the
    /// name of a conda env declared in environment.yml that isn't
    /// built on this machine, with a suggested remediation command.
    ///
    /// `None` when the CRDT field is absent; empty string indicates
    /// "scaffolded but unset" (same convention as `error_reason`).
    #[serde(default)]
    pub error_details: Option<String>,
    /// Liveness heartbeat: ISO-8601 timestamp the runtime peer was last
    /// known present on the sync link, refreshed by the room as it observes
    /// the peer. `None` when absent (no peer has reported in, a pre-field doc,
    /// or explicitly cleared — the setter writes a CRDT `Null`, unlike the
    /// empty-string `error_reason`/`error_details` convention).
    ///
    /// This is the model half of lifecycle requirement #4(b): it lets a
    /// cloud room (and viewers) distinguish "kernel alive, peer reporting"
    /// from "peer hasn't been seen since `last_seen`" — the staleness signal
    /// the room-side watchdog (Phase 3d) reads to decide a `runtime_peer` has
    /// gone away, without needing a new terminal `RuntimeLifecycle` variant.
    /// It carries no authority by itself; it is a fact the room stamps and
    /// the watchdog interprets.
    #[serde(default)]
    pub last_seen: Option<String>,
}

impl Default for KernelState {
    fn default() -> Self {
        Self {
            status: "not_started".to_string(),
            starting_phase: String::new(),
            name: String::new(),
            language: String::new(),
            env_source: String::new(),
            runtime_agent_id: String::new(),
            lifecycle: RuntimeLifecycle::NotStarted,
            error_reason: None,
            error_details: None,
            last_seen: None,
        }
    }
}

/// An entry in the execution queue.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueEntry {
    pub execution_id: String,
}

/// Queue state snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueState {
    pub executing: Option<QueueEntry>,
    pub queued: Vec<QueueEntry>,
}

/// Execution lifecycle state for a single execution.
///
/// Tracks the status of an execution from queue to completion.
/// Stored in `executions/{execution_id}/` in the RuntimeStateDoc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionState {
    /// Current status: "queued", "running", "done", "error", "cancelled".
    ///
    /// "cancelled" is terminal and means the execution never ran: it was
    /// dropped from the queue because an earlier cell errored, the user
    /// interrupted, or the kernel died/restarted before it started.
    pub status: String,
    /// Kernel execution count (set when execution starts).
    #[serde(default)]
    pub execution_count: Option<i64>,
    /// Whether the execution succeeded (set on completion). Absent on
    /// "cancelled" executions: they neither succeeded nor failed, so
    /// `success == Some(false)` always means "ran and errored".
    #[serde(default)]
    pub success: Option<bool>,
    /// Output manifests for this execution (inline Automerge Maps with blob refs).
    #[serde(default)]
    pub outputs: Vec<serde_json::Value>,
    /// Source code that was executed (audit log).
    /// Set by the coordinator when creating the execution entry.
    #[serde(default)]
    pub source: Option<String>,
    /// Notebook cell that submitted this execution, when the execution came
    /// from a notebook cell.
    #[serde(default)]
    pub cell_id: Option<String>,
    /// Queue sequence number for ordering.
    /// Monotonic counter owned by the coordinator; the runtime agent sorts
    /// queued entries by this to determine execution order.
    #[serde(default)]
    pub seq: Option<u64>,
    /// Authenticated actor label for the client that submitted this execution.
    ///
    /// Set by the daemon coordinator when it accepts an execute/run-all request.
    /// Older RuntimeStateDocs omit it.
    #[serde(default)]
    pub submitted_by_actor_label: Option<String>,
}

/// Environment sync state snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvState {
    pub in_sync: bool,
    #[serde(default)]
    pub added: Vec<String>,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub channels_changed: bool,
    #[serde(default)]
    pub deno_changed: bool,
    /// Packages pre-installed in the prewarmed environment (empty for inline envs).
    #[serde(default)]
    pub prewarmed_packages: Vec<String>,
    /// Latest environment-preparation progress event, if any.
    #[serde(default)]
    pub progress: Option<serde_json::Value>,
}

impl Default for EnvState {
    fn default() -> Self {
        Self {
            in_sync: true,
            added: Vec::new(),
            removed: Vec::new(),
            channels_changed: false,
            deno_changed: false,
            prewarmed_packages: Vec::new(),
            progress: None,
        }
    }
}

/// Trust state snapshot for the runtime state doc.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustRuntimeState {
    /// "trusted", "untrusted", "no_dependencies"
    pub status: String,
    /// Whether the frontend should show the trust approval dialog
    pub needs_approval: bool,
    /// UV dependency specs already present in the local trusted package allowlist.
    pub approved_uv_dependencies: Vec<String>,
    /// Conda dependency specs already present in the local trusted package allowlist.
    pub approved_conda_dependencies: Vec<String>,
    /// Conda channels already present in the local trusted package allowlist.
    pub approved_conda_channels: Vec<String>,
    /// Pixi conda-style dependency specs already present in the local trusted package allowlist.
    pub approved_pixi_dependencies: Vec<String>,
    /// Pixi PyPI dependency specs already present in the local trusted package allowlist.
    pub approved_pixi_pypi_dependencies: Vec<String>,
    /// Pixi channels already present in the local trusted package allowlist.
    pub approved_pixi_channels: Vec<String>,
}

/// Snapshot of a single comm entry in the RuntimeStateDoc.
///
/// State is stored as a native Automerge map for per-property merge.
/// Two peers editing different widget properties (e.g., `value` and
/// `description`) compose cleanly via CRDT semantics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommDocEntry {
    pub target_name: String,
    #[serde(default)]
    pub model_module: String,
    #[serde(default)]
    pub model_name: String,
    /// Widget state as a JSON object (stored as native Automerge map).
    #[serde(default = "default_empty_state")]
    pub state: serde_json::Value,
    /// Output manifests (inline Automerge Maps, OutputModel widgets only).
    #[serde(default)]
    pub outputs: Vec<serde_json::Value>,
    /// Insertion order for dependency-correct replay.
    #[serde(default)]
    pub seq: u64,
    /// The msg_id this Output widget is capturing (empty = not capturing).
    /// When set, kernel outputs with matching parent_header.msg_id are routed
    /// to this widget instead of cell outputs.
    #[serde(default)]
    pub capture_msg_id: String,
}

fn default_empty_state() -> serde_json::Value {
    serde_json::json!({})
}

/// Room-host-owned snapshot of the active workstation attachment for this
/// notebook room.
///
/// This is the notebook-visible projection of the selected compute target. The
/// workstation registry/control plane can provide richer host-owned data, but
/// this snapshot is what late joiners and collaborators read through
/// RuntimeStateDoc while deciding whether the room can execute.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkstationAttachmentState {
    pub workstation_id: String,
    pub display_name: String,
    pub provider: String,
    pub default_environment_label: String,
    pub environment_policy: String,
    pub status: String,
    #[serde(default)]
    pub status_message: Option<String>,
    #[serde(default)]
    pub cpu_count: Option<u64>,
    #[serde(default)]
    pub memory_bytes: Option<u64>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Room-host-owned identity for one compute session attached to this
    /// notebook. Hosted workstations use the attach-job id; local and legacy
    /// RuntimeStateDocs omit it.
    #[serde(default)]
    pub runtime_session_id: Option<String>,
}

/// Full runtime state snapshot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RuntimeState {
    /// RuntimeStateDoc identity. Mirrors the NotebookDoc's
    /// `runtime_state_doc_id` pointer when known.
    #[serde(default)]
    pub runtime_state_doc_id: Option<String>,
    pub kernel: KernelState,
    pub queue: QueueState,
    pub env: EnvState,
    pub trust: TrustRuntimeState,
    pub last_saved: Option<String>,
    /// Path to the notebook's `.ipynb` on the daemon's disk.
    /// `None` for untitled notebooks; daemon writes this on save / save-as.
    pub path: Option<String>,
    /// Execution lifecycle entries keyed by execution_id.
    #[serde(default)]
    pub executions: HashMap<String, ExecutionState>,
    /// Active comm channels keyed by comm_id.
    #[serde(default)]
    pub comms: HashMap<String, CommDocEntry>,
    /// Daemon-observed project file context (see [`ProjectContext`]).
    /// Flows through the normal sync path so WASM / Python / MCP
    /// consumers read it alongside the rest of runtime state.
    #[serde(default)]
    pub project_context: ProjectContext,
    /// Room-host-owned active workstation attachment projection.
    #[serde(default)]
    pub workstation: Option<WorkstationAttachmentState>,
}

use crate::RuntimeStateError;

#[cfg(test)]
const RUNTIME_STATE_SCHEMA_SEED_ACTOR: &str = "nteract:runtime-state-schema:v2";
pub const RUNTIME_STATE_SCHEMA_VERSION: u64 = 2;
// Frozen Automerge genesis document for runtime-state schema v2.
// Do not update this for additive runtime-state fields; those must be
// daemon-authored changes after genesis, or a negotiated schema v3.
const RUNTIME_STATE_GENESIS_V2_BYTES: &[u8] =
    include_bytes!("../assets/runtime_state_genesis_v2.am");

// ── RuntimeStateDoc ─────────────────────────────────────────────────

/// Per-notebook ephemeral Automerge document for runtime state.
///
/// The daemon creates one of these per notebook room. Clients receive
/// updates via Automerge sync — never by direct mutation.
pub struct RuntimeStateDoc {
    doc: AutoCommit,
    output_order_cache: HashMap<String, OutputOrderCacheEntry>,
}

#[derive(Clone, Debug, Default)]
struct OutputOrderCacheEntry {
    next_seq: u64,
    latest_seq: Option<u64>,
}

impl RuntimeStateDoc {
    /// Create a new `RuntimeStateDoc` for the **daemon** with schema scaffolded.
    ///
    /// Starts from the canonical runtime-state schema seed so every peer has
    /// the same root object IDs before the first sync round, then switches to
    /// the daemon actor for live runtime-state writes.
    pub fn try_new() -> Result<Self, RuntimeStateError> {
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::from(b"runtimed:state" as &[u8]));
        Ok(Self {
            doc,
            output_order_cache: HashMap::new(),
        })
    }

    /// Create a new `RuntimeStateDoc` with scaffolding and a custom actor.
    ///
    /// Used by the runtime agent to create its own doc with a unique actor
    /// for runtime-agent-authored writes. The schema scaffold remains the
    /// canonical seed history shared with the coordinator and frontend.
    pub fn try_new_with_actor(actor_label: &str) -> Result<Self, RuntimeStateError> {
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::from(actor_label.as_bytes()));
        Ok(Self {
            doc,
            output_order_cache: HashMap::new(),
        })
    }

    /// Create a bootstrap `RuntimeStateDoc` with a random local actor.
    ///
    /// The document starts from the canonical schema seed, not from an empty
    /// AutoCommit, so the first RuntimeStateSync frame can merge into the
    /// shared root scaffold instead of replacing local encoding/actor state.
    /// This is used by read-only replicas and by hosted/runtime-peer surfaces
    /// that validate writes before applying them.
    pub fn try_new_empty() -> Result<Self, RuntimeStateError> {
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::random());
        Ok(Self {
            doc,
            output_order_cache: HashMap::new(),
        })
    }

    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self::try_new().unwrap_or_else(|err| panic!("seed runtime state schema: {err}"))
    }

    pub fn new_with_actor(actor_label: &str) -> Self {
        Self::try_new_with_actor(actor_label)
            .unwrap_or_else(|err| panic!("seed runtime state schema: {err}"))
    }

    pub fn new_empty() -> Self {
        Self::try_new_empty().unwrap_or_else(|err| panic!("seed runtime state schema: {err}"))
    }

    #[cfg(test)]
    fn __patch_log_mismatch_on_next_receive_sync_calls_for_test(count: usize) {
        PATCH_LOG_MISMATCH_ON_NEXT_RECEIVE_SYNC_CALLS.with(|calls| calls.set(count));
    }

    #[cfg(test)]
    fn patch_log_mismatch_if_receive_sync_requested_for_test() -> Result<(), AutomergeError> {
        PATCH_LOG_MISMATCH_ON_NEXT_RECEIVE_SYNC_CALLS.with(|calls| {
            let count = calls.get();
            if count == 0 {
                return Ok(());
            }
            calls.set(count - 1);
            Err(automerge::PatchLogMismatch.into())
        })
    }

    fn schema_seed_doc() -> Result<AutoCommit, RuntimeStateError> {
        AutoCommit::load(RUNTIME_STATE_GENESIS_V2_BYTES).map_err(RuntimeStateError::from)
    }

    #[cfg(test)]
    fn generated_schema_seed_doc() -> Result<AutoCommit, RuntimeStateError> {
        Self::generated_schema_seed_doc_with(scaffold_runtime_state_schema)
    }

    #[cfg(test)]
    fn generated_schema_seed_doc_with(
        scaffold: impl FnOnce(&mut AutoCommit) -> Result<(), RuntimeStateError>,
    ) -> Result<AutoCommit, RuntimeStateError> {
        let mut doc = AutoCommit::new();
        doc.set_actor(ActorId::from(RUNTIME_STATE_SCHEMA_SEED_ACTOR.as_bytes()));
        scaffold(&mut doc)?;
        let _ = doc.commit_with(
            CommitOptions::default()
                .with_message("Seed nteract runtime state schema")
                .with_time(0),
        );
        Ok(doc)
    }

    /// Create a RuntimeStateDoc from a pre-existing Automerge document.
    ///
    /// Used by test fixtures and migration paths that have a saved state doc.
    pub fn from_doc(doc: AutoCommit) -> Self {
        Self {
            doc,
            output_order_cache: HashMap::new(),
        }
    }

    /// Access the underlying Automerge document (read-only).
    pub fn doc(&self) -> &AutoCommit {
        &self.doc
    }

    /// Access the underlying Automerge document (mutable, for sync protocol).
    pub fn doc_mut(&mut self) -> &mut AutoCommit {
        self.output_order_cache.clear();
        &mut self.doc
    }

    /// Current document heads (for change detection).
    pub fn get_heads(&mut self) -> Vec<automerge::ChangeHash> {
        self.doc.get_heads()
    }

    // ── Fork + Merge ────────────────────────────────────────────────

    /// Fork the document at its current state.
    ///
    /// Returns a new `RuntimeStateDoc` whose underlying `AutoCommit` is an
    /// Automerge fork. Changes made on the fork are independent of the
    /// original — call [`merge`](Self::merge) to reconcile them.
    ///
    /// Automerge forks receive a new random actor by default. Set a stable
    /// actor only when downstream filtering or attribution requires it, and do
    /// not reuse that actor for concurrent forks that can both write before
    /// merging.
    pub fn fork(&mut self) -> Self {
        Self {
            doc: self.doc.fork(),
            output_order_cache: self.output_order_cache.clone(),
        }
    }

    /// Fork the document and set a caller-chosen actor ID on the fork.
    ///
    /// Automerge forks receive a new random actor by default because an actor
    /// ID identifies one linear stream of changes. If two concurrent forks are
    /// forced to share an actor, they can each produce ops at seq `N`, `N+1`,
    /// …; the first merge lands and the second returns `DuplicateSeqNumber`,
    /// silently dropping writes if the error is ignored. The regression test
    /// [`merging_two_forks_with_shared_actor_returns_duplicate_seq_error`]
    /// pins this invariant.
    ///
    /// Prefer
    /// [`transact_at_heads_recovering`](Self::transact_at_heads_recovering)
    /// when the writes can be computed after async work and applied at a
    /// captured baseline. A transaction keeps actor sequencing on the live
    /// document and avoids creating a second document that must later merge.
    ///
    /// If a true fork must cross an `.await` point, the `actor` argument is
    /// set verbatim. The caller controls whether the actor is stable per task
    /// (e.g. `"rt:kernel:abc:iopub"`) or unique per fork.
    ///
    /// Prefer a stable per-task actor for long-running loops that fork
    /// many times in sequence — each unique actor consumes space in
    /// Automerge's internal actor list. Use a UUID suffix for one-shot
    /// sites where concurrent forks from the same logical task can
    /// overlap across the async gap.
    ///
    /// For synchronous fork+merge blocks, use
    /// [`fork_and_merge`](Self::fork_and_merge).
    pub fn fork_with_actor(&mut self, actor: impl AsRef<str>) -> Self {
        let mut fork = self.fork();
        fork.set_actor(actor.as_ref());
        fork
    }

    /// Merge another `RuntimeStateDoc`'s changes into this one.
    ///
    /// Returns the change hashes that were applied. CRDT merge semantics
    /// apply — concurrent writes to different keys compose cleanly.
    pub fn merge(
        &mut self,
        other: &mut RuntimeStateDoc,
    ) -> Result<Vec<automerge::ChangeHash>, AutomergeError> {
        let changes = self.doc.merge(&mut other.doc)?;
        self.output_order_cache.clear();
        Ok(changes)
    }

    /// Merge another runtime-state document, rebuilding both documents if Automerge panics.
    pub fn merge_recovering(
        &mut self,
        other: &mut RuntimeStateDoc,
        label: &str,
    ) -> Result<Vec<automerge::ChangeHash>, AutomergeOperationError> {
        match catch_automerge_result(label, || self.doc.merge(&mut other.doc)) {
            AutomergeAttempt::Success(changes) => {
                self.output_order_cache.clear();
                Ok(changes)
            }
            AutomergeAttempt::OperationError(source) => {
                Err(AutomergeOperationError::automerge(label, source))
            }
            AutomergeAttempt::Panic(err) => {
                let self_rebuilt = self.rebuild_from_save();
                let other_rebuilt = other.rebuild_from_save();
                if let Err(source) = self_rebuilt {
                    return Err(AutomergeOperationError::rebuild_failed(label, source));
                }
                if let Err(source) = other_rebuilt {
                    return Err(AutomergeOperationError::rebuild_failed(label, source));
                }
                Err(AutomergeOperationError::Panic(err))
            }
        }
    }

    /// Apply mutations as a transaction isolated at `heads`, then integrate
    /// them back into the live document.
    ///
    /// This is the async-safe alternative to taking a fork before an `.await`
    /// and merging it later: callers capture the baseline heads before the
    /// await, then re-acquire the document lock and run the mutation at that
    /// historical view. The live document owns the actor sequence, so repeated
    /// isolated transactions can share one stable actor without producing
    /// duplicate sequence numbers.
    ///
    /// The closure is invoked exactly once. Prepare non-deterministic values
    /// before calling this method if they need to be reused outside the
    /// transaction; the helper does not retry conflicts by re-running `f`.
    pub fn transact_at_heads_recovering<F, T>(
        &mut self,
        heads: &[automerge::ChangeHash],
        actor: Option<&str>,
        label: &str,
        f: F,
    ) -> Result<T, RuntimeStateError>
    where
        F: FnOnce(&mut RuntimeStateDoc) -> Result<T, RuntimeStateError>,
    {
        use std::cell::Cell;

        let original_actor = self.doc.get_actor().clone();
        let isolated = Cell::new(false);
        let mut recovery_panic = None;

        let result = catch_automerge_result(label, || {
            if let Some(actor) = actor {
                self.doc.set_actor(ActorId::from(actor.as_bytes()));
            }
            self.doc.isolate(heads);
            isolated.set(true);
            let result = f(self);
            self.doc.integrate();
            isolated.set(false);
            result
        });

        if isolated.get() {
            if let Err(err) = catch_automerge_panic(format!("{label}:integrate"), || {
                self.doc.integrate();
            }) {
                recovery_panic = Some(err);
            }
        }

        if let Err(err) = catch_automerge_panic(format!("{label}:restore-actor"), || {
            self.doc.set_actor(original_actor);
        }) {
            recovery_panic.get_or_insert(err);
        }

        match (result, recovery_panic) {
            (AutomergeAttempt::Success(value), None) => Ok(value),
            (AutomergeAttempt::OperationError(source), None) => Err(source),
            (AutomergeAttempt::Panic(err), _) | (_, Some(err)) => {
                if let Err(source) = self.rebuild_from_save() {
                    return Err(AutomergeOperationError::rebuild_failed(label, source).into());
                }
                Err(AutomergeOperationError::Panic(err).into())
            }
        }
    }

    /// Fork, apply mutations on the fork, and merge back.
    ///
    /// This is only for synchronous compatibility with older call sites.
    /// Prefer [`transact_at_heads_recovering`](Self::transact_at_heads_recovering)
    /// for new document-owned mutation helpers, especially when the mutation
    /// is based on heads captured before async work.
    pub fn fork_and_merge<F>(&mut self, f: F)
    where
        F: FnOnce(&mut RuntimeStateDoc),
    {
        let mut fork = self.fork();
        f(&mut fork);
        let _ = self.merge(&mut fork);
    }

    /// Round-trip save→load to rebuild internal Automerge indices.
    ///
    /// Used as a containment step after catching an Automerge panic inside a
    /// document-owned recovery boundary. See `NotebookDoc::rebuild_from_save`
    /// for the notebook-doc variant with a cell-count guard.
    pub fn rebuild_from_save(&mut self) -> Result<(), AutomergeRebuildError> {
        catch_automerge_panic("runtime-state-doc-rebuild-from-save", || {
            let actor = self.doc.get_actor().clone();
            let bytes = self.doc.save();
            match AutoCommit::load(&bytes) {
                Ok(mut doc) => {
                    doc.set_actor(actor);
                    self.doc = doc;
                    Ok(())
                }
                Err(source) => Err(AutomergeRebuildError::load(source)),
            }
        })?
    }

    /// Compact the document if its serialized size exceeds `threshold` bytes.
    ///
    /// Returns `true` if compaction was performed.
    pub fn compact_if_oversized(&mut self, threshold: usize) -> bool {
        let actor = self.doc.get_actor().clone();
        let bytes = self.doc.save();
        if bytes.len() <= threshold {
            return false;
        }
        match AutoCommit::load(&bytes) {
            Ok(mut doc) => {
                doc.set_actor(actor);
                self.doc = doc;
                true
            }
            Err(_) => false,
        }
    }

    /// Set the actor identity for this document.
    ///
    /// Forks should call this with a distinct label so their changes are
    /// attributable and don't conflict with the parent's deterministic
    /// `"runtimed:state"` actor ID.
    pub fn set_actor(&mut self, label: &str) {
        self.doc.set_actor(ActorId::from(label.as_bytes()));
    }

    // ── Helpers ─────────────────────────────────────────────────────

    /// Get the ObjId for a top-level map key.
    fn get_map(&self, key: &str) -> Option<automerge::ObjId> {
        self.doc
            .get(&ROOT, key)
            .ok()
            .flatten()
            .and_then(|(value, id)| match value {
                Value::Object(ObjType::Map) => Some(id),
                _ => None,
            })
    }

    /// Get a scaffold map, returning `RuntimeStateError::MissingScaffold` if absent.
    fn scaffold_map(&self, key: &'static str) -> Result<automerge::ObjId, RuntimeStateError> {
        self.get_map(key)
            .ok_or(RuntimeStateError::MissingScaffold(key))
    }

    /// Get or create a top-level map for additive room-host-owned fields that
    /// are intentionally absent from the frozen v2 genesis scaffold.
    fn get_or_create_root_map(
        &mut self,
        key: &'static str,
    ) -> Result<automerge::ObjId, RuntimeStateError> {
        if let Some(obj) = self.get_map(key) {
            return Ok(obj);
        }
        self.doc
            .put_object(&ROOT, key, ObjType::Map)
            .map_err(RuntimeStateError::from)
    }

    /// Get a scaffold list nested under a map, returning error if absent.
    fn scaffold_list(
        &self,
        parent: &automerge::ObjId,
        key: &'static str,
    ) -> Result<automerge::ObjId, RuntimeStateError> {
        self.doc
            .get(parent, key)
            .ok()
            .flatten()
            .and_then(|(value, id)| match value {
                Value::Object(ObjType::List) => Some(id),
                _ => None,
            })
            .ok_or(RuntimeStateError::MissingScaffold(key))
    }

    /// Read a string scalar from a map object.
    fn read_str(&self, obj: &automerge::ObjId, key: &str) -> String {
        self.doc
            .get(obj, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Str(s) => Some(s.to_string()),
                    _ => None,
                },
                _ => None,
            })
            .unwrap_or_default()
    }

    fn read_str_conflicts(&self, obj: &automerge::ObjId, key: &str) -> Vec<String> {
        self.doc
            .get_all(obj, key)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Str(s) => Some(s.to_string()),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }

    fn resolve_kernel_lifecycle(&self, kernel: &automerge::ObjId) -> RuntimeLifecycle {
        let lifecycle_key = self.read_str(kernel, "lifecycle");
        let activity_key = self.read_str(kernel, "activity");
        // Pre-typed docs (captured fixtures, `from_doc` with external bytes)
        // only have the string shape. resolve_lifecycle falls back to it when
        // the typed keys are missing.
        let stored_status = self.read_str(kernel, "status");
        let stored_starting_phase = self.read_str(kernel, "starting_phase");
        let lifecycle = crate::types::resolve_lifecycle(
            &lifecycle_key,
            &activity_key,
            &stored_status,
            &stored_starting_phase,
        );

        let lifecycle_conflicts = self.read_str_conflicts(kernel, "lifecycle");
        if lifecycle_conflicts.iter().any(|value| value == "Error") {
            return RuntimeLifecycle::Error;
        }

        if !matches!(
            lifecycle,
            RuntimeLifecycle::NotStarted | RuntimeLifecycle::Shutdown
        ) {
            return lifecycle;
        }

        if !lifecycle_conflicts.iter().any(|value| value == "Running") {
            return lifecycle;
        }

        let activity_conflicts = self.read_str_conflicts(kernel, "activity");
        let activity = if KernelActivity::parse(&activity_key).is_some() {
            KernelActivity::parse(&activity_key).unwrap_or(KernelActivity::Unknown)
        } else if activity_conflicts.iter().any(|value| value == "Idle") {
            KernelActivity::Idle
        } else if activity_conflicts.iter().any(|value| value == "Busy") {
            KernelActivity::Busy
        } else {
            KernelActivity::Unknown
        };

        RuntimeLifecycle::Running(activity)
    }

    /// Read an optional string (null → None) from a map object.
    fn read_opt_str(&self, obj: &automerge::ObjId, key: &str) -> Option<String> {
        self.doc
            .get(obj, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Null => None,
                    ScalarValue::Str(s) => Some(s.to_string()),
                    _ => None,
                },
                _ => None,
            })
    }

    /// Read an optional unsigned integer (null → None) from a map object.
    fn read_opt_u64(&self, obj: &automerge::ObjId, key: &str) -> Option<u64> {
        self.doc
            .get(obj, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Uint(n) => Some(*n),
                    ScalarValue::Int(n) if *n >= 0 => Some(*n as u64),
                    ScalarValue::Null => None,
                    _ => None,
                },
                _ => None,
            })
    }

    /// Read a bool scalar from a map object.
    fn read_bool(&self, obj: &automerge::ObjId, key: &str) -> bool {
        self.doc
            .get(obj, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Boolean(b) => Some(*b),
                    _ => None,
                },
                _ => None,
            })
            .unwrap_or(false)
    }

    /// Read an integer scalar from a map object, defaulting to 0.
    fn read_i64(&self, obj: &automerge::ObjId, key: &str) -> i64 {
        self.doc
            .get(obj, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Int(n) => Some(*n),
                    ScalarValue::Uint(n) => Some(*n as i64),
                    _ => None,
                },
                _ => None,
            })
            .unwrap_or(0)
    }

    /// Read a List[Str] from a map object.
    fn read_str_list(&self, obj: &automerge::ObjId, key: &str) -> Vec<String> {
        let Some(list_id) =
            self.doc
                .get(obj, key)
                .ok()
                .flatten()
                .and_then(|(value, id)| match value {
                    Value::Object(ObjType::List) => Some(id),
                    _ => None,
                })
        else {
            return Vec::new();
        };
        let len = self.doc.length(&list_id);
        let mut out = Vec::with_capacity(len);
        for i in 0..len {
            if let Some(s) = self
                .doc
                .get(&list_id, i)
                .ok()
                .flatten()
                .and_then(|(value, _)| match value {
                    Value::Scalar(s) => match s.as_ref() {
                        ScalarValue::Str(s) => Some(s.to_string()),
                        _ => None,
                    },
                    _ => None,
                })
            {
                out.push(s);
            }
        }
        out
    }

    fn replace_str_list(
        &mut self,
        obj: &automerge::ObjId,
        key: &'static str,
        values: &[String],
    ) -> Result<(), RuntimeStateError> {
        let list = self.scaffold_list(obj, key)?;
        for i in (0..self.doc.length(&list)).rev() {
            self.doc.delete(&list, i)?;
        }
        for (i, value) in values.iter().enumerate() {
            self.doc.insert(&list, i, value.as_str())?;
        }
        Ok(())
    }

    /// Read a List[Map] from a map object as `Vec<serde_json::Value>`.
    fn read_json_list(&self, obj: &automerge::ObjId, key: &str) -> Vec<serde_json::Value> {
        let Some(list_id) =
            self.doc
                .get(obj, key)
                .ok()
                .flatten()
                .and_then(|(value, id)| match value {
                    Value::Object(ObjType::List) => Some(id),
                    _ => None,
                })
        else {
            return Vec::new();
        };
        let len = self.doc.length(&list_id);
        let mut out = Vec::with_capacity(len);
        for i in 0..len {
            if let Some(val) = automunge::read_json_value(&self.doc, &list_id, i) {
                out.push(val);
            }
        }
        out
    }

    // ── Granular setters (daemon calls these individually) ──────────

    /// Update trust state.
    pub fn set_trust(
        &mut self,
        status: &str,
        needs_approval: bool,
    ) -> Result<(), RuntimeStateError> {
        self.set_trust_state(&TrustRuntimeState {
            status: status.to_string(),
            needs_approval,
            ..TrustRuntimeState::default()
        })
    }

    pub fn set_trust_state(&mut self, state: &TrustRuntimeState) -> Result<(), RuntimeStateError> {
        let trust = self.scaffold_map("trust")?;
        let cur_status = self.read_str(&trust, "status");
        let cur_needs = self.read_bool(&trust, "needs_approval");
        let cur_uv = self.read_str_list(&trust, "approved_uv_dependencies");
        let cur_conda = self.read_str_list(&trust, "approved_conda_dependencies");
        let cur_conda_channels = self.read_str_list(&trust, "approved_conda_channels");
        let cur_pixi = self.read_str_list(&trust, "approved_pixi_dependencies");
        let cur_pixi_pypi = self.read_str_list(&trust, "approved_pixi_pypi_dependencies");
        let cur_pixi_channels = self.read_str_list(&trust, "approved_pixi_channels");

        if cur_status == state.status
            && cur_needs == state.needs_approval
            && cur_uv == state.approved_uv_dependencies
            && cur_conda == state.approved_conda_dependencies
            && cur_conda_channels == state.approved_conda_channels
            && cur_pixi == state.approved_pixi_dependencies
            && cur_pixi_pypi == state.approved_pixi_pypi_dependencies
            && cur_pixi_channels == state.approved_pixi_channels
        {
            return Ok(());
        }

        self.doc.put(&trust, "status", state.status.as_str())?;
        self.doc
            .put(&trust, "needs_approval", state.needs_approval)?;
        self.replace_str_list(
            &trust,
            "approved_uv_dependencies",
            &state.approved_uv_dependencies,
        )?;
        self.replace_str_list(
            &trust,
            "approved_conda_dependencies",
            &state.approved_conda_dependencies,
        )?;
        self.replace_str_list(
            &trust,
            "approved_conda_channels",
            &state.approved_conda_channels,
        )?;
        self.replace_str_list(
            &trust,
            "approved_pixi_dependencies",
            &state.approved_pixi_dependencies,
        )?;
        self.replace_str_list(
            &trust,
            "approved_pixi_pypi_dependencies",
            &state.approved_pixi_pypi_dependencies,
        )?;
        self.replace_str_list(
            &trust,
            "approved_pixi_channels",
            &state.approved_pixi_channels,
        )?;
        Ok(())
    }

    /// Write a runtime lifecycle transition.
    ///
    /// - `Running(activity)`: writes `lifecycle = "Running"` and
    ///   `activity = "<variant>"`.
    /// - Any other variant: writes `lifecycle = "<variant>"` and clears
    ///   `activity` to `""`, because activity is only meaningful while
    ///   running.
    ///
    /// Also clears any pre-typed `status` / `starting_phase` scalars if
    /// they're present on the doc. This keeps typed writes
    /// authoritative: a doc hydrated from pre-typed bytes won't leave
    /// stale legacy keys that `resolve_lifecycle`'s fallback would
    /// otherwise read back instead of the fresh typed state.
    ///
    /// Does NOT touch `error_reason`. Callers that want to set or clear
    /// the error reason should use [`set_lifecycle_with_error`]. This
    /// lets a retry path re-enter `Error` without losing the original
    /// diagnosis.
    pub fn set_lifecycle(&mut self, lifecycle: &RuntimeLifecycle) -> Result<(), RuntimeStateError> {
        let kernel = self.scaffold_map("kernel")?;
        self.doc
            .put(&kernel, "lifecycle", lifecycle.variant_str())?;
        match lifecycle {
            RuntimeLifecycle::Running(activity) => {
                self.doc.put(&kernel, "activity", activity.as_str())?;
            }
            _ => {
                self.doc.put(&kernel, "activity", "")?;
            }
        }
        self.clear_legacy_kernel_status(&kernel)?;
        Ok(())
    }

    /// Clear the pre-typed `kernel.status` and `kernel.starting_phase`
    /// scalars if the doc has them. A no-op for docs scaffolded by the
    /// current `new()` / `new_with_actor()`, which don't write those
    /// keys at all. Hits when a typed writer mutates a doc hydrated
    /// from pre-typed bytes.
    fn clear_legacy_kernel_status(
        &mut self,
        kernel: &automerge::ObjId,
    ) -> Result<(), RuntimeStateError> {
        for key in ["status", "starting_phase"] {
            if let Ok(Some((_, _))) = self.doc.get(kernel, key) {
                self.doc.delete(kernel, key)?;
            }
        }
        Ok(())
    }

    /// Write a lifecycle transition and simultaneously set or clear
    /// `error_reason`.
    ///
    /// - `Some(reason)` records the diagnosis, typed so we can't typo the
    ///   reason string.
    /// - `None` clears the field to `""`.
    ///
    /// Typical use:
    /// - `set_lifecycle_with_error(Error, Some(KernelErrorReason::MissingIpykernel))`
    ///   when transitioning into Error with a specific cause.
    /// - `set_lifecycle_with_error(NotStarted, None)` when resetting out
    ///   of Error.
    pub fn set_lifecycle_with_error(
        &mut self,
        lifecycle: &RuntimeLifecycle,
        reason: Option<KernelErrorReason>,
    ) -> Result<(), RuntimeStateError> {
        self.set_lifecycle_with_error_details(lifecycle, reason, None)
    }

    /// Like [`set_lifecycle_with_error`] but also writes a free-form
    /// `error_details` string alongside the typed reason. Use for typed
    /// failure or user-decision states where the UI needs specifics that
    /// don't fit in [`KernelErrorReason`] — e.g., the name of a missing
    /// conda env.
    ///
    /// - `Some(details)` records the explanation (non-empty recommended).
    /// - `None` clears `error_details` to `""`.
    pub fn set_lifecycle_with_error_details(
        &mut self,
        lifecycle: &RuntimeLifecycle,
        reason: Option<KernelErrorReason>,
        details: Option<&str>,
    ) -> Result<(), RuntimeStateError> {
        self.set_lifecycle(lifecycle)?;
        let kernel = self.scaffold_map("kernel")?;
        let reason_str = reason.map(|r| r.as_str()).unwrap_or("");
        self.doc.put(&kernel, "error_reason", reason_str)?;
        let details_str = details.unwrap_or("");
        self.doc.put(&kernel, "error_details", details_str)?;
        Ok(())
    }

    /// Update the kernel activity. The hot path for IOPub idle/busy,
    /// called on every kernel status message.
    ///
    /// A no-op when the stored value already matches the requested value,
    /// so the doc heads don't advance on redundant `Idle → Idle` or
    /// `Busy → Busy` writes. This is the throttle that keeps sync traffic
    /// bounded during heavy execution.
    ///
    /// A real idle/busy signal also re-publishes
    /// `lifecycle = Running(<activity>)`. That keeps the live kernel branch
    /// newer than any concurrent terminal lifecycle retained by a read-only
    /// replica after room wake.
    pub fn set_activity(&mut self, activity: KernelActivity) -> Result<(), RuntimeStateError> {
        let kernel = self.scaffold_map("kernel")?;
        let current_lifecycle = self.read_str(&kernel, "lifecycle");
        let current_activity = self.read_str(&kernel, "activity");
        // Short-circuit only when the typed activity already matches
        // AND the lifecycle already reads as Running AND the legacy keys
        // are already cleared. Otherwise a pre-typed doc hydrated via
        // from_doc would stay stuck on stale `status="starting"` +
        // `starting_phase="connecting"` after the first IOPub activity
        // update, and a read-only replica can keep a concurrent
        // `lifecycle = Shutdown` branch after room wake.
        let has_stale_legacy = self.doc.get(&kernel, "status").ok().flatten().is_some()
            || self
                .doc
                .get(&kernel, "starting_phase")
                .ok()
                .flatten()
                .is_some();
        let lifecycle_needs_running_republish = current_lifecycle != "Running";
        if current_activity == activity.as_str()
            && !lifecycle_needs_running_republish
            && !has_stale_legacy
        {
            return Ok(());
        }
        if lifecycle_needs_running_republish || current_activity != activity.as_str() {
            self.doc.put(&kernel, "lifecycle", "Running")?;
            self.doc.put(&kernel, "activity", activity.as_str())?;
        }
        if has_stale_legacy {
            self.clear_legacy_kernel_status(&kernel)?;
        }
        Ok(())
    }

    /// Update kernel info (name, language, env_source).
    pub fn set_kernel_info(
        &mut self,
        name: &str,
        language: &str,
        env_source: &str,
    ) -> Result<(), RuntimeStateError> {
        let kernel = self.scaffold_map("kernel")?;
        let cur_name = self.read_str(&kernel, "name");
        let cur_lang = self.read_str(&kernel, "language");
        let cur_src = self.read_str(&kernel, "env_source");
        if cur_name == name && cur_lang == language && cur_src == env_source {
            return Ok(());
        }
        self.doc.put(&kernel, "name", name)?;
        self.doc.put(&kernel, "language", language)?;
        self.doc.put(&kernel, "env_source", env_source)?;
        Ok(())
    }

    /// Set the runtime agent ID that owns this kernel.
    pub fn set_runtime_agent_id(
        &mut self,
        runtime_agent_id: &str,
    ) -> Result<(), RuntimeStateError> {
        let kernel = self.scaffold_map("kernel")?;
        let current = self.read_str(&kernel, "runtime_agent_id");
        if current == runtime_agent_id {
            return Ok(());
        }
        self.doc
            .put(&kernel, "runtime_agent_id", runtime_agent_id)?;
        Ok(())
    }

    /// Stamp the runtime peer liveness heartbeat (`kernel/last_seen`).
    ///
    /// `Some(ts)` records an ISO-8601 timestamp the peer was last observed;
    /// `None` clears it (writes a CRDT `Null`, so `read_state().kernel.last_seen`
    /// reads back `None`). This is a pure liveness fact — it carries no
    /// lifecycle authority. The room-side watchdog (Phase 3d) refreshes it as it
    /// sees the peer and reads it back to decide a `runtime_peer` has gone stale.
    /// Idempotent: re-stamping the current value is a no-op so it doesn't churn
    /// the doc heads on every observation.
    pub fn set_last_seen(&mut self, timestamp: Option<&str>) -> Result<(), RuntimeStateError> {
        let kernel = self.scaffold_map("kernel")?;
        let current = automunge::read_str_if_present(&self.doc, &kernel, "last_seen");
        if current.as_deref() == timestamp {
            return Ok(());
        }
        match timestamp {
            Some(ts) => self.doc.put(&kernel, "last_seen", ts)?,
            None => self.doc.put(&kernel, "last_seen", ScalarValue::Null)?,
        }
        Ok(())
    }

    /// Update queue state.
    pub fn set_queue(
        &mut self,
        executing: Option<&QueueEntry>,
        queued: &[QueueEntry],
    ) -> Result<(), RuntimeStateError> {
        let queue = self.scaffold_map("queue")?;
        let cur_exec_eid = self.read_opt_str(&queue, "executing_execution_id");
        let cur_queued_eids = self.read_str_list(&queue, "queued_execution_ids");

        let exec_match = match (&cur_exec_eid, executing) {
            (None, None) => true,
            (Some(eid), Some(entry)) => eid == &entry.execution_id,
            _ => false,
        };

        let queued_eids: Vec<&str> = queued.iter().map(|e| e.execution_id.as_str()).collect();
        let cur_eid_refs: Vec<&str> = cur_queued_eids.iter().map(|s| s.as_str()).collect();

        if exec_match && cur_eid_refs == queued_eids {
            return Ok(());
        }

        match executing {
            Some(entry) => {
                self.doc.put(
                    &queue,
                    "executing_execution_id",
                    entry.execution_id.as_str(),
                )?;
            }
            None => {
                self.doc
                    .put(&queue, "executing_execution_id", ScalarValue::Null)?;
            }
        }

        let eid_list = self.scaffold_list(&queue, "queued_execution_ids")?;

        for i in (0..self.doc.length(&eid_list)).rev() {
            self.doc.delete(&eid_list, i)?;
        }

        for (i, entry) in queued.iter().enumerate() {
            self.doc.insert(&eid_list, i, entry.execution_id.as_str())?;
        }

        Ok(())
    }

    // ── Execution lifecycle ─────────────────────────────────────────

    /// Create a new execution entry with status "queued".
    ///
    /// Called by the daemon when `queue_cell()` generates an execution_id.
    pub fn create_execution(&mut self, execution_id: &str) -> Result<(), RuntimeStateError> {
        let executions = self.scaffold_map("executions")?;

        if self
            .doc
            .get(&executions, execution_id)
            .ok()
            .flatten()
            .is_some()
        {
            return Ok(());
        }

        let entry = self
            .doc
            .put_object(&executions, execution_id, ObjType::Map)?;
        self.doc.put(&entry, "status", "queued")?;
        self.doc.put(&entry, "execution_count", ScalarValue::Null)?;
        self.doc.put(&entry, "success", ScalarValue::Null)?;
        self.doc.put_object(&entry, "outputs", ObjType::Map)?;
        Ok(())
    }

    /// Create a new execution entry with source code and queue sequence number.
    ///
    /// Used by the coordinator to queue executions for the runtime agent. The
    /// source is stored as an audit log, and `seq` determines execution order.
    /// The runtime agent discovers new entries via CRDT sync and processes them
    /// in `seq` order.
    pub fn create_execution_with_source(
        &mut self,
        execution_id: &str,
        source: &str,
        seq: u64,
    ) -> Result<bool, RuntimeStateError> {
        self.create_execution_with_source_and_submitter(execution_id, source, seq, None)
    }

    /// Create a new execution entry with source code, queue sequence number,
    /// and the authenticated actor that submitted it.
    pub fn create_execution_with_source_and_submitter(
        &mut self,
        execution_id: &str,
        source: &str,
        seq: u64,
        submitted_by_actor_label: Option<&str>,
    ) -> Result<bool, RuntimeStateError> {
        self.create_execution_with_source_provenance(
            execution_id,
            source,
            seq,
            submitted_by_actor_label,
            None,
        )
    }

    /// Create a new execution entry with source code, queue sequence number,
    /// authenticated submitter, and optional notebook cell provenance.
    pub fn create_execution_with_source_provenance(
        &mut self,
        execution_id: &str,
        source: &str,
        seq: u64,
        submitted_by_actor_label: Option<&str>,
        cell_id: Option<&str>,
    ) -> Result<bool, RuntimeStateError> {
        let executions = self.scaffold_map("executions")?;

        // Don't overwrite if it already exists (idempotent)
        if self
            .doc
            .get(&executions, execution_id)
            .ok()
            .flatten()
            .is_some()
        {
            return Ok(false);
        }

        let entry = self
            .doc
            .put_object(&executions, execution_id, ObjType::Map)?;
        self.doc.put(&entry, "status", "queued")?;
        self.doc.put(&entry, "execution_count", ScalarValue::Null)?;
        self.doc.put(&entry, "success", ScalarValue::Null)?;
        self.doc.put_object(&entry, "outputs", ObjType::Map)?;
        self.doc.put(&entry, "source", source)?;
        if let Some(cell_id) = cell_id {
            self.doc.put(&entry, "cell_id", cell_id)?;
        }
        self.doc.put(&entry, "seq", ScalarValue::Uint(seq))?;
        if let Some(actor_label) = submitted_by_actor_label {
            self.doc
                .put(&entry, "submitted_by_actor_label", actor_label)?;
        }
        Ok(true)
    }

    /// Mark an execution as running.
    ///
    /// The execution_count is not known yet at this point — it arrives later
    /// from the kernel's `execute_input` message. Use [`set_execution_count`]
    /// to record it when it arrives.
    pub fn set_execution_running(&mut self, execution_id: &str) -> Result<(), RuntimeStateError> {
        let executions = self.scaffold_map("executions")?;

        let Some((_, entry)) = self.doc.get(&executions, execution_id).ok().flatten() else {
            return Ok(());
        };

        let cur_status = self.read_str(&entry, "status");
        if cur_status == "running" {
            return Ok(());
        }

        self.doc.put(&entry, "status", "running")?;
        Ok(())
    }

    /// Set the execution_count for an execution (from kernel's execute_input).
    pub fn set_execution_count(
        &mut self,
        execution_id: &str,
        execution_count: i64,
    ) -> Result<(), RuntimeStateError> {
        let executions = self.scaffold_map("executions")?;

        let Some((_, entry)) = self.doc.get(&executions, execution_id).ok().flatten() else {
            return Ok(());
        };

        self.doc.put(&entry, "execution_count", execution_count)?;
        Ok(())
    }

    /// Mark an execution as done or error.
    pub fn set_execution_done(
        &mut self,
        execution_id: &str,
        success: bool,
    ) -> Result<(), RuntimeStateError> {
        let executions = self.scaffold_map("executions")?;

        let Some((_, entry)) = self.doc.get(&executions, execution_id).ok().flatten() else {
            return Ok(());
        };

        let status = if success { "done" } else { "error" };
        self.doc.put(&entry, "status", status)?;
        self.doc.put(&entry, "success", success)?;
        Ok(())
    }

    /// Mark an execution as cancelled: it was dropped from the queue without
    /// ever running (earlier cell errored, interrupt, kernel death/restart).
    ///
    /// Terminal like "done"/"error", but `success` stays absent — the
    /// execution neither succeeded nor failed, and consumers rely on
    /// `success == false` meaning "ran and errored".
    pub fn set_execution_cancelled(&mut self, execution_id: &str) -> Result<(), RuntimeStateError> {
        let executions = self.scaffold_map("executions")?;

        let Some((_, entry)) = self.doc.get(&executions, execution_id).ok().flatten() else {
            return Ok(());
        };

        self.doc.put(&entry, "status", "cancelled")?;
        Ok(())
    }

    /// Resolve all in-flight executions to a terminal status: "running"
    /// entries become "error" (the kernel went away mid-run), "queued"
    /// entries become "cancelled" (they never started). Returns the number of
    /// executions resolved. Used during kernel restart or interrupt to catch
    /// any entries that the local KernelState doesn't know about (e.g.,
    /// entries created by CRDT sync that haven't been processed locally yet).
    pub fn abort_inflight_executions(&mut self) -> Result<usize, RuntimeStateError> {
        let Some(executions) = self.get_map("executions") else {
            return Ok(0);
        };

        let inflight: Vec<(automerge::ObjId, bool)> =
            self.doc
                .map_range(&executions, ..)
                .filter_map(|item| {
                    if !matches!(item.value, automerge::ValueRef::Object(ObjType::Map)) {
                        return None;
                    }
                    let status = self.doc.get(item.id(), "status").ok().flatten().and_then(
                        |(v, _)| match v {
                            Value::Scalar(s) => s.to_str().map(|s| s.to_string()),
                            _ => None,
                        },
                    );
                    match status.as_deref() {
                        Some("running") => Some((item.id(), true)),
                        Some("queued") => Some((item.id(), false)),
                        _ => None,
                    }
                })
                .collect();

        let count = inflight.len();
        for (entry_id, was_running) in inflight {
            if was_running {
                self.doc.put(&entry_id, "status", "error")?;
                self.doc.put(&entry_id, "success", false)?;
            } else {
                self.doc.put(&entry_id, "status", "cancelled")?;
            }
        }
        Ok(count)
    }

    /// Read a single execution's state.
    pub fn get_execution(&self, execution_id: &str) -> Option<ExecutionState> {
        let executions = self.get_map("executions")?;

        let (_, entry) = self.doc.get(&executions, execution_id).ok().flatten()?;

        let status = self.read_str(&entry, "status");

        let execution_count = self.read_execution_count(&entry);
        let success = self.read_execution_success(&entry);
        let outputs = self.get_outputs(execution_id);
        let source = self.read_opt_str(&entry, "source");
        let cell_id = self.read_opt_str(&entry, "cell_id");
        let seq = self.read_execution_seq(&entry);

        let submitted_by_actor_label = self.read_opt_str(&entry, "submitted_by_actor_label");

        Some(ExecutionState {
            status,
            execution_count,
            success,
            outputs,
            source,
            cell_id,
            seq,
            submitted_by_actor_label,
        })
    }

    fn read_execution_count(&self, entry: &ObjId) -> Option<i64> {
        self.doc
            .get(entry, "execution_count")
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Int(n) => Some(*n),
                    ScalarValue::Uint(n) => Some(*n as i64),
                    _ => None,
                },
                _ => None,
            })
    }

    fn read_execution_success(&self, entry: &ObjId) -> Option<bool> {
        self.doc
            .get(entry, "success")
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Boolean(b) => Some(*b),
                    _ => None,
                },
                _ => None,
            })
    }

    fn read_execution_seq(&self, entry: &ObjId) -> Option<u64> {
        self.doc
            .get(entry, "seq")
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Uint(n) => Some(*n),
                    ScalarValue::Int(n) => Some(*n as u64),
                    _ => None,
                },
                _ => None,
            })
    }

    /// Get execution entries with `status == "queued"`, sorted by `seq`.
    ///
    /// Used by the runtime agent to discover new work via CRDT sync. Returns
    /// `(execution_id, ExecutionState)` pairs in execution order.
    pub fn get_queued_executions(&self) -> Vec<(String, ExecutionState)> {
        let Some(executions) = self.get_map("executions") else {
            return Vec::new();
        };

        let mut queued = Vec::new();
        for execution_id in self.doc.keys(&executions) {
            let Some((_, entry)) = self.doc.get(&executions, &execution_id).ok().flatten() else {
                continue;
            };
            let status = self.read_str(&entry, "status");
            if status != "queued" {
                continue;
            }

            queued.push((
                execution_id,
                ExecutionState {
                    status,
                    execution_count: self.read_execution_count(&entry),
                    success: self.read_execution_success(&entry),
                    outputs: Vec::new(),
                    source: self.read_opt_str(&entry, "source"),
                    cell_id: self.read_opt_str(&entry, "cell_id"),
                    seq: self.read_execution_seq(&entry),
                    submitted_by_actor_label: self.read_opt_str(&entry, "submitted_by_actor_label"),
                },
            ));
        }

        queued.sort_by_key(|(_, exec)| exec.seq.unwrap_or(u64::MAX));
        queued
    }

    // ── Output storage (keyed by execution_id/output_id) ────────────

    fn get_execution_entry(&self, execution_id: &str) -> Option<automerge::ObjId> {
        let executions = self.get_map("executions")?;
        let (_, entry) = self.doc.get(&executions, execution_id).ok().flatten()?;
        Some(entry)
    }

    /// Get the ObjId for the `executions/{execution_id}/outputs` map, if it exists.
    fn get_output_map(&self, execution_id: &str) -> Option<automerge::ObjId> {
        let entry = self.get_execution_entry(execution_id)?;
        self.doc
            .get(&entry, "outputs")
            .ok()
            .flatten()
            .and_then(|(value, id)| match value {
                Value::Object(ObjType::Map) => Some(id),
                _ => None,
            })
    }

    /// Ensure the `executions/{execution_id}/outputs` map exists, creating it if absent.
    /// Returns `None` if the execution entry doesn't exist (stale IOPub race).
    fn ensure_output_map(&mut self, execution_id: &str) -> Option<automerge::ObjId> {
        let entry = self.get_execution_entry(execution_id)?;
        match self.doc.get(&entry, "outputs").ok().flatten() {
            Some((Value::Object(ObjType::Map), id)) => Some(id),
            _ => self.doc.put_object(&entry, "outputs", ObjType::Map).ok(),
        }
    }

    fn get_output_entry(&self, execution_id: &str, output_id: &str) -> Option<automerge::ObjId> {
        let outputs = self.get_output_map(execution_id)?;
        self.doc
            .get(&outputs, output_id)
            .ok()
            .flatten()
            .and_then(|(value, id)| match value {
                Value::Object(ObjType::Map) => Some(id),
                _ => None,
            })
    }

    fn read_output_seq(&self, output_entry: &automerge::ObjId) -> Option<u64> {
        self.doc
            .get(output_entry, "seq")
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Uint(n) => Some(*n),
                    ScalarValue::Int(n) if *n >= 0 => Some(*n as u64),
                    _ => None,
                },
                _ => None,
            })
    }

    fn read_output_manifest(&self, output_entry: &automerge::ObjId) -> Option<serde_json::Value> {
        automunge::read_json_value(&self.doc, output_entry, "manifest")
    }

    fn output_entries_sorted(
        &self,
        outputs: &automerge::ObjId,
    ) -> Vec<(String, u64, serde_json::Value)> {
        let mut entries = Vec::new();
        for output_id in self.doc.keys(outputs) {
            let Some((Value::Object(ObjType::Map), output_entry)) =
                self.doc.get(outputs, &output_id).ok().flatten()
            else {
                continue;
            };
            let Some(seq) = self.read_output_seq(&output_entry) else {
                continue;
            };
            let Some(manifest) = self.read_output_manifest(&output_entry) else {
                continue;
            };
            entries.push((output_id, seq, manifest));
        }
        entries.sort_by(|(left_id, left_seq, _), (right_id, right_seq, _)| {
            left_seq.cmp(right_seq).then_with(|| left_id.cmp(right_id))
        });
        entries
    }

    fn scan_output_order(&self, outputs: &automerge::ObjId) -> OutputOrderCacheEntry {
        // The daemon writes live execution outputs serially, so `seq` is
        // monotonic in production. Concurrent appenders can tie; projection
        // remains deterministic because `output_entries_sorted` falls back to
        // `output_id` ordering.
        let entries = self.output_entries_sorted(outputs);
        let latest = entries
            .last()
            .map(|(output_id, seq, _)| (output_id.clone(), *seq));
        OutputOrderCacheEntry {
            next_seq: latest.as_ref().map_or(0, |(_, seq)| seq.saturating_add(1)),
            latest_seq: latest.map(|(_, seq)| seq),
        }
    }

    fn output_order(
        &mut self,
        execution_id: &str,
        outputs: &automerge::ObjId,
    ) -> OutputOrderCacheEntry {
        if let Some(entry) = self.output_order_cache.get(execution_id) {
            return entry.clone();
        }
        let entry = self.scan_output_order(outputs);
        self.output_order_cache
            .insert(execution_id.to_string(), entry.clone());
        entry
    }

    fn next_output_seq(&mut self, execution_id: &str, outputs: &automerge::ObjId) -> u64 {
        self.output_order(execution_id, outputs).next_seq
    }

    fn write_output_order_cache(
        &mut self,
        execution_id: &str,
        next_seq: u64,
        latest_seq: Option<u64>,
    ) {
        self.output_order_cache.insert(
            execution_id.to_string(),
            OutputOrderCacheEntry {
                next_seq,
                latest_seq,
            },
        );
    }

    fn output_is_latest(
        &mut self,
        execution_id: &str,
        outputs: &automerge::ObjId,
        output_entry: &automerge::ObjId,
    ) -> bool {
        let Some(seq) = self.read_output_seq(output_entry) else {
            return false;
        };
        self.output_order(execution_id, outputs).latest_seq == Some(seq)
    }

    fn display_id_for_manifest(manifest: &serde_json::Value) -> Option<&str> {
        manifest
            .get("transient")
            .and_then(|t| t.get("display_id"))
            .and_then(|d| d.as_str())
    }

    fn write_output_manifest(
        &mut self,
        output_entry: &automerge::ObjId,
        manifest: &serde_json::Value,
    ) -> Result<(), AutomergeError> {
        automunge::update_json_at_key(&mut self.doc, output_entry, "manifest", manifest)
    }

    /// Append or replace a single output manifest for an execution.
    ///
    /// The manifest is written under `outputs/{output_id}` and ordered by a
    /// daemon-authored `seq`. Creates the execution output map if it doesn't exist.
    /// Also updates `display_index` if the manifest has a `display_id`.
    /// Returns the output_id, or the manifest output_id if the execution entry is missing.
    pub fn append_output(
        &mut self,
        execution_id: &str,
        manifest: &serde_json::Value,
    ) -> Result<String, RuntimeStateError> {
        let output_id = extract_output_id(manifest).ok_or(RuntimeStateError::MissingOutputId)?;
        let Some(outputs) = self.ensure_output_map(execution_id) else {
            return Ok(output_id);
        };

        let output_entry = match self.doc.get(&outputs, &output_id).ok().flatten() {
            Some((Value::Object(ObjType::Map), id)) => id,
            _ => {
                let id = self.doc.put_object(&outputs, &output_id, ObjType::Map)?;
                let seq = self.next_output_seq(execution_id, &outputs);
                self.doc.put(&id, "seq", ScalarValue::Uint(seq))?;
                self.write_output_order_cache(execution_id, seq.saturating_add(1), Some(seq));
                id
            }
        };

        if let Some(old_manifest) = self.read_output_manifest(&output_entry) {
            if let Some(display_id) = Self::display_id_for_manifest(&old_manifest) {
                self.remove_display_index_entry(display_id, execution_id, &output_id);
            }
        }

        self.write_output_manifest(&output_entry, manifest)?;

        if let Some(display_id) = Self::display_id_for_manifest(manifest) {
            self.add_display_index_entry(display_id, execution_id, &output_id);
        }

        Ok(output_id)
    }

    /// Append or replace multiple output manifests for one execution.
    ///
    /// This is the hot path for display bursts. It computes the next sequence
    /// number once, then assigns sequence numbers as new output entries are
    /// created. Calling [`append_output`] repeatedly would rescan and sort all
    /// existing outputs for every item in the batch.
    pub fn append_outputs(
        &mut self,
        execution_id: &str,
        manifests: &[serde_json::Value],
    ) -> Result<Vec<String>, RuntimeStateError> {
        let output_ids = manifests
            .iter()
            .map(|manifest| extract_output_id(manifest).ok_or(RuntimeStateError::MissingOutputId))
            .collect::<Result<Vec<_>, _>>()?;

        let Some(outputs) = self.ensure_output_map(execution_id) else {
            return Ok(output_ids);
        };

        let mut next_seq = self.next_output_seq(execution_id, &outputs);
        let mut first_error = None;
        let mut latest_created_seq = None;
        for (manifest, output_id) in manifests.iter().zip(output_ids.iter()) {
            let output_entry = match self.doc.get(&outputs, output_id).ok().flatten() {
                Some((Value::Object(ObjType::Map), id)) => id,
                _ => {
                    let id = match self.doc.put_object(&outputs, output_id, ObjType::Map) {
                        Ok(id) => id,
                        Err(e) => {
                            first_error.get_or_insert_with(|| e.into());
                            continue;
                        }
                    };
                    if let Err(e) = self.doc.put(&id, "seq", ScalarValue::Uint(next_seq)) {
                        first_error.get_or_insert_with(|| e.into());
                        let _ = self.doc.delete(&outputs, output_id);
                        continue;
                    }
                    latest_created_seq = Some(next_seq);
                    next_seq = next_seq.saturating_add(1);
                    id
                }
            };

            if let Some(old_manifest) = self.read_output_manifest(&output_entry) {
                if let Some(display_id) = Self::display_id_for_manifest(&old_manifest) {
                    self.remove_display_index_entry(display_id, execution_id, output_id);
                }
            }

            if let Err(e) = self.write_output_manifest(&output_entry, manifest) {
                first_error.get_or_insert_with(|| e.into());
                continue;
            }

            if let Some(display_id) = Self::display_id_for_manifest(manifest) {
                self.add_display_index_entry(display_id, execution_id, output_id);
            }
        }

        if latest_created_seq.is_some() {
            self.write_output_order_cache(execution_id, next_seq, latest_created_seq);
        }

        if let Some(error) = first_error {
            return Err(error);
        }

        Ok(output_ids)
    }

    /// Replace all outputs for an execution.
    ///
    /// Used during notebook load to populate outputs for synthetic execution_ids.
    pub fn set_outputs(
        &mut self,
        execution_id: &str,
        manifests: &[serde_json::Value],
    ) -> Result<bool, RuntimeStateError> {
        let Some(executions) = self.get_map("executions") else {
            return Ok(false);
        };
        let Some((_, entry)) = self.doc.get(&executions, execution_id).ok().flatten() else {
            return Ok(false);
        };

        // Delete existing output map and create fresh.
        self.remove_display_index_entries_for_execution(execution_id);
        let _ = self.doc.delete(&entry, "outputs");
        let outputs = self.doc.put_object(&entry, "outputs", ObjType::Map)?;
        let mut latest_seq = None;
        for (i, manifest) in manifests.iter().enumerate() {
            let output_id =
                extract_output_id(manifest).ok_or(RuntimeStateError::MissingOutputId)?;
            let output_entry = self.doc.put_object(&outputs, &output_id, ObjType::Map)?;
            self.doc
                .put(&output_entry, "seq", ScalarValue::Uint(i as u64))?;
            self.write_output_manifest(&output_entry, manifest)?;
            if let Some(display_id) = Self::display_id_for_manifest(manifest) {
                self.add_display_index_entry(display_id, execution_id, &output_id);
            }
            latest_seq = Some(i as u64);
        }
        self.write_output_order_cache(execution_id, manifests.len() as u64, latest_seq);
        Ok(true)
    }

    /// Remove execution entries by execution id.
    ///
    /// Used when a failed operation rolls back newly-created runtime records
    /// before their document-owned pointers become durable notebook state.
    pub fn remove_executions(
        &mut self,
        execution_ids: &[String],
    ) -> Result<usize, RuntimeStateError> {
        if execution_ids.is_empty() {
            return Ok(0);
        }

        let Some(executions) = self.get_map("executions") else {
            return Ok(0);
        };

        let mut removed = 0;
        for execution_id in execution_ids {
            if self
                .doc
                .get(&executions, execution_id.as_str())
                .ok()
                .flatten()
                .is_some()
            {
                self.doc.delete(&executions, execution_id.as_str())?;
                self.remove_display_index_entries_for_execution(execution_id);
                self.output_order_cache.remove(execution_id);
                removed += 1;
            }
        }

        Ok(removed)
    }

    // ── display_index management ─────────────────────────────────────

    /// Add an entry to the display_index for a given display_id.
    ///
    /// Each entry is stored as a map key `"execution_id\0output_id"` under
    /// `display_index/{display_id}`.
    pub fn add_display_index_entry(
        &mut self,
        display_id: &str,
        execution_id: &str,
        output_id: &str,
    ) {
        let Some(index_map) = self.get_map("display_index") else {
            return;
        };
        let display_entries = match self.doc.get(&index_map, display_id).ok().flatten() {
            Some((Value::Object(ObjType::Map), id)) => id,
            _ => {
                let Ok(id) = self.doc.put_object(&index_map, display_id, ObjType::Map) else {
                    return;
                };
                id
            }
        };
        let entry = format!("{}\0{}", execution_id, output_id);
        let _ = self.doc.put(&display_entries, entry, true);
    }

    fn remove_display_index_entry(
        &mut self,
        display_id: &str,
        execution_id: &str,
        output_id: &str,
    ) {
        let Some(index_map) = self.get_map("display_index") else {
            return;
        };
        let Some((Value::Object(ObjType::Map), display_entries)) =
            self.doc.get(&index_map, display_id).ok().flatten()
        else {
            return;
        };
        let entry = format!("{}\0{}", execution_id, output_id);
        let _ = self.doc.delete(&display_entries, entry.as_str());
        if self.doc.keys(&display_entries).next().is_none() {
            let _ = self.doc.delete(&index_map, display_id);
        }
    }

    /// Remove all display_index entries that reference the given execution_id.
    ///
    /// Called when an execution's outputs are cleared.
    pub fn remove_display_index_entries_for_execution(&mut self, execution_id: &str) {
        let Some(index_map) = self.get_map("display_index") else {
            return;
        };
        let display_ids: Vec<String> = self.doc.keys(&index_map).collect();
        for display_id in display_ids {
            let Some((Value::Object(ObjType::Map), display_entries)) =
                self.doc.get(&index_map, &display_id).ok().flatten()
            else {
                continue;
            };
            let prefix = format!("{}\0", execution_id);
            let to_remove: Vec<String> = self
                .doc
                .keys(&display_entries)
                .filter(|entry| entry.starts_with(&prefix))
                .collect();
            for entry in to_remove {
                let _ = self.doc.delete(&display_entries, entry.as_str());
            }
            if self.doc.keys(&display_entries).next().is_none() {
                let _ = self.doc.delete(&index_map, &display_id);
            }
        }
    }

    /// Look up all (execution_id, output_id) pairs for a given display_id.
    pub fn get_display_index_entries(&self, display_id: &str) -> Vec<(String, String)> {
        let Some(index_map) = self.get_map("display_index") else {
            return Vec::new();
        };
        let Some((Value::Object(ObjType::Map), display_entries)) =
            self.doc.get(&index_map, display_id).ok().flatten()
        else {
            return Vec::new();
        };
        let mut entries = Vec::new();
        for entry in self.doc.keys(&display_entries) {
            if let Some((eid, oid)) = entry.split_once('\0') {
                entries.push((eid.to_string(), oid.to_string()));
            }
        }
        entries
    }

    /// Update or insert a stream output for an execution.
    ///
    /// If `known_state` is provided, validates that the cached output_id
    /// still has the expected blob hash (via `text.blob`). If validation passes,
    /// replaces in place. If validation fails (hash mismatch, index out of bounds,
    /// or no state), appends a new output.
    ///
    /// Returns `(updated: bool, output_id)` where `updated` is true if an
    /// existing output was replaced in place, false if a new output was appended.
    pub fn upsert_stream_output(
        &mut self,
        execution_id: &str,
        _stream_name: &str,
        manifest: &serde_json::Value,
        known_state: Option<&StreamOutputState>,
    ) -> Result<(bool, String), RuntimeStateError> {
        let manifest_output_id =
            extract_output_id(manifest).ok_or(RuntimeStateError::MissingOutputId)?;
        let Some(outputs) = self.ensure_output_map(execution_id) else {
            return Ok((false, manifest_output_id));
        };

        // Validate cached state if provided
        if let Some(state) = known_state {
            // Must be the last output - if something was appended after (e.g., stderr
            // between two stdout messages), we should append instead of updating
            if let Some(output_entry) = self.get_output_entry(execution_id, &state.output_id) {
                let is_latest = self.output_is_latest(execution_id, &outputs, &output_entry);
                // Read the existing output and check text content ref against state.blob_hash.
                // ContentRef is either {"blob": "hash", "size": N} or {"inline": "text"}.
                // The cached blob_hash stores the blob hash or the inline content itself.
                if is_latest {
                    let existing = self.read_output_manifest(&output_entry);
                    let Some(existing) = existing else {
                        return Ok((false, self.append_output(execution_id, manifest)?));
                    };
                    let current_id = existing.get("text").and_then(|t| {
                        t.get("blob")
                            .and_then(|b| b.as_str())
                            .or_else(|| t.get("inline").and_then(|i| i.as_str()))
                    });
                    if current_id == Some(&state.blob_hash) {
                        // Carry forward the existing output_id so the
                        // coalesced stream keeps a stable identity.
                        let mut patched = manifest.clone();
                        if let (
                            Some(serde_json::Value::String(old_id)),
                            serde_json::Value::Object(ref mut map),
                        ) = (existing.get("output_id").cloned(), &mut patched)
                        {
                            if !old_id.is_empty() {
                                map.insert(
                                    "output_id".to_string(),
                                    serde_json::Value::String(old_id),
                                );
                            }
                        }
                        // In-place update: reuse the existing Map object,
                        // only updating changed fields (text, llm_preview).
                        // This avoids delete+insert which generates tombstones
                        // for the entire Map on every stream coalescence.
                        self.replace_output(execution_id, &state.output_id, &patched)?;
                        return Ok((true, state.output_id.clone()));
                    }
                }
            }
            // Validation failed — fall through to append
        }

        // No valid state, append new output
        let output_id = self.append_output(execution_id, manifest)?;
        Ok((false, output_id))
    }

    /// Replace an output by output_id for an execution.
    ///
    /// Used by UpdateDisplayData handling for in-place manifest updates.
    /// Reuses the existing Map object and only updates changed fields to
    /// minimize CRDT ops (avoids delete+insert tombstone accumulation).
    pub fn replace_output(
        &mut self,
        execution_id: &str,
        output_id: &str,
        manifest: &serde_json::Value,
    ) -> Result<bool, RuntimeStateError> {
        let Some(output_entry) = self.get_output_entry(execution_id, output_id) else {
            return Ok(false);
        };

        if let Some(old_manifest) = self.read_output_manifest(&output_entry) {
            if let Some(display_id) = Self::display_id_for_manifest(&old_manifest) {
                self.remove_display_index_entry(display_id, execution_id, output_id);
            }
        }

        self.write_output_manifest(&output_entry, manifest)?;

        if let Some(display_id) = Self::display_id_for_manifest(manifest) {
            self.add_display_index_entry(display_id, execution_id, output_id);
        }

        Ok(true)
    }

    /// Read all outputs for an execution.
    pub fn get_outputs(&self, execution_id: &str) -> Vec<serde_json::Value> {
        let Some(outputs) = self.get_output_map(execution_id) else {
            return Vec::new();
        };
        self.output_entries_sorted(&outputs)
            .into_iter()
            .map(|(_, _, manifest)| manifest)
            .collect()
    }

    /// Read one output manifest by execution id and output id.
    pub fn get_output(&self, execution_id: &str, output_id: &str) -> Option<serde_json::Value> {
        let output_entry = self.get_output_entry(execution_id, output_id)?;
        self.read_output_manifest(&output_entry)
    }

    /// Get all outputs across all executions.
    ///
    /// Returns `(execution_id, output_id, manifest)` triples.
    /// Used by UpdateDisplayData to find outputs with matching display_id.
    pub fn get_all_outputs(&self) -> Vec<(String, String, serde_json::Value)> {
        let Some(executions) = self.get_map("executions") else {
            return Vec::new();
        };
        let mut results = Vec::new();
        for exec_id in self.doc.keys(&executions) {
            if let Some((_, entry)) = self.doc.get(&executions, &exec_id).ok().flatten() {
                if let Some((Value::Object(ObjType::Map), outputs)) =
                    self.doc.get(&entry, "outputs").ok().flatten()
                {
                    for (output_id, _, manifest) in self.output_entries_sorted(&outputs) {
                        results.push((exec_id.clone(), output_id, manifest));
                    }
                }
            }
        }
        results
    }

    // ── Execution lifecycle ────────────────────────────────────────

    /// Remove old executions, keeping active and document-referenced entries.
    pub fn trim_executions(&mut self, max: usize) -> Result<usize, RuntimeStateError> {
        self.trim_executions_preserving(max, &HashSet::new())
    }

    /// Remove old executions, preserving the provided execution ids plus any
    /// ids that are currently queued or running in the RuntimeStateDoc queue.
    ///
    /// Call this from a coordinator that can include document-owned pointers
    /// in `preserve_execution_ids`. Runtime-agent-only trimming cannot see
    /// those pointers and must not be the owner of retention policy.
    pub fn trim_executions_preserving(
        &mut self,
        max: usize,
        preserve_execution_ids: &HashSet<String>,
    ) -> Result<usize, RuntimeStateError> {
        let Some(executions) = self.get_map("executions") else {
            return Ok(0);
        };

        let mut protected: HashSet<String> = preserve_execution_ids.clone();
        if let Some(queue) = self.get_map("queue") {
            if let Some(eid) = self.read_opt_str(&queue, "executing_execution_id") {
                protected.insert(eid);
            }
            protected.extend(self.read_str_list(&queue, "queued_execution_ids"));
        }

        let mut keys = Vec::new();
        for key in self.doc.keys(&executions) {
            if let Some((_, entry)) = self.doc.get(&executions, &key).ok().flatten() {
                let status = self.read_str(&entry, "status");
                if status == "queued" || status == "running" {
                    protected.insert(key.clone());
                }
                let seq = self
                    .doc
                    .get(&entry, "seq")
                    .ok()
                    .flatten()
                    .and_then(|(value, _)| match value {
                        Value::Scalar(s) => match s.as_ref() {
                            ScalarValue::Uint(n) => Some(*n),
                            ScalarValue::Int(n) if *n >= 0 => Some(*n as u64),
                            _ => None,
                        },
                        _ => None,
                    })
                    .unwrap_or(u64::MAX);
                keys.push((key, seq));
            }
        }

        let total = keys.len();
        if total <= max {
            return Ok(0);
        }

        keys.sort_by(|(a_id, a_seq), (b_id, b_seq)| a_seq.cmp(b_seq).then_with(|| a_id.cmp(b_id)));

        let mut removed = 0;
        let to_remove = total - max;
        for (exec_id, _) in keys {
            if removed >= to_remove {
                break;
            }
            if protected.contains(&exec_id) {
                continue;
            }
            self.remove_display_index_entries_for_execution(&exec_id);
            self.doc.delete(&executions, exec_id.as_str())?;
            self.output_order_cache.remove(&exec_id);
            removed += 1;
        }
        Ok(removed)
    }

    /// Update environment sync state.
    pub fn set_env_sync(
        &mut self,
        in_sync: bool,
        added: &[String],
        removed: &[String],
        channels_changed: bool,
        deno_changed: bool,
    ) -> Result<(), RuntimeStateError> {
        let env = self.scaffold_map("env")?;
        let cur_in_sync = self.read_bool(&env, "in_sync");
        let cur_added = self.read_str_list(&env, "added");
        let cur_removed = self.read_str_list(&env, "removed");
        let cur_channels = self.read_bool(&env, "channels_changed");
        let cur_deno = self.read_bool(&env, "deno_changed");

        if cur_in_sync == in_sync
            && cur_added == added
            && cur_removed == removed
            && cur_channels == channels_changed
            && cur_deno == deno_changed
        {
            return Ok(());
        }

        self.doc.put(&env, "in_sync", in_sync)?;
        self.doc.put(&env, "channels_changed", channels_changed)?;
        self.doc.put(&env, "deno_changed", deno_changed)?;

        let added_list = self.scaffold_list(&env, "added")?;
        for i in (0..self.doc.length(&added_list)).rev() {
            self.doc.delete(&added_list, i)?;
        }
        for (i, pkg) in added.iter().enumerate() {
            self.doc.insert(&added_list, i, pkg.as_str())?;
        }

        let removed_list = self.scaffold_list(&env, "removed")?;
        for i in (0..self.doc.length(&removed_list)).rev() {
            self.doc.delete(&removed_list, i)?;
        }
        for (i, pkg) in removed.iter().enumerate() {
            self.doc.insert(&removed_list, i, pkg.as_str())?;
        }

        Ok(())
    }

    /// Update prewarmed packages list.
    pub fn set_prewarmed_packages(&mut self, packages: &[String]) -> Result<(), RuntimeStateError> {
        let env = self.scaffold_map("env")?;
        let current = self.read_str_list(&env, "prewarmed_packages");
        if current == packages {
            return Ok(());
        }

        let list = self.scaffold_list(&env, "prewarmed_packages")?;
        for i in (0..self.doc.length(&list)).rev() {
            self.doc.delete(&list, i)?;
        }
        for (i, pkg) in packages.iter().enumerate() {
            self.doc.insert(&list, i, pkg.as_str())?;
        }

        Ok(())
    }

    /// Update the latest environment preparation progress snapshot.
    pub fn set_env_progress(
        &mut self,
        env_type: &str,
        phase: &serde_json::Value,
    ) -> Result<(), RuntimeStateError> {
        let env = self.scaffold_map("env")?;
        let serde_json::Value::Object(mut map) = phase.clone() else {
            return Err(RuntimeStateError::InvalidProgressShape);
        };
        map.insert(
            "env_type".to_string(),
            serde_json::Value::String(env_type.to_string()),
        );
        let progress = serde_json::Value::Object(map);

        if automunge::read_json_value(&self.doc, &env, "progress") == Some(progress.clone()) {
            return Ok(());
        }

        automunge::update_json_at_key(&mut self.doc, &env, "progress", &progress)?;
        Ok(())
    }

    /// Clear the latest environment preparation progress snapshot.
    pub fn clear_env_progress(&mut self) -> Result<(), RuntimeStateError> {
        let env = self.scaffold_map("env")?;
        if automunge::read_json_value(&self.doc, &env, "progress") == Some(serde_json::Value::Null)
        {
            return Ok(());
        }
        automunge::update_json_at_key(&mut self.doc, &env, "progress", &serde_json::Value::Null)?;
        Ok(())
    }

    /// Set the `last_saved` timestamp.
    pub fn set_last_saved(&mut self, timestamp: Option<&str>) -> Result<(), RuntimeStateError> {
        self.set_optional_str("last_saved", timestamp)
    }

    /// Set the notebook's `.ipynb` path. `None` for untitled.
    pub fn set_path(&mut self, path: Option<&str>) -> Result<(), RuntimeStateError> {
        self.set_optional_str("path", path)
    }

    /// RuntimeStateDoc identity, if the daemon has written one.
    pub fn runtime_state_doc_id(&self) -> Option<String> {
        self.read_opt_str(&ROOT, "runtime_state_doc_id")
    }

    /// Set the RuntimeStateDoc identity.
    pub fn set_runtime_state_doc_id(
        &mut self,
        runtime_state_doc_id: Option<&str>,
    ) -> Result<(), RuntimeStateError> {
        self.set_optional_str("runtime_state_doc_id", runtime_state_doc_id)
    }

    // ── Workstation attachment ──────────────────────────────────────

    /// Current room-selected workstation attachment, if the room host has
    /// published one.
    pub fn workstation_attachment(&self) -> Option<WorkstationAttachmentState> {
        let workstation = self.get_map("workstation")?;
        Some(WorkstationAttachmentState {
            workstation_id: self.read_str(&workstation, "workstation_id"),
            display_name: self.read_str(&workstation, "display_name"),
            provider: self.read_str(&workstation, "provider"),
            default_environment_label: self.read_str(&workstation, "default_environment_label"),
            environment_policy: self.read_str(&workstation, "environment_policy"),
            status: self.read_str(&workstation, "status"),
            status_message: self.read_opt_str(&workstation, "status_message"),
            cpu_count: self.read_opt_u64(&workstation, "cpu_count"),
            memory_bytes: self.read_opt_u64(&workstation, "memory_bytes"),
            working_directory: self.read_opt_str(&workstation, "working_directory"),
            updated_at: self.read_opt_str(&workstation, "updated_at"),
            runtime_session_id: self.read_opt_str(&workstation, "runtime_session_id"),
        })
    }

    /// Publish or clear the room-selected workstation attachment.
    ///
    /// This is room-host/daemon-owned state. Runtime peers report provider
    /// observations through their control path, but the room host owns the
    /// notebook-visible attachment projection because it also owns execution
    /// intent dispatch.
    pub fn set_workstation_attachment(
        &mut self,
        state: Option<&WorkstationAttachmentState>,
    ) -> Result<(), RuntimeStateError> {
        if self.workstation_attachment().as_ref() == state {
            return Ok(());
        }

        let Some(state) = state else {
            self.doc.put(&ROOT, "workstation", ScalarValue::Null)?;
            return Ok(());
        };

        let workstation = self.get_or_create_root_map("workstation")?;
        self.doc.put(
            &workstation,
            "workstation_id",
            state.workstation_id.as_str(),
        )?;
        self.doc
            .put(&workstation, "display_name", state.display_name.as_str())?;
        self.doc
            .put(&workstation, "provider", state.provider.as_str())?;
        self.doc.put(
            &workstation,
            "default_environment_label",
            state.default_environment_label.as_str(),
        )?;
        self.doc.put(
            &workstation,
            "environment_policy",
            state.environment_policy.as_str(),
        )?;
        self.doc
            .put(&workstation, "status", state.status.as_str())?;
        self.put_optional_str_at(
            &workstation,
            "status_message",
            state.status_message.as_deref(),
        )?;
        self.put_optional_u64_at(&workstation, "cpu_count", state.cpu_count)?;
        self.put_optional_u64_at(&workstation, "memory_bytes", state.memory_bytes)?;
        self.put_optional_str_at(
            &workstation,
            "working_directory",
            state.working_directory.as_deref(),
        )?;
        self.put_optional_str_at(&workstation, "updated_at", state.updated_at.as_deref())?;
        self.put_optional_str_at(
            &workstation,
            "runtime_session_id",
            state.runtime_session_id.as_deref(),
        )?;
        Ok(())
    }

    // ── Project context ─────────────────────────────────────────────

    /// Read the daemon-observed project context.
    ///
    /// Falls back to [`ProjectContext::Pending`] when the scaffolded map
    /// is missing (e.g., a peer that did not run the scaffold) or when
    /// the `state` tag is unparseable. Clients can treat `Pending` as
    /// "we haven't heard yet" without distinguishing the two cases.
    pub fn project_context(&self) -> ProjectContext {
        let Some(pc) = self.get_map("project_context") else {
            return ProjectContext::Pending;
        };
        let state = self.read_str(&pc, "state");
        match state.as_str() {
            "pending" | "" => ProjectContext::Pending,
            "not_found" => ProjectContext::NotFound {
                observed_at: self.read_str(&pc, "observed_at"),
            },
            "detected" => {
                // Unparseable kind on a "detected" entry means the doc was
                // written by a future version or corrupted. Degrade to
                // Pending so consumers don't act on kind-specific logic
                // (e.g., "ah, this is a pyproject.toml, apply uv…").
                let Some(kind) = ProjectFileKind::parse(&self.read_str(&pc, "kind")) else {
                    return ProjectContext::Pending;
                };
                ProjectContext::Detected {
                    project_file: ProjectFile {
                        kind,
                        absolute_path: self.read_str(&pc, "absolute_path"),
                        relative_to_notebook: self.read_str(&pc, "relative_to_notebook"),
                    },
                    parsed: self.read_project_file_parsed(&pc),
                    observed_at: self.read_str(&pc, "observed_at"),
                }
            }
            "unreadable" => ProjectContext::Unreadable {
                path: self.read_str(&pc, "unreadable_path"),
                reason: self.read_str(&pc, "unreadable_reason"),
                observed_at: self.read_str(&pc, "observed_at"),
            },
            _ => ProjectContext::Pending,
        }
    }

    /// Write the daemon-observed project context.
    ///
    /// The daemon is the sole writer; no concurrent writers target this
    /// key. All state fields are scalars except `parsed`, which we treat
    /// as an atomic replace — the daemon writes the whole snapshot each
    /// time it refreshes.
    pub fn set_project_context(&mut self, ctx: &ProjectContext) -> Result<(), RuntimeStateError> {
        let pc = self.scaffold_map("project_context")?;

        self.doc.put(&pc, "state", ctx.variant_str())?;

        // Clear every optional field, then fill per-variant. Keeps the
        // scaffold shape stable regardless of which state we came from.
        self.doc.put(&pc, "observed_at", "")?;
        self.doc.put(&pc, "kind", "")?;
        self.doc.put(&pc, "absolute_path", "")?;
        self.doc.put(&pc, "relative_to_notebook", "")?;
        self.doc.put(&pc, "unreadable_path", "")?;
        self.doc.put(&pc, "unreadable_reason", "")?;
        self.clear_project_file_parsed(&pc)?;

        match ctx {
            ProjectContext::Pending => {}
            ProjectContext::NotFound { observed_at } => {
                self.doc.put(&pc, "observed_at", observed_at.as_str())?;
            }
            ProjectContext::Detected {
                project_file,
                parsed,
                observed_at,
            } => {
                self.doc.put(&pc, "observed_at", observed_at.as_str())?;
                self.doc.put(&pc, "kind", project_file.kind.as_str())?;
                self.doc
                    .put(&pc, "absolute_path", project_file.absolute_path.as_str())?;
                self.doc.put(
                    &pc,
                    "relative_to_notebook",
                    project_file.relative_to_notebook.as_str(),
                )?;
                self.write_project_file_parsed(&pc, parsed)?;
            }
            ProjectContext::Unreadable {
                path,
                reason,
                observed_at,
            } => {
                self.doc.put(&pc, "observed_at", observed_at.as_str())?;
                self.doc.put(&pc, "unreadable_path", path.as_str())?;
                self.doc.put(&pc, "unreadable_reason", reason.as_str())?;
            }
        }

        Ok(())
    }

    fn read_project_file_parsed(&self, pc: &automerge::ObjId) -> ProjectFileParsed {
        let parsed_obj = match self.doc.get(pc, "parsed").ok().flatten() {
            Some((Value::Object(ObjType::Map), id)) => id,
            _ => return ProjectFileParsed::default(),
        };
        let dependencies = self.read_str_list(&parsed_obj, "dependencies");
        let dev_dependencies = self.read_str_list(&parsed_obj, "dev_dependencies");
        let requires_python = self.read_opt_str(&parsed_obj, "requires_python");
        let prerelease = self.read_opt_str(&parsed_obj, "prerelease");
        let extras_json = self.read_str(&parsed_obj, "extras");
        let extras = if extras_json.is_empty() {
            ProjectFileExtras::None
        } else {
            serde_json::from_str(&extras_json).unwrap_or(ProjectFileExtras::None)
        };
        ProjectFileParsed {
            dependencies,
            dev_dependencies,
            requires_python,
            prerelease,
            extras,
        }
    }

    fn write_project_file_parsed(
        &mut self,
        pc: &automerge::ObjId,
        parsed: &ProjectFileParsed,
    ) -> Result<(), RuntimeStateError> {
        let obj = self.doc.put_object(pc, "parsed", ObjType::Map)?;
        let deps_list = self.doc.put_object(&obj, "dependencies", ObjType::List)?;
        for (i, dep) in parsed.dependencies.iter().enumerate() {
            self.doc.insert(&deps_list, i, dep.as_str())?;
        }
        let dev_list = self
            .doc
            .put_object(&obj, "dev_dependencies", ObjType::List)?;
        for (i, dep) in parsed.dev_dependencies.iter().enumerate() {
            self.doc.insert(&dev_list, i, dep.as_str())?;
        }
        match parsed.requires_python.as_deref() {
            Some(s) => self.doc.put(&obj, "requires_python", s)?,
            None => self.doc.put(&obj, "requires_python", ScalarValue::Null)?,
        }
        match parsed.prerelease.as_deref() {
            Some(s) => self.doc.put(&obj, "prerelease", s)?,
            None => self.doc.put(&obj, "prerelease", ScalarValue::Null)?,
        }
        let extras_json = serde_json::to_string(&parsed.extras).unwrap_or_else(|_| "{}".into());
        self.doc.put(&obj, "extras", extras_json.as_str())?;
        Ok(())
    }

    fn clear_project_file_parsed(
        &mut self,
        pc: &automerge::ObjId,
    ) -> Result<(), RuntimeStateError> {
        // Replace the `parsed` child with a fresh empty map. Single-writer
        // invariant on project_context means this put_object is safe.
        let obj = self.doc.put_object(pc, "parsed", ObjType::Map)?;
        self.doc.put_object(&obj, "dependencies", ObjType::List)?;
        self.doc
            .put_object(&obj, "dev_dependencies", ObjType::List)?;
        self.doc.put(&obj, "requires_python", ScalarValue::Null)?;
        self.doc.put(&obj, "prerelease", ScalarValue::Null)?;
        self.doc.put(&obj, "extras", "")?;
        Ok(())
    }

    fn set_optional_str(
        &mut self,
        key: &'static str,
        value: Option<&str>,
    ) -> Result<(), RuntimeStateError> {
        let current = self.read_opt_str(&ROOT, key);
        if current.as_deref() == value {
            return Ok(());
        }
        match value {
            Some(s) => self.doc.put(&ROOT, key, s)?,
            None => self.doc.put(&ROOT, key, ScalarValue::Null)?,
        }
        Ok(())
    }

    fn put_optional_str_at(
        &mut self,
        obj: &automerge::ObjId,
        key: &'static str,
        value: Option<&str>,
    ) -> Result<(), RuntimeStateError> {
        match value {
            Some(s) => self.doc.put(obj, key, s)?,
            None => self.doc.put(obj, key, ScalarValue::Null)?,
        }
        Ok(())
    }

    fn put_optional_u64_at(
        &mut self,
        obj: &automerge::ObjId,
        key: &'static str,
        value: Option<u64>,
    ) -> Result<(), RuntimeStateError> {
        match value {
            Some(n) => self.doc.put(obj, key, ScalarValue::Uint(n))?,
            None => self.doc.put(obj, key, ScalarValue::Null)?,
        }
        Ok(())
    }

    // ── Comm lifecycle ────────────────────────────────────────────────

    /// Insert or replace a full comm entry (used on `comm_open`).
    pub fn put_comm(
        &mut self,
        comm_id: &str,
        target_name: &str,
        model_module: &str,
        model_name: &str,
        state: &serde_json::Value,
        seq: u64,
    ) -> Result<(), RuntimeStateError> {
        let comms = self.scaffold_map("comms")?;
        // A comm-open owns this topology record as a replaceable snapshot. The
        // mutable widget values live in CommsDoc, where existing object identity
        // is preserved on later comm_msg updates.
        let entry = serde_json::json!({
            "target_name": target_name,
            "model_module": model_module,
            "model_name": model_name,
            "state": state,
            "seq": seq as i64,
            "outputs": [],
            "capture_msg_id": "",
        });
        automunge::put_json_at_key_batched(&mut self.doc, &comms, comm_id, &entry)?;
        Ok(())
    }

    /// Set a single property in the legacy RuntimeStateDoc comm-state slot.
    ///
    /// RuntimeStateDoc still preserves this embedded state map for topology
    /// snapshots and compatibility reads, but frontend CRDT widget writes go
    /// through CommsDoc.
    pub fn set_comm_state_property(
        &mut self,
        comm_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        let Some((_, entry)) = self.doc.get(&comms, comm_id).ok().flatten() else {
            return Ok(());
        };
        let Some((Value::Object(ObjType::Map), state_id)) =
            self.doc.get(&entry, "state").ok().flatten()
        else {
            return Ok(());
        };
        automunge::update_json_at_key(&mut self.doc, &state_id, key, value)?;
        Ok(())
    }

    /// Merge a state delta into a comm's state map, skipping no-op writes.
    ///
    /// For each key in `delta` (must be a JSON object), reads the current
    /// value from `comms/{comm_id}/state/{key}` and only writes if it
    /// differs. This suppresses echo-generated CRDT changes when the
    /// frontend writes a value → kernel echoes the same value back.
    ///
    /// Returns `true` if any property was actually changed.
    pub fn merge_comm_state_delta(
        &mut self,
        comm_id: &str,
        delta: &serde_json::Value,
    ) -> Result<(), RuntimeStateError> {
        let Some(obj) = delta.as_object() else {
            return Ok(());
        };
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        let Some((_, entry)) = self.doc.get(&comms, comm_id).ok().flatten() else {
            return Ok(());
        };
        let Some((Value::Object(ObjType::Map), state_id)) =
            self.doc.get(&entry, "state").ok().flatten()
        else {
            return Ok(());
        };

        for (key, new_value) in obj {
            let should_write = match new_value {
                serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::Number(_)
                | serde_json::Value::String(_) => {
                    let current = automunge::read_json_value(&self.doc, &state_id, key.as_str());
                    current.as_ref() != Some(new_value)
                }
                _ => true,
            };
            if should_write {
                automunge::update_json_at_key(&mut self.doc, &state_id, key, new_value)?;
            }
        }
        Ok(())
    }

    /// Set or clear the capture_msg_id for an Output widget.
    ///
    /// When `msg_id` is non-empty, kernel outputs with matching
    /// `parent_header.msg_id` will be routed to this widget.
    /// Returns `false` if the comm doesn't exist.
    pub fn set_comm_capture_msg_id(
        &mut self,
        comm_id: &str,
        msg_id: &str,
    ) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        let Some((_, entry)) = self.doc.get(&comms, comm_id).ok().flatten() else {
            return Ok(());
        };
        self.doc.put(&entry, "capture_msg_id", msg_id)?;
        Ok(())
    }

    /// Find the comm_id that is capturing outputs for a given msg_id.
    ///
    /// Scans all comms for a matching `capture_msg_id`. Single-depth only:
    /// returns the first match (most recently written wins via CRDT LWW).
    pub fn get_capture_widget(&self, msg_id: &str) -> Option<String> {
        if msg_id.is_empty() {
            return None;
        }
        let comms = self.get_map("comms")?;
        for comm_id in self.doc.keys(&comms) {
            if let Some((_, entry)) = self.doc.get(&comms, &comm_id).ok().flatten() {
                let capture = self.read_str(&entry, "capture_msg_id");
                if capture == msg_id {
                    return Some(comm_id);
                }
            }
        }
        None
    }

    /// Remove a comm entry (used on `comm_close`).
    ///
    /// Returns `false` if the comm doesn't exist.
    pub fn remove_comm(&mut self, comm_id: &str) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        if self.doc.get(&comms, comm_id).ok().flatten().is_none() {
            return Ok(());
        }
        self.doc.delete(&comms, comm_id)?;
        Ok(())
    }

    /// Remove all comm entries (used on kernel shutdown/restart).
    ///
    /// Returns `false` if there were no comms to remove.
    pub fn clear_comms(&mut self) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        let keys: Vec<String> = self.doc.keys(&comms).collect();
        for key in keys {
            self.doc.delete(&comms, &key)?;
        }
        Ok(())
    }

    /// Read a single comm entry.
    pub fn get_comm(&self, comm_id: &str) -> Option<CommDocEntry> {
        let comms = self.get_map("comms")?;
        let (_, entry) = self.doc.get(&comms, comm_id).ok().flatten()?;
        // Read state as native Automerge map → serde_json::Value
        let state = automunge::read_json_value(&self.doc, &entry, "state")
            .unwrap_or_else(|| serde_json::json!({}));
        Some(CommDocEntry {
            target_name: self.read_str(&entry, "target_name"),
            model_module: self.read_str(&entry, "model_module"),
            model_name: self.read_str(&entry, "model_name"),
            state,
            outputs: self.read_json_list(&entry, "outputs"),
            seq: self.read_i64(&entry, "seq") as u64,
            capture_msg_id: self.read_str(&entry, "capture_msg_id"),
        })
    }

    /// Read all comm entries without projecting the full RuntimeState.
    ///
    /// Runtime-agent sync handling diffs comm state on every state-frame
    /// receive. Keeping that path narrow avoids materializing execution
    /// outputs when only widget comm metadata is needed.
    pub fn get_comms(&self) -> HashMap<String, CommDocEntry> {
        let Some(comms_obj) = self.get_map("comms") else {
            return HashMap::new();
        };

        let mut comms = HashMap::new();
        for key in self.doc.keys(&comms_obj) {
            if let Some(entry) = self.get_comm(&key) {
                comms.insert(key, entry);
            }
        }
        comms
    }

    /// Append an output manifest to a comm's outputs list (OutputModel widgets).
    ///
    /// Returns `false` if the comm doesn't exist.
    pub fn append_comm_output(
        &mut self,
        comm_id: &str,
        manifest: &serde_json::Value,
    ) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        let Some((_, entry)) = self.doc.get(&comms, comm_id).ok().flatten() else {
            return Ok(());
        };
        let Some((Value::Object(ObjType::List), list_id)) =
            self.doc.get(&entry, "outputs").ok().flatten()
        else {
            return Ok(());
        };
        let len = self.doc.length(&list_id);
        automunge::insert_json_at_index(&mut self.doc, &list_id, len, manifest)?;
        Ok(())
    }

    /// Clear a comm's outputs list (OutputModel widgets).
    ///
    /// Returns `false` if the comm doesn't exist or outputs is already empty.
    pub fn clear_comm_outputs(&mut self, comm_id: &str) -> Result<(), RuntimeStateError> {
        let Some(comms) = self.get_map("comms") else {
            return Ok(());
        };
        let Some((_, entry)) = self.doc.get(&comms, comm_id).ok().flatten() else {
            return Ok(());
        };
        let Some((Value::Object(ObjType::List), list_id)) =
            self.doc.get(&entry, "outputs").ok().flatten()
        else {
            return Ok(());
        };
        for i in (0..self.doc.length(&list_id)).rev() {
            self.doc.delete(&list_id, i)?;
        }
        Ok(())
    }

    // ── Full state read ─────────────────────────────────────────────

    /// Read the full runtime state snapshot.
    pub fn read_state(&self) -> RuntimeState {
        let kernel = self.get_map("kernel");
        let queue = self.get_map("queue");
        let env = self.get_map("env");
        let trust = self.get_map("trust");

        let kernel_state = kernel
            .as_ref()
            .map(|k| {
                let lifecycle = self.resolve_kernel_lifecycle(k);
                let stored_status = self.read_str(k, "status");
                let stored_starting_phase = self.read_str(k, "starting_phase");
                // Project the resolved lifecycle back to the string
                // shape for source-compat with pre-migration consumers.
                // Always derive from the resolved lifecycle rather than
                // echoing raw CRDT values so the status field is never
                // stale relative to lifecycle.
                let (status, starting_phase) = lifecycle.to_legacy();
                // error_reason is Option<String> so callers can tell "no
                // kernel map at all" (None) from "scaffolded but unset"
                // (Some("")). automunge::read_str_if_present returns None
                // only when the key itself is absent.
                //
                // Fallback: pre-typed docs encoded the error reason via
                // `starting_phase` on the Error transition
                // (status="error" + starting_phase="missing_ipykernel").
                // When the typed key is absent AND we resolved the
                // lifecycle to Error AND the stored starting_phase
                // carries a non-empty reason, surface it so the frontend
                // remediation prompt keeps firing.
                let error_reason = automunge::read_str_if_present(&self.doc, k, "error_reason")
                    .or_else(|| {
                        if matches!(lifecycle, RuntimeLifecycle::Error)
                            && stored_status == "error"
                            && !stored_starting_phase.is_empty()
                        {
                            Some(stored_starting_phase.clone())
                        } else {
                            None
                        }
                    });
                let error_details = automunge::read_str_if_present(&self.doc, k, "error_details");
                let last_seen = automunge::read_str_if_present(&self.doc, k, "last_seen");
                KernelState {
                    status: status.to_string(),
                    starting_phase: starting_phase.to_string(),
                    name: self.read_str(k, "name"),
                    language: self.read_str(k, "language"),
                    env_source: self.read_str(k, "env_source"),
                    runtime_agent_id: self.read_str(k, "runtime_agent_id"),
                    lifecycle,
                    error_reason,
                    error_details,
                    last_seen,
                }
            })
            .unwrap_or_default();

        let mut queue_state = queue
            .as_ref()
            .map(|q| {
                let executing_eid = self.read_opt_str(q, "executing_execution_id");
                let queued_eids = self.read_str_list(q, "queued_execution_ids");

                QueueState {
                    executing: executing_eid.map(|execution_id| QueueEntry { execution_id }),
                    queued: queued_eids
                        .into_iter()
                        .map(|execution_id| QueueEntry { execution_id })
                        .collect(),
                }
            })
            .unwrap_or_default();

        // Read executions map
        let executions = self
            .get_map("executions")
            .map(|exec_obj| {
                let mut map = HashMap::new();
                for key in self.doc.keys(&exec_obj) {
                    if let Some(es) = self.get_execution(&key) {
                        map.insert(key, es);
                    }
                }
                map
            })
            .unwrap_or_default();

        queue_state
            .queued
            .extend(synthesize_queued_entries_from_executions(
                &queue_state,
                &executions,
            ));

        let env_state = env
            .as_ref()
            .map(|e| EnvState {
                in_sync: self.read_bool(e, "in_sync"),
                added: self.read_str_list(e, "added"),
                removed: self.read_str_list(e, "removed"),
                channels_changed: self.read_bool(e, "channels_changed"),
                deno_changed: self.read_bool(e, "deno_changed"),
                prewarmed_packages: self.read_str_list(e, "prewarmed_packages"),
                progress: match automunge::read_json_value(&self.doc, e, "progress") {
                    Some(serde_json::Value::Null) | None => None,
                    other => other,
                },
            })
            .unwrap_or_default();

        let last_saved = self.read_opt_str(&ROOT, "last_saved");
        let path = self.read_opt_str(&ROOT, "path");
        let runtime_state_doc_id = self.runtime_state_doc_id();
        let workstation = self.workstation_attachment();

        let trust_state = trust
            .as_ref()
            .map(|t| TrustRuntimeState {
                status: self.read_str(t, "status"),
                needs_approval: self.read_bool(t, "needs_approval"),
                approved_uv_dependencies: self.read_str_list(t, "approved_uv_dependencies"),
                approved_conda_dependencies: self.read_str_list(t, "approved_conda_dependencies"),
                approved_conda_channels: self.read_str_list(t, "approved_conda_channels"),
                approved_pixi_dependencies: self.read_str_list(t, "approved_pixi_dependencies"),
                approved_pixi_pypi_dependencies: self
                    .read_str_list(t, "approved_pixi_pypi_dependencies"),
                approved_pixi_channels: self.read_str_list(t, "approved_pixi_channels"),
            })
            .unwrap_or_default();

        let comms = self.get_comms();

        RuntimeState {
            runtime_state_doc_id,
            kernel: kernel_state,
            queue: queue_state,
            env: env_state,
            trust: trust_state,
            last_saved,
            path,
            executions,
            comms,
            project_context: self.project_context(),
            workstation,
        }
    }

    // ── Automerge sync protocol ─────────────────────────────────────

    /// Generate an outbound sync message for a peer.
    pub fn generate_sync_message(&mut self, peer_state: &mut sync::State) -> Option<sync::Message> {
        self.doc.sync().generate_sync_message(peer_state)
    }

    /// Generate a sync message through the document-owned error boundary.
    ///
    /// Panics are returned to the caller as diagnostic failures. Caller-marked
    /// recoverable Automerge errors rebuild this doc, reset peer sync state,
    /// and retry once.
    pub fn generate_sync_message_recovering(
        &mut self,
        peer_state: &mut sync::State,
        label: &str,
    ) -> Result<Option<sync::Message>, AutomergeOperationError> {
        let mut context = RuntimeSyncRecoveryContext {
            doc: self,
            peer_state,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| Ok(context.doc.generate_sync_message(context.peer_state)),
            |_| false,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    /// Generate a sync message, compacting the doc if the encoded message
    /// would exceed `max_encoded_bytes`.
    ///
    /// Eliminates the TOCTOU race where the doc grows between a pre-send size
    /// check and the actual frame send. If the message is oversized, this
    /// compacts via save→load, resets `peer_state`, and regenerates.
    ///
    /// Returns the encoded bytes directly, avoiding a redundant clone of the
    /// sync message. Only safe before the first sync exchange with the peer
    /// (i.e., `peer_state` must be fresh or about to be reset).
    pub fn generate_sync_message_bounded_encoded(
        &mut self,
        peer_state: &mut sync::State,
        max_encoded_bytes: usize,
    ) -> Option<Vec<u8>> {
        let encoded = self.doc.sync().generate_sync_message(peer_state)?.encode();
        if encoded.len() <= max_encoded_bytes {
            return Some(encoded);
        }
        tracing::warn!(
            "[runtime-state] Sync message ({} bytes) exceeds threshold ({} bytes), compacting",
            encoded.len(),
            max_encoded_bytes,
        );
        if let Err(err) = self.rebuild_from_save() {
            tracing::warn!(
                "[runtime-state] Compaction failed during bounded sync generation: {}",
                err
            );
            return Some(encoded);
        }
        *peer_state = sync::State::new();
        self.doc
            .sync()
            .generate_sync_message(peer_state)
            .map(|m| m.encode())
    }

    /// Generate a bounded encoded sync message through the document-owned error boundary.
    ///
    /// Panics are returned to the caller as diagnostic failures. Caller-marked
    /// recoverable Automerge errors rebuild this doc, reset peer sync state,
    /// and retry once.
    pub fn generate_sync_message_bounded_encoded_recovering(
        &mut self,
        peer_state: &mut sync::State,
        max_encoded_bytes: usize,
        label: &str,
    ) -> Result<Option<Vec<u8>>, AutomergeOperationError> {
        let mut context = RuntimeBoundedSyncRecoveryContext {
            doc: self,
            peer_state,
            max_encoded_bytes,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                Ok(context.doc.generate_sync_message_bounded_encoded(
                    context.peer_state,
                    context.max_encoded_bytes,
                ))
            },
            |_| false,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    /// Receive a sync message with change stripping (read-only enforcement).
    ///
    /// Regular notebook clients do not author RuntimeStateDoc changes over
    /// sync. Any changes embedded in this path are stripped; only the
    /// heads/need/have handshake is processed so the peer can catch up.
    pub fn receive_sync_message(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<(), AutomergeError> {
        #[cfg(test)]
        Self::patch_log_mismatch_if_receive_sync_requested_for_test()?;

        if !message.changes.is_empty() {
            tracing::debug!(
                "[runtime-state] Stripped {} change(s) from client RuntimeStateDoc sync message",
                message.changes.len(),
            );
        }
        // Strip client changes — keep only the sync protocol handshake.
        let filtered = sync::Message {
            heads: message.heads,
            need: message.need,
            have: message.have,
            changes: sync::ChunkList::empty(),
            flags: message.flags,
            version: message.version,
        };
        self.doc.sync().receive_sync_message(peer_state, filtered)?;
        Ok(())
    }

    /// Receive a read-only sync message through the document-owned error boundary.
    ///
    /// Panics are returned to the caller as diagnostic failures. Caller-marked
    /// recoverable Automerge errors rebuild this doc, reset peer sync state,
    /// and retry once.
    pub fn receive_sync_message_recovering(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<(), AutomergeOperationError> {
        let mut context = RuntimeSyncReceiveRecoveryContext {
            doc: self,
            peer_state,
            next_message: Some(message.clone()),
            retry_message: message,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context
                    .doc
                    .receive_sync_message(context.peer_state, message)
            },
            is_recoverable_sync_error,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    /// Receive a sync message accepting policy-validated runtime writes.
    ///
    /// Unlike `receive_sync_message()` which strips peer changes, this accepts
    /// the full message after the caller has established that the peer is
    /// allowed to author RuntimeStateDoc state, such as a `runtime_peer`
    /// updating lifecycle/progress/output/topology for accepted work. Mutable
    /// widget values belong to CommsDoc, not RuntimeStateDoc.
    ///
    /// Returns `true` if the document heads changed (i.e., client sent
    /// new changes, not just a handshake).
    pub fn receive_sync_message_with_changes(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<bool, AutomergeError> {
        #[cfg(test)]
        Self::patch_log_mismatch_if_receive_sync_requested_for_test()?;

        let heads_before = self.doc.get_heads();
        self.doc.sync().receive_sync_message(peer_state, message)?;
        let heads_after = self.doc.get_heads();
        let changed = heads_before != heads_after;
        if changed {
            self.output_order_cache.clear();
        }
        Ok(changed)
    }

    /// Receive a writable sync message through the document-owned error boundary.
    ///
    /// Panics are returned to the caller as diagnostic failures. Caller-marked
    /// recoverable Automerge errors rebuild this doc, reset peer sync state,
    /// and retry once.
    pub fn receive_sync_message_with_changes_recovering(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<bool, AutomergeOperationError> {
        let mut context = RuntimeSyncReceiveRecoveryContext {
            doc: self,
            peer_state,
            next_message: Some(message.clone()),
            retry_message: message,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context
                    .doc
                    .receive_sync_message_with_changes(context.peer_state, message)
            },
            is_recoverable_sync_error,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    /// Apply a sync message and return both the list of applied-change
    /// authors AND a view of `comms` as it would look if only changes
    /// authored by "foreign" actors had been applied.
    ///
    /// This is the key primitive for the runtime agent's echo-suppression:
    /// if a single `RuntimeStateSync` frame coalesces a kernel-authored
    /// echo together with a frontend widget update, diffing the full
    /// post-sync doc against `comms_before` would re-forward the echo to
    /// the kernel. Diffing against `foreign_comms` sees only the
    /// frontend's changes, breaking the amplification loop at
    /// per-change granularity instead of per-frame.
    ///
    /// Implementation: fork at `heads_before`, apply only non-self
    /// changes on the fork, read `comms` from it. The main doc still
    /// absorbs every applied change (including kernel echoes) so local
    /// state stays consistent — only the `foreign_comms` view is filtered.
    ///
    /// `is_foreign(&ActorId) -> bool` decides which applied changes to
    /// include in the fork. Runtime agent passes a closure that returns
    /// `false` for actors starting with `rt:kernel:`.
    pub fn receive_sync_and_foreign_comms<F>(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        is_foreign: F,
    ) -> Result<ForeignSyncView, AutomergeError>
    where
        F: Fn(&ActorId) -> bool,
    {
        #[cfg(test)]
        Self::patch_log_mismatch_if_receive_sync_requested_for_test()?;

        let heads_before = self.doc.get_heads();
        self.doc.sync().receive_sync_message(peer_state, message)?;

        let applied = self.doc.get_changes(&heads_before);
        if applied.is_empty() {
            // Handshake / ack — nothing moved.
            return Ok(ForeignSyncView {
                applied_actors: Vec::new(),
                foreign_comms: None,
            });
        }
        self.output_order_cache.clear();

        let applied_actors: Vec<ActorId> = applied.iter().map(|c| c.actor_id().clone()).collect();

        if !applied_actors.iter().any(&is_foreign) {
            // Every applied change was self-authored (e.g., our own
            // kernel echoes reflected back). No foreign view to build.
            return Ok(ForeignSyncView {
                applied_actors,
                foreign_comms: None,
            });
        }

        // Per-field authorship view: walk each comm's `state` and
        // retain only fields whose current LWW winner was written by a
        // foreign actor. Fields last-written by the kernel (either
        // directly or via the coalesced-echo writer, which carries the
        // kernel's actor ID) are stripped — the runtime agent must not
        // forward them back to the kernel and trigger amplification.
        //
        // `fork_at(heads_before) + apply_changes(foreign_only)` is *not*
        // safe here: when frontend writes are causally after kernel
        // writes (the common case during continuous slider drag), the
        // frontend change's dependencies include kernel-authored
        // parents, and applying the foreign subset alone orphans them.
        // Per-field authorship sidesteps causality entirely.
        let comms_obj = match self.doc.get(ROOT, "comms")? {
            Some((Value::Object(ObjType::Map), obj)) => obj,
            _ => {
                return Ok(ForeignSyncView {
                    applied_actors,
                    foreign_comms: Some(HashMap::new()),
                });
            }
        };

        let mut foreign_comms: HashMap<String, CommDocEntry> = HashMap::new();
        let all = self.read_state().comms;
        for (comm_id, mut entry) in all {
            let Some((_, entry_obj)) = self.doc.get(&comms_obj, comm_id.as_str())? else {
                continue;
            };
            let Some((Value::Object(ObjType::Map), state_obj)) =
                self.doc.get(&entry_obj, "state")?
            else {
                continue;
            };
            let Some(state_map) = entry.state.as_object_mut() else {
                continue;
            };
            let keys: Vec<String> = state_map.keys().cloned().collect();
            for key in keys {
                let authored_by_foreign = match self.doc.get(&state_obj, key.as_str())? {
                    Some((_, ObjId::Id(_, actor, _))) => is_foreign(&actor),
                    _ => false,
                };
                if !authored_by_foreign {
                    state_map.remove(&key);
                }
            }
            if !state_map.is_empty() {
                foreign_comms.insert(comm_id, entry);
            }
        }

        Ok(ForeignSyncView {
            applied_actors,
            foreign_comms: Some(foreign_comms),
        })
    }

    /// Receive a writable sync message and compute a foreign-actor comm view
    /// through the document-owned error boundary.
    ///
    /// Panics are returned to the caller as diagnostic failures. Caller-marked
    /// recoverable Automerge errors rebuild this doc, reset peer sync state,
    /// and retry once.
    pub fn receive_sync_and_foreign_comms_recovering<F>(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        is_foreign: F,
        label: &str,
    ) -> Result<ForeignSyncView, AutomergeOperationError>
    where
        F: Fn(&ActorId) -> bool,
    {
        let mut context = RuntimeForeignSyncReceiveRecoveryContext {
            doc: self,
            peer_state,
            next_message: Some(message.clone()),
            retry_message: message,
            is_foreign,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context.doc.receive_sync_and_foreign_comms(
                    context.peer_state,
                    message,
                    &context.is_foreign,
                )
            },
            is_recoverable_sync_error,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }
}

struct RuntimeSyncRecoveryContext<'a> {
    doc: &'a mut RuntimeStateDoc,
    peer_state: &'a mut sync::State,
}

struct RuntimeBoundedSyncRecoveryContext<'a> {
    doc: &'a mut RuntimeStateDoc,
    peer_state: &'a mut sync::State,
    max_encoded_bytes: usize,
}

struct RuntimeSyncReceiveRecoveryContext<'a> {
    doc: &'a mut RuntimeStateDoc,
    peer_state: &'a mut sync::State,
    next_message: Option<sync::Message>,
    retry_message: sync::Message,
}

struct RuntimeForeignSyncReceiveRecoveryContext<'a, F> {
    doc: &'a mut RuntimeStateDoc,
    peer_state: &'a mut sync::State,
    next_message: Option<sync::Message>,
    retry_message: sync::Message,
    is_foreign: F,
}

/// Scaffold the `project_context` map in a fresh doc.
///
/// All scalar fields start empty; `state` starts at `"pending"`. The
/// daemon is the sole writer in production; clients rely on sync to
/// populate the real values.
#[cfg(test)]
fn scaffold_project_context(doc: &mut AutoCommit) -> Result<(), RuntimeStateError> {
    let pc = doc.put_object(&ROOT, "project_context", ObjType::Map)?;
    doc.put(&pc, "state", "pending")?;
    doc.put(&pc, "observed_at", "")?;
    doc.put(&pc, "kind", "")?;
    doc.put(&pc, "absolute_path", "")?;
    doc.put(&pc, "relative_to_notebook", "")?;
    doc.put(&pc, "unreadable_path", "")?;
    doc.put(&pc, "unreadable_reason", "")?;
    let parsed = doc.put_object(&pc, "parsed", ObjType::Map)?;
    doc.put_object(&parsed, "dependencies", ObjType::List)?;
    doc.put_object(&parsed, "dev_dependencies", ObjType::List)?;
    doc.put(&parsed, "requires_python", ScalarValue::Null)?;
    doc.put(&parsed, "prerelease", ScalarValue::Null)?;
    doc.put(&parsed, "extras", "")?;
    Ok(())
}

#[cfg(test)]
fn scaffold_runtime_state_schema(doc: &mut AutoCommit) -> Result<(), RuntimeStateError> {
    doc.put(
        &ROOT,
        "schema_version",
        ScalarValue::Uint(RUNTIME_STATE_SCHEMA_VERSION),
    )?;

    let kernel = doc.put_object(&ROOT, "kernel", ObjType::Map)?;
    doc.put(&kernel, "name", "")?;
    doc.put(&kernel, "language", "")?;
    doc.put(&kernel, "env_source", "")?;
    doc.put(&kernel, "runtime_agent_id", "")?;
    doc.put(&kernel, "lifecycle", "NotStarted")?;
    doc.put(&kernel, "activity", "")?;
    doc.put(&kernel, "error_reason", "")?;
    doc.put(&kernel, "error_details", "")?;

    let queue = doc.put_object(&ROOT, "queue", ObjType::Map)?;
    doc.put(&queue, "executing_execution_id", ScalarValue::Null)?;
    doc.put_object(&queue, "queued_execution_ids", ObjType::List)?;

    doc.put_object(&ROOT, "executions", ObjType::Map)?;

    let env = doc.put_object(&ROOT, "env", ObjType::Map)?;
    doc.put(&env, "in_sync", true)?;
    doc.put_object(&env, "added", ObjType::List)?;
    doc.put_object(&env, "removed", ObjType::List)?;
    doc.put(&env, "channels_changed", false)?;
    doc.put(&env, "deno_changed", false)?;
    doc.put_object(&env, "prewarmed_packages", ObjType::List)?;
    doc.put(&env, "progress", ScalarValue::Null)?;

    let trust = doc.put_object(&ROOT, "trust", ObjType::Map)?;
    doc.put(&trust, "status", "no_dependencies")?;
    doc.put(&trust, "needs_approval", false)?;
    doc.put_object(&trust, "approved_uv_dependencies", ObjType::List)?;
    doc.put_object(&trust, "approved_conda_dependencies", ObjType::List)?;
    doc.put_object(&trust, "approved_conda_channels", ObjType::List)?;
    doc.put_object(&trust, "approved_pixi_dependencies", ObjType::List)?;
    doc.put_object(&trust, "approved_pixi_pypi_dependencies", ObjType::List)?;
    doc.put_object(&trust, "approved_pixi_channels", ObjType::List)?;

    scaffold_project_context(doc)?;

    doc.put_object(&ROOT, "comms", ObjType::Map)?;
    doc.put_object(&ROOT, "display_index", ObjType::Map)?;
    doc.put(&ROOT, "last_saved", ScalarValue::Null)?;
    doc.put(&ROOT, "path", ScalarValue::Null)?;
    Ok(())
}

fn synthesize_queued_entries_from_executions(
    queue_state: &QueueState,
    executions: &HashMap<String, ExecutionState>,
) -> Vec<QueueEntry> {
    let executing_execution_id = queue_state
        .executing
        .as_ref()
        .map(|entry| entry.execution_id.as_str());
    let mut known_execution_ids: HashSet<&str> = queue_state
        .queued
        .iter()
        .map(|entry| entry.execution_id.as_str())
        .collect();
    if let Some(eid) = executing_execution_id {
        known_execution_ids.insert(eid);
    }

    let mut queued_from_executions: Vec<_> = executions
        .iter()
        .filter(|(execution_id, exec)| {
            exec.status == "queued" && !known_execution_ids.contains(execution_id.as_str())
        })
        .collect();
    queued_from_executions.sort_by(|(a_id, a), (b_id, b)| {
        match (a.seq, b.seq) {
            (Some(a_seq), Some(b_seq)) if a_seq != b_seq => a_seq.cmp(&b_seq),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        }
        .then_with(|| a_id.cmp(b_id))
    });

    queued_from_executions
        .into_iter()
        .map(|(execution_id, _exec)| QueueEntry {
            execution_id: execution_id.clone(),
        })
        .collect()
}

/// Result of [`RuntimeStateDoc::receive_sync_and_foreign_comms`].
#[derive(Debug)]
pub struct ForeignSyncView {
    /// All actors that authored changes applied by the sync message.
    /// Empty when the message was a handshake / ack.
    pub applied_actors: Vec<ActorId>,
    /// `comms` as it would appear if only foreign-authored applied
    /// changes were in the doc. `None` when the message applied no
    /// foreign changes (handshake, or every change was self-authored).
    pub foreign_comms: Option<HashMap<String, CommDocEntry>>,
}

// ── Output diff utility ─────────────────────────────────────────────

/// Diff execution outputs between a previous snapshot and the current state.
///
/// Returns `(changed_execution_ids, new_snapshot)` where:
/// - `changed_execution_ids` lists executions whose outputs changed
/// - `new_snapshot` is the updated prev_execution_outputs for the next diff
///
/// Kept as a small helper for consumers that need execution-level invalidation.
/// Notebook UIs should resolve cells through their NotebookDoc execution_id
/// pointers instead of relying on RuntimeStateDoc to report changed cell ids.
pub fn diff_execution_outputs(
    prev: &HashMap<String, Vec<serde_json::Value>>,
    current_executions: &HashMap<String, ExecutionState>,
) -> (Vec<String>, HashMap<String, Vec<serde_json::Value>>) {
    let mut changed_execution_ids = Vec::new();

    for (eid, exec) in current_executions {
        let outputs_changed = match prev.get(eid) {
            None => !exec.outputs.is_empty(),
            Some(prev_outputs) => prev_outputs != &exec.outputs,
        };
        if outputs_changed {
            changed_execution_ids.push(eid.clone());
        }
    }

    // Keep ALL executions (even with empty outputs) so the next diff
    // correctly detects transitions from [] → [hash].
    let new_snapshot: HashMap<String, Vec<serde_json::Value>> = current_executions
        .iter()
        .map(|(eid, e)| (eid.clone(), e.outputs.clone()))
        .collect();

    (changed_execution_ids, new_snapshot)
}

/// Extract the `output_id` from an output manifest, if present.
///
/// Outputs emitted by the daemon carry a `"output_id"` string field (UUIDv4)
/// for stable addressable identity. Older outputs or synthesized payloads
/// without one (or with a literal empty string) return `None` - the
/// per-output diff and the JS projection both treat missing and empty
/// as "no identity", and collapsing every empty-id output onto the same
/// key would break the `changed/removed` channel.
pub fn extract_output_id(output: &serde_json::Value) -> Option<String> {
    output
        .get("output_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Result of a per-output-id diff between two execution snapshots.
///
/// Each changed entry carries the full (un-narrowed) manifest so callers
/// can emit it directly without re-reading the state doc.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OutputIdDiff {
    /// Added or modified outputs, paired `(output_id, manifest)`. Manifest
    /// is the raw on-the-wire shape from `ExecutionState::outputs`; callers
    /// apply MIME narrowing + ContentRef resolution before handing to the UI.
    pub changed: Vec<(String, serde_json::Value)>,
    /// Output IDs that were removed (present in `prev`, absent now).
    pub removed_output_ids: Vec<String>,
}

/// Diff execution outputs by `output_id`.
///
/// Walks every current execution's output list, extracts per-output manifests
/// keyed by `output_id`, and compares them to the previous snapshot. Returns
/// `(diff, new_snapshot)`. The diff carries `(id, manifest)` pairs for
/// changed entries so callers can emit the manifest directly without a
/// second lookup against the state doc. The new snapshot is the updated
/// `output_id -> manifest` map the caller should persist for the next diff.
///
/// Outputs without an `output_id` are skipped. The daemon invariant is that
/// `create_manifest` always stamps one; if an un-stamped manifest reaches
/// this function, that is a bug upstream.
pub fn diff_output_ids(
    prev: &HashMap<String, serde_json::Value>,
    current_executions: &HashMap<String, ExecutionState>,
) -> (OutputIdDiff, HashMap<String, serde_json::Value>) {
    let mut new_snapshot: HashMap<String, serde_json::Value> = HashMap::new();
    let mut changed: Vec<(String, serde_json::Value)> = Vec::new();

    for exec in current_executions.values() {
        for output in &exec.outputs {
            let Some(oid) = extract_output_id(output) else {
                continue;
            };
            let is_changed = match prev.get(&oid) {
                None => true,
                Some(prev_output) => prev_output != output,
            };
            if is_changed {
                changed.push((oid.clone(), output.clone()));
            }
            new_snapshot.insert(oid, output.clone());
        }
    }

    let removed: Vec<String> = prev
        .keys()
        .filter(|k| !new_snapshot.contains_key(k.as_str()))
        .cloned()
        .collect();

    (
        OutputIdDiff {
            changed,
            removed_output_ids: removed,
        },
        new_snapshot,
    )
}

/// Diff execution outputs by `output_id`, updating the caller-owned snapshot.
///
/// This is the hot-path variant used by WASM runtime-state sync. It still
/// walks the current flat outputs, but it only clones manifests that are new
/// or changed. Unchanged entries remain in `prev` in place, avoiding a full
/// `output_id -> manifest` snapshot rebuild on every sync frame.
pub fn diff_output_ids_in_place(
    prev: &mut HashMap<String, serde_json::Value>,
    current_executions: &HashMap<String, ExecutionState>,
) -> OutputIdDiff {
    let mut seen: HashSet<String> = HashSet::new();
    let mut changed: Vec<(String, serde_json::Value)> = Vec::new();

    for exec in current_executions.values() {
        for output in &exec.outputs {
            let Some(oid) = extract_output_id(output) else {
                continue;
            };
            seen.insert(oid.clone());
            let is_changed = match prev.get(&oid) {
                None => true,
                Some(prev_output) => prev_output != output,
            };
            if is_changed {
                changed.push((oid.clone(), output.clone()));
                prev.insert(oid, output.clone());
            }
        }
    }

    let mut removed: Vec<String> = Vec::new();
    prev.retain(|oid, _| {
        let keep = seen.contains(oid);
        if !keep {
            removed.push(oid.clone());
        }
        keep
    });

    OutputIdDiff {
        changed,
        removed_output_ids: removed,
    }
}

/// Collect the ordered list of `output_id`s for a single execution.
///
/// Returns the output_ids in order. Outputs without an `output_id` are skipped
/// (they should not exist on the daemon write path, but we tolerate them).
pub fn output_ids_for_execution(exec: &ExecutionState) -> Vec<String> {
    exec.outputs.iter().filter_map(extract_output_id).collect()
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a stream output manifest with a blob ContentRef for tests.
    fn test_stream(blob: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "stream",
            "output_id": format!("stream-{blob}"),
            "name": "stdout",
            "text": {"blob": blob, "size": blob.len()}
        })
    }

    /// Create a stream output manifest with an inline ContentRef for tests.
    fn test_stream_inline(text: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "stream",
            "output_id": format!("stream-inline-{text}"),
            "name": "stdout",
            "text": {"inline": text}
        })
    }

    /// Create a display_data output manifest for tests.
    fn test_display(blob: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "display_data",
            "output_id": format!("display-{blob}"),
            "data": {"text/plain": {"blob": blob, "size": blob.len()}}
        })
    }

    fn actor_label_from_id(actor: &ActorId) -> String {
        std::str::from_utf8(actor.to_bytes())
            .map(|s| s.to_string())
            .unwrap_or_else(|_| actor.to_hex_string())
    }

    fn workstation_attachment_fixture() -> WorkstationAttachmentState {
        WorkstationAttachmentState {
            workstation_id: "ws-lab2".to_string(),
            display_name: "Lab 2".to_string(),
            provider: "local_daemon".to_string(),
            default_environment_label: "Current Python".to_string(),
            environment_policy: "current_python".to_string(),
            status: "ready".to_string(),
            status_message: Some("kernel attached".to_string()),
            cpu_count: Some(8),
            memory_bytes: Some(32 * 1024 * 1024 * 1024),
            working_directory: Some("/home/ubuntu/notebooks".to_string()),
            updated_at: Some("2026-06-07T21:00:00Z".to_string()),
            runtime_session_id: Some("job-123".to_string()),
        }
    }

    fn change_hashes_for_actor(
        doc: &mut AutoCommit,
        actor_label: &str,
    ) -> Vec<automerge::ChangeHash> {
        doc.get_changes(&[])
            .into_iter()
            .filter(|change| actor_label_from_id(change.actor_id()) == actor_label)
            .map(|change| change.hash())
            .collect()
    }

    fn sync_runtime_docs(
        a: &mut RuntimeStateDoc,
        a_state: &mut sync::State,
        b: &mut RuntimeStateDoc,
        b_state: &mut sync::State,
    ) {
        for _ in 0..20 {
            let a_msg = a.generate_sync_message(a_state);
            if let Some(message) = a_msg.clone() {
                b.receive_sync_message_with_changes(b_state, message)
                    .expect("b receive runtime sync");
            }

            let b_msg = b.generate_sync_message(b_state);
            if let Some(message) = b_msg.clone() {
                a.receive_sync_message_with_changes(a_state, message)
                    .expect("a receive runtime sync");
            }

            if a_msg.is_none() && b_msg.is_none() {
                break;
            }
        }
    }

    #[test]
    fn test_new_doc_has_default_state() {
        let doc = RuntimeStateDoc::new();
        let state = doc.read_state();
        // Note: new() scaffolds trust.status as "no_dependencies" which matches
        // TrustRuntimeState::default() (empty string), so we compare fields individually.
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::NotStarted);
        assert_eq!(state.kernel.name, "");
        assert_eq!(state.kernel.language, "");
        assert_eq!(state.kernel.env_source, "");
        assert!(state.queue.executing.is_none());
        assert!(state.queue.queued.is_empty());
        assert!(state.env.in_sync);
        assert!(state.env.added.is_empty());
        assert!(state.env.removed.is_empty());
        assert!(!state.env.channels_changed);
        assert!(!state.env.deno_changed);
        assert_eq!(state.trust.status, "no_dependencies");
        assert!(!state.trust.needs_approval);
        assert!(state.last_saved.is_none());
    }

    #[test]
    fn schema_seed_doc_returns_scaffold_errors() {
        let err = RuntimeStateDoc::generated_schema_seed_doc_with(|_| {
            Err(RuntimeStateError::MissingScaffold("injected"))
        })
        .unwrap_err();

        assert!(matches!(
            err,
            RuntimeStateError::MissingScaffold("injected")
        ));
    }

    #[test]
    fn runtime_state_genesis_artifact_matches_scaffold() {
        let mut generated = RuntimeStateDoc::generated_schema_seed_doc().unwrap();
        let mut frozen = RuntimeStateDoc::schema_seed_doc().unwrap();

        assert_eq!(
            change_hashes_for_actor(&mut generated, RUNTIME_STATE_SCHEMA_SEED_ACTOR),
            change_hashes_for_actor(&mut frozen, RUNTIME_STATE_SCHEMA_SEED_ACTOR)
        );
        assert_eq!(
            RuntimeStateDoc::from_doc(generated).read_state(),
            RuntimeStateDoc::from_doc(frozen).read_state()
        );
    }

    #[test]
    #[ignore]
    fn write_runtime_state_genesis_artifact() {
        let Some(path) = std::env::var_os("RUNTIME_STATE_GENESIS_OUT") else {
            return;
        };
        let mut generated = RuntimeStateDoc::generated_schema_seed_doc().unwrap();
        std::fs::write(path, generated.save()).unwrap();
    }

    #[test]
    fn schema_seed_doc_loads_frozen_genesis_artifact() {
        let mut loaded = RuntimeStateDoc::schema_seed_doc().unwrap();
        assert_eq!(
            change_hashes_for_actor(&mut loaded, RUNTIME_STATE_SCHEMA_SEED_ACTOR).len(),
            1
        );
        assert_eq!(
            RuntimeStateDoc::from_doc(loaded).read_state(),
            RuntimeStateDoc::new_empty().read_state()
        );
    }

    #[test]
    fn test_set_lifecycle() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))
            .unwrap();
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy)
        );

        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );
    }

    #[test]
    fn test_set_kernel_info() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_kernel_info("charming-toucan", "python", "uv:prewarmed")
            .unwrap();
        let state = doc.read_state();
        assert_eq!(state.kernel.name, "charming-toucan");
        assert_eq!(state.kernel.language, "python");
        assert_eq!(state.kernel.env_source, "uv:prewarmed");
    }

    #[test]
    fn test_set_queue() {
        let mut doc = RuntimeStateDoc::new();
        let exec = QueueEntry {
            execution_id: "exec-1".to_string(),
        };
        let queued = vec![
            QueueEntry {
                execution_id: "exec-2".to_string(),
            },
            QueueEntry {
                execution_id: "exec-3".to_string(),
            },
        ];
        doc.set_queue(Some(&exec), &queued).unwrap();

        let state = doc.read_state();
        assert_eq!(
            state.queue.executing.as_ref().unwrap().execution_id,
            "exec-1"
        );
        assert_eq!(state.queue.queued.len(), 2);
        assert_eq!(state.queue.queued[0].execution_id, "exec-2");
        assert_eq!(state.queue.queued[1].execution_id, "exec-3");
    }

    #[test]
    fn test_set_env_sync() {
        let mut doc = RuntimeStateDoc::new();
        let added = vec!["numpy".to_string(), "pandas".to_string()];
        let removed = vec!["scipy".to_string()];
        doc.set_env_sync(false, &added, &removed, true, false)
            .unwrap();

        let state = doc.read_state();
        assert!(!state.env.in_sync);
        assert_eq!(state.env.added, added);
        assert_eq!(state.env.removed, removed);
        assert!(state.env.channels_changed);
        assert!(!state.env.deno_changed);
    }

    #[test]
    fn test_env_progress_defaults_to_none() {
        let doc = RuntimeStateDoc::new();
        assert_eq!(doc.read_state().env.progress, None);
    }

    #[test]
    fn test_set_env_progress_round_trips_flattened_event() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_env_progress(
            "pixi",
            &serde_json::json!({
                "phase": "download_progress",
                "completed": 2,
                "total": 5,
                "current_package": "polars",
                "bytes_downloaded": 1024,
                "bytes_total": 4096,
                "bytes_per_second": 512,
            }),
        )
        .unwrap();

        assert_eq!(
            doc.read_state().env.progress,
            Some(serde_json::json!({
                "env_type": "pixi",
                "phase": "download_progress",
                "completed": 2,
                "total": 5,
                "current_package": "polars",
                "bytes_downloaded": 1024,
                "bytes_total": 4096,
                "bytes_per_second": 512,
            }))
        );
    }

    #[test]
    fn test_set_env_progress_round_trips_project_preparing() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_env_progress(
            "uv",
            &serde_json::json!({
                "phase": "project_preparing",
                "source": "uv:pyproject",
                "project_path": "/tmp/project/pyproject.toml",
            }),
        )
        .unwrap();

        assert_eq!(
            doc.read_state().env.progress,
            Some(serde_json::json!({
                "env_type": "uv",
                "phase": "project_preparing",
                "source": "uv:pyproject",
                "project_path": "/tmp/project/pyproject.toml",
            }))
        );
    }

    #[test]
    fn test_clear_env_progress_returns_to_none() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_env_progress("uv", &serde_json::json!({ "phase": "offline_hit" }))
            .unwrap();
        assert!(doc.read_state().env.progress.is_some());

        doc.clear_env_progress().unwrap();
        assert_eq!(doc.read_state().env.progress, None);
    }

    #[test]
    fn test_set_env_progress_rejects_non_object_phase() {
        let mut doc = RuntimeStateDoc::new();
        let err = doc
            .set_env_progress("uv", &serde_json::json!("offline_hit"))
            .unwrap_err();
        assert!(matches!(err, RuntimeStateError::InvalidProgressShape));
        assert_eq!(doc.read_state().env.progress, None);
    }

    #[test]
    fn test_set_last_saved() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_last_saved(Some("2025-01-15T12:00:00Z")).unwrap();
        assert_eq!(
            doc.read_state().last_saved,
            Some("2025-01-15T12:00:00Z".to_string())
        );

        doc.set_last_saved(None).unwrap();
        assert_eq!(doc.read_state().last_saved, None);
    }

    #[test]
    fn last_seen_defaults_to_none_on_a_fresh_doc() {
        // Not part of the frozen genesis scaffold: a fresh doc has no
        // last_seen, so viewers/the watchdog see "no peer has reported in".
        let doc = RuntimeStateDoc::new();
        assert_eq!(doc.read_state().kernel.last_seen, None);
    }

    #[test]
    fn set_last_seen_roundtrips_and_clears_to_none() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_last_seen(Some("2026-06-05T12:00:00Z")).unwrap();
        assert_eq!(
            doc.read_state().kernel.last_seen.as_deref(),
            Some("2026-06-05T12:00:00Z")
        );

        // A later observation moves the timestamp forward.
        doc.set_last_seen(Some("2026-06-05T12:00:05Z")).unwrap();
        assert_eq!(
            doc.read_state().kernel.last_seen.as_deref(),
            Some("2026-06-05T12:00:05Z")
        );

        // Clearing reads back as None (CRDT Null, not an empty string).
        doc.set_last_seen(None).unwrap();
        assert_eq!(doc.read_state().kernel.last_seen, None);
    }

    #[test]
    fn set_last_seen_is_idempotent_no_head_churn() {
        // The watchdog/peer stamps last_seen frequently; re-stamping the same
        // value must not advance the doc heads (no spurious sync rounds).
        let mut doc = RuntimeStateDoc::new();
        doc.set_last_seen(Some("2026-06-05T12:00:00Z")).unwrap();
        let heads_before = doc.doc_mut().get_heads();
        doc.set_last_seen(Some("2026-06-05T12:00:00Z")).unwrap();
        let heads_after = doc.doc_mut().get_heads();
        assert_eq!(heads_before, heads_after, "re-stamp must not change heads");
    }

    #[test]
    fn last_seen_is_runtime_peer_writable_but_blocked_for_editor() {
        // last_seen lives under `state.kernel`, so the existing kernel-ownership
        // policy governs it: a runtime_peer may write it, an editor/owner sync
        // may not (it is part of the runtime-authored kernel snapshot). This
        // pins that a liveness stamp can't be forged over an editor sync.
        use crate::policy::{
            runtime_state_policy_snapshot, validate_runtime_state_sync_scope,
            RuntimeStateWriteScope,
        };
        let before = RuntimeStateDoc::new();
        let mut after = RuntimeStateDoc::new();
        after.set_last_seen(Some("2026-06-05T12:00:00Z")).unwrap();

        let snap_before = runtime_state_policy_snapshot(&before);
        let snap_after = runtime_state_policy_snapshot(&after);

        // runtime_peer is allowed to stamp liveness.
        assert!(validate_runtime_state_sync_scope(
            &snap_before,
            &snap_after,
            RuntimeStateWriteScope::RuntimePeer,
        )
        .is_ok());

        // editor sync may not touch the kernel snapshot (incl. last_seen).
        assert!(validate_runtime_state_sync_scope(
            &snap_before,
            &snap_after,
            RuntimeStateWriteScope::Editor,
        )
        .is_err());
    }

    #[test]
    fn test_set_runtime_state_doc_id() {
        let mut doc = RuntimeStateDoc::new();
        assert_eq!(doc.runtime_state_doc_id(), None);

        doc.set_runtime_state_doc_id(Some("runtime:nb-1")).unwrap();
        assert_eq!(doc.runtime_state_doc_id().as_deref(), Some("runtime:nb-1"));

        let state = doc.read_state();
        assert_eq!(state.runtime_state_doc_id.as_deref(), Some("runtime:nb-1"));

        doc.set_runtime_state_doc_id(None).unwrap();
        let state = doc.read_state();
        assert_eq!(state.runtime_state_doc_id, None);
    }

    #[test]
    fn workstation_attachment_defaults_to_none_on_a_fresh_doc() {
        let doc = RuntimeStateDoc::new();
        assert_eq!(doc.workstation_attachment(), None);
        assert_eq!(doc.read_state().workstation, None);
    }

    #[test]
    fn set_workstation_attachment_roundtrips_and_clears() {
        let mut doc = RuntimeStateDoc::new();
        let attachment = workstation_attachment_fixture();

        doc.set_workstation_attachment(Some(&attachment)).unwrap();
        assert_eq!(doc.workstation_attachment(), Some(attachment.clone()));
        assert_eq!(doc.read_state().workstation, Some(attachment));

        doc.set_workstation_attachment(None).unwrap();
        assert_eq!(doc.workstation_attachment(), None);
        assert_eq!(doc.read_state().workstation, None);
    }

    #[test]
    fn set_workstation_attachment_is_idempotent_no_head_churn() {
        let mut doc = RuntimeStateDoc::new();
        let attachment = workstation_attachment_fixture();
        doc.set_workstation_attachment(Some(&attachment)).unwrap();
        let heads_before = doc.doc_mut().get_heads();
        doc.set_workstation_attachment(Some(&attachment)).unwrap();
        let heads_after = doc.doc_mut().get_heads();
        assert_eq!(
            heads_before, heads_after,
            "re-publishing the same workstation attachment must not change heads"
        );
    }

    #[test]
    fn test_set_trust() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_trust("untrusted", true).unwrap();
        let state = doc.read_state();
        assert_eq!(state.trust.status, "untrusted");
        assert!(state.trust.needs_approval);

        doc.set_trust_state(&TrustRuntimeState {
            status: "trusted".to_string(),
            needs_approval: false,
            approved_uv_dependencies: vec!["pandas".to_string()],
            approved_conda_dependencies: vec!["numpy".to_string()],
            approved_conda_channels: vec!["conda-forge".to_string()],
            approved_pixi_dependencies: vec!["polars".to_string()],
            approved_pixi_pypi_dependencies: vec!["plotly".to_string()],
            approved_pixi_channels: vec!["bioconda".to_string()],
        })
        .unwrap();
        let state = doc.read_state();
        assert_eq!(state.trust.status, "trusted");
        assert!(!state.trust.needs_approval);
        assert_eq!(state.trust.approved_uv_dependencies, vec!["pandas"]);
        assert_eq!(state.trust.approved_conda_dependencies, vec!["numpy"]);
        assert_eq!(state.trust.approved_conda_channels, vec!["conda-forge"]);
        assert_eq!(state.trust.approved_pixi_dependencies, vec!["polars"]);
        assert_eq!(state.trust.approved_pixi_pypi_dependencies, vec!["plotly"]);
        assert_eq!(state.trust.approved_pixi_channels, vec!["bioconda"]);
    }

    #[test]
    fn test_lifecycle_transitions_through_starting_phases() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Resolving).unwrap();
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Resolving
        );

        doc.set_lifecycle(&RuntimeLifecycle::Launching).unwrap();
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Launching
        );

        // Dedup: same lifecycle is a no-op at the setter level. The
        // doc.rs setter writes unconditionally, but set_activity skips.
        doc.set_lifecycle(&RuntimeLifecycle::Launching).unwrap();
    }

    #[test]
    fn test_lifecycle_clears_activity_on_leaving_running() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))
            .unwrap();
        doc.set_lifecycle(&RuntimeLifecycle::Shutdown).unwrap();
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Shutdown
        );
        // Underlying activity key is cleared to "".
        let kernel = doc.get_map("kernel").unwrap();
        assert_eq!(doc.read_str(&kernel, "activity"), "");
    }

    #[test]
    fn activity_republish_heals_stale_shutdown_after_wake_on_execute() {
        let mut room =
            RuntimeStateDoc::try_new_with_actor("owner@example.com/room-host:before").unwrap();
        room.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        room.set_kernel_info("python", "python", "uv:current_python")
            .unwrap();
        room.set_runtime_agent_id("owner@example.com/runtime:kernel:old")
            .unwrap();

        let mut viewer = RuntimeStateDoc::try_new_with_actor("viewer@example.com/app:web").unwrap();
        let mut room_viewer_state = sync::State::new();
        let mut viewer_room_state = sync::State::new();
        sync_runtime_docs(
            &mut room,
            &mut room_viewer_state,
            &mut viewer,
            &mut viewer_room_state,
        );

        let checkpoint_before_teardown = room.doc_mut().save();
        for second in 0..30 {
            room.set_last_seen(Some(&format!("2026-07-09T21:00:{second:02}Z")))
                .unwrap();
        }
        room.set_queue(None, &[]).unwrap();
        room.set_lifecycle(&RuntimeLifecycle::Shutdown).unwrap();
        sync_runtime_docs(
            &mut room,
            &mut room_viewer_state,
            &mut viewer,
            &mut viewer_room_state,
        );
        assert_eq!(
            viewer.read_state().kernel.lifecycle,
            RuntimeLifecycle::Shutdown
        );

        let rehydrated = AutoCommit::load(&checkpoint_before_teardown).unwrap();
        let mut room = RuntimeStateDoc::from_doc(rehydrated);
        room.set_actor("owner@example.com/room-host:after");
        let mut room_viewer_state = sync::State::new();
        let mut viewer_room_state = sync::State::new();

        let exec_id = "exec-after-wake";
        room.create_execution_with_source_provenance(
            exec_id,
            "print('hi')",
            1,
            Some("owner@example.com/app:web"),
            Some("cell-1"),
        )
        .unwrap();
        room.set_queue(
            None,
            &[QueueEntry {
                execution_id: exec_id.to_string(),
            }],
        )
        .unwrap();

        let mut agent =
            RuntimeStateDoc::try_new_with_actor("owner@example.com/agent:runt:new").unwrap();
        agent.set_last_seen(Some("2026-07-09T22:00:00Z")).unwrap();
        let mut room_agent_state = sync::State::new();
        let mut agent_room_state = sync::State::new();
        sync_runtime_docs(
            &mut room,
            &mut room_agent_state,
            &mut agent,
            &mut agent_room_state,
        );

        agent.set_lifecycle(&RuntimeLifecycle::Launching).unwrap();
        agent
            .set_kernel_info("python", "python", "uv:current_python")
            .unwrap();
        agent
            .set_runtime_agent_id("owner@example.com/runtime:kernel:new")
            .unwrap();
        agent
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        agent.set_execution_running(exec_id).unwrap();
        agent
            .set_queue(
                Some(&QueueEntry {
                    execution_id: exec_id.to_string(),
                }),
                &[],
            )
            .unwrap();
        agent.set_activity(KernelActivity::Busy).unwrap();
        agent.set_execution_done(exec_id, true).unwrap();
        agent.set_queue(None, &[]).unwrap();
        agent.set_activity(KernelActivity::Idle).unwrap();

        sync_runtime_docs(
            &mut room,
            &mut room_agent_state,
            &mut agent,
            &mut agent_room_state,
        );
        sync_runtime_docs(
            &mut room,
            &mut room_viewer_state,
            &mut viewer,
            &mut viewer_room_state,
        );

        let viewer_state = viewer.read_state();
        assert_eq!(
            viewer_state.kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );
        assert_eq!(
            viewer_state
                .executions
                .get(exec_id)
                .map(|execution| execution.status.as_str()),
            Some("done")
        );
    }

    #[test]
    fn lifecycle_conflict_with_error_keeps_launch_failure_loud() {
        let mut base = RuntimeStateDoc::new();
        let mut failed = base.fork_with_actor("owner@example.com/runtime:kernel:failed");
        let mut running = base.fork_with_actor("owner@example.com/runtime:kernel:running");

        failed
            .set_lifecycle_with_error_details(
                &RuntimeLifecycle::Error,
                None,
                Some("Failed to launch kernel: missing ipykernel"),
            )
            .unwrap();
        running
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();

        base.merge(&mut running).unwrap();
        base.merge(&mut failed).unwrap();

        let state = base.read_state();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(
            state.kernel.error_details.as_deref(),
            Some("Failed to launch kernel: missing ipykernel")
        );
    }

    #[test]
    fn test_dedup_skips_redundant_writes() {
        let mut doc = RuntimeStateDoc::new();

        // set_activity is the documented no-op path when the value is unchanged.
        doc.set_activity(KernelActivity::Busy).unwrap();
        doc.set_activity(KernelActivity::Busy).unwrap();

        // Same for kernel info
        doc.set_kernel_info("k", "python", "uv:prewarmed").unwrap();
        doc.set_kernel_info("k", "python", "uv:prewarmed").unwrap();

        // Same for queue
        let exec = QueueEntry {
            execution_id: "e1".to_string(),
        };
        let q = vec![QueueEntry {
            execution_id: "e2".to_string(),
        }];
        doc.set_queue(Some(&exec), &q).unwrap();
        doc.set_queue(Some(&exec), &q).unwrap();

        doc.set_env_sync(false, &[], &[], false, false).unwrap();
        doc.set_env_sync(false, &[], &[], false, false).unwrap();

        doc.set_trust("trusted", false).unwrap();
        doc.set_trust("trusted", false).unwrap();

        doc.set_last_saved(Some("2025-01-15T12:00:00Z")).unwrap();
        doc.set_last_saved(Some("2025-01-15T12:00:00Z")).unwrap();
    }

    #[test]
    fn new_empty_uses_canonical_schema_seed() {
        let daemon = RuntimeStateDoc::new();
        let client = RuntimeStateDoc::new_empty();

        for key in [
            "kernel",
            "queue",
            "executions",
            "env",
            "trust",
            "project_context",
            "comms",
            "display_index",
        ] {
            assert_eq!(
                daemon.doc().get_all(ROOT, key).unwrap_or_default().len(),
                1,
                "daemon should have exactly one {key} root object"
            );
            assert_eq!(
                client.doc().get_all(ROOT, key).unwrap_or_default().len(),
                1,
                "client should have exactly one {key} root object"
            );
        }

        let mut seeded_daemon = RuntimeStateDoc::new();
        let mut seeded_client = RuntimeStateDoc::new_empty();
        assert_eq!(
            seeded_daemon.get_heads(),
            seeded_client.get_heads(),
            "daemon and client should start from the same seed history"
        );
    }

    #[test]
    fn test_sync_between_two_docs() {
        let mut daemon_doc = RuntimeStateDoc::new();
        daemon_doc
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))
            .unwrap();
        daemon_doc
            .set_kernel_info("charming-toucan", "python", "uv:prewarmed")
            .unwrap();
        daemon_doc
            .set_queue(
                Some(&QueueEntry {
                    execution_id: "exec-1".to_string(),
                }),
                &[
                    QueueEntry {
                        execution_id: "exec-2".to_string(),
                    },
                    QueueEntry {
                        execution_id: "exec-3".to_string(),
                    },
                ],
            )
            .unwrap();
        daemon_doc
            .set_env_sync(
                false,
                &["numpy".to_string()],
                &["scipy".to_string()],
                true,
                false,
            )
            .unwrap();
        daemon_doc.set_trust("untrusted", true).unwrap();
        daemon_doc
            .set_last_saved(Some("2025-01-15T12:00:00Z"))
            .unwrap();

        // Client uses new_empty() — canonical schema seed, random actor,
        // and no client-authored state writes.
        let mut client_doc = RuntimeStateDoc::new_empty();
        let mut daemon_sync = sync::State::new();
        let mut client_sync = sync::State::new();

        // Run sync rounds until converged.
        for _ in 0..10 {
            if let Some(msg) = daemon_doc.generate_sync_message(&mut daemon_sync) {
                client_doc
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut client_sync, msg)
                    .expect("client receive");
            }
            if let Some(msg) = client_doc
                .doc_mut()
                .sync()
                .generate_sync_message(&mut client_sync)
            {
                daemon_doc
                    .receive_sync_message(&mut daemon_sync, msg)
                    .expect("daemon receive");
            }
        }

        let daemon_state = daemon_doc.read_state();
        let client_state = client_doc.read_state();
        assert_eq!(daemon_state, client_state);
        assert_eq!(
            client_state.kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy)
        );
        assert_eq!(client_state.kernel.name, "charming-toucan");
        assert_eq!(
            client_state.queue.executing.as_ref().unwrap().execution_id,
            "exec-1"
        );
        assert_eq!(client_state.queue.queued.len(), 2);
        assert!(!client_state.env.in_sync);
        assert_eq!(client_state.trust.status, "untrusted");
        assert!(client_state.trust.needs_approval);
        assert_eq!(
            client_state.last_saved,
            Some("2025-01-15T12:00:00Z".to_string()),
        );
    }

    #[test]
    fn dropped_runtime_sync_message_requires_peer_state_reset_before_recovery() {
        let mut daemon_doc = RuntimeStateDoc::new();
        daemon_doc
            .set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))
            .unwrap();

        let mut client_doc = RuntimeStateDoc::new_empty();
        let mut daemon_sync = sync::State::new();
        let mut client_sync = sync::State::new();

        let dropped = daemon_doc
            .generate_sync_message(&mut daemon_sync)
            .expect("daemon should generate initial runtime sync");
        drop(dropped);

        // This models a reliable peer-egress lane dropping an already-generated
        // RuntimeStateSync frame. The sync::State was advanced before transport
        // delivery, so the old state cannot be reused as though nothing happened.
        daemon_doc
            .set_kernel_info("python3", "python", "uv:project")
            .unwrap();

        if let Some(stale_message) = daemon_doc.generate_sync_message(&mut daemon_sync) {
            let _ = client_doc
                .doc_mut()
                .sync()
                .receive_sync_message(&mut client_sync, stale_message);
        }
        assert_ne!(
            client_doc.read_state(),
            daemon_doc.read_state(),
            "a peer stream with a dropped generated message must not be treated as converged"
        );

        daemon_sync = sync::State::new();
        client_sync = sync::State::new();
        for _ in 0..10 {
            if let Some(message) = daemon_doc.generate_sync_message(&mut daemon_sync) {
                client_doc
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut client_sync, message)
                    .expect("client should receive regenerated runtime sync");
            }
            if let Some(reply) = client_doc
                .doc_mut()
                .sync()
                .generate_sync_message(&mut client_sync)
            {
                daemon_doc
                    .receive_sync_message(&mut daemon_sync, reply)
                    .expect("daemon should receive client ack");
            }
        }

        assert_eq!(
            client_doc.read_state(),
            daemon_doc.read_state(),
            "resetting sync::State must allow the reliable runtime stream to regenerate"
        );
    }

    #[test]
    fn test_generate_sync_message_bounded_encoded_compacts_on_oversized() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        for i in 0..50 {
            let manifest = serde_json::json!({
                "output_type": "stream",
                "output_id": format!("stream-{}", i),
                "name": "stdout",
                "text": {"blob": format!("hash-{}", i), "size": 1000 + i}
            });
            doc.append_output("exec-1", &manifest).unwrap();
        }

        let mut peer_state = sync::State::new();
        // Threshold of 1 byte forces compaction
        let encoded = doc.generate_sync_message_bounded_encoded(&mut peer_state, 1);
        assert!(
            encoded.is_some(),
            "should produce a message after compaction"
        );

        // Verify the compacted message syncs correctly to a fresh client
        let mut client = RuntimeStateDoc::new_empty();
        let mut client_state = sync::State::new();
        if let Some(bytes) = encoded {
            let msg = sync::Message::decode(&bytes).expect("decode compacted message");
            client
                .doc_mut()
                .sync()
                .receive_sync_message(&mut client_state, msg)
                .expect("client receive after compaction");
        }
        for _ in 0..5 {
            if let Some(reply) = client
                .doc_mut()
                .sync()
                .generate_sync_message(&mut client_state)
            {
                doc.receive_sync_message_with_changes(&mut peer_state, reply)
                    .ok();
            }
            if let Some(msg) = doc.generate_sync_message(&mut peer_state) {
                client
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut client_state, msg)
                    .ok();
            }
        }
        assert_eq!(client.get_outputs("exec-1").len(), 50);
    }

    #[test]
    fn test_generate_sync_message_bounded_encoded_no_compact_under_limit() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();

        let mut peer_state = sync::State::new();
        let encoded = doc.generate_sync_message_bounded_encoded(&mut peer_state, 100 * 1024 * 1024);
        assert!(encoded.is_some());
    }

    // ── Execution lifecycle tests ───────────────────────────────────

    #[test]
    fn test_create_execution() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();

        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.status, "queued");
        assert_eq!(es.execution_count, None);
        assert_eq!(es.success, None);
    }

    #[test]
    fn test_create_execution_with_source() {
        let mut doc = RuntimeStateDoc::new();
        assert!(doc
            .create_execution_with_source("exec-1", "x = 42", 0)
            .unwrap());

        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.status, "queued");
        assert_eq!(es.source, Some("x = 42".to_string()));
        assert_eq!(es.seq, Some(0));
        assert_eq!(es.submitted_by_actor_label, None);
    }

    #[test]
    fn test_create_execution_with_source_and_submitter() {
        let mut doc = RuntimeStateDoc::new();
        assert!(doc
            .create_execution_with_source_and_submitter(
                "exec-1",
                "x = 42",
                0,
                Some("local:kyle/agent:codex:s1"),
            )
            .unwrap());

        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.status, "queued");
        assert_eq!(es.source, Some("x = 42".to_string()));
        assert_eq!(es.seq, Some(0));
        assert_eq!(
            es.submitted_by_actor_label.as_deref(),
            Some("local:kyle/agent:codex:s1")
        );
    }

    #[test]
    fn test_create_execution_with_source_provenance() {
        let mut doc = RuntimeStateDoc::new();
        assert!(doc
            .create_execution_with_source_provenance(
                "exec-1",
                "x = 42",
                0,
                Some("local:kyle/agent:codex:s1"),
                Some("cell-1"),
            )
            .unwrap());

        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.status, "queued");
        assert_eq!(es.source.as_deref(), Some("x = 42"));
        assert_eq!(es.cell_id.as_deref(), Some("cell-1"));
        assert_eq!(es.seq, Some(0));
        assert_eq!(
            es.submitted_by_actor_label.as_deref(),
            Some("local:kyle/agent:codex:s1")
        );

        let queued = doc.get_queued_executions();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].1.cell_id.as_deref(), Some("cell-1"));
    }

    #[test]
    fn test_get_queued_executions_sorted_by_seq() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("exec-3", "z = 3", 2)
            .unwrap();
        doc.create_execution_with_source("exec-1", "x = 1", 0)
            .unwrap();
        doc.create_execution_with_source("exec-2", "y = 2", 1)
            .unwrap();

        let queued = doc.get_queued_executions();
        assert_eq!(queued.len(), 3);
        assert_eq!(queued[0].0, "exec-1");
        assert_eq!(queued[1].0, "exec-2");
        assert_eq!(queued[2].0, "exec-3");

        // Transition one to running — should no longer appear
        doc.set_execution_running("exec-1").unwrap();
        let queued = doc.get_queued_executions();
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].0, "exec-2");
    }

    #[test]
    fn get_queued_executions_projects_only_queue_metadata() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("done-exec", "display('done')", 1)
            .unwrap();
        doc.set_execution_running("done-exec").unwrap();
        doc.append_output("done-exec", &test_display("hash-done"))
            .unwrap();
        doc.set_execution_done("done-exec", true).unwrap();
        doc.create_execution_with_source("queued-exec", "display('queued')", 2)
            .unwrap();

        let queued = doc.get_queued_executions();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].0, "queued-exec");
        assert_eq!(queued[0].1.status, "queued");
        assert_eq!(queued[0].1.source.as_deref(), Some("display('queued')"));
        assert_eq!(queued[0].1.seq, Some(2));
        assert!(queued[0].1.outputs.is_empty());
    }

    #[test]
    fn read_state_projects_queued_executions_before_kernel_queue_catches_up() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("exec-2", "y = 2", 2)
            .unwrap();
        doc.create_execution_with_source("exec-1", "x = 1", 1)
            .unwrap();

        let state = doc.read_state();
        assert_eq!(
            state.queue.queued,
            vec![
                QueueEntry {
                    execution_id: "exec-1".to_string(),
                },
                QueueEntry {
                    execution_id: "exec-2".to_string(),
                },
            ]
        );
    }

    #[test]
    fn read_state_does_not_duplicate_runtime_agent_queue_entries() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("exec-1", "x = 1", 1)
            .unwrap();
        let queued = [QueueEntry {
            execution_id: "exec-1".to_string(),
        }];
        doc.set_queue(None, &queued).unwrap();

        let state = doc.read_state();
        assert_eq!(state.queue.queued, queued);
    }

    #[test]
    fn read_state_does_not_duplicate_executing_entry_still_marked_queued() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("exec-1", "x = 1", 1)
            .unwrap();
        let executing = QueueEntry {
            execution_id: "exec-1".to_string(),
        };
        doc.set_queue(Some(&executing), &[]).unwrap();

        let state = doc.read_state();
        assert_eq!(state.queue.executing, Some(executing));
        assert!(state.queue.queued.is_empty());
    }

    #[test]
    fn test_create_execution_idempotent() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        // Second create for same execution_id is a no-op
        doc.create_execution("exec-1").unwrap();
    }

    #[test]
    fn test_execution_lifecycle_success() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();

        // queued → running
        doc.set_execution_running("exec-1").unwrap();
        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.status, "running");
        assert_eq!(es.execution_count, None);

        // Set execution_count separately (from kernel execute_input)
        doc.set_execution_count("exec-1", 5).unwrap();
        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.execution_count, Some(5));

        // running → done
        doc.set_execution_done("exec-1", true).unwrap();
        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.status, "done");
        assert_eq!(es.success, Some(true));
    }

    #[test]
    fn test_execution_lifecycle_error() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        doc.set_execution_running("exec-1").unwrap();
        doc.set_execution_count("exec-1", 3).unwrap();

        // running → error
        doc.set_execution_done("exec-1", false).unwrap();
        let es = doc.get_execution("exec-1").unwrap();
        assert_eq!(es.status, "error");
        assert_eq!(es.success, Some(false));
    }

    #[test]
    fn test_get_execution_nonexistent() {
        let doc = RuntimeStateDoc::new();
        assert!(doc.get_execution("nope").is_none());
    }

    #[test]
    fn test_abort_inflight_executions() {
        let mut doc = RuntimeStateDoc::new();
        // One running, one queued, one already done
        doc.create_execution("exec-running").unwrap();
        doc.set_execution_running("exec-running").unwrap();

        doc.create_execution("exec-queued").unwrap();

        doc.create_execution("exec-done").unwrap();
        doc.set_execution_running("exec-done").unwrap();
        doc.set_execution_done("exec-done", true).unwrap();

        assert_eq!(doc.get_execution("exec-running").unwrap().status, "running");
        assert_eq!(doc.get_execution("exec-queued").unwrap().status, "queued");
        assert_eq!(doc.get_execution("exec-done").unwrap().status, "done");

        let resolved = doc.abort_inflight_executions().unwrap();
        assert_eq!(resolved, 2);

        // Running entry was killed mid-run: error with explicit failure.
        assert_eq!(doc.get_execution("exec-running").unwrap().status, "error");
        assert_eq!(
            doc.get_execution("exec-running").unwrap().success,
            Some(false)
        );
        // Queued entry never ran: cancelled, success absent.
        assert_eq!(
            doc.get_execution("exec-queued").unwrap().status,
            "cancelled"
        );
        assert_eq!(doc.get_execution("exec-queued").unwrap().success, None);
        // Done execution should be untouched
        assert_eq!(doc.get_execution("exec-done").unwrap().status, "done");
        assert_eq!(doc.get_execution("exec-done").unwrap().success, Some(true));
    }

    #[test]
    fn test_abort_inflight_noop_when_all_done() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        doc.set_execution_running("exec-1").unwrap();
        doc.set_execution_done("exec-1", true).unwrap();

        assert_eq!(doc.abort_inflight_executions().unwrap(), 0);
    }

    #[test]
    fn test_set_execution_cancelled() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();

        doc.set_execution_cancelled("exec-1").unwrap();

        let exec = doc.get_execution("exec-1").unwrap();
        assert_eq!(exec.status, "cancelled");
        assert_eq!(exec.success, None);

        // Unknown execution id is a no-op, matching set_execution_done.
        doc.set_execution_cancelled("nope").unwrap();
    }

    #[test]
    fn test_set_execution_running_idempotent() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        doc.set_execution_running("exec-1").unwrap();
        // Already running — no-op
        doc.set_execution_running("exec-1").unwrap();
    }

    #[test]
    fn test_executions_in_read_state() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        doc.set_execution_running("exec-1").unwrap();
        doc.set_execution_count("exec-1", 7).unwrap();
        doc.create_execution("exec-2").unwrap();

        let state = doc.read_state();
        assert_eq!(state.executions.len(), 2);

        let e1 = &state.executions["exec-1"];
        assert_eq!(e1.status, "running");
        assert_eq!(e1.execution_count, Some(7));

        let e2 = &state.executions["exec-2"];
        assert_eq!(e2.status, "queued");
    }

    #[test]
    fn test_execution_count_is_keyed_by_execution_id() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("exec-1", "x = 1", 1)
            .unwrap();
        doc.set_execution_count("exec-1", 12).unwrap();

        let state = doc.read_state();
        assert_eq!(state.executions["exec-1"].execution_count, Some(12));
    }

    #[test]
    fn test_remove_executions_removes_matching_executions_and_indexes() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-a").unwrap();
        doc.create_execution("exec-b").unwrap();
        doc.create_execution("exec-c").unwrap();
        doc.add_display_index_entry("display-1", "exec-a", "output-a");
        doc.add_display_index_entry("display-1", "exec-b", "output-b");
        doc.add_display_index_entry("display-2", "exec-a", "output-c");

        let removed = doc
            .remove_executions(&["exec-a".to_string(), "exec-c".to_string()])
            .unwrap();

        assert_eq!(removed, 2);
        let state = doc.read_state();
        assert!(!state.executions.contains_key("exec-a"));
        assert!(state.executions.contains_key("exec-b"));
        assert!(!state.executions.contains_key("exec-c"));
        assert_eq!(
            doc.get_display_index_entries("display-1"),
            vec![("exec-b".to_string(), "output-b".to_string())],
            "display index entries for removed executions should be cleared"
        );
        assert!(
            doc.get_display_index_entries("display-2").is_empty(),
            "all display ids for removed executions should be cleared"
        );
    }

    #[test]
    fn test_trim_executions() {
        let mut doc = RuntimeStateDoc::new();
        // Create 5 executions.
        doc.create_execution("e1").unwrap();
        doc.create_execution("e2").unwrap();
        doc.create_execution("e3").unwrap();
        doc.create_execution("e4").unwrap();
        doc.create_execution("e5").unwrap();
        for id in ["e1", "e2", "e3", "e4", "e5"] {
            doc.set_execution_done(id, true).unwrap();
        }

        // Trim to 3 by execution history.
        let removed = doc.trim_executions(3).unwrap();
        assert!(removed > 0);

        let state = doc.read_state();
        assert!(state.executions.len() <= 3);
    }

    #[test]
    fn test_trim_executions_noop_when_under_max() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("e1").unwrap();
        doc.create_execution("e2").unwrap();
        assert_eq!(doc.trim_executions(10).unwrap(), 0);
        assert_eq!(doc.read_state().executions.len(), 2);
    }

    #[test]
    fn test_trim_executions_preserves_active_statuses() {
        let mut doc = RuntimeStateDoc::new();
        for id in ["old-1", "old-2", "old-3", "queued", "running"] {
            doc.create_execution(id).unwrap();
            doc.set_execution_count(id, 1).unwrap();
        }
        for id in ["old-1", "old-2", "old-3"] {
            doc.set_execution_done(id, true).unwrap();
        }
        doc.set_execution_running("running").unwrap();

        let removed = doc.trim_executions_preserving(2, &HashSet::new()).unwrap();

        let state = doc.read_state();
        assert!(removed > 0);
        assert!(
            state.executions.contains_key("queued"),
            "queued executions must not be trimmed before the runtime agent sees them"
        );
        assert!(
            state.executions.contains_key("running"),
            "running executions must not be trimmed"
        );
    }

    #[test]
    fn test_execution_lifecycle_syncs_between_docs() {
        let mut daemon_doc = RuntimeStateDoc::new();
        daemon_doc.create_execution("exec-1").unwrap();
        daemon_doc.set_execution_running("exec-1").unwrap();
        daemon_doc.set_execution_count("exec-1", 3).unwrap();
        daemon_doc.set_execution_done("exec-1", true).unwrap();

        // Sync to client (use raw automerge sync for client receive,
        // change-stripping receive for daemon — matches real topology).
        let mut client_doc = RuntimeStateDoc::new_empty();
        let mut daemon_sync = sync::State::new();
        let mut client_sync = sync::State::new();

        for _ in 0..10 {
            if let Some(msg) = daemon_doc.generate_sync_message(&mut daemon_sync) {
                client_doc
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut client_sync, msg)
                    .expect("client receive");
            }
            if let Some(msg) = client_doc
                .doc_mut()
                .sync()
                .generate_sync_message(&mut client_sync)
            {
                daemon_doc
                    .receive_sync_message(&mut daemon_sync, msg)
                    .expect("daemon receive");
            }
        }

        let client_state = client_doc.read_state();
        assert_eq!(client_state.executions.len(), 1);
        let es = &client_state.executions["exec-1"];
        assert_eq!(es.status, "done");
        assert_eq!(es.success, Some(true));
        assert_eq!(es.execution_count, Some(3));
    }

    // ── Fork+Merge Tests ────────────────────────────────────────────

    #[test]
    fn test_fork_and_merge_basic() {
        let mut doc = RuntimeStateDoc::new();

        let mut fork = doc.fork();
        fork.set_actor("runtimed:state:test");

        let entry = QueueEntry {
            execution_id: "exec-1".to_string(),
        };
        fork.set_queue(Some(&entry), &[]).unwrap();

        doc.merge(&mut fork).unwrap();

        let state = doc.read_state();
        assert_eq!(
            state
                .queue
                .executing
                .as_ref()
                .map(|e| e.execution_id.as_str()),
            Some("exec-1")
        );
    }

    #[test]
    fn test_fork_and_merge_concurrent_writes() {
        // Fork, write queue on fork AND kernel status on original,
        // merge — both changes should be present.
        let mut doc = RuntimeStateDoc::new();

        let mut fork = doc.fork();
        fork.set_actor("runtimed:state:test");

        // Write queue on fork
        let entry = QueueEntry {
            execution_id: "exec-1".to_string(),
        };
        fork.set_queue(Some(&entry), &[]).unwrap();

        // Write kernel lifecycle on original (concurrent)
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))
            .unwrap();

        // Merge — both changes should compose
        doc.merge(&mut fork).unwrap();

        let state = doc.read_state();
        assert_eq!(
            state.kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy)
        );
        assert_eq!(
            state
                .queue
                .executing
                .as_ref()
                .map(|e| e.execution_id.as_str()),
            Some("exec-1")
        );
    }

    #[test]
    fn test_fork_actor_distinct() {
        let mut doc = RuntimeStateDoc::new();
        let mut fork = doc.fork();

        // Fork receives an actor distinct from the parent.
        fork.set_actor("runtimed:state:cell-error");

        // Verify the fork's actor is different from the parent
        let parent_actor = format!("{}", doc.doc().get_actor());
        let fork_actor = format!("{}", fork.doc().get_actor());
        assert_ne!(parent_actor, fork_actor);
    }

    #[test]
    fn test_fork_and_merge_closure() {
        let mut doc = RuntimeStateDoc::new();

        doc.fork_and_merge(|fork| {
            fork.set_actor("runtimed:state:test");
            fork.set_lifecycle(&RuntimeLifecycle::Error).unwrap();
            fork.set_queue(None, &[]).unwrap();
            fork.set_execution_done("exec-1", false).unwrap();
        });

        let state = doc.read_state();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Error);
        assert!(state.queue.executing.is_none());
    }

    // ── Output storage tests ───────────────────────────────────────

    #[test]
    fn test_append_output() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m_a = test_stream("hash-a");
        let m_b = test_stream("hash-b");
        let id0 = doc.append_output("exec-1", &m_a).unwrap();
        assert_eq!(id0, "stream-hash-a");
        let id1 = doc.append_output("exec-1", &m_b).unwrap();
        assert_eq!(id1, "stream-hash-b");

        assert_eq!(doc.get_outputs("exec-1"), vec![m_a, m_b]);
    }

    #[test]
    fn append_outputs_preserves_batch_order() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m_a = test_stream("hash-a");
        let m_b = test_stream("hash-b");
        let m_c = test_stream("hash-c");

        let ids = doc
            .append_outputs("exec-1", &[m_a.clone(), m_b.clone(), m_c.clone()])
            .unwrap();

        assert_eq!(ids, vec!["stream-hash-a", "stream-hash-b", "stream-hash-c"]);
        assert_eq!(doc.get_outputs("exec-1"), vec![m_a, m_b, m_c]);
    }

    #[test]
    fn merging_two_forks_with_shared_actor_returns_duplicate_seq_error() {
        // Documents the Automerge invariant that motivates
        // jupyter_kernel's `unique_kernel_actor` helper: two
        // independent forks that set the same actor ID each produce
        // ops under that actor's seq series. The first merge lands;
        // the second merge comes in with an op at a seq number that
        // actor already used on main, and Automerge rejects it with
        // `DuplicateSeqNumber`.
        //
        // Before the fix, the daemon's IOPub handler ignored the Err
        // via `let _ = sd.merge(...)` and the second insert vanished.
        // The production call sites now assign a unique actor per
        // fork so this error is impossible to hit in practice.
        let mut main = RuntimeStateDoc::new();
        main.create_execution("exec-1").unwrap();

        let shared_actor = "rt:kernel:shared";

        let mut fa = main.fork();
        fa.set_actor(shared_actor);
        fa.append_output("exec-1", &test_stream("stream-a"))
            .unwrap();

        let mut fb = main.fork();
        fb.set_actor(shared_actor);
        fb.append_output("exec-1", &test_stream("display-b"))
            .unwrap();

        main.merge(&mut fa).unwrap();
        let second = main.merge(&mut fb);
        match second {
            Err(AutomergeError::DuplicateSeqNumber(_, _)) => {}
            other => panic!("expected DuplicateSeqNumber, got {:?}", other),
        }
    }

    #[test]
    fn append_output_from_forks_with_unique_actors_keeps_all_inserts() {
        // Same setup as the previous test but each fork gets its own
        // actor suffix. Both inserts must survive the merge.
        let mut main = RuntimeStateDoc::new();
        main.create_execution("exec-1").unwrap();

        let mut fa = main.fork();
        fa.set_actor("rt:kernel:shared:fork-a");
        fa.append_output("exec-1", &test_stream("stream-a"))
            .unwrap();

        let mut fb = main.fork();
        fb.set_actor("rt:kernel:shared:fork-b");
        fb.append_output("exec-1", &test_stream("display-b"))
            .unwrap();

        main.merge(&mut fa).unwrap();
        main.merge(&mut fb).unwrap();

        assert_eq!(
            main.get_outputs("exec-1").len(),
            2,
            "both inserts should survive merge when each fork has a unique actor"
        );
    }

    #[test]
    fn upsert_stream_output_treats_tied_max_seq_outputs_as_latest() {
        // Concurrent forks can legitimately create distinct output entries
        // with the same daemon-authored `seq`. Stream coalescing should match
        // the previous behavior: any output tied at the max sequence is
        // eligible for in-place update.
        let mut main = RuntimeStateDoc::new();
        main.create_execution("exec-1").unwrap();

        let mut fa = main.fork();
        fa.set_actor("rt:kernel:shared:fork-a");
        fa.append_output("exec-1", &test_stream("hash-a")).unwrap();

        let mut fb = main.fork();
        fb.set_actor("rt:kernel:shared:fork-b");
        fb.append_output("exec-1", &test_stream("hash-b")).unwrap();

        main.merge(&mut fa).unwrap();
        main.merge(&mut fb).unwrap();
        assert_eq!(main.get_outputs("exec-1").len(), 2);

        let state = StreamOutputState {
            output_id: "stream-hash-a".to_string(),
            blob_hash: "hash-a".to_string(),
        };
        let replacement = test_stream("hash-a-replacement");
        let (updated, output_id) = main
            .upsert_stream_output("exec-1", "stdout", &replacement, Some(&state))
            .unwrap();

        assert!(updated);
        assert_eq!(output_id, "stream-hash-a");
        let outputs = main.get_outputs("exec-1");
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0]["output_id"], "stream-hash-a");
        assert_eq!(outputs[0]["text"]["blob"], "hash-a-replacement");
        assert_eq!(outputs[1]["output_id"], "stream-hash-b");
    }

    #[test]
    fn isolated_transactions_with_same_actor_at_same_heads_do_not_duplicate_seq() {
        let mut doc = RuntimeStateDoc::new();
        let heads = doc.get_heads();

        doc.transact_at_heads_recovering(
            &heads,
            Some("rt:kernel:shared"),
            "test-runtime-transaction-a",
            |doc| {
                doc.create_execution("exec-a")?;
                Ok(())
            },
        )
        .unwrap();

        doc.transact_at_heads_recovering(
            &heads,
            Some("rt:kernel:shared"),
            "test-runtime-transaction-b",
            |doc| {
                doc.create_execution("exec-b")?;
                Ok(())
            },
        )
        .unwrap();

        let state = doc.read_state();
        assert!(state.executions.contains_key("exec-a"));
        assert!(state.executions.contains_key("exec-b"));
    }

    #[test]
    fn isolated_transaction_composes_with_live_changes_after_baseline() {
        let mut doc = RuntimeStateDoc::new();
        let heads = doc.get_heads();

        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))
            .unwrap();

        doc.transact_at_heads_recovering(
            &heads,
            Some("rt:kernel:shared"),
            "test-runtime-transaction-compose",
            |doc| {
                doc.create_execution("exec-1")?;
                Ok(())
            },
        )
        .unwrap();

        let state = doc.read_state();
        assert_eq!(
            state.kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy)
        );
        assert!(state.executions.contains_key("exec-1"));
    }

    #[test]
    fn isolated_transaction_panic_restores_actor_and_keeps_doc_usable() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_actor("runtime:original");
        let heads = doc.get_heads();

        let result = doc.transact_at_heads_recovering(
            &heads,
            Some("runtime:panic"),
            "test-runtime-transaction-panic",
            |_doc| -> Result<(), RuntimeStateError> {
                panic!("injected runtime transaction panic")
            },
        );
        assert!(matches!(
            result,
            Err(RuntimeStateError::AutomergeRecovery(_))
        ));
        assert_eq!(
            format!("{}", doc.doc().get_actor()),
            format!("{}", ActorId::from("runtime:original".as_bytes()))
        );

        doc.set_lifecycle(&RuntimeLifecycle::Error).unwrap();
        assert_eq!(doc.read_state().kernel.lifecycle, RuntimeLifecycle::Error);
    }

    #[test]
    fn test_set_outputs() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        doc.append_output("exec-1", &test_stream("old-hash"))
            .unwrap();

        let manifests = vec![test_display("h1"), test_display("h2"), test_display("h3")];
        doc.set_outputs("exec-1", &manifests).unwrap();

        assert_eq!(doc.get_outputs("exec-1"), manifests);
    }

    #[test]
    fn test_replace_output() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m_a = test_display("hash-a");
        let m_b = test_display("hash-b");
        let m_c = test_display("hash-c");
        let m_d = test_display("hash-d");
        doc.append_output("exec-1", &m_a).unwrap();
        doc.append_output("exec-1", &m_b).unwrap();

        assert!(doc
            .replace_output("exec-1", "display-hash-b", &m_c)
            .unwrap());
        assert_eq!(doc.get_outputs("exec-1"), vec![m_a, m_c]);

        // Unknown output_id
        assert!(!doc
            .replace_output("exec-1", "missing-output", &m_d)
            .unwrap());
        // Nonexistent execution
        assert!(!doc.replace_output("nope", "display-hash-d", &m_d).unwrap());
    }

    #[test]
    fn test_replace_output_removes_stale_keys() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();

        // Original manifest has an extra key (display_id)
        let original = serde_json::json!({
            "output_type": "display_data",
            "output_id": "display-original",
            "display_id": "plot-1",
            "data": {"text/plain": {"blob": "h1", "size": 2}}
        });
        doc.append_output("exec-1", &original).unwrap();

        // Replacement manifest omits display_id
        let replacement = serde_json::json!({
            "output_type": "display_data",
            "output_id": "display-original",
            "data": {"text/plain": {"blob": "h2", "size": 2}}
        });
        doc.replace_output("exec-1", "display-original", &replacement)
            .unwrap();

        let outputs = doc.get_outputs("exec-1");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0], replacement);
        assert!(outputs[0].get("display_id").is_none());
    }

    #[test]
    fn test_upsert_stream_output_append() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();

        let manifest = test_stream("hash-a");
        // No known state → append
        let (updated, output_id) = doc
            .upsert_stream_output("exec-1", "stdout", &manifest, None)
            .unwrap();
        assert!(!updated);
        assert_eq!(output_id, "stream-hash-a");
        assert_eq!(doc.get_outputs("exec-1"), vec![manifest]);
    }

    #[test]
    fn test_upsert_stream_output_update_in_place() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m_a = test_stream("hash-a");
        doc.append_output("exec-1", &m_a).unwrap();

        let state = StreamOutputState {
            output_id: "stream-hash-a".to_string(),
            blob_hash: "hash-a".to_string(),
        };
        let m_b = test_stream("hash-b");
        let (updated, output_id) = doc
            .upsert_stream_output("exec-1", "stdout", &m_b, Some(&state))
            .unwrap();
        assert!(updated);
        assert_eq!(output_id, "stream-hash-a");
        let mut expected = m_b;
        expected["output_id"] = serde_json::Value::String("stream-hash-a".to_string());
        assert_eq!(doc.get_outputs("exec-1"), vec![expected]);
    }

    #[test]
    fn test_upsert_stream_output_inline_update_in_place() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m_a = test_stream_inline("***");
        doc.append_output("exec-1", &m_a).unwrap();

        // blob_hash stores the inline content itself for inline ContentRefs
        let state = StreamOutputState {
            output_id: "stream-inline-***".to_string(),
            blob_hash: "***".to_string(),
        };
        let m_b = test_stream_inline("******");
        let (updated, output_id) = doc
            .upsert_stream_output("exec-1", "stdout", &m_b, Some(&state))
            .unwrap();
        assert!(updated);
        assert_eq!(output_id, "stream-inline-***");
        let mut expected = m_b;
        expected["output_id"] = serde_json::Value::String("stream-inline-***".to_string());
        assert_eq!(doc.get_outputs("exec-1"), vec![expected]);
    }

    #[test]
    fn test_upsert_stream_output_inline_to_blob_transition() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        // Start with inline content
        let m_a = test_stream_inline("small");
        doc.append_output("exec-1", &m_a).unwrap();

        let state = StreamOutputState {
            output_id: "stream-inline-small".to_string(),
            blob_hash: "small".to_string(),
        };
        // Transition to blob when content grows past threshold
        let m_b = test_stream("blob-hash-after-growth");
        let (updated, output_id) = doc
            .upsert_stream_output("exec-1", "stdout", &m_b, Some(&state))
            .unwrap();
        assert!(updated);
        assert_eq!(output_id, "stream-inline-small");
        let mut expected = m_b;
        expected["output_id"] = serde_json::Value::String("stream-inline-small".to_string());
        assert_eq!(doc.get_outputs("exec-1"), vec![expected]);
    }

    #[test]
    fn test_upsert_stream_output_hash_mismatch_appends() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m_a = test_stream("hash-a");
        doc.append_output("exec-1", &m_a).unwrap();

        let state = StreamOutputState {
            output_id: "stream-hash-a".to_string(),
            blob_hash: "wrong-hash".to_string(),
        };
        let m_b = test_stream("hash-b");
        let (updated, output_id) = doc
            .upsert_stream_output("exec-1", "stdout", &m_b, Some(&state))
            .unwrap();
        assert!(!updated);
        assert_eq!(output_id, "stream-hash-b");
        assert_eq!(doc.get_outputs("exec-1"), vec![m_a, m_b]);
    }

    #[test]
    fn test_extract_output_id_filters_empty_strings() {
        // Legacy fixtures and in-flight manifests sometimes serialize
        // `"output_id": ""`. The id diff must treat those as missing so
        // every such output does not collapse onto the empty-string key
        // and drop sibling entries.
        let with_id = serde_json::json!({ "output_id": "abc" });
        let empty = serde_json::json!({ "output_id": "" });
        let missing = serde_json::json!({});
        assert_eq!(extract_output_id(&with_id), Some("abc".to_string()));
        assert_eq!(extract_output_id(&empty), None);
        assert_eq!(extract_output_id(&missing), None);
    }

    #[test]
    fn test_diff_output_ids_in_place_updates_only_changed_entries() {
        let mut snapshot = HashMap::new();
        let unchanged = test_stream("hash1");
        let changed = test_stream("hash2-old");
        let removed = test_stream("hash3");
        snapshot.insert("stream-hash1".to_string(), unchanged.clone());
        snapshot.insert("stream-hash2-old".to_string(), changed);
        snapshot.insert("stream-hash3".to_string(), removed);

        let mut changed_output = test_stream("hash2-old");
        changed_output["text"]["blob"] = serde_json::Value::String("hash2-new".to_string());
        changed_output["text"]["size"] = serde_json::Value::from(9);
        let new_output = test_stream("hash4");
        let mut execs = HashMap::new();
        execs.insert(
            "exec-1".to_string(),
            ExecutionState {
                status: "running".to_string(),
                execution_count: Some(1),
                success: None,
                outputs: vec![
                    unchanged.clone(),
                    changed_output.clone(),
                    new_output.clone(),
                ],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );

        let diff = diff_output_ids_in_place(&mut snapshot, &execs);

        assert_eq!(
            diff.changed,
            vec![
                ("stream-hash2-old".to_string(), changed_output.clone()),
                ("stream-hash4".to_string(), new_output.clone()),
            ]
        );
        assert_eq!(diff.removed_output_ids, vec!["stream-hash3"]);
        assert_eq!(snapshot.get("stream-hash1"), Some(&unchanged));
        assert_eq!(snapshot.get("stream-hash2-old"), Some(&changed_output));
        assert_eq!(snapshot.get("stream-hash4"), Some(&new_output));
        assert!(!snapshot.contains_key("stream-hash3"));
    }

    #[test]
    fn test_diff_output_ids_wrapper_matches_in_place_diff() {
        let prev = HashMap::from([("stream-hash1".to_string(), test_stream("hash1"))]);
        let mut execs = HashMap::new();
        execs.insert(
            "exec-1".to_string(),
            ExecutionState {
                status: "done".to_string(),
                execution_count: Some(1),
                success: Some(true),
                outputs: vec![test_stream("hash1"), test_stream("hash2")],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );

        let (wrapper_diff, wrapper_snapshot) = diff_output_ids(&prev, &execs);
        let mut in_place_snapshot = prev.clone();
        let in_place_diff = diff_output_ids_in_place(&mut in_place_snapshot, &execs);

        assert_eq!(wrapper_diff, in_place_diff);
        assert_eq!(wrapper_snapshot, in_place_snapshot);
    }

    #[test]
    fn test_upsert_stream_preserves_output_id() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m_a = serde_json::json!({
            "output_type": "stream",
            "output_id": "original-id-abc",
            "name": "stdout",
            "text": {"blob": "hash-a", "size": 6}
        });
        doc.append_output("exec-1", &m_a).unwrap();

        let state = StreamOutputState {
            output_id: "original-id-abc".to_string(),
            blob_hash: "hash-a".to_string(),
        };
        let m_b = serde_json::json!({
            "output_type": "stream",
            "output_id": "fresh-minted-xyz",
            "name": "stdout",
            "text": {"blob": "hash-b", "size": 10}
        });
        let (updated, output_id) = doc
            .upsert_stream_output("exec-1", "stdout", &m_b, Some(&state))
            .unwrap();
        assert!(updated);
        assert_eq!(output_id, "original-id-abc");

        let outputs = doc.get_outputs("exec-1");
        assert_eq!(outputs.len(), 1);
        assert_eq!(
            outputs[0]["output_id"], "original-id-abc",
            "Coalesced stream should keep the original output_id"
        );
        assert_eq!(
            outputs[0]["text"]["blob"], "hash-b",
            "Content should be updated to the new manifest"
        );
    }

    #[test]
    fn test_stream_coalescence_doc_size_bounded() {
        // Simulate 100 stream updates (typical ML training loop).
        // With in-place updates, doc size should grow sub-linearly
        // because only the text ContentRef scalars change — no tombstones
        // from deleted Maps accumulate.
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();

        let initial = serde_json::json!({
            "output_type": "stream",
            "output_id": "stream-uuid",
            "name": "stdout",
            "text": {"blob": "hash-0", "size": 100}
        });
        doc.append_output("exec-1", &initial).unwrap();

        let size_after_first = doc.doc.save().len();

        let mut state = StreamOutputState {
            output_id: "stream-uuid".to_string(),
            blob_hash: "hash-0".to_string(),
        };

        for i in 1..100 {
            let new_hash = format!("hash-{}", i);
            let manifest = serde_json::json!({
                "output_type": "stream",
                "output_id": "new-uuid",
                "name": "stdout",
                "text": {"blob": &new_hash, "size": 100 + i}
            });
            let (updated, output_id) = doc
                .upsert_stream_output("exec-1", "stdout", &manifest, Some(&state))
                .unwrap();
            assert!(updated);
            assert_eq!(output_id, "stream-uuid");
            state = StreamOutputState {
                output_id: "stream-uuid".to_string(),
                blob_hash: new_hash,
            };
        }

        let size_after_100 = doc.doc.save().len();
        // In-place scalar puts generate zero Map tombstones (unlike delete+insert),
        // so history grows only by the op log for ~5 scalar puts per update.
        let growth_factor = size_after_100 as f64 / size_after_first as f64;
        assert!(
            growth_factor < 3.0,
            "Doc grew {:.1}x after 100 stream updates (expected < 3x). \
             size_after_first={}, size_after_100={}",
            growth_factor,
            size_after_first,
            size_after_100,
        );
    }

    #[test]
    fn test_get_all_outputs() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        doc.create_execution("exec-2").unwrap();
        let m1 = test_stream("h1");
        let m2 = test_stream("h2");
        let m3 = test_stream("h3");
        doc.append_output("exec-1", &m1).unwrap();
        doc.append_output("exec-1", &m2).unwrap();
        doc.append_output("exec-2", &m3).unwrap();

        let all = doc.get_all_outputs();
        assert_eq!(all.len(), 3);

        // Check that all expected entries are present (order across execution_ids
        // depends on Automerge key iteration order, so use contains)
        assert!(all.contains(&("exec-1".to_string(), "stream-h1".to_string(), m1)));
        assert!(all.contains(&("exec-1".to_string(), "stream-h2".to_string(), m2)));
        assert!(all.contains(&("exec-2".to_string(), "stream-h3".to_string(), m3)));
    }

    #[test]
    fn test_inline_outputs_in_execution_state() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        doc.create_execution("exec-2").unwrap();
        let m1 = test_stream("h1");
        let m2 = test_stream("h2");
        let m3 = test_stream("h3");
        doc.append_output("exec-1", &m1).unwrap();
        doc.append_output("exec-1", &m2).unwrap();
        doc.append_output("exec-2", &m3).unwrap();

        let state = doc.read_state();
        assert_eq!(state.executions["exec-1"].outputs, vec![m1, m2]);
        assert_eq!(state.executions["exec-2"].outputs, vec![m3]);
    }

    #[test]
    fn test_trim_executions_also_trims_outputs() {
        let mut doc = RuntimeStateDoc::new();
        // Create 5 executions with outputs
        for i in 1..=5 {
            let eid = format!("e{i}");
            doc.create_execution(&eid).unwrap();
            doc.append_output(&eid, &test_stream(&format!("hash-{i}")))
                .unwrap();
            doc.set_execution_done(&eid, true).unwrap();
        }

        // Trim to 3
        let removed = doc.trim_executions(3).unwrap();
        assert!(removed > 0);

        let state = doc.read_state();
        // Outputs for trimmed executions should be gone
        for eid in state.executions.keys() {
            assert!(
                !doc.get_outputs(eid).is_empty(),
                "surviving execution {eid} should still have outputs"
            );
        }
        // Trimmed executions should not have output entries
        for eid in ["e1", "e2", "e3", "e4", "e5"] {
            if !state.executions.contains_key(eid) {
                assert!(
                    doc.get_outputs(eid).is_empty(),
                    "trimmed execution {eid} should have no outputs"
                );
            }
        }
    }

    #[test]
    fn test_outputs_sync_between_docs() {
        let mut daemon_doc = RuntimeStateDoc::new();
        daemon_doc.create_execution("exec-1").unwrap();
        daemon_doc.create_execution("exec-2").unwrap();
        let m1 = test_stream("h1");
        let m2 = test_stream("h2");
        let m3 = test_stream("h3");
        daemon_doc.append_output("exec-1", &m1).unwrap();
        daemon_doc.append_output("exec-1", &m2).unwrap();
        daemon_doc.append_output("exec-2", &m3).unwrap();

        let mut client_doc = RuntimeStateDoc::new_empty();
        let mut daemon_sync = sync::State::new();
        let mut client_sync = sync::State::new();

        for _ in 0..10 {
            if let Some(msg) = daemon_doc.generate_sync_message(&mut daemon_sync) {
                client_doc
                    .doc_mut()
                    .sync()
                    .receive_sync_message(&mut client_sync, msg)
                    .expect("client receive");
            }
            if let Some(msg) = client_doc
                .doc_mut()
                .sync()
                .generate_sync_message(&mut client_sync)
            {
                daemon_doc
                    .receive_sync_message(&mut daemon_sync, msg)
                    .expect("daemon receive");
            }
        }

        let client_state = client_doc.read_state();
        assert_eq!(client_state.executions.len(), 2);
        assert_eq!(client_state.executions["exec-1"].outputs, vec![m1, m2]);
        assert_eq!(client_state.executions["exec-2"].outputs, vec![m3]);
    }

    #[test]
    fn test_fork_and_merge_outputs() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution("exec-1").unwrap();
        let m1 = test_stream("h1");
        let m2 = test_stream("h2");
        doc.append_output("exec-1", &m1).unwrap();

        let mut fork = doc.fork();
        fork.set_actor("runtimed:state:iopub");
        fork.append_output("exec-1", &m2).unwrap();

        doc.merge(&mut fork).unwrap();
        assert_eq!(doc.get_outputs("exec-1"), vec![m1, m2]);
    }

    #[test]
    fn test_get_outputs_nonexistent() {
        let doc = RuntimeStateDoc::new();
        // No execution entry → empty outputs
        assert!(doc.get_outputs("nope").is_empty());
    }

    // ── Comm tests ────────────────────────────────────────────────

    #[test]
    fn test_put_comm_roundtrip() {
        let mut doc = RuntimeStateDoc::new();
        let state = serde_json::json!({"value": 42});
        doc.put_comm(
            "comm-1",
            "jupyter.widget",
            "@jupyter-widgets/controls",
            "IntSliderModel",
            &state,
            0,
        )
        .unwrap();

        let entry = doc.get_comm("comm-1").unwrap();
        assert_eq!(entry.target_name, "jupyter.widget");
        assert_eq!(entry.model_module, "@jupyter-widgets/controls");
        assert_eq!(entry.model_name, "IntSliderModel");
        assert_eq!(entry.state, serde_json::json!({"value": 42}));
        assert!(entry.outputs.is_empty());
        assert_eq!(entry.seq, 0);
    }

    #[test]
    fn test_put_comm_overwrites() {
        let empty = serde_json::json!({});
        let mut doc = RuntimeStateDoc::new();
        doc.put_comm("comm-1", "jupyter.widget", "mod-a", "ModelA", &empty, 0)
            .unwrap();
        doc.put_comm("comm-1", "jupyter.widget", "mod-b", "ModelB", &empty, 1)
            .unwrap();

        let entry = doc.get_comm("comm-1").unwrap();
        assert_eq!(entry.model_module, "mod-b");
        assert_eq!(entry.model_name, "ModelB");
        assert_eq!(entry.seq, 1);
    }

    #[test]
    fn test_remove_comm() {
        let empty = serde_json::json!({});
        let mut doc = RuntimeStateDoc::new();
        doc.put_comm("comm-1", "jupyter.widget", "", "", &empty, 0)
            .unwrap();
        doc.remove_comm("comm-1").unwrap();
        assert!(doc.get_comm("comm-1").is_none());
    }

    #[test]
    fn test_remove_comm_nonexistent() {
        let mut doc = RuntimeStateDoc::new();
        doc.remove_comm("nope").unwrap();
    }

    #[test]
    fn test_clear_comms() {
        let empty = serde_json::json!({});
        let mut doc = RuntimeStateDoc::new();
        doc.put_comm("comm-1", "jupyter.widget", "", "", &empty, 0)
            .unwrap();
        doc.put_comm("comm-2", "jupyter.widget", "", "", &empty, 1)
            .unwrap();
        doc.clear_comms().unwrap();
        assert!(doc.get_comm("comm-1").is_none());
        assert!(doc.get_comm("comm-2").is_none());
    }

    #[test]
    fn test_clear_comms_empty() {
        let mut doc = RuntimeStateDoc::new();
        doc.clear_comms().unwrap();
    }

    #[test]
    fn test_comms_in_read_state() {
        let mut doc = RuntimeStateDoc::new();
        doc.put_comm(
            "comm-1",
            "jupyter.widget",
            "mod",
            "Slider",
            &serde_json::json!({"v": 1}),
            0,
        )
        .unwrap();
        doc.put_comm(
            "comm-2",
            "jupyter.widget",
            "mod",
            "Button",
            &serde_json::json!({"v": 2}),
            1,
        )
        .unwrap();

        let state = doc.read_state();
        assert_eq!(state.comms.len(), 2);
        assert_eq!(state.comms["comm-1"].model_name, "Slider");
        assert_eq!(state.comms["comm-2"].model_name, "Button");
    }

    #[test]
    fn test_get_comms_matches_read_state_projection() {
        let mut doc = RuntimeStateDoc::new();
        doc.create_execution_with_source("exec-1", "display('x')", 0)
            .unwrap();
        doc.set_execution_running("exec-1").unwrap();
        doc.append_output("exec-1", &test_display("hash-output"))
            .unwrap();
        doc.put_comm(
            "comm-1",
            "jupyter.widget",
            "mod",
            "Slider",
            &serde_json::json!({"v": 1}),
            0,
        )
        .unwrap();

        let comms = doc.get_comms();
        let state = doc.read_state();
        assert_eq!(comms, state.comms);
    }

    #[test]
    fn test_fork_and_merge_comms() {
        let empty = serde_json::json!({});
        let mut doc = RuntimeStateDoc::new();
        doc.put_comm("comm-1", "jupyter.widget", "", "", &empty, 0)
            .unwrap();

        let mut fork = doc.fork();
        fork.set_actor("runtimed:state:comms");
        fork.put_comm("comm-2", "jupyter.widget", "", "New", &empty, 1)
            .unwrap();

        doc.merge(&mut fork).unwrap();
        assert!(doc.get_comm("comm-1").is_some());
        assert_eq!(doc.get_comm("comm-2").unwrap().model_name, "New");
    }

    #[test]
    fn test_comm_output_append_and_clear() {
        let empty = serde_json::json!({});
        let mut doc = RuntimeStateDoc::new();
        doc.put_comm("comm-1", "jupyter.widget", "", "OutputModel", &empty, 0)
            .unwrap();

        let m_a = test_display("hash-a");
        let m_b = test_display("hash-b");
        doc.append_comm_output("comm-1", &m_a).unwrap();
        doc.append_comm_output("comm-1", &m_b).unwrap();
        assert_eq!(doc.get_comm("comm-1").unwrap().outputs, vec![m_a, m_b]);

        doc.clear_comm_outputs("comm-1").unwrap();
        assert!(doc.get_comm("comm-1").unwrap().outputs.is_empty());

        // Clearing already-empty returns false
        doc.clear_comm_outputs("comm-1").unwrap();
    }

    #[test]
    fn test_comm_output_nonexistent() {
        let mut doc = RuntimeStateDoc::new();
        doc.append_comm_output("nope", &test_stream("hash"))
            .unwrap();
        doc.clear_comm_outputs("nope").unwrap();
    }

    #[test]
    fn test_new_doc_has_empty_comms() {
        let doc = RuntimeStateDoc::new();
        assert!(doc.read_state().comms.is_empty());
    }

    #[test]
    fn test_set_comm_state_property() {
        let mut doc = RuntimeStateDoc::new();
        doc.put_comm(
            "comm-1",
            "jupyter.widget",
            "",
            "IntSliderModel",
            &serde_json::json!({"value": 50, "min": 0, "max": 100}),
            0,
        )
        .unwrap();

        // Set a single property
        doc.set_comm_state_property("comm-1", "value", &serde_json::json!(75))
            .unwrap();

        let entry = doc.get_comm("comm-1").unwrap();
        assert_eq!(entry.state["value"], 75);
        // Other properties preserved
        assert_eq!(entry.state["min"], 0);
        assert_eq!(entry.state["max"], 100);
    }

    #[test]
    fn test_set_comm_state_property_nonexistent() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_comm_state_property("nope", "value", &serde_json::json!(42))
            .unwrap();
    }

    #[test]
    fn test_native_state_roundtrip() {
        let mut doc = RuntimeStateDoc::new();
        let state = serde_json::json!({
            "value": 42,
            "description": "Speed:",
            "disabled": false,
            "layout": "IPY_MODEL_abc123",
            "nested": {"a": [1, 2, 3]}
        });
        doc.put_comm("comm-1", "jupyter.widget", "", "", &state, 0)
            .unwrap();

        let entry = doc.get_comm("comm-1").unwrap();
        assert_eq!(entry.state, state);
    }

    // ── Output diff tests ─────────────────────────────────────────

    #[test]
    fn test_diff_new_output_detected() {
        let prev = HashMap::new();
        let mut execs = HashMap::new();
        execs.insert(
            "exec-1".to_string(),
            ExecutionState {
                status: "done".to_string(),
                execution_count: Some(1),
                success: Some(true),
                outputs: vec![test_stream("hash1")],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );
        let (changed, _) = diff_execution_outputs(&prev, &execs);
        assert_eq!(changed, vec!["exec-1"]);
    }

    #[test]
    fn test_diff_empty_to_empty_no_change() {
        let prev = HashMap::new();
        let mut execs = HashMap::new();
        execs.insert(
            "exec-1".to_string(),
            ExecutionState {
                status: "running".to_string(),
                execution_count: None,
                success: None,
                outputs: vec![],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );
        let (changed, _) = diff_execution_outputs(&prev, &execs);
        assert!(changed.is_empty());
    }

    #[test]
    fn test_diff_output_cleared_detected() {
        let mut prev = HashMap::new();
        prev.insert("exec-1".to_string(), vec![test_stream("hash1")]);
        let mut execs = HashMap::new();
        execs.insert(
            "exec-1".to_string(),
            ExecutionState {
                status: "done".to_string(),
                execution_count: Some(1),
                success: Some(true),
                outputs: vec![],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );
        let (changed, _) = diff_execution_outputs(&prev, &execs);
        assert_eq!(changed, vec!["exec-1"]);
    }

    /// The critical edge case: after outputs are cleared, the snapshot
    /// must retain the empty outputs so the NEXT diff comparing
    /// [] vs ["new_hash"] correctly detects the change.
    #[test]
    fn test_diff_re_execution_output_after_clear() {
        // Stage 1: execution has output
        let prev = HashMap::new();
        let mut execs = HashMap::new();
        execs.insert(
            "exec-1".to_string(),
            ExecutionState {
                status: "done".to_string(),
                execution_count: Some(1),
                success: Some(true),
                outputs: vec![test_stream("hash1")],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );
        let (changed, snapshot) = diff_execution_outputs(&prev, &execs);
        assert_eq!(changed, vec!["exec-1"]);

        // Stage 2: outputs cleared (pre-execute)
        execs.get_mut("exec-1").unwrap().outputs = vec![];
        let (changed, snapshot) = diff_execution_outputs(&snapshot, &execs);
        assert_eq!(changed, vec!["exec-1"], "clear should be detected");

        // Stage 3: new execution with empty outputs (just created)
        execs.insert(
            "exec-2".to_string(),
            ExecutionState {
                status: "running".to_string(),
                execution_count: None,
                success: None,
                outputs: vec![],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );
        let (changed, snapshot) = diff_execution_outputs(&snapshot, &execs);
        assert!(changed.is_empty(), "no output change yet");

        // Stage 4: new output arrives on exec-2
        execs.get_mut("exec-2").unwrap().outputs = vec![test_stream("hash2")];
        let (changed, _) = diff_execution_outputs(&snapshot, &execs);
        assert_eq!(
            changed,
            vec!["exec-2"],
            "new output after clear must be detected"
        );
    }

    /// Verify snapshot retains empty outputs (the original bug was
    /// filtering them out, which broke subsequent diffs).
    #[test]
    fn test_diff_snapshot_retains_empty_outputs() {
        let mut prev = HashMap::new();
        prev.insert("exec-1".to_string(), vec![test_stream("hash1")]);

        let mut execs = HashMap::new();
        execs.insert(
            "exec-1".to_string(),
            ExecutionState {
                status: "done".to_string(),
                execution_count: Some(1),
                success: Some(true),
                outputs: vec![],
                source: None,
                cell_id: None,
                seq: None,
                submitted_by_actor_label: None,
            },
        );

        let (_, snapshot) = diff_execution_outputs(&prev, &execs);
        assert!(
            snapshot.contains_key("exec-1"),
            "empty outputs must be retained in snapshot"
        );
        assert!(snapshot["exec-1"].is_empty());
    }

    #[test]
    fn test_merge_comm_state_delta_skips_same_value() {
        let mut doc = RuntimeStateDoc::new();
        let state = serde_json::json!({"value": 42, "label": "hello"});
        doc.put_comm("w1", "jupyter.widget", "", "", &state, 0)
            .unwrap();

        // Same values → no change
        let delta = serde_json::json!({"value": 42, "label": "hello"});
        doc.merge_comm_state_delta("w1", &delta).unwrap();
    }

    #[test]
    fn test_merge_comm_state_delta_writes_changed_value() {
        let mut doc = RuntimeStateDoc::new();
        let state = serde_json::json!({"value": 42, "label": "hello"});
        doc.put_comm("w1", "jupyter.widget", "", "", &state, 0)
            .unwrap();

        // Different value → change
        let delta = serde_json::json!({"value": 99});
        doc.merge_comm_state_delta("w1", &delta).unwrap();
        let updated = doc.read_state();
        let w1 = &updated.comms["w1"];
        assert_eq!(w1.state["value"], 99);
        // Unchanged key preserved
        assert_eq!(w1.state["label"], "hello");
    }

    #[test]
    fn test_merge_comm_state_delta_nonexistent_comm() {
        let mut doc = RuntimeStateDoc::new();
        let delta = serde_json::json!({"value": 1});
        doc.merge_comm_state_delta("nonexistent", &delta).unwrap();
    }

    #[test]
    fn test_merge_comm_state_delta_writes_objects_unconditionally() {
        let mut doc = RuntimeStateDoc::new();
        let state = serde_json::json!({"nested": {"a": 1}});
        doc.put_comm("w1", "jupyter.widget", "", "", &state, 0)
            .unwrap();

        // Object values are always written (no deep comparison)
        let delta = serde_json::json!({"nested": {"a": 1}});
        doc.merge_comm_state_delta("w1", &delta).unwrap();
    }

    #[test]
    fn receive_sync_with_changes_retries_original_message_after_patch_log_mismatch() {
        let mut receiver = RuntimeStateDoc::new_empty();
        let mut receiver_sync = sync::State::new();

        let mut donor = RuntimeStateDoc::new();
        donor
            .create_execution_with_source("exec-retry", "x = 1", 1)
            .unwrap();
        let mut donor_sync = sync::State::new();
        if let Some(handshake) = receiver.generate_sync_message(&mut receiver_sync) {
            donor
                .doc
                .sync()
                .receive_sync_message(&mut donor_sync, handshake)
                .expect("donor receives receiver handshake");
        }
        let message = donor
            .generate_sync_message(&mut donor_sync)
            .expect("donor should advertise execution");

        RuntimeStateDoc::__patch_log_mismatch_on_next_receive_sync_calls_for_test(1);
        let changed = receiver
            .receive_sync_message_with_changes_recovering(
                &mut receiver_sync,
                message,
                "receive-sync-patch-log-mismatch-test",
            )
            .expect("recoverable sync error should reset state and retry the original message");

        assert!(changed, "retried message should apply donor changes");
        assert!(
            receiver.read_state().executions.contains_key("exec-retry"),
            "execution from the failed receive frame should not be dropped"
        );
    }

    #[test]
    fn receive_sync_and_foreign_comms_retries_original_message_after_patch_log_mismatch() {
        let mut receiver = RuntimeStateDoc::new();
        receiver.set_actor("rt:kernel:deadbeef");
        let mut receiver_sync = sync::State::new();

        let mut donor = receiver.fork();
        donor.fork_and_merge(|f| {
            f.set_actor("human:peer");
            f.put_comm(
                "human-widget",
                "j.w",
                "",
                "",
                &serde_json::json!({"value": 2}),
                0,
            )
            .unwrap();
        });
        let mut donor_sync = sync::State::new();
        if let Some(handshake) = receiver.generate_sync_message(&mut receiver_sync) {
            donor
                .doc
                .sync()
                .receive_sync_message(&mut donor_sync, handshake)
                .expect("donor receives receiver handshake");
        }
        let message = donor
            .generate_sync_message(&mut donor_sync)
            .expect("donor should advertise comm change");

        RuntimeStateDoc::__patch_log_mismatch_on_next_receive_sync_calls_for_test(1);
        let view = receiver
            .receive_sync_and_foreign_comms_recovering(
                &mut receiver_sync,
                message,
                |actor| !actor.to_bytes().starts_with(b"rt:kernel:"),
                "receive-sync-foreign-patch-log-mismatch-test",
            )
            .expect("recoverable sync error should reset state and retry the original message");

        assert!(
            view.applied_actors
                .iter()
                .any(|actor| actor.to_bytes().starts_with(b"human:")),
            "retried message should report the applied frontend actor"
        );
        let foreign_comms = view.foreign_comms.expect("foreign comm view");
        assert!(
            foreign_comms.contains_key("human-widget"),
            "foreign comm from the failed receive frame should not be dropped"
        );
    }

    #[test]
    fn receive_sync_message_with_changes_clears_output_order_cache() {
        let mut receiver = RuntimeStateDoc::new();
        receiver.create_execution("exec-1").unwrap();
        receiver
            .append_output("exec-1", &test_stream("hash-a"))
            .unwrap();
        assert!(receiver.output_order_cache.contains_key("exec-1"));

        let mut donor = receiver.fork();
        donor.set_actor("human:peer");
        donor
            .append_output("exec-1", &test_stream("hash-b"))
            .unwrap();

        let mut receiver_sync = sync::State::new();
        let mut donor_sync = sync::State::new();
        if let Some(handshake) = receiver.generate_sync_message(&mut receiver_sync) {
            donor
                .doc
                .sync()
                .receive_sync_message(&mut donor_sync, handshake)
                .expect("donor receives receiver handshake");
        }
        let message = donor
            .generate_sync_message(&mut donor_sync)
            .expect("donor should advertise output change");

        let changed = receiver
            .receive_sync_message_with_changes(&mut receiver_sync, message)
            .expect("receiver accepts donor change");

        assert!(changed);
        assert!(!receiver.output_order_cache.contains_key("exec-1"));
        assert_eq!(receiver.get_outputs("exec-1").len(), 2);
    }

    #[test]
    fn receive_sync_and_foreign_comms_clears_output_order_cache() {
        let mut receiver = RuntimeStateDoc::new();
        receiver.create_execution("exec-1").unwrap();
        receiver
            .append_output("exec-1", &test_stream("hash-a"))
            .unwrap();
        assert!(receiver.output_order_cache.contains_key("exec-1"));

        let mut donor = receiver.fork();
        donor.set_actor("human:peer");
        donor
            .append_output("exec-1", &test_stream("hash-b"))
            .unwrap();

        let mut receiver_sync = sync::State::new();
        let mut donor_sync = sync::State::new();
        if let Some(handshake) = receiver.generate_sync_message(&mut receiver_sync) {
            donor
                .doc
                .sync()
                .receive_sync_message(&mut donor_sync, handshake)
                .expect("donor receives receiver handshake");
        }
        let message = donor
            .generate_sync_message(&mut donor_sync)
            .expect("donor should advertise output change");

        let view = receiver
            .receive_sync_and_foreign_comms(&mut receiver_sync, message, |_| true)
            .expect("receiver accepts donor change");

        assert!(!view.applied_actors.is_empty());
        assert!(!receiver.output_order_cache.contains_key("exec-1"));
        assert_eq!(receiver.get_outputs("exec-1").len(), 2);
    }

    #[test]
    fn foreign_sync_view_filters_self_authored_fields() {
        // Two comms in one sync frame: kernel-widget's "value" was
        // last-written by the kernel actor (a self-echo); human-widget's
        // "value" was last-written by a frontend actor. The per-field
        // filter should strip the kernel echo and retain the frontend
        // write, even though both changes ride the same sync message.
        //
        // Production writes tag changes with the actor that authored the
        // field. We model that here by forking the donor separately for each
        // actor identity.
        let mut receiver = RuntimeStateDoc::new();
        receiver.set_actor("rt:kernel:deadbeef");
        let mut receiver_sync = sync::State::new();

        let mut donor = receiver.fork();
        // Kernel-authored comm: self-echo.
        donor.fork_and_merge(|f| {
            f.set_actor("rt:kernel:deadbeef");
            f.put_comm(
                "kernel-widget",
                "j.w",
                "",
                "",
                &serde_json::json!({"value": 1}),
                0,
            )
            .unwrap();
        });
        // Frontend-authored comm: legitimate write.
        donor.fork_and_merge(|f| {
            f.set_actor("human:peer");
            f.put_comm(
                "human-widget",
                "j.w",
                "",
                "",
                &serde_json::json!({"value": 2}),
                0,
            )
            .unwrap();
        });

        let mut donor_sync = sync::State::new();
        for _ in 0..4 {
            if let Some(msg) = donor.doc.sync().generate_sync_message(&mut donor_sync) {
                let view = receiver
                    .receive_sync_and_foreign_comms(&mut receiver_sync, msg, |actor| {
                        !actor.to_bytes().starts_with(b"rt:kernel:")
                    })
                    .expect("receive");
                if let Some(foreign_comms) = view.foreign_comms {
                    if foreign_comms.contains_key("human-widget") {
                        assert!(
                            !foreign_comms.contains_key("kernel-widget"),
                            "foreign view must not contain kernel-authored echo: {:?}",
                            foreign_comms.keys().collect::<Vec<_>>()
                        );
                        assert!(
                            view.applied_actors
                                .iter()
                                .any(|a| a.to_bytes().starts_with(b"human:")),
                            "applied_actors should include human: entry"
                        );
                        return;
                    }
                }
            }
            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                let _ = donor
                    .doc
                    .sync()
                    .receive_sync_message(&mut donor_sync, reply);
            }
        }
        panic!("sync never converged to produce a foreign view");
    }

    #[test]
    fn foreign_sync_view_strips_kernel_overwrites_on_shared_field() {
        // Frontend wrote `value=15`, kernel subsequently echoed
        // `value=10` on the same comm.state key. The per-field filter
        // must recognize the current LWW winner was authored by the
        // kernel actor and OMIT that key from the foreign view so the
        // runtime agent does not forward the kernel echo back.
        let mut receiver = RuntimeStateDoc::new();
        receiver.set_actor("rt:kernel:deadbeef");
        let mut receiver_sync = sync::State::new();

        let mut donor = receiver.fork();
        donor.fork_and_merge(|f| {
            f.set_actor("human:peer");
            f.put_comm(
                "slider",
                "j.w",
                "",
                "",
                &serde_json::json!({"value": 15}),
                0,
            )
            .unwrap();
        });
        // Kernel echoes a different value on the same key AFTER the
        // frontend's write — causally later, so LWW winner is the
        // kernel's 10.
        donor.fork_and_merge(|f| {
            f.set_actor("rt:kernel:deadbeef");
            f.merge_comm_state_delta("slider", &serde_json::json!({"value": 10}))
                .unwrap();
        });

        let mut donor_sync = sync::State::new();
        for _ in 0..4 {
            if let Some(msg) = donor.doc.sync().generate_sync_message(&mut donor_sync) {
                let view = receiver
                    .receive_sync_and_foreign_comms(&mut receiver_sync, msg, |actor| {
                        !actor.to_bytes().starts_with(b"rt:kernel:")
                    })
                    .expect("receive");
                if let Some(foreign_comms) = view.foreign_comms {
                    // Applied both the frontend open and the kernel
                    // echo? The current LWW winner on `value` is the
                    // kernel's 10, so the slider comm is either absent
                    // from the foreign view entirely (no foreign fields
                    // remain) or present with `value` stripped.
                    if view
                        .applied_actors
                        .iter()
                        .any(|a| a.to_bytes().starts_with(b"rt:kernel:"))
                        && view
                            .applied_actors
                            .iter()
                            .any(|a| a.to_bytes().starts_with(b"human:"))
                    {
                        match foreign_comms.get("slider") {
                            None => return,
                            Some(entry) => {
                                let state = entry.state.as_object().expect("state");
                                assert!(
                                    !state.contains_key("value"),
                                    "kernel-authored value must be stripped, got {:?}",
                                    state
                                );
                                return;
                            }
                        }
                    }
                }
            }
            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                let _ = donor
                    .doc
                    .sync()
                    .receive_sync_message(&mut donor_sync, reply);
            }
        }
        panic!("sync never converged");
    }

    #[test]
    fn foreign_sync_view_none_for_handshake() {
        let mut receiver = RuntimeStateDoc::new();
        let mut receiver_sync = sync::State::new();
        let mut peer = RuntimeStateDoc::new();
        let mut peer_sync = sync::State::new();

        if let Some(msg) = peer.generate_sync_message(&mut peer_sync) {
            let view = receiver
                .receive_sync_and_foreign_comms(&mut receiver_sync, msg, |_| true)
                .expect("handshake");
            assert!(view.applied_actors.is_empty());
            assert!(view.foreign_comms.is_none());
        }
    }

    #[test]
    fn foreign_sync_view_none_when_all_self_authored() {
        let mut receiver = RuntimeStateDoc::new();
        receiver.set_actor("rt:kernel:deadbeef");
        let mut receiver_sync = sync::State::new();

        let mut donor = receiver.fork();
        donor.set_actor("rt:kernel:deadbeef");
        donor
            .put_comm("w", "j.w", "", "", &serde_json::json!({}), 0)
            .unwrap();

        let mut donor_sync = sync::State::new();
        for _ in 0..4 {
            if let Some(msg) = donor.doc.sync().generate_sync_message(&mut donor_sync) {
                let view = receiver
                    .receive_sync_and_foreign_comms(&mut receiver_sync, msg, |actor| {
                        !actor.to_bytes().starts_with(b"rt:kernel:")
                    })
                    .expect("receive");
                if !view.applied_actors.is_empty() {
                    assert!(
                        view.foreign_comms.is_none(),
                        "all-self-authored message should produce no foreign view"
                    );
                    return;
                }
            }
            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                let _ = donor
                    .doc
                    .sync()
                    .receive_sync_message(&mut donor_sync, reply);
            }
        }
        panic!("sync never converged");
    }

    #[test]
    fn display_index_add_and_lookup() {
        let mut sd = RuntimeStateDoc::new();
        sd.add_display_index_entry("disp-1", "exec-a", "out-1");
        sd.add_display_index_entry("disp-1", "exec-b", "out-2");
        sd.add_display_index_entry("disp-2", "exec-a", "out-3");

        let entries1 = sd.get_display_index_entries("disp-1");
        assert_eq!(entries1.len(), 2);
        assert_eq!(entries1[0], ("exec-a".to_string(), "out-1".to_string()));
        assert_eq!(entries1[1], ("exec-b".to_string(), "out-2".to_string()));

        let entries2 = sd.get_display_index_entries("disp-2");
        assert_eq!(entries2.len(), 1);
        assert_eq!(entries2[0], ("exec-a".to_string(), "out-3".to_string()));

        assert!(sd.get_display_index_entries("no-such").is_empty());
    }

    #[test]
    fn display_index_remove_for_execution() {
        let mut sd = RuntimeStateDoc::new();
        sd.add_display_index_entry("disp-1", "exec-a", "out-1");
        sd.add_display_index_entry("disp-1", "exec-b", "out-2");
        sd.add_display_index_entry("disp-2", "exec-a", "out-3");

        sd.remove_display_index_entries_for_execution("exec-a");

        let entries1 = sd.get_display_index_entries("disp-1");
        assert_eq!(entries1.len(), 1);
        assert_eq!(entries1[0], ("exec-b".to_string(), "out-2".to_string()));

        // disp-2 key should be entirely removed (no entries left)
        assert!(sd.get_display_index_entries("disp-2").is_empty());
    }

    #[test]
    fn append_output_populates_display_index() {
        let mut sd = RuntimeStateDoc::new();
        sd.create_execution("exec-1").unwrap();

        let manifest = serde_json::json!({
            "output_type": "display_data",
            "output_id": "oid-1",
            "data": {"text/plain": {"inline": "hello"}},
            "transient": {"display_id": "disp-A"}
        });
        sd.append_output("exec-1", &manifest).unwrap();

        let entries = sd.get_display_index_entries("disp-A");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0], ("exec-1".to_string(), "oid-1".to_string()));
    }

    #[test]
    fn output_id_in_append_round_trips_through_crdt() {
        let mut sd = RuntimeStateDoc::new();
        sd.create_execution("exec-1").unwrap();

        let manifest = serde_json::json!({
            "output_type": "stream",
            "output_id": "my-uuid-123",
            "name": "stdout",
            "text": {"inline": "hi\n"}
        });
        sd.append_output("exec-1", &manifest).unwrap();

        let outputs = sd.get_outputs("exec-1");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["output_id"], "my-uuid-123");
    }

    #[test]
    fn get_output_reads_exact_manifest_by_id() {
        let mut sd = RuntimeStateDoc::new();
        sd.create_execution("exec-1").unwrap();

        let m1 = serde_json::json!({
            "output_type": "stream",
            "output_id": "stdout-1",
            "name": "stdout",
            "text": {"inline": "first\n"}
        });
        let m2 = serde_json::json!({
            "output_type": "display_data",
            "output_id": "display-1",
            "data": {"text/plain": {"inline": "second"}},
            "metadata": {},
            "transient": {"display_id": "disp-1"}
        });
        sd.append_output("exec-1", &m1).unwrap();
        sd.append_output("exec-1", &m2).unwrap();

        assert_eq!(sd.get_output("exec-1", "display-1"), Some(m2));
        assert!(sd.get_output("exec-1", "missing").is_none());
        assert!(sd.get_output("missing-exec", "display-1").is_none());
    }

    #[test]
    fn append_outputs_updates_output_order_cache() {
        let mut sd = RuntimeStateDoc::new();
        sd.create_execution("exec-1").unwrap();

        let manifests = vec![
            serde_json::json!({
                "output_type": "stream",
                "output_id": "out-1",
                "name": "stdout",
                "text": {"inline": "one\n"}
            }),
            serde_json::json!({
                "output_type": "stream",
                "output_id": "out-2",
                "name": "stdout",
                "text": {"inline": "two\n"}
            }),
        ];
        sd.append_outputs("exec-1", &manifests).unwrap();

        let order = sd.output_order_cache.get("exec-1").unwrap();
        assert_eq!(order.next_seq, 2);
        assert_eq!(order.latest_seq, Some(1));

        let next = serde_json::json!({
            "output_type": "stream",
            "output_id": "out-3",
            "name": "stdout",
            "text": {"inline": "three\n"}
        });
        sd.append_output("exec-1", &next).unwrap();

        let outputs = sd.get_outputs("exec-1");
        assert_eq!(
            outputs
                .iter()
                .map(|output| output["output_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["out-1", "out-2", "out-3"]
        );
        let order = sd.output_order_cache.get("exec-1").unwrap();
        assert_eq!(order.next_seq, 3);
        assert_eq!(order.latest_seq, Some(2));
    }

    #[test]
    fn append_output_backfills_empty_output_order_cache() {
        let mut sd = RuntimeStateDoc::new();
        sd.create_execution("exec-1").unwrap();

        let first = serde_json::json!({
            "output_type": "stream",
            "output_id": "out-1",
            "name": "stdout",
            "text": {"inline": "one\n"}
        });
        let second = serde_json::json!({
            "output_type": "stream",
            "output_id": "out-2",
            "name": "stdout",
            "text": {"inline": "two\n"}
        });
        sd.append_outputs("exec-1", &[first, second]).unwrap();
        sd.output_order_cache.clear();

        let third = serde_json::json!({
            "output_type": "stream",
            "output_id": "out-3",
            "name": "stdout",
            "text": {"inline": "three\n"}
        });
        sd.append_output("exec-1", &third).unwrap();

        let outputs = sd.get_outputs("exec-1");
        assert_eq!(
            outputs
                .iter()
                .map(|output| output["output_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["out-1", "out-2", "out-3"]
        );
        let order = sd.output_order_cache.get("exec-1").unwrap();
        assert_eq!(order.next_seq, 3);
        assert_eq!(order.latest_seq, Some(2));
    }

    #[test]
    fn stream_coalescence_preserves_distinct_output_ids() {
        let mut sd = RuntimeStateDoc::new();
        sd.create_execution("exec-1").unwrap();

        let m1 = serde_json::json!({
            "output_type": "stream",
            "output_id": "oid-stdout-1",
            "name": "stdout",
            "text": {"inline": "line1\n"}
        });
        let m2 = serde_json::json!({
            "output_type": "stream",
            "output_id": "oid-stderr-1",
            "name": "stderr",
            "text": {"inline": "err\n"}
        });
        let m3 = serde_json::json!({
            "output_type": "stream",
            "output_id": "oid-stdout-2",
            "name": "stdout",
            "text": {"inline": "line2\n"}
        });
        sd.append_output("exec-1", &m1).unwrap();
        sd.append_output("exec-1", &m2).unwrap();
        sd.append_output("exec-1", &m3).unwrap();

        let outputs = sd.get_outputs("exec-1");
        assert_eq!(outputs.len(), 3);
        assert_eq!(outputs[0]["output_id"], "oid-stdout-1");
        assert_eq!(outputs[1]["output_id"], "oid-stderr-1");
        assert_eq!(outputs[2]["output_id"], "oid-stdout-2");
        // Two stdout chunks must have distinct IDs
        assert_ne!(outputs[0]["output_id"], outputs[2]["output_id"]);
    }

    #[test]
    fn test_compact_if_oversized_below_threshold() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        // Doc is tiny — should not compact
        assert!(!doc.compact_if_oversized(1024 * 1024));
    }

    #[test]
    fn test_compact_if_oversized_above_threshold() {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))
            .unwrap();
        // Threshold of 0 forces compaction
        assert!(doc.compact_if_oversized(0));
        // State is preserved after compaction
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );
    }

    // ── RuntimeLifecycle writers ────────────────────────────────────

    #[test]
    fn set_lifecycle_round_trip() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();

        doc.set_lifecycle(&RuntimeLifecycle::Resolving)?;
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Resolving
        );

        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );

        doc.set_lifecycle(&RuntimeLifecycle::Shutdown)?;
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Shutdown
        );
        Ok(())
    }

    #[test]
    fn set_lifecycle_clears_stale_activity_on_leaving_running() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))?;
        doc.set_lifecycle(&RuntimeLifecycle::Shutdown)?;
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Shutdown
        );
        // A subsequent Running(Idle) must not resurrect stale Busy.
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );
        Ok(())
    }

    #[test]
    fn set_activity_is_noop_when_unchanged() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;

        let heads_before = doc.get_heads();
        doc.set_activity(KernelActivity::Idle)?;
        assert_eq!(
            heads_before,
            doc.get_heads(),
            "redundant Idle → Idle must not advance heads (throttle invariant)"
        );

        doc.set_activity(KernelActivity::Busy)?;
        assert_ne!(
            heads_before,
            doc.get_heads(),
            "Idle → Busy must advance heads"
        );
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy)
        );
        Ok(())
    }

    #[test]
    fn set_activity_preserves_unknown() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))?;
        doc.set_activity(KernelActivity::Unknown)?;
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Unknown)
        );
        Ok(())
    }

    #[test]
    fn set_lifecycle_preserves_error_reason() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle_with_error(
            &RuntimeLifecycle::Error,
            Some(KernelErrorReason::MissingIpykernel),
        )?;
        assert_eq!(
            doc.read_state().kernel.error_reason.as_deref(),
            Some("missing_ipykernel")
        );

        // Re-enter Error via the plain setter — reason must NOT be clobbered.
        doc.set_lifecycle(&RuntimeLifecycle::Error)?;
        assert_eq!(
            doc.read_state().kernel.error_reason.as_deref(),
            Some("missing_ipykernel"),
            "set_lifecycle must not touch error_reason — retry paths depend on this"
        );

        // Transition to a non-error state via the plain setter — still preserved.
        doc.set_lifecycle(&RuntimeLifecycle::NotStarted)?;
        assert_eq!(
            doc.read_state().kernel.error_reason.as_deref(),
            Some("missing_ipykernel"),
            "set_lifecycle still does not touch error_reason even across non-Error transitions"
        );
        Ok(())
    }

    #[test]
    fn set_lifecycle_with_error_clears_on_none() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle_with_error(
            &RuntimeLifecycle::Error,
            Some(KernelErrorReason::MissingIpykernel),
        )?;
        doc.set_lifecycle_with_error(&RuntimeLifecycle::NotStarted, None)?;
        assert_eq!(doc.read_state().kernel.error_reason.as_deref(), Some(""));
        Ok(())
    }

    #[test]
    fn set_lifecycle_with_error_second_call_updates_reason() -> Result<(), RuntimeStateError> {
        // Only one variant today; exercise the overwrite path by toggling
        // Some(MissingIpykernel) -> None -> Some(MissingIpykernel).
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle_with_error(
            &RuntimeLifecycle::Error,
            Some(KernelErrorReason::MissingIpykernel),
        )?;
        assert_eq!(
            doc.read_state().kernel.error_reason.as_deref(),
            Some("missing_ipykernel")
        );
        doc.set_lifecycle_with_error(&RuntimeLifecycle::Error, None)?;
        assert_eq!(doc.read_state().kernel.error_reason.as_deref(), Some(""));
        doc.set_lifecycle_with_error(
            &RuntimeLifecycle::Error,
            Some(KernelErrorReason::MissingIpykernel),
        )?;
        assert_eq!(
            doc.read_state().kernel.error_reason.as_deref(),
            Some("missing_ipykernel")
        );
        Ok(())
    }

    #[test]
    fn fork_merge_concurrent_lifecycle_writes() -> Result<(), RuntimeStateError> {
        // Two forks write different lifecycles, then merge. Automerge picks
        // a winner deterministically. This test pins the behavior rather
        // than prescribing it — a future regression that flips the winner
        // will surface here.
        let mut main = RuntimeStateDoc::new_with_actor("runtimed:state:test:main");
        main.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;

        let mut fork = main.fork_with_actor("runtimed:state:test:fork");
        fork.set_lifecycle(&RuntimeLifecycle::Resolving)?;

        main.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))?;

        main.merge(&mut fork).ok();

        let s = main.read_state().kernel;
        // Whichever lifecycle wins the conflict, the output must parse as
        // a valid RuntimeLifecycle — no garbage leaking through.
        match s.lifecycle {
            RuntimeLifecycle::Running(_)
            | RuntimeLifecycle::Resolving
            | RuntimeLifecycle::NotStarted => {}
            other => panic!("unexpected post-merge lifecycle: {:?}", other),
        }
        Ok(())
    }

    #[test]
    fn bootstrap_doc_reads_as_not_started() {
        let doc = RuntimeStateDoc::new_empty();
        let s = doc.read_state().kernel;
        assert_eq!(s.status, KernelState::default().status);
        assert_eq!(s.starting_phase, KernelState::default().starting_phase);
        assert_eq!(s.lifecycle, RuntimeLifecycle::NotStarted);
        assert_eq!(s.error_reason, Some(String::new()));
        assert_eq!(s.error_details, Some(String::new()));
    }

    #[test]
    fn scaffolded_doc_reads_lifecycle_from_crdt() {
        let doc = RuntimeStateDoc::new();
        let s = doc.read_state().kernel;
        assert_eq!(s.lifecycle, RuntimeLifecycle::NotStarted);
        assert_eq!(
            s.error_reason.as_deref(),
            Some(""),
            "scaffolded error_reason must be Some(\"\"), not None"
        );
    }

    #[test]
    fn set_lifecycle_error_with_reason() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle_with_error(
            &RuntimeLifecycle::Error,
            Some(KernelErrorReason::MissingIpykernel),
        )?;
        let s = doc.read_state().kernel;
        assert_eq!(s.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(s.error_reason.as_deref(), Some("missing_ipykernel"));
        Ok(())
    }

    #[test]
    fn set_lifecycle_awaiting_trust_clears_activity() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))?;
        doc.set_lifecycle(&RuntimeLifecycle::AwaitingTrust)?;
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::AwaitingTrust
        );
        Ok(())
    }

    #[test]
    fn all_lifecycle_variants_round_trip_through_crdt() -> Result<(), RuntimeStateError> {
        let variants = [
            RuntimeLifecycle::NotStarted,
            RuntimeLifecycle::AwaitingTrust,
            RuntimeLifecycle::AwaitingEnvBuild,
            RuntimeLifecycle::Resolving,
            RuntimeLifecycle::PreparingEnv,
            RuntimeLifecycle::Launching,
            RuntimeLifecycle::Connecting,
            RuntimeLifecycle::Running(KernelActivity::Unknown),
            RuntimeLifecycle::Running(KernelActivity::Idle),
            RuntimeLifecycle::Running(KernelActivity::Busy),
            RuntimeLifecycle::Error,
            RuntimeLifecycle::Shutdown,
        ];
        for v in &variants {
            let mut doc = RuntimeStateDoc::new();
            doc.set_lifecycle(v)?;
            assert_eq!(
                &doc.read_state().kernel.lifecycle,
                v,
                "round-trip failed for {v:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn set_activity_republishes_running_lifecycle() -> Result<(), RuntimeStateError> {
        // A real idle/busy signal is live-kernel evidence. It must publish the
        // typed lifecycle as Running so read-only replicas can converge away
        // from any retained terminal branch after room wake.
        let mut doc = RuntimeStateDoc::new();
        doc.set_activity(KernelActivity::Busy)?;

        let k = doc.read_state().kernel;
        assert_eq!(
            k.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy),
            "activity must publish the running lifecycle"
        );
        Ok(())
    }

    #[test]
    fn running_with_empty_activity_reads_as_unknown() -> Result<(), RuntimeStateError> {
        // A Running lifecycle written without a following set_activity
        // (activity stays "" from the scaffold or from the clear on
        // leaving Running previously) must read as Running(Unknown),
        // because that's the fallback when the activity key is empty.
        let mut doc = RuntimeStateDoc::new();
        doc.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Busy))?;
        doc.set_lifecycle(&RuntimeLifecycle::Shutdown)?;
        // activity is now "" from the Shutdown transition. Flip lifecycle
        // back to Running directly via the CRDT so we can observe the
        // "Running + empty activity" read state.
        let kernel = doc.get_map("kernel").expect("kernel map");
        doc.doc
            .put(&kernel, "lifecycle", "Running")
            .expect("raw put lifecycle");
        let k = doc.read_state().kernel;
        assert_eq!(
            k.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Unknown),
            "Running with no activity key reads as Unknown, not a crash or garbage"
        );
        Ok(())
    }

    #[test]
    fn lifecycle_survives_sync_between_docs() -> Result<(), RuntimeStateError> {
        // Beyond the single-value sync test, pin that several
        // representative lifecycle variants all survive a sync round
        // between daemon and client docs.
        for lc in [
            RuntimeLifecycle::Resolving,
            RuntimeLifecycle::Running(KernelActivity::Busy),
            RuntimeLifecycle::Running(KernelActivity::Unknown),
            RuntimeLifecycle::AwaitingEnvBuild,
            RuntimeLifecycle::Error,
            RuntimeLifecycle::Shutdown,
        ] {
            let mut daemon_doc = RuntimeStateDoc::new();
            daemon_doc.set_lifecycle(&lc)?;

            let mut client_doc = RuntimeStateDoc::new_empty();
            let mut daemon_sync = sync::State::new();
            let mut client_sync = sync::State::new();

            for _ in 0..10 {
                if let Some(msg) = daemon_doc.generate_sync_message(&mut daemon_sync) {
                    client_doc
                        .doc_mut()
                        .sync()
                        .receive_sync_message(&mut client_sync, msg)
                        .expect("client receive");
                }
                if let Some(msg) = client_doc
                    .doc_mut()
                    .sync()
                    .generate_sync_message(&mut client_sync)
                {
                    daemon_doc
                        .receive_sync_message(&mut daemon_sync, msg)
                        .expect("daemon receive");
                }
            }

            assert_eq!(
                client_doc.read_state().kernel.lifecycle,
                lc,
                "sync lost lifecycle {lc:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn doc_without_kernel_lifecycle_key_defaults_to_not_started() -> Result<(), RuntimeStateError> {
        // A doc whose kernel map exists but lacks the lifecycle key
        // (corruption, external mutation) must read as NotStarted rather
        // than crashing or returning garbage.
        use automerge::{transaction::Transactable, AutoCommit, ObjType, ROOT};

        let mut raw = AutoCommit::new();
        let kernel = raw
            .put_object(&ROOT, "kernel", ObjType::Map)
            .expect("scaffold kernel");
        raw.put(&kernel, "name", "").expect("name");
        raw.put(&kernel, "language", "").expect("language");
        raw.put(&kernel, "env_source", "").expect("env_source");
        raw.put(&kernel, "runtime_agent_id", "")
            .expect("runtime_agent_id");

        let doc = RuntimeStateDoc::from_doc(raw);
        let k = doc.read_state().kernel;
        assert_eq!(k.lifecycle, RuntimeLifecycle::NotStarted);
        assert_eq!(k.error_reason, None);
        Ok(())
    }

    #[test]
    fn pre_typed_doc_reads_lifecycle_from_string_shape() -> Result<(), RuntimeStateError> {
        // A runtime-state doc authored before the typed keys were added
        // carries only kernel.status + kernel.starting_phase. read_state
        // must derive the lifecycle from that pair rather than returning
        // the scaffold default NotStarted. This is the cross-version
        // compat path for captured test fixtures and any in-flight sync
        // frame from an older producer.
        use automerge::{transaction::Transactable, AutoCommit, ObjType, ROOT};

        let mut raw = AutoCommit::new();
        let kernel = raw
            .put_object(&ROOT, "kernel", ObjType::Map)
            .expect("scaffold kernel");
        raw.put(&kernel, "status", "busy")
            .expect("pre-typed status");
        raw.put(&kernel, "starting_phase", "")
            .expect("pre-typed starting_phase");
        raw.put(&kernel, "name", "").expect("name");
        raw.put(&kernel, "language", "").expect("language");
        raw.put(&kernel, "env_source", "").expect("env_source");
        raw.put(&kernel, "runtime_agent_id", "")
            .expect("runtime_agent_id");
        // Deliberately DO NOT write kernel/lifecycle or kernel/activity.

        let doc = RuntimeStateDoc::from_doc(raw);
        let k = doc.read_state().kernel;
        assert_eq!(
            k.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy),
            "pre-typed doc (string shape only) must read as Running(Busy)"
        );
        Ok(())
    }

    #[test]
    fn typed_write_clears_stale_legacy_keys() -> Result<(), RuntimeStateError> {
        // A doc hydrated from pre-typed bytes carries `kernel.status =
        // "busy"` with no typed keys. The first set_lifecycle(Error)
        // must make the read authoritative: the stale legacy keys get
        // cleared as part of the write, and resolve_lifecycle sees only
        // the typed state.
        use automerge::{transaction::Transactable, AutoCommit, ObjType, ROOT};

        let mut raw = AutoCommit::new();
        let kernel = raw
            .put_object(&ROOT, "kernel", ObjType::Map)
            .expect("scaffold kernel");
        raw.put(&kernel, "status", "busy").expect("status");
        raw.put(&kernel, "starting_phase", "")
            .expect("starting_phase");
        raw.put(&kernel, "name", "").expect("name");
        raw.put(&kernel, "language", "").expect("language");
        raw.put(&kernel, "env_source", "").expect("env_source");
        raw.put(&kernel, "runtime_agent_id", "")
            .expect("runtime_agent_id");

        let mut doc = RuntimeStateDoc::from_doc(raw);
        // Pre-typed shape reads correctly via the fallback.
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Busy)
        );

        // Typed write transitions to Error and clears the stale legacy
        // keys. A naive writer that only wrote the typed key would
        // leave `status = "busy"` behind, which resolve_lifecycle's
        // mismatch fallback would incorrectly prefer over the fresh
        // Error state.
        doc.set_lifecycle(&RuntimeLifecycle::Error)?;
        let k = doc.read_state().kernel;
        assert_eq!(k.lifecycle, RuntimeLifecycle::Error);
        // Projected status is now "error" (from lifecycle), not "busy".
        assert_eq!(k.status, "error");
        assert_eq!(k.starting_phase, "");
        Ok(())
    }

    #[test]
    fn set_activity_clears_stale_legacy_keys_on_pre_typed_doc() -> Result<(), RuntimeStateError> {
        // jupyter_kernel sends idle/busy updates via set_activity. A
        // doc hydrated from pre-typed bytes carries status="starting"
        // + starting_phase="connecting"; the first IOPub activity must
        // not leave the read stuck in Connecting just because the hot
        // path skipped clearing the legacy keys.
        use automerge::{transaction::Transactable, AutoCommit, ObjType, ROOT};

        let mut raw = AutoCommit::new();
        let kernel = raw
            .put_object(&ROOT, "kernel", ObjType::Map)
            .expect("scaffold kernel");
        raw.put(&kernel, "status", "starting").expect("status");
        raw.put(&kernel, "starting_phase", "connecting")
            .expect("starting_phase");
        raw.put(&kernel, "name", "").expect("name");
        raw.put(&kernel, "language", "").expect("language");
        raw.put(&kernel, "env_source", "").expect("env_source");
        raw.put(&kernel, "runtime_agent_id", "")
            .expect("runtime_agent_id");

        let mut doc = RuntimeStateDoc::from_doc(raw);
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Connecting,
            "pre-typed Connecting reads via fallback"
        );

        // First IOPub idle update. Must converge the doc to the typed
        // shape, even without a preceding set_lifecycle.
        doc.set_activity(KernelActivity::Idle)?;
        let k = doc.read_state().kernel;
        // lifecycle key is still unset (typed writers only set it via
        // set_lifecycle). resolve_lifecycle sees empty typed keys plus
        // cleared legacy keys and falls through to NotStarted. That's
        // a caller-contract issue: set_activity without a preceding
        // set_lifecycle is not a supported pattern, but we still must
        // not leave a stale "Connecting" reading from the old legacy
        // shape.
        assert_ne!(
            k.lifecycle,
            RuntimeLifecycle::Connecting,
            "stale legacy Connecting must not survive an activity update"
        );
        assert_eq!(k.starting_phase, "", "legacy starting_phase cleared");
        Ok(())
    }

    #[test]
    fn pre_typed_doc_recovers_error_reason_from_starting_phase() -> Result<(), RuntimeStateError> {
        // Pre-typed docs encoded the error reason via starting_phase.
        // NotebookToolbar gates the pixi install prompt on
        // kernel.error_reason, so the read must surface the legacy
        // reason when the typed error_reason key is absent.
        use automerge::{transaction::Transactable, AutoCommit, ObjType, ROOT};

        let mut raw = AutoCommit::new();
        let kernel = raw
            .put_object(&ROOT, "kernel", ObjType::Map)
            .expect("scaffold kernel");
        raw.put(&kernel, "status", "error").expect("status");
        raw.put(&kernel, "starting_phase", "missing_ipykernel")
            .expect("starting_phase");
        raw.put(&kernel, "name", "").expect("name");
        raw.put(&kernel, "language", "").expect("language");
        raw.put(&kernel, "env_source", "pixi:toml")
            .expect("env_source");
        raw.put(&kernel, "runtime_agent_id", "")
            .expect("runtime_agent_id");
        // Deliberately DO NOT write kernel/error_reason; the reason
        // lives in starting_phase in the pre-typed shape.

        let doc = RuntimeStateDoc::from_doc(raw);
        let k = doc.read_state().kernel;
        assert_eq!(k.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(
            k.error_reason.as_deref(),
            Some("missing_ipykernel"),
            "legacy starting_phase reason must surface as error_reason"
        );
        Ok(())
    }

    #[test]
    fn pre_typed_doc_reads_starting_sub_phase() -> Result<(), RuntimeStateError> {
        // starting_phase carries the sub-state in the pre-typed shape;
        // the fallback must preserve it.
        use automerge::{transaction::Transactable, AutoCommit, ObjType, ROOT};

        let mut raw = AutoCommit::new();
        let kernel = raw
            .put_object(&ROOT, "kernel", ObjType::Map)
            .expect("scaffold kernel");
        raw.put(&kernel, "status", "starting").expect("status");
        raw.put(&kernel, "starting_phase", "launching")
            .expect("starting_phase");
        raw.put(&kernel, "name", "").expect("name");
        raw.put(&kernel, "language", "").expect("language");
        raw.put(&kernel, "env_source", "").expect("env_source");
        raw.put(&kernel, "runtime_agent_id", "")
            .expect("runtime_agent_id");

        let doc = RuntimeStateDoc::from_doc(raw);
        assert_eq!(
            doc.read_state().kernel.lifecycle,
            RuntimeLifecycle::Launching
        );
        Ok(())
    }

    // ── Project context ─────────────────────────────────────────────

    #[test]
    fn project_context_scaffolds_as_pending() {
        let doc = RuntimeStateDoc::new();
        assert_eq!(doc.project_context(), ProjectContext::Pending);
    }

    #[test]
    fn project_context_new_with_actor_scaffolds_as_pending() {
        let doc = RuntimeStateDoc::new_with_actor("test-actor");
        assert_eq!(doc.project_context(), ProjectContext::Pending);
    }

    #[test]
    fn project_context_new_empty_is_pending_from_schema_seed() {
        // new_empty() uses the canonical schema seed. Before the daemon
        // writes project context, readers should treat that scaffold as Pending.
        let doc = RuntimeStateDoc::new_empty();
        assert_eq!(doc.project_context(), ProjectContext::Pending);
    }

    #[test]
    fn project_context_round_trips_not_found() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        let ctx = ProjectContext::NotFound {
            observed_at: "2026-04-25T12:00:00Z".into(),
        };
        doc.set_project_context(&ctx)?;
        assert_eq!(doc.project_context(), ctx);
        Ok(())
    }

    #[test]
    fn project_context_round_trips_detected_pyproject() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        let ctx = ProjectContext::Detected {
            project_file: ProjectFile {
                kind: ProjectFileKind::PyprojectToml,
                absolute_path: "/abs/pyproject.toml".into(),
                relative_to_notebook: "../pyproject.toml".into(),
            },
            parsed: ProjectFileParsed {
                dependencies: vec!["pandas>=2.0".into(), "numpy".into()],
                dev_dependencies: vec![],
                requires_python: Some(">=3.10".into()),
                prerelease: None,
                extras: ProjectFileExtras::None,
            },
            observed_at: "2026-04-25T12:00:00Z".into(),
        };
        doc.set_project_context(&ctx)?;
        assert_eq!(doc.project_context(), ctx);
        Ok(())
    }

    #[test]
    fn project_context_round_trips_detected_pixi_with_extras() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        let ctx = ProjectContext::Detected {
            project_file: ProjectFile {
                kind: ProjectFileKind::PixiToml,
                absolute_path: "/abs/pixi.toml".into(),
                relative_to_notebook: "pixi.toml".into(),
            },
            parsed: ProjectFileParsed {
                dependencies: vec!["python=3.11".into()],
                dev_dependencies: vec![],
                requires_python: None,
                prerelease: None,
                extras: ProjectFileExtras::Pixi {
                    channels: vec!["conda-forge".into()],
                    pypi_dependencies: vec!["requests".into()],
                },
            },
            observed_at: "2026-04-25T12:00:00Z".into(),
        };
        doc.set_project_context(&ctx)?;
        assert_eq!(doc.project_context(), ctx);
        Ok(())
    }

    #[test]
    fn project_context_round_trips_detected_environment_yml_with_pip(
    ) -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        let ctx = ProjectContext::Detected {
            project_file: ProjectFile {
                kind: ProjectFileKind::EnvironmentYml,
                absolute_path: "/abs/environment.yml".into(),
                relative_to_notebook: "../environment.yml".into(),
            },
            parsed: ProjectFileParsed {
                dependencies: vec!["numpy".into(), "scipy".into()],
                dev_dependencies: vec![],
                requires_python: None,
                prerelease: None,
                extras: ProjectFileExtras::EnvironmentYml {
                    channels: vec!["conda-forge".into()],
                    pip: vec!["httpx".into()],
                },
            },
            observed_at: "2026-04-25T12:00:00Z".into(),
        };
        doc.set_project_context(&ctx)?;
        assert_eq!(doc.project_context(), ctx);
        Ok(())
    }

    #[test]
    fn project_context_round_trips_unreadable() -> Result<(), RuntimeStateError> {
        let mut doc = RuntimeStateDoc::new();
        let ctx = ProjectContext::Unreadable {
            path: "/abs/pyproject.toml".into(),
            reason: "parse error at line 3".into(),
            observed_at: "2026-04-25T12:00:00Z".into(),
        };
        doc.set_project_context(&ctx)?;
        assert_eq!(doc.project_context(), ctx);
        Ok(())
    }

    #[test]
    fn project_context_transitions_clear_previous_fields() -> Result<(), RuntimeStateError> {
        // Write Detected, then NotFound. The Detected-specific fields
        // (kind, absolute_path, parsed.dependencies, ...) must all clear
        // so the subsequent read doesn't show ghost data.
        let mut doc = RuntimeStateDoc::new();
        doc.set_project_context(&ProjectContext::Detected {
            project_file: ProjectFile {
                kind: ProjectFileKind::PyprojectToml,
                absolute_path: "/abs/pyproject.toml".into(),
                relative_to_notebook: "../pyproject.toml".into(),
            },
            parsed: ProjectFileParsed {
                dependencies: vec!["pandas".into()],
                dev_dependencies: vec![],
                requires_python: Some(">=3.10".into()),
                prerelease: None,
                extras: ProjectFileExtras::None,
            },
            observed_at: "t0".into(),
        })?;
        doc.set_project_context(&ProjectContext::NotFound {
            observed_at: "t1".into(),
        })?;
        assert_eq!(
            doc.project_context(),
            ProjectContext::NotFound {
                observed_at: "t1".into(),
            }
        );
        Ok(())
    }

    #[test]
    fn read_state_exposes_project_context() -> Result<(), RuntimeStateError> {
        // Snapshot consumers (WASM, Python, MCP) read via read_state().
        // The field has to travel through that path; a separate accessor
        // would go unnoticed by every existing client.
        let mut doc = RuntimeStateDoc::new();
        let ctx = ProjectContext::Detected {
            project_file: ProjectFile {
                kind: ProjectFileKind::PyprojectToml,
                absolute_path: "/abs/pyproject.toml".into(),
                relative_to_notebook: "../pyproject.toml".into(),
            },
            parsed: ProjectFileParsed::default(),
            observed_at: "t0".into(),
        };
        doc.set_project_context(&ctx)?;
        assert_eq!(doc.read_state().project_context, ctx);
        Ok(())
    }

    #[test]
    fn read_state_project_context_defaults_to_pending() {
        // Daemon and client bootstrap docs both report `Pending`. Nothing
        // between the scaffold and the first daemon write should look like
        // `Detected`.
        assert_eq!(
            RuntimeStateDoc::new().read_state().project_context,
            ProjectContext::Pending
        );
        assert_eq!(
            RuntimeStateDoc::new_empty().read_state().project_context,
            ProjectContext::Pending
        );
    }

    #[test]
    fn project_context_unparseable_kind_degrades_to_pending() -> Result<(), RuntimeStateError> {
        // A future schema version or a corrupt frame could leave
        // `state="detected"` with a `kind` string we don't recognise.
        // Silently mapping that to PyprojectToml would mislead consumers
        // into kind-specific logic. Degrade to Pending instead.
        let mut doc = RuntimeStateDoc::new();
        let pc = doc.scaffold_map("project_context")?;
        doc.doc.put(&pc, "state", "detected")?;
        doc.doc.put(&pc, "kind", "some_future_kind")?;
        doc.doc.put(&pc, "absolute_path", "/abs/future")?;
        doc.doc.put(&pc, "relative_to_notebook", "../future")?;
        doc.doc.put(&pc, "observed_at", "t0")?;
        assert_eq!(doc.project_context(), ProjectContext::Pending);
        Ok(())
    }
}
