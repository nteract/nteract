/**
 * Windowed data: the view↔data protocol for a table whose cells, permutation,
 * filtered summaries, and images arrive asynchronously.
 *
 * The data side owns the permutation (filter + sort) and the summary mask. The
 * view asks for windows in *view* positions and receives the matching data
 * rows alongside their cells, so it never holds the full permutation. Geometry
 * stays dense: `rowCount` is a number within the resident budget.
 *
 * `createResidentWindowedData` adapts today's `TableData` to this shape on the
 * main thread; a worker-backed implementation speaks the same protocol over a
 * `MessagePort`.
 */

import type {
  Column,
  ColumnFileStats,
  ColumnFilter,
  ColumnSummary,
  ColumnType,
  DatasetCoverage,
} from "./table";

export type WindowCells = {
  /** View position of `dataRows[0]`. */
  viewStart: number;
  /** Data rows in view order: identity for pooled rows, focus, and the detail sheet. */
  dataRows: Uint32Array;
  /** Row-major, `dataRows.length * columns.length`; `""` for null. */
  strings: string[];
  /** 1 = null. */
  nulls: Uint8Array;
  /**
   * Numeric and timestamp values; booleans as 1/0 so the view does not parse
   * display strings. NaN for other columns and for null.
   */
  numeric: Float64Array;
};

/**
 * The view's filter and sort state, in the engine's own vocabulary. This moves
 * where the permutation is computed, not the filter model; the committed
 * `TableQuery` of a provider result is orthogonal.
 */
export type ViewQuery = {
  /** One entry per column; `null` means no filter. */
  filters: (ColumnFilter | null)[];
  sort: { col: number; dir: "asc" | "desc" } | null;
};

export type QueryResult = {
  generation: number;
  filteredCount: number;
  /** Filtered summaries, what the header shows. */
  summaries: ColumnSummary[];
  /** Unfiltered snapshot; the engine's "hidden values" labels compare against it. */
  summariesAll: ColumnSummary[];
};

export type DataEvent =
  | { type: "rows-appended"; rowCount: number; summariesAll: ColumnSummary[] }
  | { type: "schema-changed"; columns: Column[] }
  | {
      type: "streaming-done";
      /**
       * Final counts, when the data side knows them (the worker does): rows
       * resident, the file's row count, and whether the budget stopped early.
       */
      loadedRows?: number;
      totalRows?: number;
      truncated?: boolean;
      /**
       * True when the load paused at a soft budget with row groups left: the
       * table is at rest, and a `streaming-resumed` follows if more rows are
       * requested. False or absent when loading has finished.
       */
      resumable?: boolean;
    }
  /** A paused load continues; `rows-appended` events follow. */
  | { type: "streaming-resumed"; rowCount: number }
  | { type: "error"; message: string; fatal: boolean };

export type WindowedTableData = {
  kind: "windowed";
  columns: Column[];
  /** Resident rows (dense geometry). Grows on `rows-appended`. */
  rowCount: number;
  coverage?: DatasetCoverage;
  datasetStats?: readonly (ColumnFileStats | null)[];
  /**
   * Cells for data rows `[0, headRows)` in identity order, regardless of the
   * current query; the engine uses it only when no sort or filter is active.
   * Available at mount for auto-width and first paint. Refresh it when cell
   * strings change (cast, undo).
   */
  head: WindowCells;
  /**
   * Cells for view rows `[viewStart, viewEnd)` under the current query. The
   * engine drops a response whose `generation` is no longer current.
   */
  requestWindow(viewStart: number, viewEnd: number, generation: number): Promise<WindowCells>;
  /** Recompute the permutation and summaries for `query`. */
  setQuery(query: ViewQuery, generation: number): Promise<QueryResult>;
  /** Image bytes for one cell: one entry per image, or `null` when there are none. */
  requestImage(dataRow: number, col: number): Promise<Uint8Array[] | null>;
  castColumn?(
    col: number,
    to: ColumnType,
    generation: number,
  ): Promise<QueryResult & { columns: Column[] }>;
  undoCastColumn?(col: number, generation: number): Promise<QueryResult & { columns: Column[] }>;
  isColumnCast?(col: number): boolean;
  subscribe(listener: (event: DataEvent) => void): () => void;
  dispose(): void;
};

export function isWindowedTableData(data: object): data is WindowedTableData {
  return "kind" in data && (data as { kind?: unknown }).kind === "windowed";
}
