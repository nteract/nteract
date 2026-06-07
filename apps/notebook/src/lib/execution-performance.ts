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
const MAX_MARKS = 10_000;
const MAX_TRACES = 50;
const MAX_MARKS_PER_TRACE = 2_000;

let sequence = 0;
let marks: ExecutionPerformanceMark[] = [];
const traces = new Map<string, ExecutionPerformanceTrace>();
const activeTraceByCellId = new Map<string, string>();
const traceByExecutionId = new Map<string, string>();
let latestTraceId: string | null = null;
let enabledCache: boolean | null = null;

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
  if (win.__NTERACT_EXECUTION_PERF_ENABLED === true) {
    enabledCache = true;
    return true;
  }
  if (enabledCache !== null) return enabledCache;
  enabledCache = localStorageEnabled(win);
  return enabledCache;
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
    if (trace) {
      trace.marks.push(mark);
      pruneTraceMarks(trace);
    }
  }

  pruneGlobalMarks();
  return mark;
}

function pruneGlobalMarks(): void {
  if (marks.length <= MAX_MARKS) return;
  marks.splice(0, marks.length - MAX_MARKS);
}

function pruneTraceMarks(trace: ExecutionPerformanceTrace): void {
  if (trace.marks.length <= MAX_MARKS_PER_TRACE) return;
  trace.marks.splice(0, trace.marks.length - MAX_MARKS_PER_TRACE);
}

function pruneTraces(): void {
  while (traces.size > MAX_TRACES) {
    const oldestTraceId = traces.keys().next().value;
    if (!oldestTraceId) return;
    const oldestTrace = traces.get(oldestTraceId);
    traces.delete(oldestTraceId);
    if (oldestTrace) {
      if (activeTraceByCellId.get(oldestTrace.cellId) === oldestTraceId) {
        activeTraceByCellId.delete(oldestTrace.cellId);
      }
      for (const [executionId, traceId] of traceByExecutionId) {
        if (traceId === oldestTraceId) traceByExecutionId.delete(executionId);
      }
    }
    if (latestTraceId === oldestTraceId) latestTraceId = null;
  }
}

export function installExecutionPerformanceApi(): void {
  const win = getWindow();
  if (!win || win.__nteractExecutionPerf) return;

  win.__nteractExecutionPerf = {
    enable() {
      win.__NTERACT_EXECUTION_PERF_ENABLED = true;
      enabledCache = true;
      setLocalStorageEnabled(win, true);
    },
    disable() {
      win.__NTERACT_EXECUTION_PERF_ENABLED = false;
      enabledCache = false;
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
  pruneTraces();
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
