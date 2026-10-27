/**
 * A `WindowedTableData` over an in-memory `TableData`, on the main thread.
 *
 * This is how the engine's windowed mode is tested, and the shape a worker
 * implements over a `MessagePort`. The adapter owns the permutation and the
 * summary mask the engine owns in resident mode; it never touches the DOM.
 * Every response resolves on a microtask, so the engine's code path is
 * asynchronous even here.
 */

import { computePermutation } from "./permutation";
import type { ColumnSummary, ColumnType, TableData } from "./table";
import type { DataEvent, QueryResult, ViewQuery, WindowCells, WindowedTableData } from "./windowed";

export type ResidentWindowedData = WindowedTableData & {
  /** The source grew (`TableData.rowCount` already updated): emit `rows-appended`. */
  notifyAppended(): void;
  /** The source finished loading: emit `streaming-done`. */
  notifyStreamingDone(): void;
};

const DEFAULT_HEAD_ROWS = 100;

/** Numeric value of a raw cell for `WindowCells.numeric`; NaN when not a number. */
function numericOf(raw: unknown): number {
  if (raw == null) return Number.NaN;
  if (typeof raw === "number") return raw;
  if (raw instanceof Date) return raw.getTime();
  const v = Number(raw);
  return Number.isNaN(v) ? Number.NaN : v;
}

function imageChunks(raw: unknown): Uint8Array[] {
  return Array.isArray(raw) ? (raw as Uint8Array[]) : raw instanceof Uint8Array ? [raw] : [];
}

