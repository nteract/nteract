/**
 * Runtime state types from the daemon's RuntimeStateDoc.
 *
 * Pure module — no React, no Tauri. Consumers that need a reactive store
 * (e.g. React's useSyncExternalStore) build their own on top of these types.
 */

// ── Types ────────────────────────────────────────────────────────────

/**
 * Observable activity of a running kernel.
 *
 * Mirror of `runtime_doc::KernelActivity`. Only meaningful when the
 * runtime lifecycle is `Running`.
 */
export type KernelActivity = "Unknown" | "Idle" | "Busy";

/**
 * Typed reason accompanying a [`RuntimeLifecycle`] `Error` transition.
 *
 * Mirror of `runtime_doc::KernelErrorReason`. The daemon writes one of
 * these strings to `kernel.error_reason`; readers can use the exported
 * [`KERNEL_ERROR_REASON`] constants instead of bare string literals when
 * gating UI on a specific cause.
 */
export type KernelErrorReasonKey =
  | "environment_prepare_failed"
  | "missing_ipykernel"
  | "dependency_cache_missing_ipykernel"
  | "ipykernel_site_packages_mismatch"
  | "conda_env_yml_missing"
  | "conda_env_build_failed";

/**
 * Typed error-reason strings. Mirrors `KernelErrorReason::as_str()` on
 * the Rust side — both ends use the same literal so the CRDT value is
 * unambiguous.
 */
export const KERNEL_ERROR_REASON = {
  ENVIRONMENT_PREPARE_FAILED: "environment_prepare_failed",
  MISSING_IPYKERNEL: "missing_ipykernel",
  DEPENDENCY_CACHE_MISSING_IPYKERNEL: "dependency_cache_missing_ipykernel",
  IPYKERNEL_SITE_PACKAGES_MISMATCH: "ipykernel_site_packages_mismatch",
  /**
   * environment.yml declares a conda env that isn't built on this
   * machine. Daemon sets this instead of silently falling back to a
   * pool env so the UI can render a specific "build your env" banner.
   * `kernel.error_details` carries the declared env name and the
   * remediation command.
   */
  CONDA_ENV_YML_MISSING: "conda_env_yml_missing",
  /**
   * An approved environment.yml build was attempted but failed (e.g.,
   * channel unreachable, dependency solve error). `kernel.error_details`
   * carries the rattler/conda error message.
   */
  CONDA_ENV_BUILD_FAILED: "conda_env_build_failed",
} as const satisfies Record<string, KernelErrorReasonKey>;

/**
 * Lifecycle of a runtime, from not-started through running to shutdown.
 *
 * Discriminated union on the `lifecycle` tag, matching Rust's serde
 * tag+content format (`#[serde(tag = "lifecycle", content = "activity")]`).
 * Only `Running` carries an `activity` payload — everything else is a
 * lone tag.
 *
 * Mirror of `runtime_doc::RuntimeLifecycle`.
 */
export type RuntimeLifecycle =
  | { lifecycle: "NotStarted" }
  | { lifecycle: "AwaitingTrust" }
  | { lifecycle: "AwaitingEnvBuild" }
  | { lifecycle: "Resolving" }
  | { lifecycle: "PreparingEnv" }
  | { lifecycle: "Launching" }
  | { lifecycle: "Connecting" }
  | { lifecycle: "Running"; activity: KernelActivity }
  | { lifecycle: "Error" }
  | { lifecycle: "Shutdown" };

export interface KernelState {
  /** Typed lifecycle. The authoritative view of kernel state. */
  lifecycle: RuntimeLifecycle;
  /**
   * Typed reason populated for lifecycle states that carry a specific cause
   * such as `Error` or `AwaitingEnvBuild`.
   * `null` when the kernel map is absent; empty string when scaffolded but
   * unset. Most consumers can treat both as "no reason."
   */
  error_reason: string | null;
  /**
   * Free-form details accompanying an error or user-decision state, shown
   * to the user via the banner/dialog. Carries specifics that don't fit in the typed
   * `error_reason` enum — e.g., the name of a conda env declared in
   * environment.yml that isn't built on this machine, with a suggested
   * remediation command. `null`/empty when absent or unset.
   */
  error_details: string | null;
  name: string;
  language: string;
  env_source: string;
}

