import type { Observable } from "rxjs";

export { RelaySession, connectRelay, createRelay, openRelayPath, queryDaemonInfo } from "./relay";
export type {
  CommentsNotebookRef,
  CreateRelayOptions,
  DaemonInfo,
  OpenRelayOptions,
  QueryDaemonOptions,
  RelayFrame,
  RelayInfo,
} from "./relay";

export type ConnectionState = "Connected" | "Disconnected";
export type NotebookDocPhase = "Pending" | "Syncing" | "Interactive";
export type RuntimeStatePhase = "Pending" | "Syncing" | "Ready";

export type InitialLoadPhase = "NotNeeded" | "Streaming" | "Ready" | { Failed: { reason: string } };

export interface SessionStatus {
  connection: ConnectionState;
  notebook_doc: NotebookDocPhase;
  runtime_state: RuntimeStatePhase;
  initial_load: InitialLoadPhase;
}

export interface ExecutionTransition {
  execution_id: string;
  kind: "started" | "done" | "error";
  execution_count: number | null;
}

import type {
  ExecutionViewChangeset,
  ExecutionView,
  NotebookExecutionStore,
} from "./execution-store.cjs";
export type {
  ExecutionViewSnapshot,
  ExecutionQueueProjection,
  ExecutionViewChangeset,
  ExecutionSnapshot,
  ExecutionQueueSnapshot,
  ExecutionView,
  NotebookExecutionStore,
} from "./execution-store.cjs";

export type RuntimeState = Record<string, unknown>;

export type RuntimeKind = "python" | "deno" | (string & {});

export interface OpenTelemetryRegistrationOptions {
  /** Explicit daemon endpoint. This API never starts a daemon. */
  socketPath: string;
  /** Stable product slug, not a user, window, session, or installation identifier. */
  hostId: string;
  source: "app" | "mcp";
  /** Host permission only; daemon consent and emission gates still apply. Defaults to false. */
  allowed?: boolean;
}

/** One host-lifetime owner. Aggregate active windows before granting permission. */
export class TelemetryRegistration {
  private constructor();
  /** Await the daemon acknowledgment. Disconnected handles reject, never reconnect. */
  updatePermission(allowed: boolean): Promise<void>;
  /**
   * Await revocation acknowledgment. Idempotent after success; disconnection rejects.
   * Without acknowledgment, remote revocation can take up to the 120-second lease expiry.
   */
  close(): Promise<void>;
}

/**
 * Return null if host telemetry is unsupported or the capability probe is unavailable.
 * Permission defaults to denied.
 * Keep the handle alive while active and await close() when finished. Garbage collection
 * terminates its socket without awaiting revocation. The handle never reconnects.
 * Older native binaries omit this export; feature-detect it when supporting those binaries.
 */
export function openTelemetryRegistration(
  options: OpenTelemetryRegistrationOptions,
): Promise<TelemetryRegistration | null>;

export const PackageManager: {
  readonly Uv: "uv";
  readonly Conda: "conda";
  readonly Pixi: "pixi";
};
export type PackageManager = (typeof PackageManager)[keyof typeof PackageManager];

export const CreateNotebookEnvironmentMode: {
  readonly Auto: "auto";
  readonly Project: "project";
  readonly Notebook: "notebook";
};
export type CreateNotebookEnvironmentMode =
  (typeof CreateNotebookEnvironmentMode)[keyof typeof CreateNotebookEnvironmentMode];

/**
 * Existing Python environment bound to a new notebook room. `prefix` must be
 * an absolute Conda environment directory with Python and ipykernel. It
 * replaces only the prewarmed fallback: inline dependencies, PEP 723 blocks,
 * a captured environment, and a trusted project file still win. The daemon
 * borrows the prefix and never deletes it.
 */
export interface LocalEnvironmentOptions {
  prefix: string;
}

/**
 * Daemon verdict on `localEnvironment`. Absent when none was requested or the
 * daemon predates the option. A rejected prefix falls back to normal selection.
 */
