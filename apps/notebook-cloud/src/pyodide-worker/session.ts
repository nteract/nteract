/**
 * Pyodide interpreter session for the fleet execution worker.
 *
 * Lifecycle: `initializing → ready → executing → restarting`. In-memory
 * Python state is lost across restarts by design (terminate-and-restart
 * cancellation).
 *
 * Security posture: the interpreter is assumed compromiseable. It never
 * receives host capability bindings; egress exists only as the worker's own
 * fetch used for package wheels.
 */

export type SessionState = "initializing" | "ready" | "executing" | "restarting";

export interface PyodideLoadOptions {
  /** Base URL (or bundled sibling prefix) for the Pyodide distribution. */
  indexURL: string;
}

export interface ExecutionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** `repr()` of the last expression when the cell produced one. */
  repr?: string;
  error?: StructuredError;
}

export interface StructuredError {
  ename: string;
  evalue: string;
  traceback: string[];
}

/** Minimal structural type for the Pyodide API surface the session uses. */
export interface PyodideInterface {
  runPythonAsync(source: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
}

export type PyodideLoader = (options: PyodideLoadOptions) => Promise<PyodideInterface>;

/**
 * Resolve the Pyodide loader.
 *
 * The specifier is computed at runtime from `indexURL` so bundlers do not
 * statically resolve it: in the bundled fleet artifact celld's build rewrites
 * WASM imports into static siblings, and in dev `indexURL` points at a Pyodide
 * distribution directory or HTTP base.
 */
export function defaultLoader(): PyodideLoader {
  return async ({ indexURL }) => {
    const bundleUrl = new URL("pyodide.mjs", indexURL).href;
    const mod = (await import(/* @vite-ignore */ bundleUrl)) as {
      loadPyodide?: PyodideLoaderFactory;
      default?: { loadPyodide?: PyodideLoaderFactory };
    };
    const loadPyodide = mod.loadPyodide ?? mod.default?.loadPyodide;
    if (!loadPyodide) {
      throw new Error(
        `pyodide.mjs not resolvable from ${indexURL}; set the worker's pyodide asset base or bundle the distribution as static siblings`,
      );
    }
    return loadPyodide({ indexURL });
  };
}

type PyodideLoaderFactory = (
  options: PyodideLoadOptions,
) => PyodideInterface | Promise<PyodideInterface>;

export class PyodideSession {
  state: SessionState = "initializing";
  private pyodide: PyodideInterface | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly loader: PyodideLoader;
  private readonly indexURL: string;

  constructor(options: { indexURL: string; loader?: PyodideLoader }) {
    this.indexURL = options.indexURL;
    this.loader = options.loader ?? defaultLoader();
  }

  async init(): Promise<void> {
    this.state = "initializing";
    this.pyodide = await this.loader({ indexURL: this.indexURL });
    this.pyodide.setStdout({ batched: (text) => (this.stdoutBuffer += text) });
    this.pyodide.setStderr({ batched: (text) => (this.stderrBuffer += text) });
    this.state = "ready";
  }

  /** True once the interpreter is initialized and idle. */
  get ready(): boolean {
    return this.state === "ready" && this.pyodide !== null;
  }

  /**
   * Execute one cell source and collect streamed output.
   *
   * Callers pass the source read from the synced NotebookDoc by `cell_id`
   * (invariant 1); this session never re-reads or mutates notebook state.
   */
  async execute(source: string): Promise<ExecutionResult> {
    if (this.pyodide === null) {
      return this.missingInterpreter();
    }
    this.state = "executing";
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    try {
      const result = await this.pyodide.runPythonAsync(source);
      const repr = result === undefined || result === null ? undefined : safeRepr(result);
      this.state = "ready";
      return {
        ok: true,
        stdout: this.stdoutBuffer,
        stderr: this.stderrBuffer,
        repr,
      };
    } catch (error) {
      this.state = "ready";
      return {
        ok: false,
        stdout: this.stdoutBuffer,
        stderr: this.stderrBuffer,
        error: toStructuredError(error),
      };
    }
  }

  /**
   * Terminate-and-restart cancellation: the interpreter is discarded; queued
   * executions survive in RuntimeStateDoc, in-memory state does not (R10).
   */
  async cancel(): Promise<void> {
    this.state = "restarting";
    this.pyodide = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    await this.init();
  }

  async shutdown(): Promise<void> {
    this.state = "restarting";
    this.pyodide = null;
  }

  private missingInterpreter(): ExecutionResult {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: {
        ename: "PyodideRuntimeError",
        evalue: "interpreter not initialized",
        traceback: [],
      },
    };
  }
}

function safeRepr(value: unknown): string {
  try {
    const repr = (value as { toString?: () => string }).toString;
    if (typeof repr === "function") return String(value);
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Map a thrown Python error to the nbformat error-output triple. */
export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof Error) {
    return {
      ename: error.constructor.name,
      evalue: error.message,
      traceback: error.message
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0),
    };
  }
  return {
    ename: "Exception",
    evalue: String(error),
    traceback: [],
  };
}
