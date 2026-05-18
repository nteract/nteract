import type { Observable } from "rxjs";

export type NotebookDocPhase = "pending" | "syncing" | "interactive";
export type RuntimeStatePhase = "pending" | "syncing" | "ready";

export type InitialLoadPhase =
  | { phase: "not_needed" }
  | { phase: "streaming" }
  | { phase: "ready" }
  | { phase: "failed"; reason: string };

export interface SessionStatus {
  notebook_doc: NotebookDocPhase;
  runtime_state: RuntimeStatePhase;
  initial_load: InitialLoadPhase;
}

export interface ExecutionTransition {
  execution_id: string;
  kind: "started" | "done" | "error";
  execution_count: number | null;
}

export interface ExecutionViewSnapshot {
  execution_count: number | null;
  status: "queued" | "running" | "done" | "error" | (string & {});
  success: boolean | null;
  output_ids: string[];
}

export interface ExecutionQueueProjection {
  executing_execution_id?: string | null;
  queued_execution_ids: string[];
  notebook?: {
    executing_cell_id?: string | null;
    queued_cell_ids: string[];
  } | null;
}

export interface ExecutionViewChangeset {
  cell_pointer_changes?: Array<[cell_id: string, execution_id: string | null]>;
  execution_upserts?: Array<[execution_id: string, snapshot: ExecutionViewSnapshot]>;
  removed_execution_ids?: string[];
  queue?: ExecutionQueueProjection;
}

export type RuntimeState = Record<string, unknown>;

export type RuntimeKind = "python" | "deno" | (string & {});

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

export interface CreateNotebookOptions {
  runtime?: RuntimeKind;
  workingDir?: string;
  socketPath?: string;
  peerLabel?: string;
  description?: string;
  dependencies?: string[];
  packageManager?: PackageManager;
  environmentMode?: CreateNotebookEnvironmentMode;
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

export interface RuntimeStatus {
  status: string;
  lifecycle: string;
  activity?: string;
  startingPhase: string;
  name: string;
  language: string;
  envSource: string;
  runtimeAgentId: string;
  errorReason?: string;
  errorDetails?: string;
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
  fingerprint?: string;
  trust?: unknown;
}

export class Session {
  readonly notebookId: string;
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
  restartKernel(): Promise<void>;
  shutdownNotebook(): Promise<boolean>;
  addDependency(pkg: string, options?: DependencyEditOptions): Promise<void>;
  addDependencies(packages: string[], options?: DependencyEditOptions): Promise<void>;
  removeDependency(pkg: string, options?: DependencyEditOptions): Promise<boolean>;
  removeDependencies(packages: string[], options?: DependencyEditOptions): Promise<number>;
  getDependencyStatus(): Promise<DependencyStatus>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  dependencyFingerprint(): Promise<string | null>;
  approveTrust(observedHeads?: string[]): Promise<void>;
  syncEnvironment(): Promise<void>;
  close(): Promise<void>;
}

export const NativeSession: unknown;

export function defaultSocketPath(): string;
export function socketPathForChannel(channel: "stable" | "nightly"): string;
export function createNotebook(options?: CreateNotebookOptions): Promise<Session>;
export function openNotebook(notebookId: string, options?: OpenNotebookOptions): Promise<Session>;
export function getExecutionResult(
  executionId: string,
  options?: { socketPath?: string },
): Promise<CellResult>;

export function readParquetFile(
  filePath: string,
  offset: number,
  limit: number,
): {
  columns: string[];
  rows: string[][];
  totalRows: number;
  offset: number;
};

export function summarizeParquetFile(filePath: string): {
  numRows: number;
  numBytes: number;
  columns: Array<{ name: string; dataType: string; nullCount: number; statsJson: string }>;
};