export interface LocalEnvironmentStatus {
  status: "bound" | "rejected";
  /** Canonical prefix when bound; the requested prefix when rejected. */
  prefix: string;
  error?: string;
}

export interface CreateNotebookOptions {
  runtime?: RuntimeKind;
  workingDir?: string;
  socketPath?: string;
  peerLabel?: string;
  description?: string;
  dependencies?: string[];
  packageManager?: PackageManager;
  environmentMode?: CreateNotebookEnvironmentMode;
  localEnvironment?: LocalEnvironmentOptions;
}

export type EnvironmentSelectionTarget =
  | { kind: "automatic"; prefix?: undefined }
  | { kind: "conda"; prefix: string }
  | { kind: "kernelspec"; name: string };

export interface InstalledKernelspec {
  name: string;
  displayName: string;
  language: string;
}

export interface KernelspecInventory {
  kernelspecs: InstalledKernelspec[];
  warnings: string[];
  truncated: boolean;
}

export interface LocalCondaEnvironmentInfo {
  id: string;
  name: string;
  prefix: string;
  pythonPath: string;
  pythonVersion?: string;
}

/** Daemon-session environment intent, separate from the running kernel. */
export interface EnvironmentSelection {
  selectedKernelspec?: InstalledKernelspec;
  appliedKernelspec?: InstalledKernelspec;
  /** Pass back as `expectedRevision` to set or apply. */
  revision: number;
  /** Staged target. Absent means Automatic. */
  selected?: LocalCondaEnvironmentInfo;
  /** Target the running kernel was applied with. Absent means Automatic. */
  applied?: LocalCondaEnvironmentInfo;
  applying: boolean;
}

export interface OpenNotebookOptions {
  socketPath?: string;
  peerLabel?: string;
  description?: string;
}

export interface RunCellOptions {
  timeoutMs?: number;
  cellType?: "code" | "markdown" | "raw";
  onUpdate?: (progress: CellResult) => void;
}

export interface QueueCellOptions {
  cellType?: "code" | "markdown" | "raw";
}

export interface DependencyEditOptions {
  packageManager?: PackageManager;
}

export interface WaitExecutionOptions {
  cellId?: string;
  timeoutMs?: number;
  onUpdate?: (progress: CellResult) => void;
}

export interface QueuedExecution {
  cellId: string;
  executionId: string;
}

export interface JsOutput {
  outputType: string;
  name?: string;
  text?: string;
  dataJson?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  executionCount?: number;
  blobUrlsJson?: string;
  blobPathsJson?: string;
}

export interface CellResult {
  cellId: string;
  executionId: string;
  executionCount?: number;
  status:
    | "done"
    | "error"
    | "timeout"
    | "kernel_error"
    | "kernel_failed"
    | "closed"
    | "queued"
    | "running"
    | (string & {});
  success: boolean;
  outputs: JsOutput[];
}

export interface SnapshotPair {
  notebookId: string;
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  commsDocBytes: Uint8Array;
  notebookHeads: string[];
  runtimeStateHeads: string[];
  commsDocHeads: string[];
  blobBaseUrl?: string | null;
  blobStorePath?: string | null;
}

export interface EventSubscription {
  dispose(): void;
}

export interface CellSnapshot {
  id: string;
  cellType: string;
  position: string;
  source: string;
  metadataJson: string;
  executionCount?: string;
}

export interface CreateCellOptions {
  cellType?: "code" | "markdown" | "raw";
  /** Omit to append at the end. 0 prepends; out-of-range values append. */
  index?: number;
  /**
   * Insert after this cell. Cannot be combined with index.
   */
  afterCellId?: string;
}

export interface SetCellOptions {
  source?: string;
  cellType?: "code" | "markdown" | "raw";
}

/** What trusting a project folder lets uv, pixi, or conda do. Parse-only. */
export interface ProjectTrustSummary {
  dependencies: string[];
  nonRegistrySources: string[];
  indexesAndChannels: string[];
  buildBackend?: string;
  activationScripts: string[];
  outsideDirectory: string[];
  environmentToBuild?: string;
}