export interface QueueEntry {
  execution_id: string;
}

export interface QueueState {
  executing: QueueEntry | null;
  queued: QueueEntry[];
}

export interface EnvState {
  in_sync: boolean;
  added: string[];
  removed: string[];
  channels_changed: boolean;
  deno_changed: boolean;
  prewarmed_packages: string[];
  progress: EnvProgressEvent | null;
}

export type EnvProgressEnvType = "conda" | "uv" | "pixi" | (string & {});

export type EnvProgressPhase =
  | { phase: "starting"; env_hash: string }
  | { phase: "cache_hit"; env_path: string }
  | { phase: "lock_file_hit" }
  | { phase: "offline_hit" }
  | { phase: "fetching_repodata"; channels: string[] }
  | { phase: "repodata_complete"; record_count: number; elapsed_ms: number }
  | { phase: "solving"; spec_count: number }
  | { phase: "solve_complete"; package_count: number; elapsed_ms: number }
  | { phase: "installing"; total: number }
  | {
      phase: "download_progress";
      completed: number;
      total: number;
      current_package: string;
      bytes_downloaded: number;
      bytes_total: number | null;
      bytes_per_second: number;
    }
  | {
      phase: "link_progress";
      completed: number;
      total: number;
      current_package: string;
    }
  | { phase: "install_complete"; elapsed_ms: number }
  | { phase: "creating_venv" }
  | { phase: "installing_packages"; packages: string[] }
  | { phase: "project_preparing"; source: string; project_path: string }
  | { phase: "ready"; env_path: string; python_path: string }
  | { phase: "error"; message: string };

export type EnvProgressEvent = EnvProgressPhase & {
  env_type: EnvProgressEnvType;
};

/**
 * Trust status mirrors `runt_trust::TrustStatus` serialized with
 * `rename_all = "snake_case"`.
 */
export type TrustStatus = "trusted" | "untrusted" | "no_dependencies";

export interface TrustState {
  status: TrustStatus;
  needs_approval: boolean;
  approved_uv_dependencies: string[];
  approved_conda_dependencies: string[];
  approved_conda_channels: string[];
  approved_pixi_dependencies: string[];
  approved_pixi_pypi_dependencies: string[];
  approved_pixi_channels: string[];
}

export interface ExecutionState {
  status: "queued" | "running" | "done" | "error";
  execution_count: number | null;
  success: boolean | null;
  /** Notebook cell that submitted this execution, when available. */
  cell_id?: string | null;
  /** Queue sequence number from RuntimeStateDoc; used as execution recency. */
  seq?: number | null;
  /**
   * Output manifests in emission order, as the WASM runtime-state snapshot
   * exposes them. Each entry is the raw on-the-wire manifest (un-narrowed,
   * with `{inline}`/`{blob}` ContentRefs). Resolved manifests live in the
   * per-output store, not here.
   */
  outputs?: unknown[];
}

/**
 * A single sandbox annotation for one execution.
 *
 * Written by the daemon when a sandbox event (HTTP block, credential error,
 * proxy degradation) is correlated with a running or completed execution.
 * The frontend overlays this when rendering the cell.
 *
 * Mirror of `runtime_doc::CellAnnotation`.
 */
export interface CellAnnotation {
  /** Short machine-readable tag, e.g. `"sandbox_http_block"`. */
  kind: string;
  /** Human-readable enrichment string shown in the UI overlay. */
  message: string;
  /** Optional structured payload carrying additional details. */
  details?: unknown;
}

/**
 * Sandbox runtime state for the active kernel session.
 *
 * Mirrors `SandboxStateInfo` from the notebook protocol (task 07).
 * The daemon writes this into RuntimeStateDoc when sandbox state changes.
 */