export function createResidentWindowedData(
  data: TableData,
  opts: { headRows?: number } = {},
): ResidentWindowedData {
  const headRows = opts.headRows ?? DEFAULT_HEAD_ROWS;
  const listeners = new Set<(event: DataEvent) => void>();
  let query: ViewQuery = { filters: data.columns.map(() => null), sort: null };
  /** Data rows in view order under `query`; `null` when it is the identity. */
  let permutation: number[] | null = null;
  let filteredCount = data.rowCount;
  let summariesAll: ColumnSummary[] = [...data.columnSummaries];
  let disposed = false;

  const hasFilters = (q: ViewQuery) => q.filters.some((f) => f !== null);

  function emit(event: DataEvent) {
    for (const listener of listeners) listener(event);
  }

  function cellsFor(viewStart: number, dataRows: Uint32Array): WindowCells {
    const { columns } = data;
    const cols = columns.length;
    data.prefetchViewport?.(Array.from(dataRows));
    const strings: string[] = Array.from({ length: dataRows.length * cols }, () => "");
    const nulls = new Uint8Array(dataRows.length * cols);
    const numeric = new Float64Array(dataRows.length * cols).fill(Number.NaN);
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      for (let c = 0; c < cols; c++) {
        const k = i * cols + c;
        const colType = columns[c].columnType;
        const raw = data.getCellRaw(row, c);
        if (raw == null) {
          strings[k] = "";
          nulls[k] = 1;
          continue;
        }
        strings[k] = data.getCell(row, c);
        if (colType === "numeric" || colType === "timestamp") numeric[k] = numericOf(raw);
        else if (colType === "boolean") numeric[k] = raw ? 1 : 0;
      }
    }
    return { viewStart, dataRows, strings, nulls, numeric };
  }

  function viewRows(viewStart: number, viewEnd: number): Uint32Array {
    const start = Math.max(0, viewStart);
    const end = Math.min(viewEnd, filteredCount);
    const out = new Uint32Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) out[i] = permutation ? permutation[start + i] : start + i;
    return out;
  }

  /** Recompute the permutation for `query` and the summaries the header shows. */
  function runQuery(generation: number): QueryResult {
    const { columns, rowCount } = data;
    if (hasFilters(query) || query.sort) {
      permutation = computePermutation(data, columns, query.filters, query.sort, rowCount);
      filteredCount = permutation.length;
    } else {
      permutation = null;
      filteredCount = rowCount;
    }

    let summaries: ColumnSummary[];
    if (hasFilters(query) && data.recomputeFilteredSummaries) {
      const mask = new Uint8Array(rowCount);
      for (let i = 0; i < filteredCount; i++) mask[permutation![i]] = 1;
      data.recomputeFilteredSummaries(mask, filteredCount);
      summaries = [...data.columnSummaries];
      // Carry forward isIndex from unfiltered summaries — WASM doesn't track it
      for (let c = 0; c < columns.length; c++) {
        const full = summariesAll[c];
        const filtered = summaries[c];
        if (full && filtered && (full as { isIndex?: boolean }).isIndex) {
          (filtered as { isIndex?: boolean }).isIndex = true;
        }
      }
    } else {
      data.columnSummaries = [...summariesAll];
      summaries = [...summariesAll];
    }
    return { generation, filteredCount, summaries, summariesAll: [...summariesAll] };
  }

  /** Run `compute` now (state updates synchronously) and resolve on a microtask. */
  function settle<T>(compute: () => T): Promise<T> {
    if (disposed) return Promise.reject(new Error("Windowed data is disposed"));
    try {
      const value = compute();
      return Promise.resolve().then(() => value);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function assertOpen() {
    if (disposed) throw new Error("Windowed data is disposed");
  }

  const adapter: ResidentWindowedData = {
    kind: "windowed",
    columns: data.columns,
    rowCount: data.rowCount,
    // Loaders refresh coverage as rows arrive; read it live.
    get coverage() {
      return data.coverage;
    },
    get datasetStats() {
      return data.datasetStats;
    },
    head: cellsFor(0, viewRows(0, headRows)),
    requestWindow(viewStart, viewEnd) {
      return settle(() => cellsFor(Math.max(0, viewStart), viewRows(viewStart, viewEnd)));
    },
    setQuery(next, generation) {
      return settle(() => {
        query = { filters: [...next.filters], sort: next.sort };
        return runQuery(generation);
      });
    },
    requestImage(dataRow, col) {
      return settle(() => {
        const chunks = imageChunks(data.getCellRaw(dataRow, col));
        return chunks.length > 0 ? chunks : null;
      });
    },
    castColumn: data.castColumn
      ? (col, to: ColumnType, generation) =>
          settle(() => {
            data.castColumn!(col, to);
            data.columns[col].columnType = to;
            data.columns[col].numeric = to === "numeric";
            data.recomputeSummaries?.();
            summariesAll = [...data.columnSummaries];
            const result = runQuery(generation);
            adapter.head = cellsFor(0, viewRows(0, headRows));
            return { ...result, columns: data.columns };
          })
      : undefined,
    undoCastColumn: data.undoCastColumn
      ? (col, generation) =>
          settle(() => {
            const restored = data.undoCastColumn!(col);
            data.columns[col].columnType = restored;
            data.columns[col].numeric = restored === "numeric";
            data.recomputeSummaries?.();
            summariesAll = [...data.columnSummaries];
            const result = runQuery(generation);
            adapter.head = cellsFor(0, viewRows(0, headRows));
            return { ...result, columns: data.columns };
          })
      : undefined,
    isColumnCast: data.isColumnCast ? (col) => data.isColumnCast!(col) : undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      data.dispose?.();
    },
    notifyAppended() {
      assertOpen();
      adapter.rowCount = data.rowCount;
      // Under the identity permutation the new rows are already in view
      // order; a filter or sort waits for the engine's re-query.
      if (!permutation) filteredCount = data.rowCount;
      // The loader refreshed the source summaries for the new rows.
      summariesAll = [...data.columnSummaries];
      emit({ type: "rows-appended", rowCount: data.rowCount, summariesAll: [...summariesAll] });
    },
    notifyStreamingDone() {
      assertOpen();
      emit({ type: "streaming-done" });
    },
  };
  return adapter;
}