/**
 * Project-folder trust for the project file that would drive the environment.
 * When `RuntimeStatus.lifecycle` is `"AwaitingProjectTrust"`, pass `projectDir`
 * (or an ancestor such as `repoRoot`) to `approveProjectTrust()` or
 * `declineProjectTrust()`, then launch the kernel.
 */
export interface ProjectTrustStatus {
  /** Absent until the daemon evaluates the room. */
  status?: "no_project" | "trusted" | "untrusted" | "notebook_env" | (string & {});
  needsApproval: boolean;
  manifestPath?: string;
  kind?: "pyproject_toml" | "pixi_toml" | "environment_yml" | (string & {});
  projectDir?: string;
  repoRoot?: string;
  trustedDir?: string;
  summary: ProjectTrustSummary;
}

export interface RuntimeStatus {
  status: string;
  lifecycle: string;
  activity?: string;
  startingPhase: string;
  name: string;
  language: string;
  /** Active identity fields are empty unless lifecycle is "Running". */
  envSource: string;
  runtimeAgentId: string;
  environmentId: string;
  environmentName: string;
  pythonVersion: string;
  errorReason?: string;
  errorDetails?: string;
  projectTrust: ProjectTrustStatus;
}

export interface DependencyStatus {
  uv?: {
    dependencies: string[];
    requiresPython?: string;
  };
  conda?: {
    dependencies: string[];
    channels: string[];
    python?: string;
  };
  pixi?: {
    dependencies: string[];
    pypiDependencies: string[];
    channels: string[];
    python?: string;
  };
  pep723Dependencies: string[];
  fingerprint?: string;
  trust?: unknown;
  projectTrust: ProjectTrustStatus;
}

export type EnvironmentSyncStatus = "applied" | "restart_required" | "failed";
export type EnvironmentSyncNextAction = "none" | "restart" | "inspect";

/**
 * Daemon verdict for `syncEnvironmentResult()`.
 *
 * - `applied`: packages are installed in the running kernel. `needsRestart` false, `nextAction` `"none"`.
 * - `restart_required`: the daemon cannot hot-apply this change (removals, channel or
 *   package-manager changes, project file updates). Nothing was installed. Call
 *   `restartKernel()` when discarding in-memory state is acceptable.
 *   `needsRestart` true, `nextAction` `"restart"`.
 * - `failed`: the change was not applied and a restart will not apply it (trust not
 *   approved, borrowed environment, install error). `needsRestart` false, `nextAction` `"inspect"`.
 *
 * Notebook dependency metadata is the saved spec. It is not proof of the running environment.
 */
export interface EnvironmentSyncResult {
  status: EnvironmentSyncStatus;
  /** Packages the daemon installed into the running kernel. */
  syncedPackages: string[];
  needsRestart: boolean;
  /** Daemon error text; present unless `status` is `"applied"`. */
  error?: string;
  nextAction: EnvironmentSyncNextAction;
}

export interface RestartKernelOptions {
  /**
   * Bound in milliseconds for each client-side wait: the old kernel observed stopped,
   * then a matching kernel observed running. Default 30000. The daemon's launch request
   * (environment preparation) keeps its own deadline.
   */
  timeoutMs?: number;
}

export type KernelRestartOutcome =
  | "running"
  | "trust_required"
  | "launch_rejected"
  | "failed"
  | "stopped"
  | "timed_out";

/**
 * How `restartKernelResult()` ended.
 *
 * - `running`: this client's RuntimeStateDoc showed the old kernel stop, then a kernel
 *   Running with `launchedEnvSource` and the accepted local environment id, when supplied.
 * - `trust_required`: the daemon refused the launch until dependencies are approved.
 * - `launch_rejected`: the daemon refused or failed the launch (`error` explains).
 * - `failed` / `stopped`: the daemon accepted the launch, then the kernel errored or stopped.
 * - `timed_out`: a client wait expired. The kernel may still come up; `status` is not authoritative.
 *
 * The protocol has no launch generation. If another peer restarts the kernel with the
 * same environment during this call, `running` cannot tell which launch it observed.
 */