export type SandboxStateInfo =
  | { state: "Disabled" }
  | { state: "Active"; nono_pid: number; kernel_pid: number }
  | { state: "StartupFailed"; reason: string }
  | { state: "Degraded"; reason: string };

/** Snapshot of a comm channel from RuntimeStateDoc. */
export interface CommDocEntry {
  target_name: string;
  model_module: string;
  model_name: string;
  /** Widget state as a native object (stored as native Automerge map). */
  state: Record<string, unknown>;
  /** Output manifest hashes (OutputModel widgets only). */
  outputs: string[];
  /** Insertion order for dependency-correct replay. */
  seq: number;
}

/** A detected status transition for a single execution. */
export interface ExecutionTransition {
  execution_id: string;
  kind: "started" | "done" | "error";
  execution_count: number | null;
}

/**
 * Kind of project file the daemon walked up and found for the notebook.
 * Mirrors `runtime_doc::ProjectFileKind`.
 */
export type ProjectFileKind = "PyprojectToml" | "PixiToml" | "EnvironmentYml";

/** Pointer to the project file on the daemon's disk. */
export interface ProjectFile {
  kind: ProjectFileKind;
  absolute_path: string;
  relative_to_notebook: string;
}

/**
 * Kind-specific parsed extras. Discriminated by `kind`; matches the
 * Rust `ProjectFileExtras` tagged enum.
 */
export type ProjectFileExtras =
  | { kind: "None" }
  | { kind: "Pixi"; channels: string[]; pypi_dependencies: string[] }
  | { kind: "EnvironmentYml"; channels: string[]; pip: string[] };

/** Snapshot of the daemon's parse of a detected project file. */
export interface ProjectFileParsed {
  dependencies: string[];
  /**
   * Dev-only dependencies. Populated from pyproject.toml's
   * `[tool.uv].dev-dependencies` and `[dependency-groups].dev`; always
   * empty for pixi and environment.yml (they carry their own sublists in
   * `extras`).
   */
  dev_dependencies: string[];
  requires_python: string | null;
  prerelease: string | null;
  extras: ProjectFileExtras;
}

/**
 * Daemon-observed project-file context for a notebook, discriminated
 * by `state`. Matches the Rust `ProjectContext` tagged enum. Untitled
 * notebooks and fresh peers see `Pending` until the first daemon write
 * arrives via sync.
 */
export type ProjectContext =
  | { state: "Pending" }
  | { state: "NotFound"; observed_at: string }
  | {
      state: "Detected";
      project_file: ProjectFile;
      parsed: ProjectFileParsed;
      observed_at: string;
    }
  | {
      state: "Unreadable";
      path: string;
      reason: string;
      observed_at: string;
    };

/**
 * Room-host-owned snapshot of the workstation selected for this notebook
 * room. The daemon/room host writes this into RuntimeStateDoc so late joiners
 * can see compute attachment state without polling a separate registry.
 */
export interface WorkstationAttachmentState {
  workstation_id: string;
  display_name: string;
  provider: string;
  default_environment_label: string;
  environment_policy: string;
  status: string;
  status_message?: string | null;
  cpu_count?: number | null;
  memory_bytes?: number | null;
  working_directory?: string | null;
  updated_at?: string | null;
}

