export interface ExecutionPerformanceMark {
  name: string;
  t: number;
  traceId: string | null;
  cellId?: string;
  executionId?: string;
  outputId?: string;
  detail?: Record<string, unknown>;
}

export interface ExecutionPerformanceTrace {
  traceId: string;
  cellId: string;
  startedAt: number;
  marks: ExecutionPerformanceMark[];
}

export interface ExecutionPerformanceSnapshot {
  enabled: boolean;
  marks: ExecutionPerformanceMark[];
  traces: ExecutionPerformanceTrace[];
}

interface ExecutionPerformanceApi {
  enable(): void;
  disable(): void;
  reset(): void;
  snapshot(): ExecutionPerformanceSnapshot;
  mark(name: string, detail?: Record<string, unknown>): void;
}

interface ExecutionPerformanceWindow extends Window {
  __NTERACT_EXECUTION_PERF_ENABLED?: boolean;
  __nteractExecutionPerf?: ExecutionPerformanceApi;
}

const STORAGE_KEY = "nteract:execution-performance";

let sequence = 0;
let marks: ExecutionPerformanceMark[] = [];
const traces = new Map<string, ExecutionPerformanceTrace>();
const activeTraceByCellId = new Map<string, string>();
const traceByExecutionId = new Map<string, string>();
let latestTraceId: string | null = null;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getWindow(): ExecutionPerformanceWindow | null {
  return typeof window === "undefined" ? null : (window as ExecutionPerformanceWindow);
}

function localStorageEnabled(win: ExecutionPerformanceWindow): boolean {
  try {
    return win.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function setLocalStorageEnabled(win: ExecutionPerformanceWindow, enabled: boolean): void {
  try {
    if (enabled) {
      win.localStorage?.setItem(STORAGE_KEY, "1");
    } else {
      win.localStorage?.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted contexts; the window flag is enough.
  }
}

function isEnabled(): boolean {
  const win = getWindow();
  if (!win) return false;
  return (
    win.__NTERACT_EXECUTION_PERF_ENABLED === true ||
    localStorageEnabled(win) ||
    import.meta.env.VITE_E2E === "1"
  );
}

function cloneMark(mark: ExecutionPerformanceMark): ExecutionPerformanceMark {
  return {
    ...mark,
    detail: mark.detail ? { ...mark.detail } : undefined,
  };
}

function buildSnapshot(): ExecutionPerformanceSnapshot {
  const clonedMarks = marks.map(cloneMark);
  return {
    enabled: isEnabled(),
    marks: clonedMarks,
    traces: Array.from(traces.values()).map((trace) => ({
      traceId: trace.traceId,
      cellId: trace.cellId,
      startedAt: trace.startedAt,
      marks: trace.marks.map(cloneMark),
    })),
  };
}

function resolveTraceId(detail: Record<string, unknown> | undefined): string | null {
  const explicit = detail?.traceId;
  if (typeof explicit === "string") return explicit;

  const executionId = detail?.executionId;
  if (typeof executionId === "string") {
    const traceId = traceByExecutionId.get(executionId);
    if (traceId) return traceId;
  }

  const cellId = detail?.cellId;
  if (typeof cellId === "string") {
    const traceId = activeTraceByCellId.get(cellId);
    if (traceId) return traceId;
  }

  return latestTraceId;
}

function appendMark(
  name: string,
  detail: Record<string, unknown> | undefined,
): ExecutionPerformanceMark | null {
  if (!isEnabled()) return null;
  installExecutionPerformanceApi();

  const traceId = resolveTraceId(detail);
  const cellId = typeof detail?.cellId === "string" ? detail.cellId : undefined;
  const executionId =
    typeof detail?.executionId === "string" ? detail.executionId : undefined;
  const outputId = typeof detail?.outputId === "string" ? detail.outputId : undefined;
  const mark: ExecutionPerformanceMark = {
    name,
    t: now(),
    traceId,
    cellId,
    executionId,
    outputId,
    detail,
  };
  marks.push(mark);

  if (traceId) {
    const trace = traces.get(traceId);
    if (trace) trace.marks.push(mark);
  }

  return mark;
}

export function installExecutionPerformanceApi(): void {
  const win = getWindow();
  if (!win || win.__nteractExecutionPerf) return;

  win.__nteractExecutionPerf = {
    enable() {
      win.__NTERACT_EXECUTION_PERF_ENABLED = true;
      setLocalStorageEnabled(win, true);
    },
    disable() {
      win.__NTERACT_EXECUTION_PERF_ENABLED = false;
      setLocalStorageEnabled(win, false);
    },
    reset() {
      marks = [];
      traces.clear();
      activeTraceByCellId.clear();
      traceByExecutionId.clear();
      latestTraceId = null;
    },
    snapshot: buildSnapshot,
    mark(name: string, detail?: Record<string, unknown>) {
      appendMark(name, detail);
    },
  };
}

export function startExecutionPerformanceTrace(
  cellId: string,
  detail: Record<string, unknown> = {},
): string | null {
  if (!isEnabled()) return null;
  installExecutionPerformanceApi();

  const traceId = `execute-${++sequence}`;
  const startedAt = now();
  traces.set(traceId, {
    traceId,
    cellId,
    startedAt,
    marks: [],
  });
  activeTraceByCellId.set(cellId, traceId);
  latestTraceId = traceId;
  appendMark("app.execute.invoke", { ...detail, cellId, traceId });
  return traceId;
}

export function attachExecutionPerformanceId(cellId: string, executionId: string): void {
  if (!isEnabled()) return;
  const traceId = activeTraceByCellId.get(cellId) ?? latestTraceId;
  if (!traceId) return;
  traceByExecutionId.set(executionId, traceId);
  appendMark("client.execute.execution_id", { cellId, executionId, traceId });
}

export function markExecutionPerformance(
  name: string,
  detail?: Record<string, unknown>,
): void {
  appendMark(name, detail);
}