export interface KernelRestartResult {
  outcome: KernelRestartOutcome;
  /** Present unless `outcome` is `"running"`. */
  error?: string;
  /** envSource the daemon reported for the accepted launch. */
  launchedEnvSource?: string;
  /** This client's runtime view when the call finished. Observed Running after stop with matching launch source/identity only for `"running"`. */
  status: RuntimeStatus;
}

export class Session {
  readonly notebookId: string;
  /** Daemon verdict on `createNotebook({ localEnvironment })`; null otherwise. */
  readonly localEnvironment: LocalEnvironmentStatus | null;
  readonly runtimeState$: Observable<RuntimeState>;
  readonly executionTransitions$: Observable<ExecutionTransition>;
  readonly executionViewChanges$: Observable<ExecutionViewChangeset>;
  readonly cellChanges$: Observable<null>;
  readonly broadcasts$: Observable<unknown>;
  readonly sessionStatus$: Observable<SessionStatus>;

  queueCell(source: string, options?: QueueCellOptions): Promise<QueuedExecution>;
  waitForExecution(executionId: string, options?: WaitExecutionOptions): Promise<CellResult>;
  runCell(source: string, options?: RunCellOptions): Promise<CellResult>;
  saveNotebook(path?: string): Promise<void>;
  exportSnapshotPair(): Promise<SnapshotPair>;
  /**
   * Return the current NotebookDoc heads after the connected daemon accepts them.
   * Later edits are not covered. Rejects on timeout, close, disconnect, rejection,
   * and unsupported peers (including hosted bridges). Persistent local rooms
   * preserve recovery-journal-before-acceptance; ephemeral rooms promise acceptance
   * only. Does not export an .ipynb or acknowledge runtime, comments, or widgets.
   */
  confirmNotebookSync(): Promise<string[]>;
  listCells(): Promise<CellSnapshot[]>;
  getCell(cellId: string): Promise<CellSnapshot | null>;
  createCell(source: string, options?: CreateCellOptions): Promise<string>;
  setCell(cellId: string, options: SetCellOptions): Promise<boolean>;
  deleteCell(cellId: string): Promise<boolean>;
  moveCell(cellId: string, afterCellId?: string | null): Promise<string>;
  executeCell(cellId: string, options?: { timeoutMs?: number }): Promise<CellResult>;
  showNotebook(): Promise<unknown>;
  interruptKernel(): Promise<void>;
  shutdownKernel(): Promise<void>;
  /**
   * Restart the kernel; in-memory state is lost. Resolves only after a stopped state followed by a matching kernel
   * observed Running (outcome `"running"` of `restartKernelResult()`); rejects with
   * the outcome's error otherwise. The match uses the accepted environment source
   * and local identity when supplied, not a launch generation; same-target peer
   * restarts cannot be distinguished.
   */
  restartKernel(options?: RestartKernelOptions): Promise<void>;
  /** Restart the kernel and return how it ended. Rejects on session close or connection loss. */
  restartKernelResult(options?: RestartKernelOptions): Promise<KernelRestartResult>;
  shutdownNotebook(): Promise<boolean>;
  addDependency(pkg: string, options?: DependencyEditOptions): Promise<void>;
  addDependencies(packages: string[], options?: DependencyEditOptions): Promise<void>;
  removeDependency(pkg: string, options?: DependencyEditOptions): Promise<boolean>;
  removeDependencies(packages: string[], options?: DependencyEditOptions): Promise<number>;
  getDependencyStatus(): Promise<DependencyStatus>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  /** Stable immutable state; explicitly copy it if mutable ownership is needed. */
  getExecutionView(): ExecutionView;
  readonly executions: NotebookExecutionStore;
  dependencyFingerprint(): Promise<string | null>;
  approveTrust(observedHeads?: string[]): Promise<void>;
  /**
   * Trust a folder so project files at or below it may drive uv, pixi, or conda
   * on this machine. `directory` must be the project file's folder or an
   * ancestor; the daemon refuses folders that contain the home directory.
   * Trust is local and never written into the notebook. Launch afterwards.
   */
  approveProjectTrust(directory: string): Promise<void>;
  /**
   * Use the notebook's own environment instead of the project file in
   * `directory`. With `remember`, the choice persists for that folder on this
   * machine; otherwise it lasts for this room. Launch afterwards.
   */
  declineProjectTrust(directory: string, remember?: boolean): Promise<void>;
  /**
   * Hot-install pending dependency changes into the running kernel. Starts a kernel
   * first only when none is running. Resolves for `applied`; rejects with the daemon's
   * error otherwise.
   */
  syncEnvironment(): Promise<void>;
  /**
   * Same request as `syncEnvironment()`, with the daemon's verdict returned as a value.
   * Never restarts a running kernel. Rejects on session close, connection loss, or an
   * unexpected daemon response; the daemon-side effect is then unknown.
   */
  syncEnvironmentResult(): Promise<EnvironmentSyncResult>;
  getEnvironmentSelection(): Promise<EnvironmentSelection>;
  listInstalledKernelspecs(): Promise<KernelspecInventory>;
  /** Stage a target without touching the running kernel. */
  setEnvironmentSelection(
    target: EnvironmentSelectionTarget,
    expectedRevision: number,
  ): Promise<EnvironmentSelection>;
  /** Launch with the staged target. `observedHeads` defaults to current heads. */
  applyEnvironmentSelection(
    expectedRevision: number,
    observedHeads?: string[],
  ): Promise<EnvironmentSelection>;
  close(): Promise<void>;
}