export interface RuntimeState {
  /**
   * RuntimeStateDoc identity. Mirrors the NotebookDoc's runtime_state_doc_id
   * pointer when known.
   */
  runtime_state_doc_id: string | null;
  kernel: KernelState;
  queue: QueueState;
  env: EnvState;
  trust: TrustState;
  last_saved: string | null;
  /**
   * Path to the notebook's `.ipynb` on the daemon's disk. `null` for
   * untitled notebooks; the daemon writes this on save / save-as.
   */
  path: string | null;
  executions: Record<string, ExecutionState>;
  comms: Record<string, CommDocEntry>;
  /**
   * Daemon-observed project file context. Clients read this instead of
   * walking the filesystem themselves.
   */
  project_context: ProjectContext;
  /**
   * Room-host-owned active workstation attachment projection.
   */
  workstation: WorkstationAttachmentState | null;
/**
 * Ephemeral per-execution sandbox annotations written by the daemon.
 *
 * Keyed by `execution_id`. Empty (`{}`) on old documents that predate the
 * sandbox feature and on any doc that has never had an annotation written.
 * Never written to the notebook export.
 */
  cell_annotations: Record<string, CellAnnotation>;
  /**
   * Current sandbox state for the active kernel session.
   *
   * Mirrors `SandboxStateInfo` from the notebook protocol. Defaults to
   * `Disabled` on old documents or documents without a sandbox profile.
   * Written by the daemon when sandbox state changes (launch, degradation,
   * startup failure).
   */
  /**
   * Current sandbox state for the active kernel session.
   *
   * Absent on documents projected before this field was added to the Rust
   * `RuntimeState` struct — the daemon writes it on kernel launch and on proxy
   * state changes.  The WASM projection always serializes the field (defaulting
   * to `{ state: "Disabled" }` for old docs), so consumers can rely on it
   * being present after the first RuntimeStateDoc sync.
   */
  sandbox_state: SandboxStateInfo;
}

// ── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_RUNTIME_STATE: RuntimeState = {
  runtime_state_doc_id: null,
  kernel: {
    lifecycle: { lifecycle: "NotStarted" },
    error_reason: "",
    error_details: "",
    name: "",
    language: "",
    env_source: "",
  },
  queue: {
    executing: null,
    queued: [],
  },
  env: {
    in_sync: true,
    added: [],
    removed: [],
    channels_changed: false,
    deno_changed: false,
    prewarmed_packages: [],
    progress: null,
  },
  trust: {
    status: "no_dependencies",
    needs_approval: false,
    approved_uv_dependencies: [],
    approved_conda_dependencies: [],
    approved_conda_channels: [],
    approved_pixi_dependencies: [],
    approved_pixi_pypi_dependencies: [],
    approved_pixi_channels: [],
  },
  last_saved: null,
  path: null,
  executions: {},
  comms: {},
  project_context: { state: "Pending" },
  workstation: null,
  cell_annotations: {},
  sandbox_state: { state: "Disabled" },
};

// ── Utilities ────────────────────────────────────────────────────────

/**
 * Diff two executions maps to detect status transitions.
 *
 * Returns transitions for:
 * - New entry or "queued"→"running" → "started"
 * - "running"→"done" → "done"
 * - "running"→"error" or "queued"→"error" (kernel death) → "error"
 *
 * Slow joiners see the final state — no missed transitions. If a sync
 * batches multiple changes (queued→done in one round), we emit the
 * terminal event only.
 */
export function diffExecutions(
  prev: Record<string, ExecutionState>,
  curr: Record<string, ExecutionState>,
): ExecutionTransition[] {
  const transitions: ExecutionTransition[] = [];

  for (const [eid, entry] of Object.entries(curr)) {
    const prevEntry = prev[eid];
    const prevStatus = prevEntry?.status;
    const currStatus = entry.status;

    // Same status — check if execution_count arrived (kernel sends
    // execute_input after the status transitions to "running").
    if (prevStatus === currStatus) {
      if (
        currStatus === "running" &&
        entry.execution_count != null &&
        prevEntry?.execution_count == null
      ) {
        transitions.push({
          execution_id: eid,
          kind: "started",
          execution_count: entry.execution_count,
        });
      }
      continue;
    }

    // Terminal states: done or error
    if (currStatus === "done") {
      transitions.push({
        execution_id: eid,
        kind: "done",
        execution_count: entry.execution_count,
      });
    } else if (currStatus === "error") {
      transitions.push({
        execution_id: eid,
        kind: "error",
        execution_count: entry.execution_count,
      });
    } else if (currStatus === "running" && prevStatus !== "done" && prevStatus !== "error") {
      // Started (queued→running or new→running)
      transitions.push({
        execution_id: eid,
        kind: "started",
        execution_count: entry.execution_count,
      });
    }
  }

  return transitions;
}
