import type { Observable } from "rxjs";
import type { ExecutionTransition, RuntimeState } from "runtimed";

export type RuntimeKind = "python" | "deno" | (string & {});

export interface CreateNotebookOptions {
  runtime?: RuntimeKind;
  workingDir?: string;
  socketPath?: string;
  peerLabel?: string;
}

export interface OpenNotebookOptions {
  socketPath?: string;
  peerLabel?: string;
}

export interface RunCellOptions {
  timeoutMs?: number;
  cellType?: "code" | "markdown" | "raw";
  onUpdate?: (progress: CellResult) => void;
}

export interface QueueCellOptions {
  cellType?: "code" | "markdown" | "raw";
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
  status: "done" | "error" | "timeout" | "kernel_error" | "queued" | "running" | (string & {});
  success: boolean;
  outputs: JsOutput[];
}

export interface EventSubscription {
  dispose(): void;
}

export class Session {
  readonly notebookId: string;
  readonly runtimeState$: Observable<RuntimeState>;
  readonly executionTransitions$: Observable<ExecutionTransition>;

  queueCell(source: string, options?: QueueCellOptions): Promise<QueuedExecution>;
  waitForExecution(executionId: string, options?: WaitExecutionOptions): Promise<CellResult>;
  runCell(source: string, options?: RunCellOptions): Promise<CellResult>;
  saveNotebook(path?: string): Promise<void>;
  addUvDependency(pkg: string): Promise<void>;
  dependencyFingerprint(): Promise<string | null>;
  approveTrust(observedHeads?: string[]): Promise<void>;
  syncEnvironment(): Promise<void>;
  close(): Promise<void>;
}

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