export const NativeSession: unknown;

export function defaultSocketPath(): string;
export function socketPathForChannel(channel: "stable" | "nightly"): string;

export interface InitializeEnvironmentYmlOptions {
  /** Existing absolute directory the local host is authorized to write. */
  directory: string;
  /** Optional name containing only letters, numbers, '.', '_' and '-'. */
  name?: string;
  /** Conda match specs. Pip subsections are not supported by this initializer. */
  dependencies: string[];
  /** Python version constraint, e.g. "3.12" or ">=3.11,<3.13". */
  python?: string;
  /** At least one channel, in priority order. No channels are inferred. */
  channels: string[];
}

/**
 * Explicitly create environment.yml using the local host's filesystem authority.
 * Returns its filesystem-canonical absolute path. Rejects existing files/symlinks.
 * Checks for environment.yaml first; hosts must coordinate other writers of it.
 * Does not install packages, approve trust, contact a daemon or change a kernel.
 */
export function initializeEnvironmentYml(options: InitializeEnvironmentYmlOptions): Promise<string>;

export function createNotebook(options?: CreateNotebookOptions): Promise<Session>;
export function openNotebook(notebookId: string, options?: OpenNotebookOptions): Promise<Session>;
export function openNotebookPath(path: string, options?: OpenNotebookOptions): Promise<Session>;
export function getExecutionResult(
  executionId: string,
  options?: { socketPath?: string },
): Promise<CellResult>;

export interface ParquetColumnInfo {
  name: string;
  dataType: string;
  nullCount: number;
  statsJson: string;
}

export interface ParquetRowPage {
  columns: string[];
  rows: string[][];
  totalRows: number;
  offset: number;
}

export interface ParquetSummaryResult {
  numRows: number;
  numBytes: number;
  columns: ParquetColumnInfo[];
}

export type TableRowPage = ParquetRowPage;
export type TableSummaryResult = ParquetSummaryResult;

export function blobStorePath(socketPath?: string | null): string | null;
export function resolveBlobPath(hash: string, socketPath?: string | null): string | null;

export function readParquetFile(filePath: string, offset: number, limit: number): ParquetRowPage;

export function readArrowFile(filePath: string, offset: number, limit: number): ParquetRowPage;

export function readArrowChunks(filePaths: string[], offset: number, limit: number): ParquetRowPage;

export function summarizeParquetFile(filePath: string): ParquetSummaryResult;

export function summarizeArrowFile(filePath: string): ParquetSummaryResult;

export function summarizeArrowChunks(filePaths: string[]): ParquetSummaryResult;
